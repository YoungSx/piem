import { afterAll, describe, expect, it } from "bun:test";
import { installObsidianStub } from "../testUtils/obsidianStub";
import { stubWindowTimers } from "../testUtils/windowStub";
import { searchVault } from "../testUtils/searchVault";
import { DEFAULT_MAX_BYTES } from "../vault/piTruncate";

installObsidianStub();
const restore = stubWindowTimers();
afterAll(restore);
const { createGrepTool } = await import("./grepTool");

function text(result: Awaited<ReturnType<ReturnType<typeof createGrepTool>["execute"]>>): string {
	return result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

describe("grep paging", () => {
	it("continues past a file that fills the first page, without duplicate or missing rows", async () => {
		const { app, reads } = searchVault([
			{ path: "Z.md", content: "needle last" },
			{ path: "A.md", content: Array.from({ length: 105 }, (_, i) => `needle ${i}`).join("\n") },
		]);
		const tool = createGrepTool(app);
		const first = await tool.execute("first", { pattern: "needle" });
		expect(first.details).toMatchObject({ count: 100, offset: 0, hasMore: true, nextOffset: 100, candidateFiles: 2, readFiles: 1, fullyScannedFiles: 0 });
		expect(reads).toEqual(["A.md"]);
		expect(text(first)).toContain("offset=0; hasMore=true; nextOffset=100");
		const last = await tool.execute("last", { pattern: "needle", offset: first.details.nextOffset });
		expect(last.details).toMatchObject({ count: 6, hasMore: false, readFiles: 2, fullyScannedFiles: 2 });
		expect(last.details.nextOffset).toBeUndefined();
		const rows = [first, last].flatMap((result) => text(result).split("\n").filter((line) => /^[AZ]\.md:\d+:/.test(line)));
		expect(rows).toEqual([...Array.from({ length: 105 }, (_, i) => `A.md:${i + 1}: needle ${i}`), "Z.md:1: needle last"]);
	});

	it("probes past the limit before marking more results, and exhausts out-of-range offsets", async () => {
		const { app } = searchVault([{ path: "Only.md", content: "needle\nneedle\nnot a match" }]);
		const tool = createGrepTool(app);
		const exact = await tool.execute("exact", { pattern: "needle", maxMatches: 2 });
		expect(exact.details).toMatchObject({ count: 2, hasMore: false, fullyScannedFiles: 1, truncated: false });
		const short = await tool.execute("short", { pattern: "needle", maxMatches: 1 });
		expect(short.details).toMatchObject({ count: 1, hasMore: true, nextOffset: 1, fullyScannedFiles: 0 });
		const beyond = await tool.execute("beyond", { pattern: "needle", offset: 20 });
		expect(beyond.details).toMatchObject({ count: 0, hasMore: false, fullyScannedFiles: 1 });
		expect(text(beyond)).toContain("No matches.");
	});

	it("budgets UTF-8 display records before delivery and advances by visible rows only", async () => {
		const line = `needle ${"中".repeat(493)}`;
		const { app } = searchVault([{ path: "中文.md", content: Array.from({ length: 100 }, () => line).join("\n") }]);
		const tool = createGrepTool(app);
		const rows: string[] = [];
		let offset = 0;
		for (let page = 0; page < 10; page += 1) {
			const result = await tool.execute("bytes", { pattern: "needle", maxMatches: 1000, offset });
			const visible = text(result).split("\n").filter((row) => row.startsWith("中文.md:"));
			expect(visible).toHaveLength(result.details.count);
			expect(new TextEncoder().encode(text(result)).byteLength).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
			rows.push(...visible);
			if (!result.details.hasMore) break;
			expect(result.details.truncatedBy).toBe("bytes");
			expect(result.details.lineTruncated).toBe(false);
			expect(result.details.nextOffset).toBe(offset + visible.length);
			expect(text(result)).toContain(`nextOffset=${result.details.nextOffset}`);
			offset = result.details.nextOffset!;
		}
		expect(rows).toEqual(Array.from({ length: 100 }, (_, i) => `中文.md:${i + 1}: ${line}`));
	});

	it("orders mixed Unicode paths independently of locale and keeps CRLF line numbers", async () => {
		const { app } = searchVault(["中.md", "a.md", "B.md", "A.md"].map((path) => ({ path, content: "skip\r\nNEEDLE\r\n" })));
		const result = await createGrepTool(app).execute("order", { pattern: "needle" });
		expect(text(result).split("\n").filter((row) => row.includes(".md:"))).toEqual(["A.md:2: NEEDLE", "B.md:2: NEEDLE", "a.md:2: NEEDLE", "中.md:2: NEEDLE"]);
	});

	it("keeps literal, regex, case, scope, and searchable-extension semantics", async () => {
		const { app, reads } = searchVault([
			{ path: "Notes/a.md", content: "a.b\naxb\nA.B" },
			{ path: "Notes/image.png", content: "a.b" },
			{ path: "Other.md", content: "a.b" },
		]);
		const tool = createGrepTool(app);
		const literal = await tool.execute("literal", { pattern: "a.b", path: "Notes" });
		expect(literal.details.count).toBe(2);
		expect(reads).toEqual(["Notes/a.md"]);
		const regex = await tool.execute("regex", { pattern: "^a.b$", regex: true, caseSensitive: true, path: "Notes/a.md" });
		expect(regex.details.count).toBe(2);
	});

	it("separates shortened line text from missing records", async () => {
		const { app } = searchVault([{ path: "A.md", content: `needle ${"x".repeat(800)}` }]);
		const result = await createGrepTool(app).execute("long", { pattern: "needle" });
		expect(result.details).toMatchObject({ count: 1, hasMore: false, truncated: false, lineTruncated: true });
		expect(text(result)).toContain("... [truncated]");
		expect(text(result)).toContain("read the file at its line number");
	});

	it("rejects invalid budgets, regex, and nonexistent scopes even without candidates", async () => {
		const { app } = searchVault([]);
		const tool = createGrepTool(app);
		for (const maxMatches of [0, -1, 0.5, 1001, NaN, Infinity]) await expect(tool.execute("invalid", { pattern: "x", maxMatches })).rejects.toThrow("maxMatches");
		for (const offset of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) await expect(tool.execute("invalid", { pattern: "x", offset })).rejects.toThrow("offset");
		await expect(tool.execute("regex", { pattern: "[", regex: true })).rejects.toThrow();
		await expect(tool.execute("scope", { pattern: "x", path: "Missing" })).rejects.toThrow("File or folder not found");
		await expect(tool.execute("scope", { pattern: "x", path: "../Escape" })).rejects.toThrow("..");
	});

	it("rejects cancellation after a read and stops before later files", async () => {
		const { app, reads } = searchVault([{ path: "A.md", content: "x" }, { path: "B.md", content: "x" }]);
		const controller = new AbortController();
		const original = app.vault.cachedRead;
		app.vault.cachedRead = async (file) => { const result = await original(file); controller.abort(); return result; };
		await expect(createGrepTool(app).execute("abort", { pattern: "x" }, controller.signal)).rejects.toThrow("Operation aborted");
		expect(reads).toEqual(["A.md"]);
	});

	it("lets a queued abort interrupt a long nonmatching file", async () => {
		const { app } = searchVault([{ path: "A.md", content: "plain\n".repeat(10000) }]);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 0);
		try { await expect(createGrepTool(app).execute("abort", { pattern: "missing" }, controller.signal)).rejects.toThrow("Operation aborted"); }
		finally { clearTimeout(timer); }
	});

	it("propagates read failures instead of claiming complete coverage", async () => {
		const { app } = searchVault([{ path: "A.md", content: "x" }]);
		app.vault.cachedRead = async () => { throw new Error("Read failed"); };
		await expect(createGrepTool(app).execute("read", { pattern: "x" })).rejects.toThrow("Read failed");
	});
});
