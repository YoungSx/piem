import { afterEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { DataAdapter } from "obsidian";
import type { ContextNavigation } from "../extensions/contextSession";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { stubWindowTimers } from "../testUtils/windowStub";
import { ObsidianSessionManager } from "./ObsidianSessionManager";
import { CONTEXT_STAGING_LANE, navigateExtensionSummary } from "./extensionNavigation";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const defaults = { provider: "test", modelId: "test", thinkingLevel: "off" as const };
const message = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: Date.now() });

async function fixture() {
	cleanups.push(stubWindowTimers());
	const memory = new MemoryAdapter();
	memory.allowReplaceRemoval = true;
	const createManager = () => new ObsidianSessionManager(memory as unknown as DataAdapter, "Piem/chats", "piem");
	const manager = createManager();
	const { path } = await manager.createSession(defaults);
	const start = await manager.appendMessageFor(path, message("Research this note"));
	const tip = await manager.appendMessageFor(path, message("Keep the useful result"));
	const session = manager.getSessionFor(path);
	let current = true;
	const assertCurrent = () => { if (!current) throw new Error("Owner stopped"); };
	const request = async (targetId: string | null = start): Promise<ContextNavigation> => ({
		summaryEntryId: session.idGenerator.next(), targetId, fromId: await session.getLeafId() ?? "root",
		expectedLeafId: await session.getLeafId(), checkpointSeq: (await session.getLog()).at(-1)?.seq ?? 0,
		summary: "Keep the source links. Next: verify citations.", lane: "main",
	});
	return {
		memory, manager, path, start, tip, session, request, assertCurrent,
		stop: () => { current = false; },
		reopen: async () => { const reopened = createManager(); await reopened.loadSession(path); return reopened; },
	};
}

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

