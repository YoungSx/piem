import { expect, test } from "bun:test";
import type { DataAdapter } from "obsidian";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, createSession, GenerationTask, Harness, ResetEntry, CompactionEntry } from "@earendil-works/pi-durable";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { DurableVaultStorage, SessionChangedError } from "./DurableVaultStorage";
import { PiemSession } from "./PiemSession";
import { VaultSessionRepository } from "./SessionRepository";
import { ObsidianSessionFileSystem } from "./ObsidianSessionFileSystem";
import { nativeSessionHeader, readNativeHistory, recoverNativeSessionCopy } from "./nativeSessionData";
import { appendTranscript } from "./piTranscript";

const path = "Piem/chats/--vault--/native.jsonl";
const metadata = { id: "native-fixture", cwd: "vault", createdAt: 1, storageVersion: 1, path, modifiedAt: 1 };

// MemoryAdapter writes its map synchronously; emulate Vault.create's no-overwrite contract.
function createNew(adapter: MemoryAdapter) {
	return async (file: string, content: string) => {
		if (adapter.contentOf(file) !== undefined) throw new Error("File already exists");
		await adapter.write(file, content);
	};
}

async function fixture() {
	const adapter = new MemoryAdapter();
	await adapter.mkdir("Piem/chats");
	await adapter.mkdir("Piem/chats/--vault--");
	await adapter.write(path, nativeSessionHeader(metadata));
	const storage = await DurableVaultStorage.open(adapter, path);
	const faux = fauxProvider({ tokensPerSecond: Infinity });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	const options = { models, registry: createRegistry() };
	const harness = await Harness.open(storage, options, context);
	const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
	faux.setResponses([fauxAssistantMessage("Native answer")]);
	await (await root.submit({ type: "input", content: "Native question", requestId: "one" }, context)).wait(context);
	return { adapter, storage, harness, root, options };
}

test("native history reads official messages without writes and keeps fork and reopen identities", async () => {
	const f = await fixture();
	try {
		const original = await f.adapter.read(path);
		const history = await readNativeHistory(f.storage, metadata.id, f.root.id);
		expect(history.map(entry => entry.kind)).toEqual(["pi.user", "pi.assistant"]);
		expect(history.map(entry => entry.model?.[0]?.role)).toEqual(["user", "assistant"]);
		expect(history[0]!.id).toBe(`native:${metadata.id}:${history[0]!.entryId}`);
		expect(await f.adapter.read(path)).toBe(original);
		const fork = await f.harness.commit(tx => tx.forkConversation(f.root.id, history[0]!.entryId, { ownership: { kind: "ownerless" } }), context);
		expect((await readNativeHistory(f.storage, metadata.id, fork.id)).map(entry => entry.id)).toEqual([history[0]!.id]);
		await f.harness.close(context);
		const reopened = await DurableVaultStorage.open(f.adapter, path);
		try { expect(await readNativeHistory(reopened, metadata.id, f.root.id)).toEqual(history); }
		finally { await reopened.close(); }
	} finally { await f.harness.close(context); }
});

test("projection preserves genuine legacy UUIDs and distinguishes reset and compaction entries", async () => {
	const f = await fixture();
	try {
		const id = "019c6e27-e55b-73d1-87d8-4e01f1f75043";
		await f.harness.commit(async tx => {
			await appendTranscript(tx, f.root.id, { type: "message", id, parentId: null, seq: 1, timestamp: 1, message: { role: "user", content: "Imported", timestamp: 1 } });
			await tx.appendEntry(f.root.id, { kind: ResetEntry.kind, head: "self" });
			await tx.appendEntry(f.root.id, { kind: CompactionEntry.kind, data: { reason: "manual", id }, model: [{ role: "user", content: "Summary", timestamp: 2 }] });
		}, context);
		const entries = await readNativeHistory(f.storage, metadata.id, f.root.id);
		expect(entries[2]!.id).toBe(id);
		expect(entries[3]!.kind).toBe(ResetEntry.kind);
		expect(entries[4]!.kind).toBe(CompactionEntry.kind);
		expect(entries[4]!.id).not.toBe(id);
		expect(entries[4]).not.toHaveProperty("seq");
	} finally { await f.harness.close(context); }
});

