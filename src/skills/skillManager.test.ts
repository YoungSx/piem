import { describe, expect, test } from "bun:test";

import {
	err,
	ExecutionError,
	FileError,
	ok,
	type ExecutionEnv,
	type FileInfo,
	type FileKind,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
} from "@earendil-works/pi-agent-core";

import {
	SIDECAR_FILENAME,
	parseProvenance,
	type SkillProvenance,
} from "./skillImport";
import { SkillManager } from "./skillManager";

/**
 * In-memory {@link ExecutionEnv} with a real directory model.
 *
 * {@link SkillImporter} only ever writes files, so its test can stand in for
 * the vault with a flat map. Listing skills walks the tree, so this one
 * derives directories from file paths: a listable tree, without pretending to
 * be a filesystem in any other respect.
 */
class MemoryFsEnv implements ExecutionEnv {
	readonly cwd = "/vault";

	private readonly files = new Map<string, string>();

	/** Raw map access for arranging state in tests. */
	writeText(path: string, content: string): void {
		this.files.set(path, content);
	}

	/** Raw map access for assertions. */
	read(path: string): string | undefined {
		return this.files.get(path);
	}

	async readTextFile(path: string): Promise<Result<string, FileError>> {
		const content = this.files.get(path);
		return content === undefined ? err(new FileError("not_found", `missing: ${path}`, path)) : ok(content);
	}

	async readTextLines(path: string): Promise<Result<string[], FileError>> {
		const text = await this.readTextFile(path);
		return text.ok ? ok(text.value.split("\n")) : text;
	}

	async readBinaryFile(): Promise<Result<Uint8Array, FileError>> {
		return err(new FileError("not_supported", "unused in tests", this.cwd));
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		this.files.set(path, typeof content === "string" ? content : new TextDecoder().decode(content));
		return ok(undefined);
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
		if (this.files.has(path)) {
			return ok(this.fileInfoFor(path, "file"));
		}
		if (this.dirExists(path)) {
			return ok(this.fileInfoFor(path, "directory"));
		}
		return err(new FileError("not_found", `missing: ${path}`, path));
	}

	async listDir(path: string): Promise<Result<FileInfo[], FileError>> {
		const prefix = `${path === "/" ? "" : path}/`;
		const children = new Map<string, FileKind>();
		for (const file of this.files.keys()) {
			if (!file.startsWith(prefix)) {
				continue;
			}
			const rest = file.slice(prefix.length);
			const [segment, ...nested] = rest.split("/");
			if (!segment) {
				continue;
			}
			children.set(segment, nested.length > 0 ? "directory" : "file");
		}
		if (children.size === 0 && !this.dirExists(path)) {
			return err(new FileError("not_found", `missing: ${path}`, path));
		}
		return ok([...children.entries()].map(([name, kind]) => this.fileInfoFor(`${prefix}${name}`, kind)));
	}

