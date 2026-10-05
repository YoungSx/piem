import { expect, test } from "bun:test";
import type { DataAdapter } from "obsidian";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { ObsidianSessionManager } from "./ObsidianSessionManager";
import { ObsidianSessionFileSystem } from "./ObsidianSessionFileSystem";
import { VaultSessionRepository } from "./SessionRepository";
import { snapshotSession } from "./sessionSnapshot";
import type { StorageWrite } from "@earendil-works/pi-durable";

async function fixture() {
	const adapter = new MemoryAdapter();
	const manager = new ObsidianSessionManager(adapter as unknown as DataAdapter, "Piem/chats", "vault");
	const info = await manager.createSession({ provider: "test", modelId: "test", thinkingLevel: "off" });
	const local = manager.getSessionFor(info.path);
	const tip = await local.appendMessage("Question");
	const withoutRun = await adapter.read(info.path);
	await local.restoreExecutions({ main: { input: { promptIds: [tip], tip }, checkpoint: { phase: "execute", tip }, metadata: { note: "Original.md" } } });
	const repo = new VaultSessionRepository({ fileSystem: new ObsidianSessionFileSystem(adapter as unknown as DataAdapter), sessionsRoot: "Piem/chats" });
	return { adapter, manager, info, local, repo, withoutRun };
}

test.each(["completed", "aborted"] as const)("reloads a remote %s receipt without another transcript message", async outcome => {
	const f = await fixture();
	const foreign = await f.repo.open(f.local.metadata);
	try {
		await (await foreign.execution()).run({
			resume: true, metadata: null, signal: new AbortController().signal,
			drive: async () => outcome === "completed" ? { status: "completed", result: null } : { status: "aborted" },
		});
		await foreign.close();
		const before = await f.adapter.read(f.info.path);
		expect(await f.manager.reconcileExternalDrift(f.info.path)).toEqual({ action: "merged" });
		expect(await (await f.manager.getSession().execution()).hasPending()).toBe(false);
		expect(await f.adapter.read(f.info.path)).toBe(before);
		await f.manager.getSession().appendMessage("Still writable");
	} finally { await foreign.close(); await f.manager.getSession().close(); }
});

test("keeps a local unfinished run when a stale peer has no task yet", async () => {
	const f = await fixture();
	try {
		await f.adapter.write(f.info.path, f.withoutRun);
		expect(await f.manager.reconcileExternalDrift(f.info.path)).toEqual({ action: "merged" });
		expect(await (await f.manager.getSession().execution()).hasPending()).toBe(true);
		expect((await f.manager.getSession().snapshotExecutions()).main?.metadata).toEqual({ note: "Original.md" });
		await f.manager.getSession().appendMessage("Still writable");
	} finally { await f.manager.getSession().close(); }
});

test("merges a local title without reviving a run stopped on the other device", async () => {
	const f = await fixture();
	const shared = await f.adapter.read(f.info.path);
	const foreign = await f.repo.open(f.local.metadata);
	try {
		await (await foreign.execution()).run({ resume: true, metadata: null, signal: new AbortController().signal, drive: async () => ({ status: "aborted" }) });
		const stopped = await f.adapter.read(f.info.path);
		await foreign.close();
		await f.adapter.write(f.info.path, shared);
		await f.local.setName("Local title");
		await f.adapter.write(f.info.path, stopped);
		expect(await f.manager.reconcileExternalDrift(f.info.path)).toEqual({ action: "merged" });
		expect(await f.manager.getSession().getName()).toBe("Local title");
		expect(await (await f.manager.getSession().execution()).hasPending()).toBe(false);
		// A second delivery of the old pending copy must not undo the receipt
		// that survived the first replacement's portable reconstruction.
		await f.adapter.write(f.info.path, shared);
		expect(await f.manager.reconcileExternalDrift(f.info.path)).toEqual({ action: "merged" });
		expect(await (await f.manager.getSession().execution()).hasPending()).toBe(false);
		expect((await f.manager.getSession().snapshotExecutions()).main?.outcome?.status).toBe("aborted");
		await f.manager.getSession().appendMessage("Still writable");
	} finally { await foreign.close(); await f.manager.getSession().close(); }
});

test("retains a committed Stop mark through rebuilding before the task drains", async () => {
	const f = await fixture();
	const shared = await f.adapter.read(f.info.path);
	try {
		const snapshot = (await f.local.snapshotExecutions()).main!;
		if (!snapshot.checkpoint) throw new Error("Expected unfinished task");
		await f.local.restoreExecutions({ main: { ...snapshot, abortRequested: true } });
		await f.adapter.write(f.info.path, shared);
		expect(await f.manager.reconcileExternalDrift(f.info.path)).toEqual({ action: "merged" });
		expect(await (await f.manager.getSession().execution()).hasPending()).toBe(false);
		expect((await f.manager.getSession().snapshotExecutions()).main?.outcome?.status).toBe("aborted");
	} finally { await f.manager.getSession().close(); }
});

