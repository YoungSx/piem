import { describe, expect, it } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession } from "@earendil-works/pi-durable";
import { createExpectAssertions, createStorageConformance } from "@earendil-works/pi-durable/testing";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { DurableVaultStorage, SessionChangedError } from "./DurableVaultStorage";

const path = "Piem/chats/test.jsonl";
async function fixture(adapter = new MemoryAdapter()) {
	await adapter.write(path, `${JSON.stringify({ kind: "header", v: 5, id: "test" })}\n`);
	return { adapter, storage: await DurableVaultStorage.open(adapter, path) };
}

describe("Pi durable storage through the Vault API", () => {
	for (const test of createStorageConformance({
		assertions: createExpectAssertions(expect),
		withStorage: async use => {
			const { storage } = await fixture();
			try { await use(storage); } finally { await storage.close(); }
		},
	})) it(test.name, test.run);

	it("reopens Pi transactions with their entry IDs and model content", async () => {
		const { adapter, storage } = await fixture();
		const session = createSession(storage);
		const conversation = await session.commit(tx => tx.createConversation({ ownership: { kind: "ownerless" } }), BACKGROUND_CONTEXT);
		const entry = await session.commit(tx => tx.appendEntry(conversation.id, { kind: "pi.user", model: [{ role: "user", content: "hello", timestamp: 1 }] }), BACKGROUND_CONTEXT);
		await session.close(BACKGROUND_CONTEXT);
		const reopened = await DurableVaultStorage.open(adapter, path);
		expect((await reopened.entry(entry.id, BACKGROUND_CONTEXT))?.entry).toEqual(entry);
		await reopened.close();
	});

	it("rejects writes after a foreign file lands without changing that file", async () => {
		const { adapter, storage } = await fixture();
		const foreign = `${await adapter.read(path)}\n`;
		await adapter.write(path, foreign);
		await expect(storage.commit([], BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(SessionChangedError);
		expect(await adapter.read(path)).toBe(foreign);
		await storage.close();
	});

	it.each([
		{ type: "unknown", value: { id: 2 } },
		{ type: "conversation", value: { id: -1 } },
		{ type: "entry", value: { id: 2, conversationId: "missing", kind: "pi.user" } },
		{ type: "entry", value: { id: 2, conversationId: 999, kind: "pi.user" } },
	])("rejects malformed committed writes without touching the file: %j", async write => {
		const { adapter, storage } = await fixture();
		await storage.close();
		await adapter.append(path, `${JSON.stringify({ kind: "durable_commit", seq: 1, writes: [write] })}\n`);
		const before = await adapter.read(path);
		await expect(DurableVaultStorage.open(adapter, path)).rejects.toThrow();
		expect(await adapter.read(path)).toBe(before);
	});

	it.each(["before", "partial", "after"])("classifies an append failure %s the frame without losing committed data", async phase => {
		const { adapter, storage } = await fixture();
		const session = createSession(storage);
		const conversation = await session.commit(tx => tx.createConversation({ ownership: { kind: "ownerless" } }), BACKGROUND_CONTEXT);
		const append = adapter.append.bind(adapter);
		adapter.append = async (target, line) => {
			if (phase !== "before") await append(target, phase === "partial" ? line.slice(0, -2) : line);
			throw new Error("Disk failed");
		};
		const write = () => session.commit(tx => tx.appendEntry(conversation.id, { kind: "pi.user", model: [{ role: "user", content: "saved", timestamp: 1 }] }), BACKGROUND_CONTEXT);
		if (phase === "after") await write();
		else await expect(write()).rejects.toThrow("Disk failed");
		adapter.append = append;
		if (phase === "partial") await expect(write()).rejects.toThrow("poisoned");
		else await write();
		await session.close(BACKGROUND_CONTEXT);
		const reopened = await DurableVaultStorage.open(adapter, path);
		const entries = await reopened.scanEntries({ conversationId: conversation.id }, 10, undefined, BACKGROUND_CONTEXT);
		expect(entries.items).toHaveLength(phase === "after" ? 2 : phase === "before" ? 1 : 0);
		await reopened.close();
	});
});
