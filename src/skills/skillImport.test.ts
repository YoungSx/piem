import { describe, expect, test } from "bun:test";

import {
	err,
	FileError,
	ok,
	type ExecutionEnv,
	type FileInfo,
	type FileKind,
	type Result,
	type ShellExecOptions,
} from "@earendil-works/pi-agent-core";

import {
	SIDECAR_FILENAME,
	SkillImporter,
	parseProvenance,
	parseSkillFrontmatter,
	parseSkillUrl,
	planUpdate,
	sanitizeDirName,
	sha256Hex,
	type SkillProvenance,
} from "./skillImport";

// ── parseSkillUrl ───────────────────────────────────────────────────────────

describe("parseSkillUrl", () => {
	test("classifies a github tree URL with and without a subpath", () => {
		expect(parseSkillUrl("https://github.com/acme/skills/tree/main")).toEqual({
			kind: "github-tree",
			owner: "acme",
			repo: "skills",
			ref: "main",
			subpath: "",
		});
		expect(parseSkillUrl("https://github.com/acme/skills/tree/v1.2/folder/sub")).toEqual({
			kind: "github-tree",
			owner: "acme",
			repo: "skills",
			ref: "v1.2",
			subpath: "folder/sub",
		});
	});

	test("classifies github blob and raw URLs as single-file sources", () => {
		expect(parseSkillUrl("https://github.com/acme/skills/blob/main/skills/x/SKILL.md")).toEqual({
			kind: "github-blob",
			owner: "acme",
			repo: "skills",
			ref: "main",
			path: "skills/x/SKILL.md",
		});
		expect(parseSkillUrl("https://raw.githubusercontent.com/acme/skills/main/summarize.md")).toEqual({
			kind: "github-blob",
			owner: "acme",
			repo: "skills",
			ref: "main",
			path: "summarize.md",
		});
	});

	test("falls back to raw for other hosts ending in .md", () => {
		expect(parseSkillUrl("https://example.com/notes/my-skill.md?raw=1")).toEqual({
			kind: "raw",
			url: "https://example.com/notes/my-skill.md?raw=1",
		});
	});

	test("rejects non-markdown, non-github and malformed inputs", () => {
		expect(parseSkillUrl("https://github.com/acme/skills/blob/main/image.png")).toBeUndefined();
		expect(parseSkillUrl("https://example.com/page")).toBeUndefined();
		expect(parseSkillUrl("https://github.com/acme/skills")).toBeUndefined();
		expect(parseSkillUrl("ftp://example.com/skill.md")).toBeUndefined();
		expect(parseSkillUrl("not a url")).toBeUndefined();
		expect(parseSkillUrl("")).toBeUndefined();
	});
});

// ── small pure helpers ──────────────────────────────────────────────────────

describe("sanitizeDirName", () => {
	test("keeps simple names, mangles unsafe ones, never returns empty", () => {
		expect(sanitizeDirName("Summarize")).toBe("summarize");
		expect(sanitizeDirName("my cool/skill!")).toBe("my-cool-skill");
		expect(sanitizeDirName("../../etc")).toBe("etc");
		expect(sanitizeDirName("  ")).toBe("skill");
	});
});

describe("parseSkillFrontmatter", () => {
	test("reads name and description from frontmatter", () => {
		expect(parseSkillFrontmatter("---\nname: Summarize\ndescription: Shortens text\n---\nbody")).toEqual({
			name: "Summarize",
			description: "Shortens text",
		});
	});

	test("returns empty for files without frontmatter", () => {
		expect(parseSkillFrontmatter("# just markdown")).toEqual({});
	});

	test("unquotes scalars, so the install directory matches pi's registered name", () => {
		expect(parseSkillFrontmatter('---\nname: "my-skill"\ndescription: \'Quoted\'\n---\nbody')).toEqual({
			name: "my-skill",
			description: "Quoted",
		});
	});

	test("reads folded block scalars", () => {
		expect(parseSkillFrontmatter("---\nname: >-\n  folded\n  skill\n---\nbody")).toEqual({
			name: "folded skill",
		});
	});

	test("ignores commented-out keys", () => {
		expect(parseSkillFrontmatter("---\n# name: stale\nname: real\n---\nbody")).toEqual({ name: "real" });
	});

	test("returns empty for malformed frontmatter instead of failing the import", () => {
		expect(parseSkillFrontmatter("---\ndescription: a: b\n---\nbody")).toEqual({});
	});
});