test("keeps the matching remote checkpoint when its messages advanced", async () => {
	const f = await fixture();
	const shared = await f.adapter.read(f.info.path);
	const foreign = await f.repo.open(f.local.metadata);
	try {
		const snapshot = (await foreign.snapshotExecutions()).main!;
		if (!snapshot.checkpoint) throw new Error("Expected unfinished task");
		const tip = await foreign.appendMessage("More progress");
		await foreign.restoreExecutions({ main: { ...snapshot, checkpoint: { phase: "execute", tip } } });
		const progressed = await f.adapter.read(f.info.path);
		await foreign.close();
		await f.adapter.write(f.info.path, shared);
		await f.local.setName("Local title");
		await f.adapter.write(f.info.path, progressed);
		expect(await f.manager.reconcileExternalDrift(f.info.path)).toEqual({ action: "merged" });
		expect(await (await f.manager.getSession().execution()).hasPending()).toBe(true);
		expect((await f.manager.getSession().snapshotExecutions()).main?.checkpoint?.tip).toBe(tip);
	} finally { await foreign.close(); await f.manager.getSession().close(); }
});

test("does not mistake a newly admitted Continue for an older stopped run at the same tip", async () => {
	const f = await fixture();
	const shared = await f.adapter.read(f.info.path);
	const foreign = await f.repo.open(f.local.metadata);
	try {
		await (await foreign.execution()).run({ resume: true, metadata: null, signal: new AbortController().signal, drive: async () => ({ status: "aborted" }) });
		const stopped = await f.adapter.read(f.info.path);
		await foreign.close();
		await f.adapter.write(f.info.path, shared);
		const snapshot = (await f.local.snapshotExecutions()).main!;
		await f.local.restoreExecutions({ main: { ...snapshot, input: { ...snapshot.input, runId: "new-intent" } } });
		await f.adapter.write(f.info.path, stopped);
		expect(await f.manager.reconcileExternalDrift(f.info.path)).toEqual({ action: "merged" });
		expect(await (await f.manager.getSession().execution()).hasPending()).toBe(true);
		expect((await f.manager.getSession().snapshotExecutions()).main?.input.runId).toBe("new-intent");
	} finally { await foreign.close(); await f.manager.getSession().close(); }
});

test("rejects a failed receipt rebuild without hanging or publishing a resumable replacement", async () => {
	const f = await fixture();
	try {
		await (await f.local.execution()).run({ resume: true, metadata: null, signal: new AbortController().signal, drive: async () => ({ status: "aborted" }) });
		const snapshot = await snapshotSession(f.local);
		const original = await f.adapter.read(f.info.path);
		const append = f.adapter.append.bind(f.adapter);
		f.adapter.append = async (path, line) => {
			const record = JSON.parse(line) as { writes: StorageWrite[] };
			if (path.endsWith(".migrating.tmp") && record.writes.some(write => write.type === "task" && write.value.state.status === "terminal")) throw new Error("Receipt disk failure");
			await append(path, line);
		};
		await expect(f.repo.replace(f.local.metadata, snapshot, original)).rejects.toThrow("Receipt disk failure");
		expect(await f.adapter.read(f.info.path)).toBe(original);
		expect(await (await f.local.execution()).hasPending()).toBe(false);
	} finally { await f.manager.getSession().close(); }
});

test("keeps the newer terminal receipt when two Continue intents share a transcript tip", async () => {
	const f = await fixture();
	const foreign = await f.repo.open(f.local.metadata);
	try {
		await (await foreign.execution()).run({ resume: true, metadata: null, signal: new AbortController().signal, drive: async () => ({ status: "aborted" }) });
		const firstStopped = await f.adapter.read(f.info.path);
		await f.manager.reconcileExternalDrift(f.info.path);
		let secondPending = "";
		await (await foreign.execution()).run({ resume: false, metadata: null, signal: new AbortController().signal, drive: async () => {
			secondPending = await f.adapter.read(f.info.path);
			return { status: "aborted" };
		} });
		const secondStopped = await f.adapter.read(f.info.path);
		const latestRun = (await foreign.snapshotExecutions()).main?.input.runId;
		await foreign.close();
		await f.adapter.write(f.info.path, firstStopped);
		await f.manager.getSession().setName("Local title");
		await f.adapter.write(f.info.path, secondStopped);
		await f.manager.reconcileExternalDrift(f.info.path);
		expect((await f.manager.getSession().snapshotExecutions()).main?.input.runId).toBe(latestRun);
		await f.adapter.write(f.info.path, secondPending);
		await f.manager.reconcileExternalDrift(f.info.path);
		expect(await (await f.manager.getSession().execution()).hasPending()).toBe(false);
		expect((await f.manager.getSession().snapshotExecutions()).main?.outcome?.status).toBe("aborted");
	} finally { await foreign.close(); await f.manager.getSession().close(); }
});
