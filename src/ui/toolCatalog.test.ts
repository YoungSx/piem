import { describe, expect, it } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import type { App } from "obsidian";
import { getT } from "../i18n";
import { zhCN } from "../i18n/zhCN";
import { installObsidianStub } from "../testUtils/obsidianStub";
import { GENERIC_TOOL_ICON, TOOL_CATALOG, categorizeTool, toolCopyKey, toolIcon } from "./toolCatalog";

installObsidianStub();

// Dynamic imports so the stubbed `obsidian` module wins over any cached real one.
const { createObsidianTools } = await import("../tools/obsidianTools");
const { createVaultHarnessContext } = await import("../vault/harnessAdapter");
const { DEFAULT_SETTINGS } = await import("../settings");
const { AskUserBroker } = await import("../tools/askUserBroker");
const { createSubagentExtension } = await import("../subagent/extension");

const MODEL = { id: "test-model", api: "openai-completions", provider: "test", contextWindow: 128_000, maxTokens: 4_096 } as unknown as Model<string>;

/**
 * Every tool id the plugin actually hands a model.
 *
 * Built from the real factories rather than listed here, which is the whole
 * point: a tool added to `createObsidianTools` or to the delegation five turns
 * up in this array on its own, and the two tests below go red until the catalog
 * has been taught it. A hand-written list would have to be kept in step with
 * the catalog by the same person who forgot the catalog.
 *
 * Both optional deps are supplied so the two conditional tools (`read_skill`,
 * `ask_user`) are present; `createVaultTools` returns nothing so the extension
 * contributes only its own five.
 */
function shippedToolIds(): string[] {
	const app = {} as App;
	const settings = { ...DEFAULT_SETTINGS, networkTransport: "requestUrl" as const };
	const vaultTools = createObsidianTools(app, createVaultHarnessContext(app).env, settings, {
		getSkills: () => [],
		askUserBroker: new AskUserBroker(),
	});
	const extension = createSubagentExtension({
		createVaultTools: () => [],
		getModel: () => MODEL,
		getStreamFn: () => {
			throw new Error("this test builds tools, it never runs a child");
		},
		getThinkingLevel: () => "off" as never,
		getSkills: () => [],
	});
	try {
		return [...vaultTools, ...extension.createTools()].map((tool) => tool.name);
	} finally {
		extension.disposeAll();
	}
}

/** Reads a dotted copy path out of a partial translation tree. */
function leaf(tree: unknown, path: string): unknown {
	return path
		.split(".")
		.reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), tree);
}

describe("TOOL_CATALOG", () => {
	it("has an entry for every tool the plugin ships", () => {
		const missing = shippedToolIds().filter((id) => !(id in TOOL_CATALOG));

		expect(missing).toEqual([]);
	});

	/*
	 * The other direction, which the first test cannot see: an entry for a tool
	 * that was renamed or removed keeps a name and a glyph alive for a row that
	 * will never be drawn, and reads as coverage while providing none.
	 */
	it("ships every tool it has an entry for", () => {
		const shipped = new Set(shippedToolIds());
		const stale = Object.keys(TOOL_CATALOG).filter((id) => !shipped.has(id));

		expect(stale).toEqual([]);
	});

	/*
	 * `zhCN` is a partial tree that falls back to English, so a missing Chinese
	 * name renders as the English sentence rather than as a visible gap — which
	 * means asking the translator would pass on a key nobody translated. This
	 * reads the tree itself.
	 */
	it("names every tool in both languages", () => {
		const en = getT("en");
		const untranslated = Object.values(TOOL_CATALOG).filter((facts) => typeof leaf(zhCN, facts.copyKey) !== "string");

		expect(untranslated).toEqual([]);
		for (const facts of Object.values(TOOL_CATALOG)) {
			expect(en.t(facts.copyKey)).not.toBe(facts.copyKey);
		}
	});
});

describe("toolIcon", () => {
	/*
	 * The three used to be one glyph, and their copy already said which had run.
	 * A reader's question about a search row is which kind of search it was.
	 */
	it("tells the three ways of looking for something apart", () => {
		const glyphs = [toolIcon("ls"), toolIcon("find"), toolIcon("grep")];

		expect(new Set(glyphs).size).toBe(3);
	});

	// Both read a note's words, which is what an eye is for. The tools that read
	// its structure keep glyphs of their own.
	it("gives one eye to both tools that read a note's body", () => {
		expect(toolIcon("read")).toBe("eye");
		expect(toolIcon("get_active_note")).toBe("eye");
		expect(toolIcon("get_note_links")).not.toBe("eye");
		expect(toolIcon("get_note_metadata")).not.toBe("eye");
	});

	it("falls back to the generic wrench for a tool it has never been taught", () => {
		expect(toolIcon("mcp__linear__create_issue")).toBe(GENERIC_TOOL_ICON);
	});
});

describe("toolCopyKey", () => {
	it("returns null for a tool it has never been taught, so the row shows the raw id", () => {
		expect(toolCopyKey("mcp__linear__create_issue")).toBeNull();
	});
});

describe("categorizeTool", () => {
	it("groups the vault tools by what the reader would say they did", () => {
		expect(categorizeTool("read")).toBe("read");
		expect(categorizeTool("get_note_links")).toBe("read");
		expect(categorizeTool("grep")).toBe("search");
		expect(categorizeTool("ls")).toBe("search");
		expect(categorizeTool("edit")).toBe("write");
		expect(categorizeTool("trash_note")).toBe("write");
		expect(categorizeTool("web_fetch")).toBe("web");
		expect(categorizeTool("spawn_subagent")).toBe("subagent");
	});

	// It rides the editor rather than the vault API, which is why the plugin files
	// it with the screen tools — but what it does to the reader's note is write to
	// it, and that is what the folded line is reporting.
	it("counts an insert at the cursor as a change to the note", () => {
		expect(categorizeTool("insert_at_cursor")).toBe("write");
	});

	it("falls back to the honest bucket for a tool it has never been taught", () => {
		expect(categorizeTool("mcp__linear__create_issue")).toBe("other");
		expect(categorizeTool("notify")).toBe("other");
		expect(categorizeTool("list_tasks")).toBe("other");
	});
});
