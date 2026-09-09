import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { parse } from "yaml";
import type { FetchFn } from "../net/obsidianFetch";
import { DEFAULT_SKILLS_DIR } from "../agent/skillLoader";
import { sha256Hex } from "./skillHash";
export { sha256Hex } from "./skillHash";

/**
 * Sidecar written next to every imported skill's SKILL.md.
 *
 * Answers issue #80's version-management requirement with the facts an update
 * actually needs: where the skill came from, what was pinned when it landed,
 * and the content hash of every installed file — which is what separates a
 * clean update from one that would clobber local edits.
 */
export interface SkillProvenance {
	/** The URL the user imported from, echoed verbatim for the update button. */
	url: string;
	kind: SkillSourceKind;
	/** GitHub ref the import was resolved against (branch or tag name). */
	ref?: string;
	/**
	 * Git tree sha at import time. Equal on refetch means upstream is unchanged
	 * and nothing needs downloading at all; it is a pin, not a version number.
	 */
	treeSha?: string;
	importedAt: string;
	/** Installed path (relative to the skill directory) → sha256 of its content. */
	files: Record<string, string>;
}

export type SkillSourceKind = "github-tree" | "github-blob" | "raw";

/**
 * Where a pasted URL points. GitHub gets the rich treatment (tree enumeration,
 * version pinning, multi-file skills); any other URL is treated as one plain
 * markdown file, which is the only honest thing to do with an unknown shape.
 */
export type ParsedSkillSource =
	| { kind: "github-tree"; owner: string; repo: string; ref: string; subpath: string }
	| { kind: "github-blob"; owner: string; repo: string; ref: string; path: string }
	| { kind: "raw"; url: string };

/** One file fetched from upstream, path relative to the skill's install dir. */
export interface FetchedFile {
	path: string;
	content: string;
}

/** A complete skill downloaded from upstream, ready to install. */
export interface FetchedSkill {
	/** Directory name to install under, under the vault skills folder. */
	dirName: string;
	/** Skill name as pi will register it: frontmatter value, else the dir name. */
	name: string;
	description: string;
	/** Always includes the SKILL.md itself. */
	files: FetchedFile[];
}

/** Everything fetched from one source URL, in one pass. */
export interface FetchedSource {
	kind: SkillSourceKind;
	url: string;
	ref?: string;
	treeSha?: string;
	skills: FetchedSkill[];
	/** Non-fatal problems: a skipped oversized file, a name collision. */
	notes: string[];
}

export type UpdateAction = "add" | "update" | "remove" | "conflict";

export interface UpdatePlanEntry {
	path: string;
	action: UpdateAction;
	/** Present for `conflict`: why the file cannot be updated without a decision. */
	reason?: string;
}

export type UpdatePlan =
	| { status: "up-to-date" }
	| { status: "changed"; hasConflicts: boolean; entries: UpdatePlanEntry[] };

// ── Caps ────────────────────────────────────────────────────────────────────
// GitHub's tree API returns whole-repo listings, so the import filters hard:
// a skills repo is markdown, and anything beyond these bounds is either not a
// skill collection or too large to review file-by-file in a modal.

/** Files downloaded per import, total. */
const MAX_FILES = 40;
/** Skill directories accepted per repo import. */
const MAX_SKILLS = 10;
/** Per-file byte cap; real skills are prose, not datasets. */
const MAX_FILE_BYTES = 256 * 1024;
/** Maximum directory depth of a SKILL.md below the pasted subpath. */
const MAX_SKILL_DEPTH = 3;
/** Extensions never fetched — the import is markdown-only by design. */
const BINARY_EXTENSIONS = new Set([
	"png", "jpg", "jpeg", "gif", "webp", "ico", "pdf", "zip", "gz", "tgz", "tar", "mp3", "mp4", "wav", "woff", "woff2", "ttf", "otf", "eot", "exe", "dll", "so", "dylib", "wasm",
]);

export const SIDECAR_FILENAME = "piem-source.json";

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/**
 * Classifies a pasted URL without any network access.
 *
 * Accepted shapes:
 * - `github.com/{o}/{r}/tree/{ref}/{subpath?}` — a whole skill collection
 * - `github.com/{o}/{r}/blob/{ref}/{path}.md` — a single markdown file
 * - `raw.githubusercontent.com/{o}/{r}/{ref}/{path}.md` — same, direct link
 * - any other https URL ending in `.md` — fetched as one plain file
 *
 * Returns undefined for anything else; the caller owns the user-facing
 * message. Refs containing slashes are not supported — the
 * `tree/{ref}/{subpath}` grammar is ambiguous for them and branch names with
 * slashes are rare in skill repos.
 */
