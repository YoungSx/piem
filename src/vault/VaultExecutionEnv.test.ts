import { describe, expect, it } from "bun:test";
import type { FileError } from "@earendil-works/pi-agent-core";
import { installObsidianStub } from "../testUtils/obsidianStub";
import type { App, TFile, TFolder } from "obsidian";

installObsidianStub();

// Dynamic imports so the mocked module wins over any cached real one.
const { TFile: TFileClass, TFolder: TFolderClass } = await import("obsidian");
const { VaultExecutionEnv: VaultExecutionEnvClass } = await import("./VaultExecutionEnv");
const { adaptHarnessTool, createVaultHarnessContext } = await import("./harnessAdapter");
const core = await import("@earendil-works/pi-agent-core");

export interface VaultFixture {
	kind: "file" | "folder";
	path: string;
	content?: string;
	/**
	 * Present on disk but absent from the vault index — how Obsidian treats the
	 * config directory and dot-folders, and the reason a config file used to read
	 * as `not_found`.
	 */
	unindexed?: boolean;
}

/**
 * In-memory stand-in for Obsidian's Vault, following the MemoryAdapter
 * precedent in src/agent/ObsidianAgentService.test.ts. Implements exactly the
 * slice of the Vault API that VaultExecutionEnv touches; every method mutates
 * shared maps so tests can assert on resulting state directly.
 *
 * The one asymmetry it deliberately keeps is index-versus-disk: `getFileByPath`
 * sees only indexed entries, while `adapter` sees everything. Collapsing the two
 * would make the config-directory tests pass against a vault Obsidian does not
 * have.
 */
class MemoryVault {
	private readonly files = new Map<string, { content: string; mtime: number; indexed: boolean }>();
	/** Path → indexed, kept as a map so the adapter's listing can include the rest. */
	private readonly folders = new Map<string, boolean>();
	/** The vault's config directory. A user may rename it, so a test can too. */
	readonly configDir: string;
	/** Paths sent to `fileManager.trashFile`, in order, for assertions. */
	readonly trashed: string[] = [];

	/** Paths sent through the atomic `process` primitive, in order, for assertions. */
	readonly processCalls: string[] = [];

	constructor(fixtures: VaultFixture[] = [], options: { configDir?: string } = {}) {
		this.configDir = options.configDir ?? ".obsidian";
		for (const fixture of fixtures) {
			const indexed = fixture.unindexed !== true;
			if (fixture.kind === "folder") {
				this.registerFolders(fixture.path, indexed);
			} else {
				this.files.set(fixture.path, { content: fixture.content ?? "", mtime: 1_700_000_000_000, indexed });
				this.registerFolders(parentOf(fixture.path), indexed);
			}
		}
	}

	/** Real vaults always expose every ancestor folder; the stub must too. */
	private registerFolders(path: string, indexed: boolean): void {
		let current = "";
		for (const segment of path.split("/")) {
			if (!segment) {
				continue;
			}
			current = current ? `${current}/${segment}` : segment;
			// Once a folder is known to sit outside the index it stays there, so a
			// fixture order that happens to register a parent first cannot promote
			// `.obsidian` into the index.
			this.folders.set(current, indexed && this.folders.get(current) !== false);
		}
	}

	/** Everything the adapter can see, indexed or not. */
	private diskEntry(path: string): { kind: "file"; content: string; mtime: number } | { kind: "folder" } | null {
		const file = this.files.get(path);
		if (file) {
			return { kind: "file", content: file.content, mtime: file.mtime };
		}
		return this.folders.has(path) ? { kind: "folder" } : null;
	}

	private requireDiskFile(path: string): { kind: "file"; content: string; mtime: number } {
		const entry = this.diskEntry(path);
		if (entry?.kind !== "file") {
			throw new Error(`File not found: ${path}`);
		}
		return entry;
	}

	get adapter() {
		return {
			exists: async (path: string): Promise<boolean> => this.diskEntry(path) !== null,
			stat: async (path: string) => {
				const entry = this.diskEntry(path);
				if (!entry) {
					return null;
				}
				return entry.kind === "file"
					? { type: "file" as const, ctime: entry.mtime, mtime: entry.mtime, size: entry.content.length }
					: { type: "folder" as const, ctime: 0, mtime: 0, size: 0 };
			},
			list: async (path: string) => ({
				files: [...this.files.keys()].filter((child) => parentOf(child) === path),
				folders: [...this.folders.keys()].filter((child) => parentOf(child) === path),
			}),
			read: async (path: string): Promise<string> => this.requireDiskFile(path).content,
			readBinary: async (path: string): Promise<ArrayBuffer> =>
				new TextEncoder().encode(this.requireDiskFile(path).content).buffer as ArrayBuffer,
		};
	}

	getName(): string {
		return "Test";
	}

	getFileByPath(path: string): TFile | null {
		const entry = this.files.get(path);
		if (!entry || !entry.indexed) {
			return null;
		}
		const file: TFile = new TFileClass();
		file.path = path;
		file.name = path.split("/").pop() ?? path;
		file.stat = { ctime: entry.mtime, mtime: entry.mtime, size: entry.content.length };
		return file;
	}

