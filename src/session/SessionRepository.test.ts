import { expect, it } from "bun:test";
import type { DataAdapter } from "obsidian";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { ObsidianSessionFileSystem } from "./ObsidianSessionFileSystem";
import { VaultSessionRepository } from "./SessionRepository";
import { ObsidianSessionManager } from "./ObsidianSessionManager";
import { snapshotSession } from "./sessionSnapshot";
import { createSession, defineDoc } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DurableVaultStorage } from "./DurableVaultStorage";

const root = "Piem/chats";
function repository(adapter: MemoryAdapter) {
	return new VaultSessionRepository({ fileSystem: new ObsidianSessionFileSystem(adapter as unknown as DataAdapter), sessionsRoot: root });
}

it("backs up a torn frame and permits new writes after reopening", async () => {
	const adapter = new MemoryAdapter();
	const repo = repository(adapter);
	const original = await repo.create({ cwd: "vault" });
	await original.appendMessage("Before the fault");
	const metadata = await original.getMetadata();
	await original.close();
	await adapter.append(metadata.path, '{"kind":"durable_commit","seq":');
	const broken = await adapter.read(metadata.path);
	const reopened = await repo.open(metadata);
	await reopened.appendMessage("After recovery");
	expect((await reopened.findEntries()).map(entry => entry.type)).toEqual(["message", "message"]);
	const backup = adapter.filePaths().find(path => path.endsWith(".legacy"))!;
	expect(await adapter.read(backup)).toBe(broken);
	await reopened.close();
	const again = await repo.open(metadata);
	expect(await again.findEntries()).toHaveLength(2);
	await again.close();
});

it.each(["list", "open"])("recovers an interrupted publication through %s", async method => {
	const adapter = new MemoryAdapter();
	const repo = repository(adapter);
	const original = await repo.create({ cwd: "vault" });
	await original.appendMessage("Keep this conversation");
	const metadata = await original.getMetadata();
	await original.close();
	// Simulate process death after the old file moves but before stage publication.
	await adapter.write(`${metadata.path}.migrating.tmp`, "incomplete staging data");
	await adapter.rename(metadata.path, `${metadata.path}.replaced.tmp`);
	if (method === "list") expect(await repository(adapter).list()).toHaveLength(1);
	const manager = new ObsidianSessionManager(adapter as unknown as DataAdapter, root, "vault");
	await manager.loadSession(metadata.path);
	expect(await manager.getSession().findEntries()).toHaveLength(1);
	await manager.getSession().appendMessage("Still writable");
	await manager.getSession().close();
});

it("recovers the live manager after an uncertain partial append", async () => {
	const adapter = new MemoryAdapter();
	const manager = new ObsidianSessionManager(adapter as unknown as DataAdapter, root, "vault");
	const created = await manager.createSession({ provider: "test", modelId: "test", thinkingLevel: "off" });
	await manager.appendMessage({ role: "user", content: "Before", timestamp: 1 });
	const append = adapter.append.bind(adapter);
	adapter.append = async (path, line) => { await append(path, line.slice(0, -2)); throw new Error("Disk failed"); };
	await expect(manager.appendMessage({ role: "user", content: "Unconfirmed", timestamp: 2 })).rejects.toThrow("Disk failed");
	adapter.append = append;
	expect(await manager.reconcileExternalDrift(created.path)).toEqual({ action: "merged" });
	await manager.appendMessage({ role: "user", content: "After", timestamp: 3 });
	expect((await manager.buildSessionContext()).messages).toMatchObject([{ content: "Before" }, { content: "After" }]);
	await manager.getSession().close();
});

it("lets another repository wait for publication before attempting recovery", async () => {
	const adapter = new MemoryAdapter();
	const repo = repository(adapter);
	const session = await repo.create({ cwd: "vault" });
	await session.appendMessage("Keep this");
	const metadata = await session.getMetadata();
	const snapshot = await snapshotSession(session);
	await session.close();
	const original = await adapter.read(metadata.path);
	let release!: () => void;
	let started!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const entered = new Promise<void>(resolve => { started = resolve; });
	const rename = adapter.rename.bind(adapter);
	adapter.rename = async (from, to) => {
		if (from.endsWith(".migrating.tmp")) { started(); await gate; }
		await rename(from, to);
	};
	const publishing = repo.replace(metadata, snapshot, original, false);
	try {
		await entered;
		let listed = false;
		const listing = repository(adapter).list().then(items => { listed = true; return items; });
		await Promise.resolve();
		await Promise.resolve();
		expect(listed).toBe(false);
		release();
		await publishing;
		expect(await listing).toHaveLength(1);
		const reopened = await repository(adapter).open(metadata);
		expect(await reopened.findEntries()).toHaveLength(1);
		await reopened.close();
	} finally { release(); await publishing; }
});

it("migrates the previous flat durable format into native forks without losing UUIDs or bookmarks", async () => {
	const adapter = new MemoryAdapter();
	const metadata = { id: "previous", path: `${root}/--vault--/previous.jsonl`, cwd: "vault", createdAt: 1, modifiedAt: 1, storageVersion: 1 };
	await adapter.write(metadata.path, `${JSON.stringify({ kind: "header", v: 5, ...metadata })}\n`);
	const storage = await DurableVaultStorage.open(adapter, metadata.path);
	const old = createSession(storage);
	const state = defineDoc({ kind: "piem.session", version: 1, scope: "session", initial: () => ({
		seq: 6, name: { seq: 5, value: "Previous chat" }, labels: { old: { seq: 4, value: "Keep" } }, records: {},
		lanes: { main: { seq: 6, leafId: "old" }, alternative: { seq: 3, leafId: "alternate" } },
		legacyValues: { "pi.lane.config/main": { model: { provider: "test", modelId: "original" }, thinkingLevel: "high" } },
	}) });
	await old.commit(async tx => {
		const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
		await tx.doc(state);
		for (const [index, [id, parentId]] of [["first", null], ["old", "first"], ["alternate", "first"]].entries()) {
			await tx.appendEntry(conversation.id, { kind: "piem.transcript", data: { type: "message", id: id!, parentId: parentId ?? null, seq: index + 1, timestamp: index + 1, message: { role: "user", content: id!, timestamp: index + 1 } } });
		}
	}, BACKGROUND_CONTEXT);
	await old.close(BACKGROUND_CONTEXT);
	const before = await adapter.read(metadata.path);
	const migrated = await repository(adapter).open(metadata);
	try {
		expect((await migrated.view().findEntries()).map(entry => entry.id)).toEqual(["first", "old"]);
		expect((await migrated.view("alternative").findEntries()).map(entry => entry.id)).toEqual(["first", "alternate"]);
		expect(await migrated.getLabel("old")).toBe("Keep");
		expect(await migrated.getName()).toBe("Previous chat");
		expect(await migrated.getConfiguration()).toMatchObject({ model: { modelId: "original" }, thinkingLevel: "high" });
		await migrated.appendMessage("Still independent", "alternative");
		expect(await migrated.getLeafId()).toBe("old");
		expect(await adapter.read(adapter.filePaths().find(path => path.endsWith(".legacy"))!)).toBe(before);
		expect(JSON.parse((await adapter.read(metadata.path)).split("\n")[0]!).v).toBe(6);
	} finally { await migrated.close(); }
});
