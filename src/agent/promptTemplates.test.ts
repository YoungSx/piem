import { describe, expect, it } from "bun:test";
import { installObsidianStub } from "../testUtils/obsidianStub";
import type { App, TFile, TFolder } from "obsidian";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";

installObsidianStub();

// Dynamic imports so the mocked `obsidian` module wins over any cached real one.
// Runtime classes come from the mocked module; types stay type-only.
const { TFile: TFileClass, TFolder: TFolderClass } = await import("obsidian");
const { loadVaultPromptTemplates, parsePromptCommand, expandPromptTemplate, findPromptTemplate, VAULT_PROMPT_TEMPLATES_DIR } = await import(
	"./promptTemplates"
);
const { BUILTIN_PROMPT_TEMPLATES } = await import("./builtinTemplates");
const { VaultExecutionEnv } = await import("../vault/VaultExecutionEnv");

/*
 * A vault that lives in memory, so a test can stage `Piem/prompts/*.md` files
 * without touching disk. It mirrors the same `App` surface `VaultExecutionEnv`
 * reads through — `getFileByPath` / `getFolderByPath` / `getRoot` / `read` — so
 * the loader exercises the same path normalisation the production env does.
 */
class InMemoryVault {
	private readonly files = new Map<string, TFile>();
	private readonly content = new Map<string, string>();
	private readonly folders = new Map<string, TFolder>();

	constructor() {
		this.ensureFolder("");
	}

	write(path: string, body: string): void {
		const parent = this.ensureFolder(parentOf(path));
		const file = new TFileClass();
		file.path = path;
		file.name = baseName(path);
		file.extension = "md";
		file.stat = { size: body.length, mtime: Date.now(), ctime: Date.now() } as TFile["stat"];
		this.files.set(path, file);
		this.content.set(path, body);
		parent.children.push(file);
	}

	ensureFolder(path: string): TFolder {
		const existing = this.folders.get(path);
		if (existing) {
			return existing;
		}
		const folder = new TFolderClass();
		folder.path = path;
		folder.name = baseName(path) || "/";
		folder.children = [];
		this.folders.set(path, folder);
		if (path !== "") {
			const parent = this.ensureFolder(parentOf(path));
			parent.children.push(folder);
		}
		return folder;
	}

	getFileByPath(path: string): TFile | null {
		return this.files.get(path) ?? null;
	}

	getFolderByPath(path: string): TFolder | null {
		return this.folders.get(path) ?? null;
	}

	getAbstractFileByPath(path: string): TFile | TFolder | null {
		return this.files.get(path) ?? this.folders.get(path) ?? null;
	}

	getRoot(): TFolder {
		return this.folders.get("")!;
	}

	async read(file: TFile): Promise<string> {
		return this.content.get(file.path) ?? "";
	}

	/**
	 * The config directory and dot-folders live outside the index, so the env asks
	 * the adapter whether such a path is a file, a folder, or nothing at all.
	 */
	get adapter() {
		return {
			stat: async (path: string) => {
				const file = this.files.get(path);
				if (file) {
					return { type: "file" as const, ctime: file.stat.ctime, mtime: file.stat.mtime, size: file.stat.size };
				}
				return this.folders.has(path) ? { type: "folder" as const, ctime: 0, mtime: 0, size: 0 } : null;
			},
		};
	}

	asApp(): App {
		return { vault: this } as unknown as App;
	}
}

function parentOf(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}

function baseName(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? path : path.slice(index + 1);
}

/** Stages templates under `Piem/prompts/` and returns an env over them. */
function envWithTemplates(files: Record<string, string>): ExecutionEnv {
	const vault = new InMemoryVault();
	vault.ensureFolder("Piem/prompts");
	for (const [name, body] of Object.entries(files)) {
		vault.write(`Piem/prompts/${name}`, body);
	}
	return new VaultExecutionEnv(vault.asApp());
}

describe("parsePromptCommand", () => {
	it("returns null for an ordinary message, so prose never gets routed as a command", () => {
		expect(parsePromptCommand("summarize this note")).toBeNull();
		expect(parsePromptCommand("  hello world")).toBeNull();
	});

	it("parses a bare command name with no arguments", () => {
		expect(parsePromptCommand("/echo")).toEqual({ name: "echo", args: [], additionalInstructions: "" });
	});

	it("parses a command with a single positional argument", () => {
		expect(parsePromptCommand("/echo hello")).toEqual({ name: "echo", args: ["hello"], additionalInstructions: "hello" });
	});

	it("splits arguments on whitespace", () => {
		expect(parsePromptCommand("/echo hello world")).toEqual({
			name: "echo",
			args: ["hello", "world"],
			additionalInstructions: "hello world",
		});
	});

	it("honours double quotes so a quoted phrase stays one argument", () => {
		expect(parsePromptCommand('/echo hello "world foo"')).toEqual({
			name: "echo",
			args: ["hello", "world foo"],
			additionalInstructions: 'hello "world foo"',
		});
	});

	it("honours single quotes the same way", () => {
		expect(parsePromptCommand("/echo 'a b' c")).toEqual({
			name: "echo",
			args: ["a b", "c"],
			additionalInstructions: "'a b' c",
		});
	});

	it("flags a bare slash as a command with an empty name, leaving usefulness to the caller", () => {
		expect(parsePromptCommand("/")).toEqual({ name: "", args: [], additionalInstructions: "" });
	});

	it("ignores leading whitespace before the slash", () => {
		expect(parsePromptCommand("  /echo hi")).toEqual({ name: "echo", args: ["hi"], additionalInstructions: "hi" });
	});
});