describe("sha256Hex", () => {
	test("matches the reference vector for sha256", async () => {
		expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});
});

describe("parseProvenance", () => {
	test("round-trips a valid sidecar and tolerates junk", () => {
		const provenance: SkillProvenance = {
			url: "https://example.com/skill.md",
			kind: "raw",
			importedAt: "2026-01-01T00:00:00.000Z",
			files: { "SKILL.md": "aa" },
		};
		expect(parseProvenance(JSON.stringify(provenance))).toEqual(provenance);
		expect(parseProvenance("{not json")).toBeUndefined();
		expect(parseProvenance(JSON.stringify({ url: 42 }))).toBeUndefined();
		expect(parseProvenance(undefined)).toBeUndefined();
	});
});

// ── planUpdate ──────────────────────────────────────────────────────────────

async function provenanceWith(files: Record<string, string>): Promise<SkillProvenance> {
	const hashes: Record<string, string> = {};
	for (const [path, content] of Object.entries(files)) {
		hashes[path] = await sha256Hex(content);
	}
	return { url: "https://example.com", kind: "github-tree", treeSha: "tree-1", importedAt: "2026-01-01T00:00:00.000Z", files: hashes };
}

describe("planUpdate", () => {
	test("unchanged file hashes report up-to-date", async () => {
		const provenance = await provenanceWith({ "SKILL.md": "a" });
		expect(await planUpdate(provenance, { treeSha: "tree-1", files: [{ path: "SKILL.md", content: "a" }] }, {})).toEqual({
			status: "up-to-date",
		});
	});

	test("adds previously omitted resources even when the source tree has not changed", async () => {
		const provenance = await provenanceWith({ "SKILL.md": "a" });
		const plan = await planUpdate(provenance, {
			treeSha: "tree-1", files: [{ path: "SKILL.md", content: "a" }, { path: "references/detail.md", content: "reference" }],
		}, { "SKILL.md": await sha256Hex("a") });
		expect(plan).toEqual({ status: "changed", hasConflicts: false, entries: [{ path: "references/detail.md", action: "add" }] });
	});

	test("clean local copies update, untouched files are skipped, new files add", async () => {
		const provenance = await provenanceWith({ "SKILL.md": "v1", "refs.md": "same" });
		const local = {
			"SKILL.md": await sha256Hex("v1"),
			"refs.md": await sha256Hex("same"),
			"extra.md": await sha256Hex("x"),
		};
		const plan = await planUpdate(
			provenance,
			{ treeSha: "tree-2", files: [{ path: "SKILL.md", content: "v2" }, { path: "refs.md", content: "same" }, { path: "extra.md", content: "x" }, { path: "new.md", content: "n" }] },
			local,
		);
		expect(plan).toEqual({
			status: "changed",
			hasConflicts: false,
			entries: [
				{ path: "SKILL.md", action: "update" },
				{ path: "new.md", action: "add" },
			],
		});
	});

	test("a locally modified file conflicts instead of being overwritten", async () => {
		const provenance = await provenanceWith({ "SKILL.md": "v1" });
		const plan = await planUpdate(
			provenance,
			{ treeSha: "tree-2", files: [{ path: "SKILL.md", content: "v2" }] },
			{ "SKILL.md": await sha256Hex("user edit") },
		);
		expect(plan).toEqual({
			status: "changed",
			hasConflicts: true,
			entries: [{ path: "SKILL.md", action: "conflict", reason: "local-modified" }],
		});
	});

	test("upstream deletions remove pristine files and conflict on edited ones", async () => {
		const provenance = await provenanceWith({ "gone.md": "old", "edited.md": "old" });
		const plan = await planUpdate(provenance, { treeSha: "tree-2", files: [] }, {
			"gone.md": await sha256Hex("old"),
			"edited.md": await sha256Hex("user edit"),
		});
		expect(plan).toEqual({
			status: "changed",
			hasConflicts: true,
			entries: [
				{ path: "gone.md", action: "remove" },
				{ path: "edited.md", action: "conflict", reason: "local-modified" },
			],
		});
	});
});

// ── in-memory vault for the importer ────────────────────────────────────────

/** In-memory ExecutionEnv: a flat path→content map standing in for the vault. */
class MemoryEnv implements ExecutionEnv {
	readonly cwd = "/vault";