	getFolderByPath(path: string): TFolder | null {
		if (this.folders.get(path) !== true) {
			return null;
		}
		const folder: TFolder = new TFolderClass();
		folder.path = path;
		folder.name = path.split("/").pop() ?? path;
		folder.children = [
			...[...this.files.keys()].filter((filePath) => parentOf(filePath) === path).map((filePath) => this.getFileByPath(filePath)!),
			...[...this.folders.keys()].filter((folderPath) => parentOf(folderPath) === path).map((folderPath) => this.getFolderByPath(folderPath)!),
		];
		return folder;
	}

	getAbstractFileByPath(path: string): TFile | TFolder | null {
		return this.getFileByPath(path) ?? this.getFolderByPath(path);
	}

	getRoot(): TFolder {
		return this.getFolderByPath("") ?? this.getFolderByPath("/") ?? emptyRoot();
	}

	async read(file: TFile): Promise<string> {
		return this.requireEntry(file.path).content;
	}

	async create(path: string, data: string): Promise<TFile> {
		if (this.files.has(path)) {
			throw new Error(`File already exists: ${path}`);
		}
		await this.createParentFolders(path);
		this.files.set(path, { content: data, mtime: Date.now(), indexed: true });
		return this.getFileByPath(path)!;
	}

	async modify(file: TFile, data: string): Promise<void> {
		this.requireEntry(file.path);
		this.files.set(file.path, { content: data, mtime: Date.now(), indexed: true });
	}

	/**
	 * Mirrors Obsidian's atomic read-modify-write: the callback receives the
	 * content read at operation time, and a throw from it rejects the whole
	 * call without writing anything.
	 */
	async process<T>(file: TFile, fn: (data: string) => T): Promise<T> {
		const entry = this.requireEntry(file.path);
		this.processCalls.push(file.path);
		const result = fn(entry.content);
		entry.content = result as unknown as string;
		entry.mtime = Date.now();
		return result;
	}

	async append(file: TFile, data: string): Promise<void> {
		const entry = this.requireEntry(file.path);
		entry.content += data;
	}

	async readBinary(file: TFile): Promise<ArrayBuffer> {
		const entry = this.requireEntry(file.path);
		return new TextEncoder().encode(entry.content).buffer as ArrayBuffer;
	}

	async createBinary(path: string, _data: ArrayBuffer): Promise<TFile> {
		if (this.files.has(path)) {
			throw new Error(`File already exists: ${path}`);
		}
		await this.createParentFolders(path);
		this.files.set(path, { content: "(binary)", mtime: Date.now(), indexed: true });
		return this.getFileByPath(path)!;
	}

	async rename(file: TFile | TFolder, newPath: string): Promise<void> {
		const from = file.path;
		if (this.files.has(newPath) || this.folders.has(newPath)) {
			throw new Error(`Destination already exists: ${newPath}`);
		}
		await this.createParentFolders(newPath);
		if (this.files.has(from)) {
			const entry = this.files.get(from)!;
			this.files.delete(from);
			this.files.set(newPath, entry);
			return;
		}
		if (!this.folders.delete(from)) {
			throw new Error(`File not found: ${from}`);
		}
		this.folders.set(newPath, true);
		for (const [filePath, entry] of [...this.files.entries()]) {
			if (filePath.startsWith(`${from}/`)) {
				this.files.delete(filePath);
				this.files.set(`${newPath}${filePath.slice(from.length)}`, entry);
			}
		}
	}

	async delete(target: TFile | TFolder, force: boolean): Promise<void> {
		void force;
		this.removeFromMaps(target.path);
	}

	async trashFile(target: TFile | TFolder): Promise<void> {
		this.trashed.push(target.path);
		this.removeFromMaps(target.path);
	}

	private removeFromMaps(path: string): void {
		if (this.files.has(path)) {
			this.files.delete(path);
			return;
		}
		if (!this.folders.delete(path)) {
			throw new Error(`Missing file: ${path}`);
		}
		for (const filePath of [...this.files.keys()]) {
			if (filePath.startsWith(`${path}/`)) {
				this.files.delete(filePath);
			}
		}
		for (const folderPath of [...this.folders.keys()]) {
			if (folderPath.startsWith(`${path}/`)) {
				this.folders.delete(folderPath);
			}
		}
	}

	async createFolder(path: string): Promise<TFolder> {
		if (this.folders.has(path)) {
			throw new Error(`Folder already exists: ${path}`);
		}
		this.folders.set(path, true);
		return this.getFolderByPath(path)!;
	}

	readText(path: string): string | undefined {
		return this.files.get(path)?.content;
	}

	hasFile(path: string): boolean {
		return this.files.has(path);
	}

	private requireEntry(path: string): { content: string; mtime: number } {
		const entry = this.files.get(path);
		if (!entry) {
			throw new Error(`File not found: ${path}`);
		}
		return entry;
	}