export function parseSkillUrl(input: string): ParsedSkillSource | undefined {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		return undefined;
	}
	if (GITHUB_HOSTS.has(url.hostname)) {
		const segments = url.pathname.split("/").filter((segment) => segment !== "");
		// [owner, repo, tree|blob, ref, ...rest]
		if (segments.length < 4) {
			return undefined;
		}
		const owner = segments[0];
		const repo = segments[1];
		const kind = segments[2];
		const ref = segments[3];
		if (!owner || !repo || !ref) {
			return undefined;
		}
		const rest = segments.slice(4);
		if (kind === "tree") {
			return { kind: "github-tree", owner, repo, ref, subpath: rest.join("/") };
		}
		if (kind === "blob") {
			const path = rest.join("/");
			if (!path.endsWith(".md")) {
				return undefined;
			}
			return { kind: "github-blob", owner, repo, ref, path };
		}
		return undefined;
	}
	if (url.hostname === "raw.githubusercontent.com") {
		const segments = url.pathname.split("/").filter((segment) => segment !== "");
		// [owner, repo, ref, ...path]
		if (segments.length < 4 || !url.pathname.endsWith(".md")) {
			return undefined;
		}
		const owner = segments[0];
		const repo = segments[1];
		const ref = segments[2];
		if (!owner || !repo || !ref) {
			return undefined;
		}
		return { kind: "github-blob", owner, repo, ref, path: segments.slice(3).join("/") };
	}
	if (!url.pathname.endsWith(".md")) {
		return undefined;
	}
	return { kind: "raw", url: url.toString() };
}

/** Limits a pasted name to a safe single-directory name under the skills folder. */
export function sanitizeDirName(input: string): string {
	const cleaned = input
		.trim()
		.toLowerCase()
		.replace(/[^\w.-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, 64);
	return cleaned || "skill";
}

/**
 * Extracts `name`/`description` from a skill file's frontmatter.
 *
 * Parses with the same `yaml` package pi loads skills with, so import-time and
 * load-time agree — regex extraction read quoted, folded, or commented YAML
 * differently and could install a skill under a directory name pi would never
 * register. Still deliberately minimal: full frontmatter validation is pi's
 * job at load time. A parse failure swallows to `{}` so one malformed skill
 * falls back to the URL-derived directory instead of failing the whole import.
 */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!match) {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = parse(match[1] ?? "");
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {};
	}
	const raw = parsed as Record<string, unknown>;
	const read = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
	return { name: read(raw.name), description: read(raw.description) };
}

/**
 * Computes the update plan from three snapshots — no IO beyond hashing, fully
 * unit-testable.
 *
 * A file updates cleanly when its local copy still matches the provenance
 * hash: the user has not touched it, so upstream may. Any locally-modified
 * file becomes a `conflict` instead of an `update`, because silently
 * overwriting a user's edit is the one mistake this feature must never make.
 * Upstream deletions follow the same rule in reverse: only a pristine local
 * copy is removed.
 */
export async function planUpdate(
	provenance: SkillProvenance,
	remote: { treeSha?: string; files: { path: string; content: string }[] },
	localHashes: Record<string, string | undefined>,
): Promise<UpdatePlan> {
	if (provenance.treeSha && remote.treeSha && provenance.treeSha === remote.treeSha) {
		return { status: "up-to-date" };
	}
	const remoteHashes = new Map<string, string>();
	for (const file of remote.files) {
		remoteHashes.set(file.path, await sha256Hex(file.content));
	}
	const entries: UpdatePlanEntry[] = [];
	let hasConflicts = false;
	for (const file of remote.files) {
		const remoteHash = remoteHashes.get(file.path) ?? "";
		const localHash = localHashes[file.path];
		const provenanceHash = provenance.files[file.path];
		if (localHash === undefined) {
			entries.push({ path: file.path, action: "add" });
			continue;
		}
		if (localHash === remoteHash) {
			continue;
		}
		if (provenanceHash !== undefined && localHash === provenanceHash) {
			entries.push({ path: file.path, action: "update" });
			continue;
		}
		hasConflicts = true;
		entries.push({ path: file.path, action: "conflict", reason: "local-modified" });
	}
	for (const [path, provenanceHash] of Object.entries(provenance.files)) {
		if (remoteHashes.has(path)) {
			continue;
		}
		const localHash = localHashes[path];
		if (localHash === undefined) {
			continue;
		}
		if (localHash === provenanceHash) {
			entries.push({ path, action: "remove" });
			continue;
		}
		hasConflicts = true;
		entries.push({ path, action: "conflict", reason: "local-modified" });
	}
	return { status: "changed", hasConflicts, entries };
}

