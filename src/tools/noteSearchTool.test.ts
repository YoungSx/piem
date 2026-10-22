import { afterAll, describe, expect, it } from "bun:test";
import { installObsidianStub } from "../testUtils/obsidianStub";
import { stubWindowTimers } from "../testUtils/windowStub";
import { searchVault } from "../testUtils/searchVault";
import { DEFAULT_MAX_BYTES } from "../vault/piTruncate";

installObsidianStub();
const restore = stubWindowTimers();
afterAll(restore);
const { createNoteSearchTool } = await import("./noteSearchTool");

describe("search_notes", () => {
	it("ranks a late title and alias over repeated body text after reading every candidate", async () => {
		const { app, reads } = searchVault([
			{ path: "A-log.md", content: "atlas ".repeat(1000), metadata: {} },
			{ path: "Z-Atlas.md", content: "planning", metadata: { frontmatter: { aliases: "Atlas" } } },
			{ path: "B-unrelated.md", content: "something else", metadata: {} },
		]);
		const result = await createNoteSearchTool(app).execute("rank", { query: "Atlas", maxResults: 1 });
		expect(reads).toEqual(["A-log.md", "B-unrelated.md", "Z-Atlas.md"]);
		expect(result.details).toMatchObject({ scannedFiles: 3, candidateFiles: 3, matchedNotes: 2, returnedNotes: 1, truncated: true });
		expect(result.details.matches[0]?.path).toBe("Z-Atlas.md");
		expect(result.details.matches[0]?.fields).toEqual(["title", "aliases"]);
	});

	it("normalizes repeated query terms without changing full-phrase ranking", async () => {
		const { app } = searchVault([{ path: "Atlas.md", content: "nothing", metadata: {} }]);
		const tool = createNoteSearchTool(app);
		const single = await tool.execute("single", { query: "atlas" });
		const repeated = await tool.execute("repeated", { query: " Atlas  ATLAS " });
		expect(repeated.details.query).toBe("atlas");
		expect(repeated.details.matches[0]?.rank).toEqual(single.details.matches[0]?.rank);
	});

	it("counts distinct terms across fields, handles alias arrays and tags, and keeps body evidence", async () => {
		const { app } = searchVault([
			{ path: "Work.md", content: "intro\nretro planning", metadata: { frontmatter: { aliases: ["Atlas"], tags: ["project"] }, tags: [{ tag: "#review", position: {} as never }], headings: [{ heading: "Design", level: 1, position: {} as never }] } },
			{ path: "Atlas.md", content: "Atlas ".repeat(20), metadata: {} },
		]);
		const result = await createNoteSearchTool(app).execute("fields", { query: "  ATLAS atlas  project review design retro " });
		const match = result.details.matches[0]!;
		expect(match.path).toBe("Work.md");
		expect(match.matchedTerms).toEqual(["atlas", "project", "review", "design", "retro"]);
		expect(match.fields).toEqual(["aliases", "headings", "tags", "body"]);
		expect(match.evidence).toEqual({ lineNumber: 2, text: "retro planning" });
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Matched 5/5 terms") });
	});

	it("finds body-only and Chinese terms when metadata is missing, with stable ties", async () => {
		const { app } = searchVault(["中.md", "a.md", "B.md", "A.md"].map((path) => ({ path, content: "nothing\r\n架构设计\r\n" })));
		const result = await createNoteSearchTool(app).execute("chinese", { query: "架构设计" });
		expect(result.details.matches.map((match) => match.path)).toEqual(["A.md", "B.md", "a.md", "中.md"]);
		expect(result.details.metadataMissingCount).toBe(4);
		expect(result.details.matches[0]?.evidence?.lineNumber).toBe(2);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Metadata unavailable for 4") });
	});

	it("scopes Markdown candidates and reports complete no-match coverage", async () => {
		const { app, reads } = searchVault([{ path: "Notes/A.md", content: "atlas" }, { path: "Notes/b.txt", content: "atlas" }, { path: "Other.md", content: "atlas" }]);
		const tool = createNoteSearchTool(app);
		const result = await tool.execute("scope", { query: "atlas", path: "Notes" });
		expect(result.details.matches.map((match) => match.path)).toEqual(["Notes/A.md"]);
		expect(reads).toEqual(["Notes/A.md"]);
		const empty = await tool.execute("none", { query: "missing", path: "Notes/A.md" });
		expect(empty.details).toMatchObject({ scannedFiles: 1, matchedNotes: 0, returnedNotes: 0, truncated: false });
	});

	it("limits complete note records by bytes without reducing scan coverage", async () => {
		const terms = Array.from({ length: 32 }, (_, i) => `词项${i}`);
		const { app } = searchVault(Array.from({ length: 100 }, (_, i) => ({ path: `Note-${i}.md`, content: `${terms.join(" ")} ${"中".repeat(500)}` })));
		const result = await createNoteSearchTool(app).execute("bytes", { query: terms.join(" "), maxResults: 100 });
		expect(result.details).toMatchObject({ candidateFiles: 100, scannedFiles: 100, matchedNotes: 100, truncatedBy: "bytes" });
		expect(result.details.returnedNotes).toBeLessThan(100);
		expect(result.details.matches).toHaveLength(result.details.returnedNotes);
		const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
		expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(text).toContain(`Returned ${result.details.returnedNotes}/100`);
	});

	it("validates normalized queries, limits, scopes, and literal punctuation", async () => {
		const { app } = searchVault([{ path: "A.md", content: "a.b\naxb" }]);
		const tool = createNoteSearchTool(app);
		for (const query of ["", " \n ", "a".repeat(1001), Array.from({ length: 33 }, (_, i) => `t${i}`).join(" ")]) await expect(tool.execute("bad", { query })).rejects.toThrow("query");
		for (const maxResults of [0, 0.5, 101, Infinity]) await expect(tool.execute("bad", { query: "a", maxResults })).rejects.toThrow("maxResults");
		await expect(tool.execute("scope", { query: "a", path: "Missing" })).rejects.toThrow("not found");
		const literal = await tool.execute("literal", { query: "a.b" });
		expect(literal.details.matches[0]?.evidence?.text).toBe("a.b");
	});

	it("stops after an in-flight read aborts, and propagates read errors", async () => {
		const { app, reads } = searchVault([{ path: "A.md", content: "atlas" }, { path: "B.md", content: "atlas" }]);
		const original = app.vault.cachedRead;
		const controller = new AbortController();
		app.vault.cachedRead = async (file) => { const content = await original(file); controller.abort(); return content; };
		await expect(createNoteSearchTool(app).execute("abort", { query: "atlas" }, controller.signal)).rejects.toThrow("Operation aborted");
		expect(reads).toEqual(["A.md"]);
		app.vault.cachedRead = async () => { throw new Error("Read failed"); };
		await expect(createNoteSearchTool(app).execute("error", { query: "atlas" })).rejects.toThrow("Read failed");
	});

	it("lets a queued abort interrupt scanning a long body", async () => {
		const { app } = searchVault([{ path: "A.md", content: "plain\n".repeat(10000) }]);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 0);
		try { await expect(createNoteSearchTool(app).execute("abort", { query: "missing" }, controller.signal)).rejects.toThrow("Operation aborted"); }
		finally { clearTimeout(timer); }
	});
});