	private async createParentFolders(path: string): Promise<void> {
		let current = "";
		for (const segment of parentOf(path).split("/")) {
			if (!segment) {
				continue;
			}
			current = current ? `${current}/${segment}` : segment;
			this.folders.set(current, true);
		}
	}
}

function emptyRoot(): TFolder {
	const root: TFolder = new TFolderClass();
	root.path = "";
	root.name = "";
	root.children = [];
	return root;
}

function parentOf(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}

function createApp(vault: MemoryVault): App {
	return {
		vault,
		fileManager: {
			trashFile: (target: TFile | TFolder) => vault.trashFile(target),
		},
	} as unknown as App;
}

describe("VaultExecutionEnv", () => {
	it("maps absolute environment paths onto vault-relative reads", async () => {
		const vault = new MemoryVault([{ kind: "file", path: "Notes/Idea.md", content: "hello" }]);
		const env = new VaultExecutionEnvClass(createApp(vault));

		const result = await env.readTextFile("/Notes/Idea.md");

		expect(result.ok).toBe(true);
		expect((result as { value: string }).value).toBe("hello");
	});

	it("resolves relative paths against cwd /", async () => {
		const vault = new MemoryVault([{ kind: "file", path: "Notes/Idea.md", content: "body" }]);
		const env = new VaultExecutionEnvClass(createApp(vault));

		expect(((await env.absolutePath("Notes/Idea.md")) as { value: string }).value).toBe("/Notes/Idea.md");
	});

	it("rejects traversal and plugin-internals paths through the shared guard", async () => {
		const vault = new MemoryVault([]);
		const env = new VaultExecutionEnvClass(createApp(vault));

		const escape = await env.readTextFile("/../outside.md");
		expect(escape.ok).toBe(false);

		const internals = await env.writeFile(`/.${"obsidian"}/plugins/piem/main.js`, "x");
		expect(internals.ok).toBe(false);
	});

	it("reports missing files as not_found without throwing", async () => {
		const vault = new MemoryVault([]);
		const env = new VaultExecutionEnvClass(createApp(vault));

		const result = await env.fileInfo("/Notes/Missing.md");
		expect(result.ok).toBe(false);
		expect(((result as { error: FileError }).error.code)).toBe("not_found");
	});

	it("writeFile creates parents and overwrites existing notes through the atomic process primitive", async () => {
		const vault = new MemoryVault([{ kind: "file", path: "Notes/Existing.md", content: "old" }]);
		const env = new VaultExecutionEnvClass(createApp(vault));

		const write = await env.writeFile("/Notes/New Folder/Draft.md", "fresh");
		expect(write.ok).toBe(true);
		expect(vault.readText("Notes/New Folder/Draft.md")).toBe("fresh");

		const overwrite = await env.writeFile("/Notes/Existing.md", "new");
		expect(overwrite.ok).toBe(true);
		expect(vault.readText("Notes/Existing.md")).toBe("new");
	});

	it("refuses to write over a folder with is_directory", async () => {
		const vault = new MemoryVault([{ kind: "folder", path: "Archive" }]);
		const env = new VaultExecutionEnvClass(createApp(vault));

		const result = await env.writeFile("/Archive", "nope");
		expect(result.ok).toBe(false);
		expect(((result as { error: FileError }).error.code)).toBe("is_directory");
	});

	it("lists direct children of a folder", async () => {
		const vault = new MemoryVault([
			{ kind: "file", path: "Notes/a.md" },
			{ kind: "file", path: "Notes/sub/b.md" },
			{ kind: "folder", path: "Notes/sub" },
		]);
		const env = new VaultExecutionEnvClass(createApp(vault));

		const listing = await env.listDir("/Notes");
		expect(listing.ok).toBe(true);
		const entries = (listing as { value: Array<{ name: string; kind: string }> }).value;
		expect(entries.map((entry) => `${entry.name}:${entry.kind}`)).toEqual(["a.md:file", "sub:directory"]);
	});

	it("returns the same path from canonicalPath because the vault has no symlinks", async () => {
		const vault = new MemoryVault([{ kind: "file", path: "Notes/a.md" }]);
		const env = new VaultExecutionEnvClass(createApp(vault));

		const canonical = await env.canonicalPath("/Notes/a.md");
		expect((canonical as { value: string }).value).toBe("/Notes/a.md");

		const missing = await env.canonicalPath("/Notes/missing.md");
		expect(missing.ok).toBe(false);
	});

	it("stubs shell exec with an explicit unavailable error", async () => {
		const vault = new MemoryVault([]);
		const env = new VaultExecutionEnvClass(createApp(vault));

		const result = await env.exec("ls -la");
		expect(result.ok).toBe(false);
		const failure = (result as { error: { code: string; message: string } }).error;
		expect(failure.code).toBe("shell_unavailable");
		expect(failure.message).toContain("Shell is not available in Obsidian");
	});
});