/**
 * Reads and validates a skill's sidecar.
 *
 * Tolerates junk (wrong shape, wrong JSON) by returning undefined rather than
 * throwing: an unreadable provenance only means the skill cannot auto-update,
 * and the user can always delete and re-import.
 */
export function parseProvenance(json: string | undefined): SkillProvenance | undefined {
	if (!json) {
		return undefined;
	}
	try {
		const data: unknown = JSON.parse(json);
		if (typeof data !== "object" || data === null) {
			return undefined;
		}
		const record = data as Record<string, unknown>;
		if (typeof record.url !== "string" || typeof record.kind !== "string" || typeof record.importedAt !== "string") {
			return undefined;
		}
		if (typeof record.files !== "object" || record.files === null) {
			return undefined;
		}
		const files: Record<string, string> = {};
		for (const [path, hash] of Object.entries(record.files)) {
			if (typeof hash === "string") {
				files[path] = hash;
			}
		}
		return {
			url: record.url,
			kind: record.kind as SkillSourceKind,
			ref: typeof record.ref === "string" ? record.ref : undefined,
			treeSha: typeof record.treeSha === "string" ? record.treeSha : undefined,
			importedAt: record.importedAt,
			files,
		};
	} catch {
		return undefined;
	}
}

/**
 * Fetches skills from a URL the user pasted, over whatever transport the
 * plugin was configured to use.
 *
 * GitHub sources walk the git tree once (`git/trees/{ref}?recursive=1`) to
 * enumerate SKILL.md files, then download each file from
 * `raw.githubusercontent.com` — the raw CDN is unauthenticated and generous,
 * unlike the contents API, so a ten-skill repo costs one API call and N CDN
 * requests. The tree's sha is captured as the version pin for later updates.
 */
export class SkillImporter {
	constructor(
		private readonly fetchImpl: FetchFn,
		private readonly env: ExecutionEnv,
		private readonly skillsDir: string = DEFAULT_SKILLS_DIR,
	) {}

	/** Vault-absolute path for an installed skill dir, e.g. `/Piem/skills/foo`. */
	private installPath(dirName: string, relative = ""): string {
		return `/${this.skillsDir}/${dirName}${relative ? `/${relative}` : ""}`;
	}

	async fetchSource(url: string): Promise<FetchedSource> {
		const parsed = parseSkillUrl(url);
		if (!parsed) {
			throw new Error(`Unsupported URL: ${url}`);
		}
		if (parsed.kind === "github-tree") {
			return this.fetchGithubTree(parsed, url);
		}
		if (parsed.kind === "github-blob") {
			return this.fetchGithubBlob(parsed, url);
		}
		const content = await this.fetchText(parsed.url);
		const frontmatter = parseSkillFrontmatter(content);
		const dirName = sanitizeDirName(frontmatter.name ?? basename(parsed.url).replace(/\.md$/, ""));
		return {
			kind: "raw",
			url: parsed.url,
			skills: [{ dirName, name: frontmatter.name ?? dirName, description: frontmatter.description ?? "", files: [{ path: "SKILL.md", content }] }],
			notes: [],
		};
	}

	/**
	 * Writes one fetched skill into the vault and records its sidecar, hashing
	 * every installed file so a later update can tell local edits from
	 * untouched ones.
	 */
	async installSkill(source: FetchedSource, skill: FetchedSkill): Promise<void> {
		const files: Record<string, string> = {};
		for (const file of skill.files) {
			await this.env.writeFile(this.installPath(skill.dirName, file.path), file.content);
			files[file.path] = await sha256Hex(file.content);
		}
		const provenance: SkillProvenance = {
			url: source.url,
			kind: source.kind,
			ref: source.ref,
			treeSha: source.treeSha,
			importedAt: new Date().toISOString(),
			files,
		};
		await this.env.writeFile(this.installPath(skill.dirName, SIDECAR_FILENAME), `${JSON.stringify(provenance, null, "\t")}\n`);
	}

	async readProvenance(dirName: string): Promise<SkillProvenance | undefined> {
		const sidecar = await this.env.readTextFile(this.installPath(dirName, SIDECAR_FILENAME));
		if (!sidecar.ok) {
			return undefined;
		}
		return parseProvenance(sidecar.value);
	}