describe("durable Pi context navigation", () => {
	it("publishes the summary last, keeps the old branch, and continues after reopening", async () => {
		const f = await fixture();
		const request = await f.request();
		await navigateExtensionSummary(f.session, request, f.assertCurrent);
		const reopened = await f.reopen();
		expect(await reopened.getSession().getLeafId()).toBe(request.summaryEntryId);
		expect(await reopened.getSession().getEntry(request.summaryEntryId)).toMatchObject({
			type: "branch_summary", parentId: f.start, fromId: f.tip, summary: request.summary,
		});
		expect(await reopened.getSession().getEntry(f.tip)).toMatchObject({ type: "message", parentId: f.start });
		const context = await reopened.buildSessionContext();
		expect(JSON.stringify(context.messages)).toContain(request.summary);
		expect(JSON.stringify(context.messages)).not.toContain("Keep the useful result");
		expect((await reopened.getSession().getStats()).messageCount).toBe(2);
		const next = await reopened.appendMessage(message("Verify the first source"));
		expect(await reopened.getSession().getEntry(next)).toMatchObject({ parentId: request.summaryEntryId });
		expect(await (await f.reopen()).getSession().getLeafId()).toBe(next);
		expect(f.memory.trashed).toHaveLength(0);
	});

	it("supports a root handoff without removing any old entries", async () => {
		const f = await fixture();
		const request = await f.request(null);
		const before = await f.session.findEntries();
		await navigateExtensionSummary(f.session, request, f.assertCurrent);
		const reopened = await f.reopen();
		expect(await reopened.getSession().getEntry(request.summaryEntryId)).toMatchObject({ parentId: null });
		expect(await reopened.getSession().findEntries()).toHaveLength(before.length + 1);
		expect((await reopened.buildSessionContext()).messages).toHaveLength(1);
	});

	it("reuses one staging lane and leaves the active run ledger on its original lane", async () => {
		const f = await fixture();
		const run = await f.manager.beginRunOperationFor(f.path, [message("Research")]);
		const first = await f.request();
		await navigateExtensionSummary(f.session, first, f.assertCurrent);
		const second = await f.request();
		await navigateExtensionSummary(f.session, second, f.assertCurrent);
		expect(await f.session.getLanes()).toEqual([
			{ lane: "main", leafId: second.summaryEntryId }, { lane: CONTEXT_STAGING_LANE, leafId: second.summaryEntryId },
		]);
		expect([...(await f.manager.findAllOpenRunOperationsFor(f.path)).keys()]).toEqual(["main"]);
		expect(await f.session.findOpenOperations(CONTEXT_STAGING_LANE)).toHaveLength(0);
		await f.manager.endRunOperationFor(f.path, run, "completed");
		expect(await (await f.reopen()).findAllOpenRunOperations()).toEqual(new Map());
		expect(await f.session.getEntry(first.summaryEntryId)).toBeDefined();
	});

	for (const failingWrite of [1, 2, 3]) {
		it(`keeps the old branch after write ${failingWrite} fails and reports staged data honestly`, async () => {
			const f = await fixture();
			const request = await f.request();
			const append = f.memory.append.bind(f.memory);
			let writes = 0;
			f.memory.append = async (path, data) => {
				if (++writes === failingWrite) throw new Error("Vault is read only");
				await append(path, data);
			};
			await expect(navigateExtensionSummary(f.session, request, f.assertCurrent)).rejects.toThrow("Vault is read only");
			f.memory.append = append;
			const reopened = await f.reopen();
			expect(await reopened.getSession().getLeafId()).toBe(f.tip);
			expect(JSON.stringify((await reopened.buildSessionContext()).messages)).toContain("Keep the useful result");
			expect(await reopened.getSession().getEntry(request.summaryEntryId)).toEqual(
				failingWrite === 3 ? expect.objectContaining({ summary: request.summary }) : undefined,
			);
			expect((await reopened.getSession().getLanes()).length).toBe(failingWrite === 1 ? 1 : 2);
		});
	}

	for (const blockedWrite of [1, 2, 3]) {
		it(`awaits write ${blockedWrite} already in flight on stop, without a later write or rollback`, async () => {
			const f = await fixture();
			const request = await f.request();
			const started = gate();
			const release = gate();
			const append = f.memory.append.bind(f.memory);
			let writes = 0;
			f.memory.append = async (path, data) => {
				if (++writes === blockedWrite) { started.resolve(); await release.promise; }
				await append(path, data);
			};
			const pending = navigateExtensionSummary(f.session, request, f.assertCurrent);
			await started.promise;
			f.stop();
			release.resolve();
			await expect(pending).rejects.toThrow("Owner stopped");
			expect(writes).toBe(blockedWrite);
			const reopened = await f.reopen();
			expect(await reopened.getSession().getLeafId()).toBe(blockedWrite === 3 ? request.summaryEntryId : f.tip);
			expect(await reopened.getSession().getEntry(request.summaryEntryId)).toEqual(
				blockedWrite >= 2 ? expect.objectContaining({ summary: request.summary }) : undefined,
			);
		});
	}

	it("rejects a stopped owner before reading or writing storage", async () => {
		const f = await fixture();
		const request = await f.request();
		const before = await f.memory.read(f.path);
		f.stop();
		await expect(navigateExtensionSummary(f.session, request, f.assertCurrent)).rejects.toThrow("Owner stopped");
		expect(await f.memory.read(f.path)).toBe(before);
	});

	it("rejects an advanced leaf and a changed checkpoint even when the leaf is unchanged", async () => {
		const f = await fixture();
		const leafRequest = await f.request();
		await f.session.appendMessage(message("Another request"));
		await expect(navigateExtensionSummary(f.session, leafRequest, f.assertCurrent)).rejects.toThrow("Conversation changed");
		const checkpointRequest = await f.request();
		await f.session.setLabel(f.start, "New checkpoint");
		const before = await f.memory.read(f.path);
		await expect(navigateExtensionSummary(f.session, checkpointRequest, f.assertCurrent)).rejects.toThrow("Conversation changed");
		expect(await f.memory.read(f.path)).toBe(before);
		expect(await f.session.getLanes()).toHaveLength(1);
	});

	it("does not overwrite a branch changed while the summary was saving", async () => {
		const f = await fixture();
		const request = await f.request();
		const appendEntry = f.session.appendEntry.bind(f.session);
		f.session.appendEntry = async (entry, lane) => {
			const result = await appendEntry(entry, lane);
			await f.session.appendMessage(message("A newer request"));
			return result;
		};
		await expect(navigateExtensionSummary(f.session, request, f.assertCurrent)).rejects.toThrow("Conversation changed");
		const reopened = await f.reopen();
		expect(await reopened.getSession().getLeafId()).not.toBe(request.summaryEntryId);
		expect(JSON.stringify((await reopened.buildSessionContext()).messages)).toContain("A newer request");
		expect(await reopened.getSession().getEntry(request.summaryEntryId)).toBeDefined();
	});

	it("does not treat its extra lane as sync drift or resurrect an unselected summary", async () => {
		const f = await fixture();
		const request = await f.request();
		const moveLane = f.session.moveLane.bind(f.session);
		f.session.moveLane = async (lane, target) => {
			if (lane === "main") throw new Error("Selection failed");
			await moveLane(lane, target);
		};
		await expect(navigateExtensionSummary(f.session, request, f.assertCurrent)).rejects.toThrow("Selection failed");
		f.session.moveLane = moveLane;
		const before = await f.memory.read(f.path);
		expect(await f.manager.reconcileExternalDrift(f.path)).toEqual({ action: "skipped" });
		expect(await f.memory.read(f.path)).toBe(before);
		const foreign = await f.reopen();
		const foreignTip = await foreign.appendMessage(message("Synced continuation"));
		expect(await f.manager.reconcileExternalDrift(f.path)).toEqual({ action: "merged" });
		expect(await f.manager.getSessionFor(f.path).getLeafId()).toBe(foreignTip);
		expect(JSON.stringify((await f.manager.buildSessionContextFor(f.path)).messages)).not.toContain(request.summary);
		expect(await (await f.reopen()).getSession().getLeafId()).toBe(foreignTip);
	});

	it("retains a selected summary through a synced continuation without restoring the discarded path", async () => {
		const f = await fixture();
		const request = await f.request();
		await navigateExtensionSummary(f.session, request, f.assertCurrent);
		const before = await f.memory.read(f.path);
		expect(await f.manager.reconcileExternalDrift(f.path)).toEqual({ action: "skipped" });
		expect(await f.memory.read(f.path)).toBe(before);
		const foreign = await f.reopen();
		const foreignTip = await foreign.appendMessage(message("Continue the verified summary"));
		expect(await f.manager.reconcileExternalDrift(f.path)).toEqual({ action: "merged" });
		const context = await f.manager.buildSessionContextFor(f.path);
		expect(JSON.stringify(context.messages)).toContain(request.summary);
		expect(JSON.stringify(context.messages)).toContain("Continue the verified summary");
		expect(JSON.stringify(context.messages)).not.toContain("Keep the useful result");
		expect(await (await f.reopen()).getSession().getLeafId()).toBe(foreignTip);
	});
});