describe("native harness tools over VaultExecutionEnv (issue #16 spike)", () => {
	it("runs pi's native edit tool end-to-end with exact matching on the memory vault", async () => {
		const vault = new MemoryVault([{ kind: "file", path: "Journal/Today.md", content: "# Today\n\nWent for a walk.\n" }]);
		const app = createApp(vault);
		const context = createVaultHarnessContext(app);
		const editTool = adaptHarnessTool(core.createEditTool(), { context });

		const result = await editTool.execute("call-1", {
			path: "/Journal/Today.md",
			edits: [{ oldText: "Went for a walk.", newText: "Ran five miles." }],
		});

		expect(vault.readText("Journal/Today.md")).toBe("# Today\n\nRan five miles.\n");
		expect(result.details?.diff).toContain("Ran five miles.");
	});

	it("fuzzy-matches smart quotes and trailing whitespace through the native edit tool", async () => {
		const vault = new MemoryVault([
			{ kind: "file", path: "Quotes.md", content: 'She said “hello there”   \nuntouched line\n' },
		]);
		const context = createVaultHarnessContext(createApp(vault));
		const editTool = adaptHarnessTool(core.createEditTool(), { context });

		const result = await editTool.execute("call-2", {
			path: "/Quotes.md",
			edits: [{ oldText: 'She said "hello there"', newText: 'She said "hi"' }],
		});

		expect(result.content[0]).toEqual({ type: "text", text: "Successfully replaced 1 block(s) in /Quotes.md." });
		// Untouched line keeps its trailing whitespace; only matched lines are rewritten.
		expect(vault.readText("Quotes.md")).toBe('She said "hi"\nuntouched line\n');
	});

	it("preserves CRLF endings across a native edit", async () => {
		const vault = new MemoryVault([{ kind: "file", path: "Windows.md", content: "line one\r\nline two\r\n" }]);
		const context = createVaultHarnessContext(createApp(vault));
		const editTool = adaptHarnessTool(core.createEditTool(), { context });

		await editTool.execute("call-3", {
			path: "/Windows.md",
			edits: [{ oldText: "line two", newText: "LINE TWO" }],
		});

		expect(vault.readText("Windows.md")).toBe("line one\r\nLINE TWO\r\n");
	});

	it("round-trips a BOM through a native edit", async () => {
		const bom = "﻿";
		const vault = new MemoryVault([{ kind: "file", path: "Bom.md", content: `${bom}body text\n` }]);
		const context = createVaultHarnessContext(createApp(vault));
		const editTool = adaptHarnessTool(core.createEditTool(), { context });

		await editTool.execute("call-4", {
			path: "/Bom.md",
			edits: [{ oldText: "body text", newText: "body text!" }],
		});

		expect(vault.readText("Bom.md")).toBe(`${bom}body text!\n`);
	});

	it("surfaces a failed match as a thrown error that the agent loop turns into an error toolResult", async () => {
		const vault = new MemoryVault([{ kind: "file", path: "Plain.md", content: "nothing to see\n" }]);
		const context = createVaultHarnessContext(createApp(vault));
		const editTool = adaptHarnessTool(core.createEditTool(), { context });

		let thrown: unknown;
		try {
			await editTool.execute("call-5", {
				path: "/Plain.md",
				edits: [{ oldText: "absent text", newText: "x" }],
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain("Could not find");
		// The file must be untouched after a failed edit.
		expect(vault.readText("Plain.md")).toBe("nothing to see\n");
	});

	it("runs pi's native read tool including image sniffing fallback to text", async () => {
		const vault = new MemoryVault([{ kind: "file", path: "Note.md", content: "alpha\nbeta\ngamma\n" }]);
		const context = createVaultHarnessContext(createApp(vault));
		const readTool = adaptHarnessTool(core.createReadTool(), { context });

		const result = await readTool.execute("call-6", { path: "/Note.md", offset: 2, limit: 1 });
		expect((result.content[0] as { text: string }).text).toContain("beta");
	});

	it("runs pi's native write tool creating nested folders on demand", async () => {
		const vault = new MemoryVault([]);
		const context = createVaultHarnessContext(createApp(vault));
		const writeTool = adaptHarnessTool(core.createWriteTool(), { context });

		const result = await writeTool.execute("call-7", { path: "/Deep/Nested/Note.md", content: "created" });
		expect((result.content[0] as { text: string }).text).toContain("Successfully wrote");
		expect(vault.readText("Deep/Nested/Note.md")).toBe("created");
	});

	it("serializes two concurrent edits to the same note via pi's mutation queue", async () => {
		const vault = new MemoryVault([{ kind: "file", path: "Queue.md", content: "one\ntwo\nthree\n" }]);
		const context = createVaultHarnessContext(createApp(vault));
		const editTool = adaptHarnessTool(core.createEditTool(), { context });

		await Promise.all([
			editTool.execute("q-1", { path: "/Queue.md", edits: [{ oldText: "two", newText: "TWO" }] }),
			editTool.execute("q-2", { path: "/Queue.md", edits: [{ oldText: "three", newText: "THREE" }] }),
		]);

		const finalContent = vault.readText("Queue.md") ?? "";
		expect(finalContent).toContain("TWO");
		expect(finalContent).toContain("THREE");
		expect(finalContent).toContain("one\n");
	});

	it("adapts tools so a low-level Agent turn can execute them end-to-end", async () => {
		const vault = new MemoryVault([{ kind: "file", path: "Loop.md", content: "before edit\n" }]);
		const app = createApp(vault);
		const context = createVaultHarnessContext(app);
		const editTool = adaptHarnessTool(core.createEditTool(), { context });
		const readTool = adaptHarnessTool(core.createReadTool(), { context });
		const writeTool = adaptHarnessTool(core.createWriteTool(), { context });

		// The adapted tools must satisfy the AgentTool contract the agent loop uses:
		// four-parameter execute, schema-carrying parameters.
		expect(typeof editTool.execute).toBe("function");
		expect(editTool.parameters).toBeDefined();

		await writeTool.execute("loop-w", { path: "/Loop2.md", content: "second note\n" }, undefined, undefined);
		await editTool.execute("loop-e", { path: "/Loop.md", edits: [{ oldText: "before", newText: "after" }] }, undefined, undefined);
		const read = await readTool.execute("loop-r", { path: "/Loop.md" }, undefined, undefined);

		expect((read.content[0] as { text: string }).text).toContain("after edit");
		expect(vault.readText("Loop2.md")).toBe("second note\n");
	});
});

describe("write CAS (content ledger, PR-B)", () => {
	it("overwrites existing files through the atomic process primitive", async () => {
		const vault = new MemoryVault([{ kind: "file", path: "Note.md", content: "old" }]);
		const env = new VaultExecutionEnvClass(createApp(vault));

		const result = await env.writeFile("/Note.md", "new");
		expect(result.ok).toBe(true);
		expect(vault.readText("Note.md")).toBe("new");
		expect(vault.processCalls).toEqual(["Note.md"]);
	});

	it("compareAndWriteFile writes when the vault still matches the expectation", async () => {
		const vault = new MemoryVault([{ kind: "file", path: "Note.md", content: "observed" }]);
		const env = new VaultExecutionEnvClass(createApp(vault));

		const result = await env.compareAndWriteFile("/Note.md", "written", "observed");
		expect(result.ok).toBe(true);
		expect(vault.readText("Note.md")).toBe("written");
	});

	it("compareAndWriteFile refuses with an explicit conflict when content moved on, leaving the file untouched", async () => {
		const vault = new MemoryVault([{ kind: "file", path: "Note.md", content: "changed by someone else" }]);
		const env = new VaultExecutionEnvClass(createApp(vault));

		const result = await env.compareAndWriteFile("/Note.md", "stale write", "what I saw earlier");
		expect(result.ok).toBe(false);
		const failure = (result as { error: FileError }).error;
		expect(failure.message).toContain("Write conflict");
		expect(failure.message).toContain("Re-read");
		expect(vault.readText("Note.md")).toBe("changed by someone else");
	});

	it("compareAndWriteFile reports not_found when the observed file vanished", async () => {
		const vault = new MemoryVault([]);
		const env = new VaultExecutionEnvClass(createApp(vault));

		const result = await env.compareAndWriteFile("/Gone.md", "text", "observed");
		expect(result.ok).toBe(false);
		expect((result as { error: { code: string } }).error.code).toBe("not_found");
	});

	it("a stale concurrent write fails loudly instead of silently clobbering the other session", async () => {
		// Two sessions, two ledger views, one shared env — the shape the service
		// builds per conversation. Both observe v1; A writes; B's write must be
		// rejected on its stale baseline, never overwrite A's change.
		const vault = new MemoryVault([{ kind: "file", path: "Shared.md", content: "v1" }]);
		const env = new VaultExecutionEnvClass(createApp(vault));
		const { withContentLedger: ledger } = await import("./contentLedger");
		const sessionA = ledger(env);
		const sessionB = ledger(env);

		await sessionA.readTextFile("/Shared.md");
		await sessionB.readTextFile("/Shared.md");

		const writeA = await sessionA.writeFile("/Shared.md", "v2 from A");
		const writeB = await sessionB.writeFile("/Shared.md", "v2 from B");

		expect(writeA.ok).toBe(true);
		expect(writeB.ok).toBe(false);
		expect((writeB as { error: { message: string } }).error.message).toContain("Write conflict");
		expect(vault.readText("Shared.md")).toBe("v2 from A");
	});

	it("a session may keep writing its own freshly written file without re-reading", async () => {
		const vault = new MemoryVault([]);
		const env = new VaultExecutionEnvClass(createApp(vault));
		const { withContentLedger: ledger } = await import("./contentLedger");
		const session = ledger(env);

		const first = await session.writeFile("/Draft.md", "first");
		const second = await session.writeFile("/Draft.md", "second");

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(vault.readText("Draft.md")).toBe("second");
	});

	it("runs pi's native write tool end-to-end on a stale baseline through the ledger", async () => {
		const vault = new MemoryVault([{ kind: "file", path: "Tool.md", content: "v1" }]);
		const env = new VaultExecutionEnvClass(createApp(vault));
		const { withContentLedger: ledger } = await import("./contentLedger");
		const writeTool = adaptHarnessTool(core.createWriteTool(), { context: { env: ledger(env) } });

		await writeTool.execute("cas-r", { path: "/Tool.md", content: "v1" });
		// Someone else edits after the model's read.
		await vault.modify(vault.getFileByPath("Tool.md")!, "edited elsewhere");
		vault.processCalls.length = 0;

		let thrown: unknown;
		try {
			await writeTool.execute("cas-c", { path: "/Tool.md", content: "full overwrite from stale read" });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain("Write conflict");
		expect(vault.readText("Tool.md")).toBe("edited elsewhere");
	});

	it("runs pi's native edit tool end-to-end through the ledger", async () => {
		const vault = new MemoryVault([{ kind: "file", path: "LedgerEdit.md", content: "alpha\nbeta\n" }]);
		const env = new VaultExecutionEnvClass(createApp(vault));
		const { withContentLedger: ledger } = await import("./contentLedger");
		const editTool = adaptHarnessTool(core.createEditTool(), { context: { env: ledger(env) } });

		const result = await editTool.execute("cas-e", {
			path: "/LedgerEdit.md",
			edits: [{ oldText: "beta", newText: "BETA" }],
		});
		expect((result.content[0] as { text: string }).text).toContain("Successfully replaced");
		expect(vault.readText("LedgerEdit.md")).toBe("alpha\nBETA\n");
	});
});

describe("write CAS (content ledger, PR-B)", () => {
	it("overwrites existing files through the atomic process primitive", async () => {
		const vault = new MemoryVault([{ kind: "file", path: "Note.md", content: "old" }]);
		const env = new VaultExecutionEnvClass(createApp(vault));

		const result = await env.writeFile("/Note.md", "new");
		expect(result.ok).toBe(true);
		expect(vault.readText("Note.md")).toBe("new");
		expect(vault.processCalls).toEqual(["Note.md"]);
	});

	it("compareAndWriteFile writes when the vault still matches the expectation", async () => {
		const vault = new MemoryVault([{ kind: "file", path: "Note.md", content: "observed" }]);
		const env = new VaultExecutionEnvClass(createApp(vault));

		const result = await env.compareAndWriteFile("/Note.md", "written", "observed");
		expect(result.ok).toBe(true);
		expect(vault.readText("Note.md")).toBe("written");
	});

	it("compareAndWriteFile refuses with an explicit conflict when content moved on, leaving the file untouched", async () => {
		const vault = new MemoryVault([{ kind: "file", path: "Note.md", content: "changed by someone else" }]);
		const env = new VaultExecutionEnvClass(createApp(vault));

		const result = await env.compareAndWriteFile("/Note.md", "stale write", "what I saw earlier");
		expect(result.ok).toBe(false);
		const failure = (result as { error: FileError }).error;
		expect(failure.message).toContain("Write conflict");
		expect(failure.message).toContain("Re-read");
		expect(vault.readText("Note.md")).toBe("changed by someone else");
	});

	it("compareAndWriteFile reports not_found when the observed file vanished", async () => {
		const vault = new MemoryVault([]);
		const env = new VaultExecutionEnvClass(createApp(vault));

		const result = await env.compareAndWriteFile("/Gone.md", "text", "observed");
		expect(result.ok).toBe(false);
		expect((result as { error: { code: string } }).error.code).toBe("not_found");
	});

	it("a stale concurrent write fails loudly instead of silently clobbering the other session", async () => {
		// Two sessions, two ledger views, one shared env — the shape the service
		// builds per conversation. Both observe v1; A writes; B's write must be
		// rejected on its stale baseline, never overwrite A's change.
		const vault = new MemoryVault([{ kind: "file", path: "Shared.md", content: "v1" }]);
		const env = new VaultExecutionEnvClass(createApp(vault));
		const { withContentLedger: ledger } = await import("./contentLedger");
		const sessionA = ledger(env);
		const sessionB = ledger(env);

		await sessionA.readTextFile("/Shared.md");
		await sessionB.readTextFile("/Shared.md");

		const writeA = await sessionA.writeFile("/Shared.md", "v2 from A");
		const writeB = await sessionB.writeFile("/Shared.md", "v2 from B");

		expect(writeA.ok).toBe(true);
		expect(writeB.ok).toBe(false);
		expect((writeB as { error: { message: string } }).error.message).toContain("Write conflict");
		expect(vault.readText("Shared.md")).toBe("v2 from A");
	});

	it("a session may keep writing its own freshly written file without re-reading", async () => {
		const vault = new MemoryVault([]);
		const env = new VaultExecutionEnvClass(createApp(vault));
		const { withContentLedger: ledger } = await import("./contentLedger");
		const session = ledger(env);

		const first = await session.writeFile("/Draft.md", "first");
		const second = await session.writeFile("/Draft.md", "second");

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(vault.readText("Draft.md")).toBe("second");
	});

	it("runs pi's native write tool end-to-end on a stale baseline through the ledger", async () => {
		const vault = new MemoryVault([{ kind: "file", path: "Tool.md", content: "v1" }]);
		const env = new VaultExecutionEnvClass(createApp(vault));
		const { withContentLedger: ledger } = await import("./contentLedger");
		const writeTool = adaptHarnessTool(core.createWriteTool(), { context: { env: ledger(env) } });

		await writeTool.execute("cas-r", { path: "/Tool.md", content: "v1" });
		// Someone else edits after the model's read.
		await vault.modify(vault.getFileByPath("Tool.md")!, "edited elsewhere");
		vault.processCalls.length = 0;

		let thrown: unknown;
		try {
			await writeTool.execute("cas-c", { path: "/Tool.md", content: "full overwrite from stale read" });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain("Write conflict");
		expect(vault.readText("Tool.md")).toBe("edited elsewhere");
	});

	it("runs pi's native edit tool end-to-end through the ledger", async () => {
		const vault = new MemoryVault([{ kind: "file", path: "LedgerEdit.md", content: "alpha\nbeta\n" }]);
		const env = new VaultExecutionEnvClass(createApp(vault));
		const { withContentLedger: ledger } = await import("./contentLedger");
		const editTool = adaptHarnessTool(core.createEditTool(), { context: { env: ledger(env) } });

		const result = await editTool.execute("cas-e", {
			path: "/LedgerEdit.md",
			edits: [{ oldText: "beta", newText: "BETA" }],
		});
		expect((result.content[0] as { text: string }).text).toContain("Successfully replaced");
		expect(vault.readText("LedgerEdit.md")).toBe("alpha\nBETA\n");
	});
});

describe("config directory: readable, never writable", () => {
	/**
	 * A vault whose config directory is on disk but not in the index — the shape
	 * Obsidian actually has, and the one that made `read .obsidian/app.json`
	 * answer `not_found` while the file sat right there.
	 */
	const configFixtures: VaultFixture[] = [
		{ kind: "folder", path: ".obsidian", unindexed: true },
		{ kind: "folder", path: ".obsidian/plugins", unindexed: true },
		{ kind: "folder", path: ".obsidian/plugins/piem", unindexed: true },
		{ kind: "file", path: ".obsidian/app.json", content: '{"theme":"moonstone"}', unindexed: true },
		{ kind: "file", path: ".obsidian/plugins/piem/data.json", content: '{"apiKey":"sk-secret"}', unindexed: true },
	];

	it("reads a config file the vault index does not know", async () => {
		const env = new VaultExecutionEnvClass(createApp(new MemoryVault(configFixtures)));

		const result = await env.readTextFile("/.obsidian/app.json");

		expect(result.ok).toBe(true);
		expect((result as { value: string }).value).toBe('{"theme":"moonstone"}');
	});

	it("lists the config directory through the adapter", async () => {
		const env = new VaultExecutionEnvClass(createApp(new MemoryVault(configFixtures)));

		const listing = await env.listDir("/.obsidian");

		expect(listing.ok).toBe(true);
		const entries = (listing as { value: Array<{ name: string; kind: string; size: number }> }).value;
		expect(entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(["file:app.json", "directory:plugins"]);
		expect(entries.find((entry) => entry.name === "app.json")?.size).toBe('{"theme":"moonstone"}'.length);
	});

	it("reports file info for a config file", async () => {
		const env = new VaultExecutionEnvClass(createApp(new MemoryVault(configFixtures)));

		const info = await env.fileInfo("/.obsidian/app.json");

		expect(info.ok).toBe(true);
		const entry = (info as { value: { name: string; kind: string; size: number } }).value;
		expect(`${entry.kind}:${entry.name}`).toBe("file:app.json");
		expect(entry.size).toBe('{"theme":"moonstone"}'.length);
	});

	it("runs pi's native read tool on a config file end-to-end", async () => {
		const context = createVaultHarnessContext(createApp(new MemoryVault(configFixtures)));
		const readTool = adaptHarnessTool(core.createReadTool(), { context });

		const result = await readTool.execute("cfg-read", { path: "/.obsidian/app.json" });

		expect((result.content[0] as { text: string }).text).toContain("moonstone");
	});

	it("refuses every mutation of the config directory", async () => {
		const vault = new MemoryVault(configFixtures);
		const env = new VaultExecutionEnvClass(createApp(vault));

		const failures = await Promise.all([
			env.writeFile("/.obsidian/app.json", "{}"),
			env.writeFile("/.obsidian/app.json", new Uint8Array([1, 2, 3])),
			env.appendFile("/.obsidian/app.json", "x"),
			env.compareAndWriteFile("/.obsidian/app.json", "{}", '{"theme":"moonstone"}'),
			env.createDir("/.obsidian/workspace"),
			env.renameFile("/.obsidian/app.json", "/.obsidian/other.json"),
			env.renameFile("/Note.md", "/.obsidian/Note.md"),
			env.remove("/.obsidian/app.json"),
		]);

		for (const failure of failures) {
			expect(failure.ok).toBe(false);
			const error = (failure as { error: { code: string; message: string } }).error;
			expect(error.code).toBe("permission_denied");
			expect(error.message).toContain("read-only");
		}
		expect(vault.readText(".obsidian/app.json")).toBe('{"theme":"moonstone"}');
	});

	it("refuses the native write tool on a config file", async () => {
		const vault = new MemoryVault(configFixtures);
		const context = createVaultHarnessContext(createApp(vault));
		const writeTool = adaptHarnessTool(core.createWriteTool(), { context });

		let thrown: unknown;
		try {
			await writeTool.execute("cfg-write", { path: "/.obsidian/app.json", content: "{}" });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain("read-only");
		expect(vault.readText(".obsidian/app.json")).toBe('{"theme":"moonstone"}');
	});

	it("keeps the plugin's own folder shut even for reading", async () => {
		const env = new VaultExecutionEnvClass(createApp(new MemoryVault(configFixtures)));

		const result = await env.readTextFile("/.obsidian/plugins/piem/data.json");

		expect(result.ok).toBe(false);
		expect((result as { error: { message: string } }).error.message).toContain("plugin internals");
	});

	it("guards by the vault's own configDir, not by the literal .obsidian", async () => {
		// A user can rename the config directory; a hardcoded guard would still
		// read fine and silently stop refusing writes.
		const vault = new MemoryVault(
			[
				{ kind: "folder", path: ".my-config", unindexed: true },
				{ kind: "file", path: ".my-config/app.json", content: '{"theme":"moonstone"}', unindexed: true },
			],
			{ configDir: ".my-config" },
		);
		const env = new VaultExecutionEnvClass(createApp(vault));

		expect((await env.readTextFile("/.my-config/app.json")).ok).toBe(true);
		const write = await env.writeFile("/.my-config/app.json", "{}");
		expect((write as { error: { code: string } }).error.code).toBe("permission_denied");
	});
});

describe("createNativeFileTools registration (issue #20)", () => {
	it("returns read/write/edit tools with the names pi's agent loop expects", async () => {
		const vault = new MemoryVault([{ kind: "file", path: "Note.md", content: "hello\n" }]);
		const { createNativeFileTools: createNative } = await import("./harnessAdapter");
		const core = await import("@earendil-works/pi-agent-core");

		const tools = createNative(createApp(vault), {
			read: () => core.createReadTool(),
			write: () => core.createWriteTool(),
			edit: () => core.createEditTool(),
		});

		expect(tools.map((tool) => tool.name).sort()).toEqual(["edit", "read", "write"]);
		for (const tool of tools) {
			expect(typeof tool.execute).toBe("function");
			expect(tool.parameters).toBeDefined();
		}
	});

	it("serializes concurrent edits across the three tools sharing one env", async () => {
		// Two concurrent edits to the same file through two separate edit tool
		// instances built from createNativeFileTools must not corrupt each other.
		// The shared env instance is what makes pi's mutation queue serialize them.
		const vault = new MemoryVault([{ kind: "file", path: "Shared.md", content: "alpha\nbeta\ngamma\n" }]);
		const { createNativeFileTools: createNative } = await import("./harnessAdapter");
		const core = await import("@earendil-works/pi-agent-core");

		const tools = createNative(createApp(vault), {
			read: () => core.createReadTool(),
			write: () => core.createWriteTool(),
			edit: () => core.createEditTool(),
		});
		const editTool = tools.find((tool) => tool.name === "edit")!;

		await Promise.all([
			editTool.execute("c1", { path: "/Shared.md", edits: [{ oldText: "alpha", newText: "ALPHA" }] }),
			editTool.execute("c2", { path: "/Shared.md", edits: [{ oldText: "beta", newText: "BETA" }] }),
		]);

		const content = vault.readText("Shared.md") ?? "";
		expect(content).toContain("ALPHA");
		expect(content).toContain("BETA");
		expect(content).toContain("gamma");
	});

	it("routes remove through fileManager.trashFile (recoverable, not permanent)", async () => {
		const vault = new MemoryVault([{ kind: "file", path: "Doomed.md", content: "goodbye\n" }]);
		const env = new VaultExecutionEnvClass(createApp(vault));

		const result = await env.remove("/Doomed.md");
		expect(result.ok).toBe(true);
		expect(vault.trashed).toContain("Doomed.md");
		expect(vault.hasFile("Doomed.md")).toBe(false);
	});

	it("renameFile trashes a pre-existing destination before renaming", async () => {
		const vault = new MemoryVault([
			{ kind: "file", path: "Source.md", content: "source\n" },
			{ kind: "file", path: "Dest.md", content: "dest\n" },
		]);
		const env = new VaultExecutionEnvClass(createApp(vault));

		const result = await env.renameFile("/Source.md", "/Dest.md");
		expect(result.ok).toBe(true);
		expect(vault.trashed).toContain("Dest.md");
		expect(vault.readText("Dest.md")).toBe("source\n");
	});
});