	/** Hashes the installed files the sidecar lists; absent files hash as undefined. */
	async hashInstalled(dirName: string, provenance: SkillProvenance): Promise<Record<string, string | undefined>> {
		const hashes: Record<string, string | undefined> = {};
		for (const path of Object.keys(provenance.files)) {
			const read = await this.env.readTextFile(this.installPath(dirName, path));
			hashes[path] = read.ok ? await sha256Hex(read.value) : undefined;
		}
		return hashes;
	}

	/**
	 * Refetches the source URL and plans the update for one installed skill.
	 *
	 * Throws when the sidecar's URL no longer yields the same skill — the
	 * upstream moved the directory or renamed it, and guessing would install
	 * something the user did not ask for.
	 */
	async planUpdateFor(dirName: string, provenance: SkillProvenance): Promise<{ source: FetchedSource; skill: FetchedSkill; plan: UpdatePlan }> {
		const source = await this.fetchSource(provenance.url);
		const skill = source.skills.find((candidate) => candidate.dirName === dirName);
		if (!skill) {
			throw new Error(`Source no longer contains skill "${dirName}": ${provenance.url}`);
		}
		const localHashes = await this.hashInstalled(dirName, provenance);
		const plan = await planUpdate(provenance, { treeSha: source.treeSha, files: skill.files }, localHashes);
		return { source, skill, plan };
	}

	/**
	 * Applies a conflict-free update plan: writes every add/update, removes
	 * every remove, then rewrites the sidecar against the new upstream state.
	 * Refuses to run when the plan still holds conflicts — the caller decides
	 * what happens to a user's local edits, not this method.
	 */
	async applyUpdate(dirName: string, source: FetchedSource, skill: FetchedSkill, plan: UpdatePlan): Promise<void> {
		if (plan.status === "up-to-date") {
			return;
		}
		if (plan.hasConflicts) {
			throw new Error(`Update plan for "${dirName}" has conflicts; resolve them first`);
		}
		for (const entry of plan.entries) {
			if (entry.action === "conflict") {
				continue;
			}
			if (entry.action === "remove") {
				await this.env.remove(this.installPath(dirName, entry.path));
				continue;
			}
			const file = skill.files.find((candidate) => candidate.path === entry.path);
			if (!file) {
				throw new Error(`Plan references missing file "${entry.path}"`);
			}
			await this.env.writeFile(this.installPath(dirName, file.path), file.content);
		}
		const files: Record<string, string> = {};
		for (const file of skill.files) {
			files[file.path] = await sha256Hex(file.content);
		}
		const provenance: SkillProvenance = {
			url: source.url,
			kind: source.kind,
			ref: source.ref,
			treeSha: source.treeSha,
			importedAt: new Date().toISOString(),
			files,
		};
		await this.env.writeFile(this.installPath(dirName, SIDECAR_FILENAME), `${JSON.stringify(provenance, null, "\t")}\n`);
	}