test("native history paginates beyond one page without inventing timestamps or losing ancestry", async () => {
	const f = await fixture();
	try {
		await f.harness.commit(async tx => {
			for (let index = 0; index < 520; index++) await tx.appendEntry(f.root.id, { kind: ResetEntry.kind });
		}, context);
		const entries = await readNativeHistory(f.storage, metadata.id, f.root.id);
		expect(entries).toHaveLength(522);
		expect(new Set(entries.map(entry => entry.id)).size).toBe(522);
		expect(entries.map(entry => entry.entryId)).toEqual(entries.map(entry => entry.entryId).sort((a, b) => a - b));
		expect(entries.at(-1)).not.toHaveProperty("timestamp");
	} finally { await f.harness.close(context); }
});

test("legacy repository cannot list, open, snapshot or replace a native graph", async () => {
	const f = await fixture();
	await f.harness.close(context);
	const original = await f.adapter.read(path);
	const repo = new VaultSessionRepository({ fileSystem: new ObsidianSessionFileSystem(f.adapter as unknown as DataAdapter), sessionsRoot: "Piem/chats" });
	expect(await repo.list()).toEqual([]);
	await expect(repo.open(metadata)).rejects.toThrow("native reader");
	await expect(repo.readSnapshot(metadata)).rejects.toThrow("native reader");
	await expect(repo.replace(metadata, { log: [], lanes: [], legacyValues: {} })).rejects.toThrow("native reader");
	const storage = await DurableVaultStorage.open(f.adapter, path);
	try { await expect(PiemSession.open(storage, metadata)).rejects.toThrow("native reader"); }
	finally { await storage.close(); }
	expect(await f.adapter.read(path)).toBe(original);
	expect(f.adapter.filePaths()).toEqual([path]);
});

test.each([{ kind: "header", v: 8 }, { kind: "header", v: 8, version: 4 }, { type: "session", version: 8 }, { kind: "other", v: 6 }])("legacy repository refuses unknown headers without rewriting: %j", async unsupported => {
	const adapter = new MemoryAdapter();
	await adapter.mkdir("Piem/chats");
	await adapter.mkdir("Piem/chats/--vault--");
	const original = `${JSON.stringify({ ...metadata, ...unsupported })}\n`;
	await adapter.write(path, original);
	const repo = new VaultSessionRepository({ fileSystem: new ObsidianSessionFileSystem(adapter as unknown as DataAdapter), sessionsRoot: "Piem/chats" });
	expect(await repo.list()).toEqual([]);
	await expect(repo.open(metadata)).rejects.toThrow("Unsupported");
	await expect(repo.readSnapshot(metadata)).rejects.toThrow("Unsupported");
	await expect(repo.replace(metadata, { log: [], lanes: [], legacyValues: {} })).rejects.toThrow("Unsupported");
	expect(await adapter.read(path)).toBe(original);
	expect(adapter.filePaths()).toEqual([path]);
});

test.each([{ type: "session", version: 3, timestamp: "2026-10-05T00:00:00Z" }, { kind: "header", v: 4 }, { kind: "header", version: 4 }, { kind: "header", v: 4, version: 4 }])("legacy header guard preserves supported imports: %j", async supported => {
	const adapter = new MemoryAdapter();
	await adapter.mkdir("Piem/chats");
	await adapter.mkdir("Piem/chats/--vault--");
	await adapter.write(path, `${JSON.stringify({ ...metadata, ...supported })}\n`);
	const repo = new VaultSessionRepository({ fileSystem: new ObsidianSessionFileSystem(adapter as unknown as DataAdapter), sessionsRoot: "Piem/chats" });
	expect(await repo.list()).toHaveLength(1);
	expect((await repo.readSnapshot(metadata)).log).toEqual([]);
	const session = await repo.open(metadata);
	try { expect(await session.findEntries()).toEqual([]); }
	finally { await session.close(); }
});