describe("loadVaultPromptTemplates", () => {
	it("loads a template from Piem/prompts with its name, description, and body", async () => {
		const env = envWithTemplates({
			"echo.md": ["---", "description: Echo the arguments back", "---", "", "Echo back: $@"].join("\n"),
		});

		const { templates, diagnostics } = await loadVaultPromptTemplates(env);

		expect(diagnostics).toEqual([]);
		expect(templates).toHaveLength(1);
		expect(templates[0]?.name).toBe("echo");
		expect(templates[0]?.description).toBe("Echo the arguments back");
		expect(templates[0]?.content).toContain("Echo back: $@");
	});

	it("yields no templates and no diagnostics when the vault has no Piem/prompts folder", async () => {
		// A missing folder is the normal first-run state. pi's loader skips
		// not_found paths rather than reporting them, so the result is empty —
		// not an error a panel would have to surface.
		const vault = new InMemoryVault();
		const env = new VaultExecutionEnv(vault.asApp());

		const { templates, diagnostics } = await loadVaultPromptTemplates(env);

		expect(templates).toEqual([]);
		expect(diagnostics).toEqual([]);
	});

	it("looks in a folder Obsidian will actually index", async () => {
		// The defect this pins is a silent one, and it shipped. The folder used to be
		// `.piem/prompts`, and Obsidian does not index dot-directories: every path
		// `VaultExecutionEnv` resolves goes through `getFileByPath` /
		// `getFolderByPath`, both of which return null there, which the env reports
		// as `not_found` — and pi's loader skips a `not_found` path *without a
		// diagnostic*, correctly, since a missing folder is the ordinary state of a
		// vault that defines no templates. The two behaviours composed into silence:
		// no template ever loaded, no warning was ever raised, and the notice this
		// plugin showed about template warnings was unreachable.
		//
		// The in-memory vault below registers any path it is handed, so it cannot
		// reproduce Obsidian's indexing rule — which is exactly why every test here
		// passed against the broken path. So this asserts the constant instead, in
		// the one way a unit test can: no leading dot on any segment.
		expect(VAULT_PROMPT_TEMPLATES_DIR).toBe("/Piem/prompts");
		for (const segment of VAULT_PROMPT_TEMPLATES_DIR.split("/")) {
			expect(segment.startsWith(".")).toBe(false);
		}
	});

	it("reports a warning diagnostic for a template whose frontmatter will not parse", async () => {
		// A `---` fence promises YAML, but an unindented tab-indented mapping key is
		// not valid YAML, so the parser rejects it. The file is skipped, but the
		// loader says why rather than failing silently — the service surfaces the
		// count in a notice.
		const env = envWithTemplates({
			"bad.md": ["---", "description: : :", "---", "", "body"].join("\n"),
		});

		const { templates, diagnostics } = await loadVaultPromptTemplates(env);

		expect(templates).toEqual([]);
		expect(diagnostics.length).toBeGreaterThanOrEqual(1);
		expect(diagnostics[0]?.type).toBe("warning");
	});
});

describe("expandPromptTemplate", () => {
	it("fills $ARGUMENTS with all arguments joined by spaces", () => {
		const template = BUILTIN_PROMPT_TEMPLATES[0];
		if (!template) {
			throw new Error("builtin template missing");
		}
		const expanded = expandPromptTemplate(template, ["one", "two"]);
		expect(expanded).toContain("one two");
	});

	it("leaves the body intact when no arguments are given", async () => {
		const env = envWithTemplates({
			"echo.md": ["---", "description: echo", "---", "", "Echo: $@"].join("\n"),
		});
		const { templates } = await loadVaultPromptTemplates(env);
		const echo = templates[0];
		if (!echo) {
			throw new Error("echo template missing");
		}
		expect(expandPromptTemplate(echo, [])).toBe("Echo: ");
	});
});

describe("findPromptTemplate", () => {
	it("finds a template by exact name", async () => {
		const env = envWithTemplates({
			"echo.md": ["---", "description: echo", "---", "", "Echo: $@"].join("\n"),
		});
		const { templates } = await loadVaultPromptTemplates(env);
		expect(findPromptTemplate(templates, "echo")?.name).toBe("echo");
	});

	it("returns undefined for an unknown name", () => {
		expect(findPromptTemplate([], "nope")).toBeUndefined();
	});
});