	private readonly files = new Map<string, string>();

	async readTextFile(path: string): Promise<Result<string, FileError>> {
		const content = this.files.get(path);
		return content === undefined ? err(new FileError("not_found", `missing: ${path}`, path)) : ok(content);
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		this.files.set(path, typeof content === "string" ? content : new TextDecoder().decode(content));
		return ok(undefined);
	}

	/** Raw map access for assertions. */
	writeText(path: string, content: string): void {
		this.files.set(path, content);
	}

	async remove(path: string): Promise<Result<void, FileError>> {
		if (!this.files.delete(path)) {
			return err(new FileError("not_found", `missing: ${path}`, path));
		}
		return ok(undefined);
	}

	/** Raw map access for assertions. */
	read(path: string): string | undefined {
		return this.files.get(path);
	}

	async readTextLines(path: string): Promise<Result<string[], FileError>> {
		const text = await this.readTextFile(path);
		return text.ok ? ok(text.value.split("\n")) : text;
	}

	async readBinaryFile(): Promise<Result<Uint8Array, FileError>> {
		return err(new FileError("not_supported", "unused in tests", this.cwd));
	}

	async appendFile(path: string, content: string): Promise<Result<void, FileError>> {
		this.files.set(path, (this.files.get(path) ?? "") + content);
		return ok(undefined);
	}

	async renameFile(source: string, destination: string): Promise<Result<void, FileError>> {
		const content = this.files.get(source);
		if (content === undefined) {
			return err(new FileError("not_found", `missing: ${source}`, source));
		}
		this.files.set(destination, content);
		this.files.delete(source);
		return ok(undefined);
	}

	async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
		if (!this.files.has(path)) {
			return err(new FileError("not_found", `missing: ${path}`, path));
		}
		const info: FileInfo = { name: path.slice(path.lastIndexOf("/") + 1), path, kind: "file" as FileKind, size: this.files.get(path)?.length ?? 0, mtimeMs: 0 };
		return ok(info);
	}

	async listDir(): Promise<Result<FileInfo[], FileError>> {
		return ok([]);
	}

	async canonicalPath(path: string): Promise<Result<string, FileError>> {
		return ok(path);
	}

	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return ok(path);
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(parts.join("/"));
	}

	async exists(path: string): Promise<Result<boolean, FileError>> {
		return ok(this.files.has(path));
	}

	async createDir(): Promise<Result<void, FileError>> {
		return ok(undefined);
	}

	async createTempDir(): Promise<Result<string, FileError>> {
		return err(new FileError("not_supported", "unused in tests", this.cwd));
	}

	async createTempFile(): Promise<Result<string, FileError>> {
		return err(new FileError("not_supported", "unused in tests", this.cwd));
	}

	async cleanup(): Promise<void> {
		// stateless
	}

	async exec(_command: string, _options?: ShellExecOptions): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, never>> {
		throw new Error("unused in tests");
	}
}

interface StubRoute {
	status?: number;
	body: string;
}

/** fetch stub keyed by exact URL. */
function stubFetch(routes: Record<string, StubRoute>): typeof globalThis.fetch {
	return (async (input: RequestInfo | URL) => {
		const url = input instanceof Request ? input.url : String(input);
		const route = routes[url];
		if (!route) {
			return new Response(`no route: ${url}`, { status: 404 });
		}
		return new Response(route.body, { status: route.status ?? 200 });
	}) as typeof globalThis.fetch;
}

const TREE_API = "https://api.github.com/repos/acme/skills/git/trees/main?recursive=1";

function treeResponse(entries: Array<{ path: string; type: string; size?: number }>, sha = "tree-1"): string {
	return JSON.stringify({ sha, truncated: false, tree: entries });
}

// ── SkillImporter.fetchSource ───────────────────────────────────────────────

