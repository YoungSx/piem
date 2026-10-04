import { expect, it } from "bun:test";
import type { DataAdapter } from "obsidian";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { ObsidianSessionFileSystem } from "./ObsidianSessionFileSystem";
import { VaultSessionRepository } from "./SessionRepository";
import { ObsidianSessionManager } from "./ObsidianSessionManager";
import { snapshotSession } from "./sessionSnapshot";

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