	async remove(path: string, options?: { recursive?: boolean }): Promise<Result<void, FileError>> {
		if (this.files.delete(path)) {
			return ok(undefined);
		}
		if (options?.recursive) {
			const prefix = `${path}/`;
			let removed = false;
			for (const file of [...this.files.keys()]) {
				if (file.startsWith(prefix)) {
					this.files.delete(file);
					removed = true;
				}
			}
			if (!removed && !this.dirExists(path)) {
				return err(new FileError("not_found", `missing: ${path}`, path));
			}
			return ok(undefined);
		}
		return err(new FileError("not_found", `missing: ${path}`, path));
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
		return ok(this.files.has(path) || this.dirExists(path));
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

	async exec(_command: string, _options?: ShellExecOptions): Promise<Result<ShellExecResult, ExecutionError>> {
		throw new Error("unused in tests");
	}

	private fileInfoFor(path: string, kind: FileKind): FileInfo {
		return { name: path.slice(path.lastIndexOf("/") + 1), path, kind, size: this.files.get(path)?.length ?? 0, mtimeMs: 0 };
	}

	private dirExists(path: string): boolean {
		if (path === "/") {
			return true;
		}
		const prefix = `${path}/`;
		for (const file of this.files.keys()) {
			if (file.startsWith(prefix)) {
				return true;
			}
		}
		return false;
	}
}

interface StubRoute {
	status?: number;
	body: string;
}

/** fetch stub keyed by exact URL, same shape as skillImport's tests. */
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

function treeResponse(entries: Array<{ path: string; type: string; size?: number }>, sha: string): string {
	return JSON.stringify({ sha, truncated: false, tree: entries });
}

const SKILL_V1 = "---\nname: Summarize\ndescription: Shortens text\n---\nbody";
const SKILL_V2 = "---\nname: Summarize\ndescription: Shortens text\n---\nupdated body";

/** Installs one skill from a stubbed upstream, the way the panel would. */
async function installedManager(): Promise<{ env: MemoryFsEnv; manager: SkillManager; routes: Record<string, StubRoute> }> {
	const env = new MemoryFsEnv();
	const routes: Record<string, StubRoute> = {
		[TREE_API]: { body: treeResponse([
			{ path: "skills/summarize/SKILL.md", type: "blob", size: 30 },
		], "tree-1") },
		"https://raw.githubusercontent.com/acme/skills/main/skills/summarize/SKILL.md": { body: SKILL_V1 },
	};
	const manager = new SkillManager(stubFetch(routes), env);
	const source = await manager.fetchSource("https://github.com/acme/skills/tree/main/skills");
	const skill = source.skills[0];
	if (!skill) {
		throw new Error("expected one skill");
	}
	await manager.install(source, skill);
	return { env, manager, routes };
}

// ── listSkills ──────────────────────────────────────────────────────────────

describe("SkillManager.listSkills", () => {
	test("an empty vault lists as empty", async () => {
		const manager = new SkillManager(stubFetch({}), new MemoryFsEnv());
		const inventory = await manager.listSkills();
		expect(inventory.rows).toEqual([]);
	});

	test("directory and root-level skills are listed with the right shape", async () => {
		const env = new MemoryFsEnv();
		env.writeText("/Piem/skills/summarize/SKILL.md", SKILL_V1);
		env.writeText("/Piem/skills/summarize/refs.md", "refs");
		env.writeText("/Piem/skills/loose-skill.md", "---\nname: Loose\ndescription: A root file\n---\nbody");
		const provenance: SkillProvenance = {
			url: "https://github.com/acme/skills/tree/main/skills/summarize",
			kind: "github-tree",
			ref: "main",
			treeSha: "tree-1",
			importedAt: "2026-01-01T00:00:00.000Z",
			files: { "SKILL.md": "aa" },
		};
		env.writeText(`/Piem/skills/summarize/${SIDECAR_FILENAME}`, JSON.stringify(provenance));

		const manager = new SkillManager(stubFetch({}), env);
		const { rows } = await manager.listSkills();
		expect(rows).toHaveLength(2);

		const imported = rows.find((row) => row.dirName === "summarize");
		expect(imported?.name).toBe("Summarize");
		expect(imported?.description).toBe("Shortens text");
		expect(imported?.path).toBe("/Piem/skills/summarize/SKILL.md");
		expect(parseProvenance(JSON.stringify(imported?.provenance))?.treeSha).toBe("tree-1");

		const loose = rows.find((row) => row.dirName === "");
		expect(loose?.name).toBe("Loose");
		expect(loose?.provenance).toBeUndefined();
	});
});

// ── update / remove ─────────────────────────────────────────────────────────

describe("SkillManager.update", () => {
	test("a clean upstream change is applied and reported", async () => {
		const { env, manager, routes } = await installedManager();
		routes[TREE_API] = { body: treeResponse([{ path: "skills/summarize/SKILL.md", type: "blob", size: 40 }], "tree-2") };
		routes["https://raw.githubusercontent.com/acme/skills/main/skills/summarize/SKILL.md"] = { body: SKILL_V2 };

		const plan = await manager.update("summarize");
		expect(plan).toEqual({ status: "changed", hasConflicts: false, entries: [{ path: "SKILL.md", action: "update" }] });
		expect(env.read("/Piem/skills/summarize/SKILL.md")).toContain("updated body");
	});

	test("an unchanged upstream reports up-to-date", async () => {
		const { manager } = await installedManager();
		expect(await manager.update("summarize")).toEqual({ status: "up-to-date" });
	});

	test("a local edit surfaces as a conflict and nothing is overwritten", async () => {
		const { env, manager, routes } = await installedManager();
		env.writeText("/Piem/skills/summarize/SKILL.md", "user edit");
		routes[TREE_API] = { body: treeResponse([{ path: "skills/summarize/SKILL.md", type: "blob", size: 40 }], "tree-2") };
		routes["https://raw.githubusercontent.com/acme/skills/main/skills/summarize/SKILL.md"] = { body: "upstream new" };

		const plan = await manager.update("summarize");
		expect(plan.status).toBe("changed");
		if (plan.status === "changed") {
			expect(plan.hasConflicts).toBe(true);
		}
		expect(env.read("/Piem/skills/summarize/SKILL.md")).toBe("user edit");
	});

	test("a hand-authored skill without a sidecar refuses to update", async () => {
		const env = new MemoryFsEnv();
		env.writeText("/Piem/skills/local/SKILL.md", SKILL_V1);
		const manager = new SkillManager(stubFetch({}), env);
		expect(manager.update("local")).rejects.toThrow("import source");
	});
});

describe("SkillManager.remove", () => {
	test("deletes the skill folder including the sidecar", async () => {
		const { env, manager } = await installedManager();
		await manager.remove("summarize");
		expect(env.read("/Piem/skills/summarize/SKILL.md")).toBeUndefined();
		expect(env.read(`/Piem/skills/summarize/${SIDECAR_FILENAME}`)).toBeUndefined();
	});

	test("surfaces a failed removal as an error", async () => {
		const manager = new SkillManager(stubFetch({}), new MemoryFsEnv());
		expect(manager.remove("missing")).rejects.toThrow("missing");
	});
});

// Sanity: the importer still round-trips through the manager's own surface.
describe("SkillManager.install", () => {
	test("writes SKILL.md and the sidecar", async () => {
		const { env } = await installedManager();
		expect(env.read("/Piem/skills/summarize/SKILL.md")).toContain("Summarize");
		expect(parseProvenance(env.read(`/Piem/skills/summarize/${SIDECAR_FILENAME}`))?.url).toBe(
			"https://github.com/acme/skills/tree/main/skills",
		);
	});
});