	private async fetchGithubTree(parsed: Extract<ParsedSkillSource, { kind: "github-tree" }>, originalUrl: string): Promise<FetchedSource> {
		const notes: string[] = [];
		const api = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${encodeURIComponent(parsed.ref)}?recursive=1`;
		const response = await this.fetchImpl(api, { headers: { Accept: "application/vnd.github+json" } });
		if (!response.ok) {
			throw new Error(`GitHub API returned ${response.status} for ${api}`);
		}
		const data = (await response.json()) as { sha?: unknown; truncated?: unknown; tree?: Array<{ path?: unknown; type?: unknown; size?: unknown }> };
		if (typeof data.sha !== "string") {
			throw new Error(`GitHub API response is missing a tree sha: ${api}`);
		}
		if (data.truncated === true) {
			throw new Error(`Repository tree is too large to import: ${originalUrl}`);
		}
		const blobs = (data.tree ?? []).flatMap((entry) =>
			entry.type === "blob" && typeof entry.path === "string" ? [{ path: entry.path, size: typeof entry.size === "number" ? entry.size : 0 }] : [],
		);
		const scope = parsed.subpath ? `${parsed.subpath.replace(/\/+$/, "")}/` : "";
		const inScope = blobs.filter((blob) => blob.path.startsWith(scope));

		const markers = inScope.filter((blob) => {
			const relative = blob.path.slice(scope.length);
			if (relative === "SKILL.md") {
				return true;
			}
			if (!relative.endsWith("/SKILL.md")) {
				return false;
			}
			// Directory segments between scope and the marker, depth-capped so a
			// stray deep-nested SKILL.md in a dependency folder is not pulled in.
			return relative.split("/").length - 2 <= MAX_SKILL_DEPTH;
		});
		if (markers.length === 0) {
			throw new Error(`No SKILL.md files found under "${parsed.subpath || "/"}" in ${parsed.owner}/${parsed.repo}`);
		}
		if (markers.length > MAX_SKILLS) {
			throw new Error(`Found ${markers.length} skills; at most ${MAX_SKILLS} can be imported at once`);
		}

		// Repo dir path → install dir name, deduplicated with a numeric suffix.
		const dirNames = new Map<string, string>();
		for (const marker of markers) {
			const dir = marker.path.slice(scope.length, marker.path.length - "SKILL.md".length).replace(/\/+$/, "");
			let name = sanitizeDirName(dir);
			for (let suffix = 2; [...dirNames.values()].includes(name); suffix++) {
				name = `${sanitizeDirName(dir)}-${suffix}`;
			}
			dirNames.set(dir, name);
		}

		// Everything under each accepted dir travels with the skill, so sibling
		// reference files the SKILL.md points at are not lost.
		const wanted = new Map<string, number>();
		for (const [dir] of dirNames) {
			for (const blob of inScope) {
				// `dir` is scope-relative; repo paths need the scope prefixed back on.
				const included = dir === "" ? blob.path === `${scope}SKILL.md` : blob.path.startsWith(`${scope}${dir}/`);
				if (included) {
					wanted.set(blob.path, blob.size);
				}
			}
		}

		const downloads: string[] = [];
		for (const [path, size] of wanted) {
			if (downloads.length >= MAX_FILES) {
				notes.push(`Import limited to the first ${MAX_FILES} files`);
				break;
			}
			if (isBinaryPath(path)) {
				notes.push(`Skipped binary file: ${path}`);
				continue;
			}
			if (size > MAX_FILE_BYTES) {
				notes.push(`Skipped oversized file: ${path}`);
				continue;
			}
			downloads.push(path);
		}

		const byDir = new Map<string, FetchedFile[]>();
		for (const path of downloads) {
			const dir = [...dirNames.keys()].find((candidate) => (candidate === "" ? path === `${scope}SKILL.md` : path.startsWith(`${scope}${candidate}/`)));
			if (dir === undefined) {
				continue;
			}
			const dirName = dirNames.get(dir) ?? "skill";
			const relative = path.slice((dir === "" ? scope : `${scope}${dir}/`).length);
			const list = byDir.get(dirName) ?? [];
			list.push({ path: relative, content: await this.fetchText(rawContentUrl(parsed.owner, parsed.repo, parsed.ref, path)) });
			byDir.set(dirName, list);
		}

		const skills: FetchedSkill[] = [];
		for (const [dirName, files] of byDir) {
			const skillFile = files.find((file) => file.path === "SKILL.md");
			const frontmatter = skillFile ? parseSkillFrontmatter(skillFile.content) : {};
			skills.push({ dirName, name: frontmatter.name ?? dirName, description: frontmatter.description ?? "", files });
		}
		return { kind: "github-tree", url: originalUrl, ref: parsed.ref, treeSha: data.sha, skills, notes };
	}

	private async fetchGithubBlob(parsed: Extract<ParsedSkillSource, { kind: "github-blob" }>, originalUrl: string): Promise<FetchedSource> {
		const content = await this.fetchText(rawContentUrl(parsed.owner, parsed.repo, parsed.ref, parsed.path));
		const frontmatter = parseSkillFrontmatter(content);
		const dirName = sanitizeDirName(frontmatter.name ?? basename(parsed.path).replace(/\.md$/, ""));
		return {
			kind: "github-blob",
			url: originalUrl,
			ref: parsed.ref,
			skills: [{ dirName, name: frontmatter.name ?? dirName, description: frontmatter.description ?? "", files: [{ path: "SKILL.md", content }] }],
			notes: [],
		};
	}

	private async fetchText(url: string): Promise<string> {
		const response = await this.fetchImpl(url);
		if (!response.ok) {
			throw new Error(`Download failed (${response.status}): ${url}`);
		}
		return response.text();
	}
}

function rawContentUrl(owner: string, repo: string, ref: string, path: string): string {
	return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${encodePath(path)}`;
}

/** Percent-encodes each path segment; slashes must survive. */
function encodePath(path: string): string {
	return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function isBinaryPath(path: string): boolean {
	const dot = path.lastIndexOf(".");
	return dot > path.lastIndexOf("/") && BINARY_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}
