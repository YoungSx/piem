import { describe, expect, it } from "bun:test";
import { installObsidianStub } from "../testUtils/obsidianStub";
import { searchVault } from "../testUtils/searchVault";
import { createCodemodeTool } from "./tool";

installObsidianStub();
const { createGrepTool } = await import("../tools/grepTool");
const { createNoteSearchTool } = await import("../tools/noteSearchTool");

describe("search declarations in Code Mode", () => {
	it("carries the real paging and note query schemas into script declarations", () => {
		const { app } = searchVault([]);
		const tools = [createGrepTool(app), createNoteSearchTool(app)];
		const code = createCodemodeTool(() => ({ tools: () => tools, executeTool: async () => { throw new Error("Declarations only"); } }), { mode: "only" });
		expect(code.description).toContain("grep(args:");
		expect(code.description).toContain("offset?: number");
		expect(code.description).toContain("search_notes(args:");
		expect(code.description).toContain("query: string");
		expect(code.description).toContain("maxResults?: number");
		expect(code.description).toContain("32 distinct terms");
	});
});