describe("SkillImporter.fetchSource", () => {
	test("imports every skill under a repo subpath, with sibling files", async () => {
		const env = new MemoryEnv();
		const importer = new SkillImporter(
			stubFetch({
				[TREE_API]: { body: treeResponse([
					{ path: "skills/summarize/SKILL.md", type: "blob", size: 30 },
					{ path: "skills/summarize/refs.md", type: "blob", size: 10 },
					{ path: "skills/logo.png", type: "blob", size: 9 },
					{ path: "README.md", type: "blob", size: 4 },
				]) },
				"https://raw.githubusercontent.com/acme/skills/main/skills/summarize/SKILL.md": { body: "---\nname: Summarize\ndescription: Shortens text\n---\nbody" },
				"https://raw.githubusercontent.com/acme/skills/main/skills/summarize/refs.md": { body: "refs" },
			}),
			env,
		);
		const source = await importer.fetchSource("https://github.com/acme/skills/tree/main/skills");
		expect(source.kind).toBe("github-tree");
		expect(source.treeSha).toBe("tree-1");
		expect(source.notes).toEqual([]);
		expect(source.skills).toHaveLength(1);
		const skill = source.skills[0];
		if (!skill) {
			throw new Error("expected one skill");
		}
		expect(skill.dirName).toBe("summarize");
		expect(skill.name).toBe("Summarize");
		expect(skill.description).toBe("Shortens text");
		expect(skill.files.map((file) => file.path).sort()).toEqual(["SKILL.md", "refs.md"]);
	});

	test("imports a single blob URL as one skill", async () => {
		const env = new MemoryEnv();
		const importer = new SkillImporter(
			stubFetch({
				"https://raw.githubusercontent.com/acme/skills/main/summarize.md": { body: "---\nname: Summarize\n---\nbody" },
			}),
			env,
		);
		const source = await importer.fetchSource("https://github.com/acme/skills/blob/main/summarize.md");
		expect(source.skills[0]?.dirName).toBe("summarize");
		expect(source.skills[0]?.files).toEqual([{ path: "SKILL.md", content: "---\nname: Summarize\n---\nbody" }]);
	});

	test("imports a skill folder with its Markdown resources but never downloads scripts", async () => {
		const fetched: string[] = [];
		const routes = stubFetch({
			[TREE_API]: { body: treeResponse([
				{ path: "skills/example/SKILL.md", type: "blob", size: 80 },
				{ path: "skills/example/references/detail.md", type: "blob", size: 8 },
				{ path: "skills/example/scripts/run.py", type: "blob", size: 8 },
				{ path: "skills/example/assets/image.png", type: "blob", size: 8 },
				{ path: "skills/example-neighbor/private.md", type: "blob", size: 8 },
			]) },
			"https://raw.githubusercontent.com/acme/skills/main/skills/example/SKILL.md": { body: "---\nname: example\ndescription: Reads a reference\n---\n[Details](references/detail.md)" },
			"https://raw.githubusercontent.com/acme/skills/main/skills/example/references/detail.md": { body: "Resource" },
		});
		const importer = new SkillImporter(async (input, init) => {
			fetched.push(String(input));
			return routes(input, init);
		}, new MemoryEnv());

		for (const scope of ["skills", "skills/example"]) {
			const source = await importer.fetchSource(`https://github.com/acme/skills/tree/main/${scope}`);
			expect(source.skills).toHaveLength(1);
			expect(source.skills[0]?.dirName).toBe("example");
			expect(source.skills[0]?.files.map((file) => file.path).sort()).toEqual(["SKILL.md", "references/detail.md"]);
			expect(source.notes.some((note) => note.includes("run.py"))).toBe(true);
		}
		expect(fetched.some((url) => url.endsWith("run.py") || url.endsWith("image.png") || url.endsWith("private.md"))).toBe(false);
	});

	test("treats a repository-root skill as one package and keeps its resources", async () => {
		const importer = new SkillImporter(stubFetch({
			[TREE_API]: { body: treeResponse([
				{ path: "SKILL.md", type: "blob", size: 80 },
				{ path: "references/detail.md", type: "blob", size: 8 },
			]) },
			"https://raw.githubusercontent.com/acme/skills/main/SKILL.md": { body: "---\nname: example\ndescription: Root skill\n---\nBody" },
			"https://raw.githubusercontent.com/acme/skills/main/references/detail.md": { body: "Resource" },
		}), new MemoryEnv());
		const source = await importer.fetchSource("https://github.com/acme/skills/tree/main");
		expect(source.skills[0]?.dirName).toBe("example");
		expect(source.skills[0]?.files.map((file) => file.path)).toEqual(["SKILL.md", "references/detail.md"]);
	});

	test("checks the downloaded size even when GitHub reports a smaller file", async () => {
		const importer = new SkillImporter(stubFetch({
			"https://raw.githubusercontent.com/acme/skills/main/example.md": { body: "大".repeat(100_000) },
		}), new MemoryEnv());
		await expect(importer.fetchSource("https://github.com/acme/skills/blob/main/example.md")).rejects.toThrow("too large");
	});

	test("rejects an incomplete package instead of dropping resources at the file limit", async () => {
		const entries = ["example/SKILL.md", ...Array.from({ length: 40 }, (_, i) => `example/references/${i}.md`)];
		const importer = new SkillImporter(stubFetch({
			[TREE_API]: { body: treeResponse(entries.map((path) => ({ path, type: "blob", size: 10 }))) },
			...Object.fromEntries(entries.map((path) => [`https://raw.githubusercontent.com/acme/skills/main/${path}`, { body: path.endsWith("SKILL.md") ? "---\nname: example\ndescription: Test\n---\nBody" : "Resource" }])),
		}), new MemoryEnv());
		await expect(importer.fetchSource("https://github.com/acme/skills/tree/main")).rejects.toThrow("at most 40");
	});

	test("surfaces HTTP failures as errors", async () => {
		const importer = new SkillImporter(stubFetch({ [TREE_API]: { status: 404, body: "nope" } }), new MemoryEnv());
		expect(importer.fetchSource("https://github.com/acme/skills/tree/main")).rejects.toThrow("404");
	});
});

