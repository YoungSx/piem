import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installObsidianStub } from "../testUtils/obsidianStub";
import { stubWindowMembers } from "../testUtils/windowStub";
import { MEMORY_PATH } from "../memory/memoryEdits";

installObsidianStub();
const { MemoryVault } = await import("../testUtils/memoryVault");
const { VaultMemory } = await import("../memory/VaultMemory");
const { createReadMemoryTool, createUpdateMemoryTool } = await import("./memoryTools");
const { createSessionSearchTool } = await import("./sessionSearchTool");
let restoreWindow: () => void;
beforeEach(() => { restoreWindow = stubWindowMembers({ crypto: globalThis.crypto }); });
afterEach(() => restoreWindow());

describe("memory tools", () => {
	it("saves, corrects and removes through tool calls without a question broker", async () => {
		const vault = new MemoryVault();
		const memory = new VaultMemory(vault.app);
		const update = createUpdateMemoryTool(memory);
		await update.execute("save", { edits: [{ type: "append", text: "- User: reply in English" }] });
		const correction = await update.execute("correct", { edits: [{ type: "replace", oldText: "English", newText: "Chinese" }] });
		expect(correction.details).toMatchObject({ path: MEMORY_PATH, changed: true });
		const read = await createReadMemoryTool(new VaultMemory(vault.app)).execute("recall", {});
		expect(JSON.stringify(read.content)).toContain("Chinese");
		expect(JSON.stringify(read.content)).not.toContain("English");
		await update.execute("remove", { edits: [{ type: "remove", oldText: "- User: reply in Chinese\n" }] });
		expect(vault.contents.get(MEMORY_PATH)).toBe("");
	});

	it("returns pagination and read failures where the model can see them", async () => {
		const vault = new MemoryVault();
		for (let n = 0; n < 21; n++) vault.put(`Piem/memory/${n}.md`, "absent");
		vault.failRead.add("Piem/memory/20.md");
		const result = await createReadMemoryTool(new VaultMemory(vault.app)).execute("search", { query: "missing" });
		expect(result.details).toMatchObject({ nextOffset: 20 });
		expect(JSON.stringify(result.content)).toContain("offset: 20");
		expect(JSON.stringify(result.content)).toContain("not empty");
	});

	it("forwards a bounded session query with cancellation and exposes source ids", async () => {
		const controller = new AbortController();
		let received: unknown;
		const tool = createSessionSearchTool(async (query, options) => {
			received = { query, options };
			return {
				hits: [{ path: "Chats/history.jsonl", sessionId: "s1", entryId: "e1", entryType: "message", timestamp: 1, snippet: "decision" }],
				nextOffset: 40, scanned: 20, skipped: ["Chats/broken.jsonl"],
			};
		});
		const result = await tool.execute("search", { query: " decision ", offset: 20 }, controller.signal);
		expect(received).toEqual({ query: "decision", options: { offset: 20, signal: controller.signal } });
		expect(JSON.stringify(result.content)).toContain("session s1 | entry e1");
		expect(JSON.stringify(result.content)).toContain("offset: 40");
		expect(JSON.stringify(result.content)).toContain("Chats/broken.jsonl");
	});
});