test("task-only foreign cancellation rejects stale writes and survives native reopen without transcript changes", async () => {
	const f = await fixture();
	await f.harness.close(context);
	const seed = createSession(await DurableVaultStorage.open(f.adapter, path));
	const taskId = await seed.commit(tx => tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, conversationId: f.root.id }), context);
	await seed.close(context);
	const staleStorage = await DurableVaultStorage.open(f.adapter, path);
	const stale = createSession(staleStorage);
	const before = await readNativeHistory(staleStorage, metadata.id, f.root.id);
	const peer = await Harness.open(await DurableVaultStorage.open(f.adapter, path), f.options, context);
	try {
		await peer.abortTask(taskId, context);
		const foreign = await f.adapter.read(path);
		await expect(stale.commit(tx => tx.appendEntry(f.root.id, { kind: ResetEntry.kind }), context)).rejects.toBeInstanceOf(SessionChangedError);
		expect(await f.adapter.read(path)).toBe(foreign);
		const reopened = await DurableVaultStorage.open(f.adapter, path);
		try {
			expect(await readNativeHistory(reopened, metadata.id, f.root.id)).toEqual(before);
			expect((await reopened.task(taskId, context))?.abortRequested).toBe(true);
		} finally { await reopened.close(); }
	} finally { await stale.close(context); await peer.close(context); }
});

test("torn native recovery copies all committed bytes and task state while preserving its original", async () => {
	const f = await fixture();
	const tasks = (await f.storage.scanTasks({}, 100, undefined, context)).items;
	await f.harness.close(context);
	const complete = await f.adapter.read(path);
	await f.adapter.append(path, '{"kind":"durable_commit","seq":');
	const torn = await f.adapter.read(path);
	const target = await recoverNativeSessionCopy(f.adapter, path, createNew(f.adapter));
	expect(await f.adapter.read(path)).toBe(torn);
	expect(await f.adapter.read(target)).toBe(complete);
	const recovered = await DurableVaultStorage.open(f.adapter, target);
	try { expect((await recovered.scanTasks({}, 100, undefined, context)).items).toEqual(tasks); }
	finally { await recovered.close(); }
	await expect(recoverNativeSessionCopy(f.adapter, "../escape", createNew(f.adapter))).rejects.toThrow();
	await f.adapter.write(path, `${complete}{"kind":"broken"}\n`);
	await expect(recoverNativeSessionCopy(f.adapter, path, createNew(f.adapter))).rejects.toThrow();
	expect(f.adapter.filePaths()).toHaveLength(2);
});

test("recovery detects a changing source and keeps the candidate as evidence", async () => {
	const f = await fixture();
	await f.harness.close(context);
	await f.adapter.append(path, "torn");
	let target = "";
	await expect(recoverNativeSessionCopy(f.adapter, path, async (file, value) => {
		target = file;
		await createNew(f.adapter)(file, value);
		await f.adapter.append(path, " changed");
	})).rejects.toThrow("changed during recovery");
	expect(await f.adapter.exists(target)).toBe(true);
	expect((await f.adapter.read(path)).endsWith("torn changed")).toBe(true);
	expect(f.adapter.trashed).toEqual([]);
});

test.each(["before", "after"])("recovery never overwrites or removes a foreign target appearing %s create", async when => {
	const f = await fixture();
	await f.harness.close(context);
	await f.adapter.append(path, "torn");
	const original = await f.adapter.read(path);
	let target = "";
	await expect(recoverNativeSessionCopy(f.adapter, path, async (file, value) => {
		target = file;
		if (when === "before") await f.adapter.write(file, "Foreign bytes");
		await createNew(f.adapter)(file, value);
		if (when === "after") await f.adapter.write(file, "Foreign bytes");
	})).rejects.toThrow(when === "before" ? "File already exists" : "verification failed");
	expect(await f.adapter.read(target)).toBe("Foreign bytes");
	expect(await f.adapter.read(path)).toBe(original);
	expect(f.adapter.trashed).toEqual([]);
});