// ── install → update round-trip ─────────────────────────────────────────────

describe("SkillImporter install/update round-trip", () => {
	async function installedEnv(): Promise<{ env: MemoryEnv; importer: SkillImporter; routes: Record<string, StubRoute> }> {
		const env = new MemoryEnv();
		const routes: Record<string, StubRoute> = {
			[TREE_API]: { body: treeResponse([
				{ path: "skills/summarize/SKILL.md", type: "blob", size: 30 },
				{ path: "skills/summarize/refs.md", type: "blob", size: 10 },
			], "tree-1") },
			"https://raw.githubusercontent.com/acme/skills/main/skills/summarize/SKILL.md": { body: "---\nname: Summarize\n---\nbody" },
			"https://raw.githubusercontent.com/acme/skills/main/skills/summarize/refs.md": { body: "refs" },
		};
		const importer = new SkillImporter(stubFetch(routes), env);
		const source = await importer.fetchSource("https://github.com/acme/skills/tree/main/skills");
		const skill = source.skills[0];
		if (!skill) {
			throw new Error("expected one skill");
		}
		await importer.installSkill(source, skill);
		return { env, importer, routes };
	}

	test("install writes files and a readable sidecar", async () => {
		const { env } = await installedEnv();
		expect(env.read("/Piem/skills/summarize/SKILL.md")).toContain("Summarize");
		const provenance = parseProvenance(env.read(`/Piem/skills/summarize/${SIDECAR_FILENAME}`));
		expect(provenance?.treeSha).toBe("tree-1");
		expect(Object.keys(provenance?.files ?? {}).sort()).toEqual(["SKILL.md", "refs.md"]);
	});

	test("pristine install plans a clean update when upstream moves", async () => {
		const { env, importer, routes } = await installedEnv();
		routes[TREE_API] = { body: treeResponse([
			{ path: "skills/summarize/SKILL.md", type: "blob", size: 40 },
			{ path: "skills/summarize/refs.md", type: "blob", size: 10 },
		], "tree-2") };
		routes["https://raw.githubusercontent.com/acme/skills/main/skills/summarize/SKILL.md"] = { body: "---\nname: Summarize\n---\nupdated body" };

		const provenance = await importer.readProvenance("summarize");
		if (!provenance) {
			throw new Error("sidecar missing after install");
		}
		const { source, skill, plan } = await importer.planUpdateFor("summarize", provenance);
		expect(plan).toEqual({ status: "changed", hasConflicts: false, entries: [{ path: "SKILL.md", action: "update" }] });
		await importer.applyUpdate("summarize", source, skill, plan);
		expect(env.read("/Piem/skills/summarize/SKILL.md")).toContain("updated body");
		const updated = parseProvenance(env.read(`/Piem/skills/summarize/${SIDECAR_FILENAME}`));
		expect(updated?.treeSha).toBe("tree-2");
	});

	test("a local edit turns the update into a conflict and applyUpdate refuses", async () => {
		const { env, importer, routes } = await installedEnv();
		env.writeText("/Piem/skills/summarize/SKILL.md", "user edit");
		routes[TREE_API] = { body: treeResponse([{ path: "skills/summarize/SKILL.md", type: "blob", size: 40 }], "tree-2") };
		routes["https://raw.githubusercontent.com/acme/skills/main/skills/summarize/SKILL.md"] = { body: "upstream new" };

		const provenance = await importer.readProvenance("summarize");
		if (!provenance) {
			throw new Error("sidecar missing after install");
		}
		const { source, skill, plan } = await importer.planUpdateFor("summarize", provenance);
		expect(plan.status).toBe("changed");
		if (plan.status === "changed") {
			expect(plan.hasConflicts).toBe(true);
		}
		expect(importer.applyUpdate("summarize", source, skill, plan)).rejects.toThrow("conflict");
		// The user's edit is still on disk.
		expect(env.read("/Piem/skills/summarize/SKILL.md")).toBe("user edit");
	});

	test("unchanged downloaded files report up-to-date", async () => {
		const { importer } = await installedEnv();
		const provenance = await importer.readProvenance("summarize");
		if (!provenance) {
			throw new Error("sidecar missing after install");
		}
		const { plan } = await importer.planUpdateFor("summarize", provenance);
		expect(plan).toEqual({ status: "up-to-date" });
	});

	test("updates an existing single-folder import using its skill name and keeps its directory", async () => {
		const env = new MemoryEnv();
		const body = "---\nname: example\ndescription: Test\n---\nBody";
		const url = "https://github.com/acme/skills/tree/main/skills/example";
		const routes = stubFetch({
			[TREE_API]: { body: treeResponse([{ path: "skills/example/SKILL.md", type: "blob", size: 80 }, { path: "skills/example/references/detail.md", type: "blob", size: 10 }]) },
			"https://raw.githubusercontent.com/acme/skills/main/skills/example/SKILL.md": { body },
			"https://raw.githubusercontent.com/acme/skills/main/skills/example/references/detail.md": { body: "reference" },
		});
		const importer = new SkillImporter(routes, env);
		const oldSkill = { name: "example", dirName: "skill", description: "Test", files: [{ path: "SKILL.md", content: body }] };
		await importer.installSkill({ kind: "github-tree", url, treeSha: "tree-1", skills: [oldSkill], notes: [] }, oldSkill);
		const provenance = await importer.readProvenance("skill");
		if (!provenance) throw new Error("Missing provenance");
		const { source, skill, plan } = await importer.planUpdateFor("skill", provenance);
		await importer.applyUpdate("skill", source, skill, plan);
		expect(env.read("/Piem/skills/skill/references/detail.md")).toBe("reference");
		expect(env.read("/Piem/skills/example/SKILL.md")).toBeUndefined();
	});

	test("propagates failed writes instead of recording a successful import", async () => {
		const env = new MemoryEnv();
		env.writeFile = async (path) => err(new FileError("permission_denied", "Read-only vault", path));
		const importer = new SkillImporter(stubFetch({}), env);
		const skill = { dirName: "example", name: "example", description: "Test", files: [{ path: "SKILL.md", content: "body" }] };
		await expect(importer.installSkill({ kind: "raw", url: "https://example.com/skill.md", skills: [skill], notes: [] }, skill)).rejects.toThrow("Read-only vault");
		expect(env.read(`/Piem/skills/example/${SIDECAR_FILENAME}`)).toBeUndefined();
	});

	test("keeps the prior provenance when an update write fails", async () => {
		const { env, importer, routes } = await installedEnv();
		const sidecarPath = `/Piem/skills/summarize/${SIDECAR_FILENAME}`;
		const before = env.read(sidecarPath);
		const provenance = await importer.readProvenance("summarize");
		if (!provenance) throw new Error("Missing provenance");
		routes[TREE_API] = { body: treeResponse([{ path: "skills/summarize/SKILL.md", type: "blob", size: 20 }], "tree-2") };
		routes["https://raw.githubusercontent.com/acme/skills/main/skills/summarize/SKILL.md"] = { body: "new body" };
		const { source, skill, plan } = await importer.planUpdateFor("summarize", provenance);
		env.writeFile = async (path) => err(new FileError("permission_denied", "Read-only vault", path));
		await expect(importer.applyUpdate("summarize", source, skill, plan)).rejects.toThrow("Read-only vault");
		expect(env.read(sidecarPath)).toBe(before);
	});
});
