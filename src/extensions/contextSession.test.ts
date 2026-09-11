import { afterEach, describe, expect, it } from "bun:test";
import type { DataAdapter } from "obsidian";
import type { AgentMessage, Session } from "@earendil-works/pi-agent-core";
import { ObsidianSessionManager } from "../session/ObsidianSessionManager";
import { navigateExtensionSummary } from "../session/extensionNavigation";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { stubWindowTimers } from "../testUtils/windowStub";
import { ContextSession, type ContextNavigation } from "./contextSession";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const defaults = { provider: "test", modelId: "test", thinkingLevel: "off" as const };
const message = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: Date.now() });

async function fixture(lane = "main") {
	cleanups.push(stubWindowTimers());
	const memory = new MemoryAdapter();
	memory.allowReplaceRemoval = true;
	const manager = new ObsidianSessionManager(memory as unknown as DataAdapter, "Piem/chats", "piem");
	const { path } = await manager.createSession(defaults);
	const start = await manager.appendMessageFor(path, message("Research this note"));
	const tip = await manager.appendMessageFor(path, message("Keep the useful result"));
	if (lane !== "main") await manager.getSessionFor(path).createLane(lane, tip);
	let available = true;
	const navigations: ContextNavigation[] = [];
	let navigate: (request: ContextNavigation, session: Session) => Promise<void> = async (request, session) => {
		await navigateExtensionSummary(session, request, () => {
			if (!available || session !== manager.getSessionFor(path)) throw new Error("Owner unavailable");
		});
	};
	const bridge = new ContextSession({
		load: async () => manager.getSessionFor(path),
		assertAvailable: session => {
			if (!available || session && session !== manager.getSessionFor(path)) throw new Error("Owner unavailable");
		},
		navigate: async (request, session) => { navigations.push(request); await navigate(request, session); },
	}, lane);
	cleanups.push(() => bridge.dispose());
	await bridge.refresh();
	return {
		memory, manager, path, start, tip, bridge, navigations,
		forbid: () => { available = false; },
		setNavigate: (callback: typeof navigate) => { navigate = callback; },
		reopen: async () => {
			const reopened = new ObsidianSessionManager(memory as unknown as DataAdapter, "Piem/chats", "piem");
			await reopened.loadSession(path);
			return reopened;
		},
	};
}

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

describe("Pi context over the authoritative Vault session", () => {
	it("reads staged custom state synchronously, persists real entries, and never injects it into model context", async () => {
		const f = await fixture();
		const before = await f.memory.read(f.path);
		const contextBefore = await f.manager.buildSessionContext();
		const data = { phase: "draft", unused: undefined, nested: { count: 1 } };
		f.bridge.appendEntry("extension-state", data);
		const entry = f.bridge.getBranch().at(-1)!;
		expect(entry).toMatchObject({ type: "custom", customType: "extension-state", parentId: f.tip, data: { phase: "draft", nested: { count: 1 } } });
		expect(entry.seq).toBeUndefined();
		expect(f.bridge.getEntries().at(-1)).toEqual(entry);
		expect(f.bridge.getLeafId()).toBe(entry.id);
		data.nested.count = 2;
		f.bridge.appendEntry("extension-state");
		const next = f.bridge.getBranch().at(-1)!;
		expect(next.parentId).toBe(entry.id);
		expect(await f.memory.read(f.path)).toBe(before);
		await f.bridge.flush();
		const reopened = await f.reopen();
		expect(await reopened.getSession().getEntry(entry.id)).toMatchObject({ type: "custom", customType: "extension-state", parentId: f.tip, data: { phase: "draft", nested: { count: 1 } } });
		expect(await reopened.getSession().getEntry(next.id)).toMatchObject({ type: "custom", parentId: entry.id });
		expect(f.bridge.getEntry(entry.id)?.seq).toBeGreaterThan(0);
		expect((await reopened.buildSessionContext()).messages).toEqual(contextBefore.messages);
		await f.bridge.refresh();
		expect(f.bridge.getEntries().filter(item => item.id === entry.id)).toHaveLength(1);
	});

	it("keeps a staged append on its owning session and lane after focus changes", async () => {
		const f = await fixture("thread");
		const other = await f.manager.createSession(defaults);
		const before = await f.memory.read(other.path);
		f.bridge.appendEntry("lane-state", { owner: "thread" });
		const id = f.bridge.getLeafId()!;
		await f.bridge.flush();
		const session = f.manager.getSessionFor(f.path);
		expect(await session.view("thread").getLeafId()).toBe(id);
		expect(await session.getLeafId()).toBe(f.tip);
		expect(await f.memory.read(other.path)).toBe(before);
		await f.bridge.refresh();
		expect(f.bridge.getBranch().at(-1)).toMatchObject({ id, customType: "lane-state" });
	});

	it("rejects every waiter on a failed batch and reloads without unsaved state", async () => {
		const f = await fixture();
		const append = f.memory.append.bind(f.memory);
		f.memory.append = async () => { throw new Error("Vault is read only"); };
		f.bridge.appendEntry("not-saved", { value: 1 });
		const pending = [f.bridge.flush(), f.bridge.flush()];
		const results = await Promise.allSettled(pending);
		expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
		for (const result of results) if (result.status === "rejected") expect(String(result.reason)).toContain("Vault is read only");
		expect(() => f.bridge.getEntries()).toThrow("refreshed");
		f.memory.append = append;
		await f.bridge.refresh();
		expect(f.bridge.getEntries().some(entry => entry.type === "custom")).toBe(false);
		f.bridge.appendEntry("saved", null);
		await f.bridge.flush();
		expect(await (await f.reopen()).getSession().findEntries({ type: "custom" })).toHaveLength(1);
	});

	it("preserves entries staged by a parallel hook while an earlier append is writing", async () => {
		const f = await fixture();
		const entered = gate(), release = gate();
		const append = f.memory.append.bind(f.memory);
		let writes = 0;
		f.memory.append = async (path, data) => { if (++writes === 1) { entered.resolve(); await release.promise; } await append(path, data); };
		f.bridge.appendEntry("first");
		const first = f.bridge.flush();
		await entered.promise;
		f.bridge.appendEntry("second");
		const id = f.bridge.getLeafId();
		const second = f.bridge.flush();
		release.resolve();
		await Promise.all([first, second]);
		expect(f.bridge.getLeafId()).toBe(id);
		expect(f.bridge.getBranch().filter(entry => entry.type === "custom").map(entry => entry.customType)).toEqual(["first", "second"]);
		expect(await (await f.reopen()).getSession().findEntries({ type: "custom" })).toHaveLength(2);
	});

	it("clears queued state on Stop and waits for an in-flight append before a new host reads", async () => {
		const f = await fixture();
		f.bridge.appendEntry("cancel-before-write");
		const queued = f.bridge.flush();
		f.bridge.cancel();
		await expect(queued).rejects.toThrow("cancelled");
		await f.bridge.refresh();
		expect(f.bridge.getEntries().some(entry => entry.type === "custom")).toBe(false);
		const entered = gate(), release = gate();
		const append = f.memory.append.bind(f.memory);
		let writes = 0;
		f.memory.append = async (path, data) => { writes++; entered.resolve(); await release.promise; await append(path, data); };
		f.bridge.appendEntry("in-flight");
		f.bridge.appendEntry("must-not-start");
		const pending = f.bridge.flush();
		await entered.promise;
		f.bridge.cancel();
		let settled = false;
		const drain = f.bridge.settled().then(() => { settled = true; });
		await Promise.resolve();
		expect(settled).toBe(false);
		release.resolve();
		await expect(pending).rejects.toThrow("cancelled");
		await drain;
		expect(writes).toBe(1);
		await f.bridge.refresh();
		expect(f.bridge.getEntries().filter(entry => entry.type === "custom").map(entry => entry.customType)).toEqual(["in-flight"]);
		f.bridge.appendEntry("next-run");
		await f.bridge.flush();
		expect(f.bridge.getBranch().at(-1)).toMatchObject({ type: "custom", customType: "next-run" });
	});

	it("rejects unserializable state synchronously and separates append from pending navigation", async () => {
		const f = await fixture();
		const circular: { self?: unknown } = {};
		circular.self = circular;
		expect(() => f.bridge.appendEntry("cycle", circular)).toThrow();
		expect(() => f.bridge.appendEntry("bigint", 1n)).toThrow();
		expect(f.bridge.getLeafId()).toBe(f.tip);
		f.bridge.appendEntry("state");
		expect(() => f.bridge.branchWithSummary(f.start, "Handoff")).toThrow("saved before navigation");
		await f.bridge.flush();
		f.bridge.branchWithSummary(f.start, "Handoff");
		expect(() => f.bridge.appendEntry("late-state")).toThrow("navigation");
	});

	it("keeps every branch, the selected path, and real labels when focus changes", async () => {
		const f = await fixture();
		const session = f.manager.getSessionFor(f.path);
		await session.setLabel(f.start, "research-start");
		await session.moveLane("main", f.start);
		const forkTip = await session.appendMessage(message("A different continuation"));
		await session.moveLane("main", f.tip);
		await f.manager.createSession(defaults);
		await f.bridge.refresh();
		expect(f.bridge.getLeafId()).toBe(f.tip);
		expect(f.bridge.getBranch().at(-1)?.id).toBe(f.tip);
		expect(f.bridge.getEntries().some(entry => entry.id === forkTip)).toBe(true);
		expect(f.bridge.getChildren(f.start).map(entry => entry.id)).toEqual([f.tip, forkTip]);
		expect(f.bridge.getLabel(f.start)).toBe("research-start");
		expect(f.bridge.getEntries().some(entry => entry.type === "custom_message")).toBe(false);
	});

	it("saves checkpoint facts before success and reads them after reopening", async () => {
		const f = await fixture();
		const before = await f.memory.read(f.path);
		f.bridge.setLabel(f.tip, "research-result");
		expect(f.bridge.getLabel(f.tip)).toBe("research-result");
		expect(await f.memory.read(f.path)).toBe(before);
		await f.bridge.flush();
		expect(await (await f.reopen()).getSession().getLabel(f.tip)).toBe("research-result");
		expect(f.bridge.getLeafId()).toBe(f.tip);
		f.bridge.setLabel(f.tip, undefined);
		await f.bridge.flush();
		expect(await (await f.reopen()).getSession().getLabel(f.tip)).toBeUndefined();
	});

	it("returns detached tree and message views without corrupting its snapshot", async () => {
		const f = await fixture();
		f.bridge.setLabel(f.start, "research-start");
		await f.bridge.flush();
		const entries = f.bridge.getEntries();
		entries[0]!.id = "tampered";
		const tree = f.bridge.getTree();
		tree[0]!.children.length = 0;
		const entry = f.bridge.getEntry(f.start)!;
		if (entry.type === "message" && entry.message.role === "user") entry.message.content = "changed";
		expect(f.bridge.getEntries()[0]!.id).not.toBe("tampered");
		expect(f.bridge.getTree()[0]!.children.length).toBeGreaterThan(0);
		expect(f.bridge.getEntry(f.start)).toMatchObject({ message: { content: "Research this note" } });
	});

	it("does not leave an unsaved checkpoint in the next operation after storage failure", async () => {
		const f = await fixture();
		const append = f.memory.append.bind(f.memory);
		f.memory.append = async () => { throw new Error("Vault is read only"); };
		f.bridge.setLabel(f.tip, "unsaved");
		await expect(f.bridge.flush()).rejects.toThrow("Vault is read only");
		expect(() => f.bridge.getLabel(f.tip)).toThrow("refreshed");
		f.memory.append = append;
		await f.bridge.refresh();
		expect(f.bridge.getLabel(f.tip)).toBeUndefined();
		f.bridge.setLabel(f.tip, "saved");
		await f.bridge.flush();
		expect(await (await f.reopen()).getSession().getLabel(f.tip)).toBe("saved");
	});

	it("reserves a summary without claiming a durable branch, then persists the handoff", async () => {
		const f = await fixture();
		const other = await f.manager.createSession(defaults);
		const otherBefore = await f.memory.read(other.path);
		const before = await f.memory.read(f.path);
		const summary = "Decision: keep the linked note. Next: check its references.";
		const id = f.bridge.branchWithSummary(f.start, summary);
		f.bridge.branch(f.start);
		expect(f.bridge.getLeafId()).toBe(f.tip);
		expect(f.bridge.getEntry(id)).toBeUndefined();
		expect(await f.memory.read(f.path)).toBe(before);
		expect(await f.bridge.navigateTree(id, { summarize: false })).toEqual({ cancelled: false });
		expect(f.bridge.getLeafId()).toBe(id);
		expect(f.bridge.getBranch().map(entry => entry.id)).not.toContain(f.tip);
		expect(f.bridge.getEntries().map(entry => entry.id)).toContain(f.tip);
		expect(f.navigations).toEqual([expect.objectContaining({ summaryEntryId: id, targetId: f.start, fromId: f.tip, expectedLeafId: f.tip, summary, lane: "main" })]);
		const reopened = await f.reopen();
		expect(await reopened.getSession().getLeafId()).toBe(id);
		expect(await reopened.getSession().getEntry(id)).toMatchObject({ type: "branch_summary", parentId: f.start, fromId: f.tip, summary });
		expect(JSON.stringify((await reopened.buildSessionContext()).messages)).toContain(summary);
		expect(await f.memory.read(other.path)).toBe(otherBefore);
	});

	it("rejects a stale plan after history advances instead of navigating a changed chat", async () => {
		const f = await fixture();
		const id = f.bridge.branchWithSummary(f.start, "Handoff");
		const next = await f.manager.appendMessageFor(f.path, message("New user request"));
		await expect(f.bridge.navigateTree(id, { summarize: false })).rejects.toThrow("Conversation changed");
		expect(f.navigations).toHaveLength(0);
		expect(await f.manager.getSessionFor(f.path).getLeafId()).toBe(next);
		await f.bridge.refresh();
		expect(f.bridge.getLeafId()).toBe(next);
	});

	it("clears a failed navigation and forces a durable refresh before another attempt", async () => {
		const f = await fixture();
		f.setNavigate(async () => { throw new Error("Navigation write failed"); });
		const id = f.bridge.branchWithSummary(f.start, "Handoff");
		await expect(f.bridge.navigateTree(id, { summarize: false })).rejects.toThrow("Navigation write failed");
		expect(await f.manager.getSessionFor(f.path).getLeafId()).toBe(f.tip);
		expect(() => f.bridge.getLeafId()).toThrow("refreshed");
		await f.bridge.refresh();
		expect(f.bridge.getEntry(id)).toBeUndefined();
		expect(f.bridge.branchWithSummary(f.start, "Fresh handoff")).not.toBe(id);
	});

	it("refuses a host callback that returns before the summary was persisted", async () => {
		const f = await fixture();
		f.setNavigate(async () => {});
		const id = f.bridge.branchWithSummary(f.start, "Handoff");
		await expect(f.bridge.navigateTree(id, { summarize: false })).rejects.toThrow("did not persist");
	});

	it("cancels queued checkpoint writes and allows a fresh operation afterward", async () => {
		const f = await fixture();
		f.bridge.setLabel(f.tip, "cancelled");
		const pending = f.bridge.flush();
		f.bridge.cancel();
		await expect(pending).rejects.toThrow("cancelled");
		await f.bridge.settled();
		expect(await f.manager.getSessionFor(f.path).getLabel(f.tip)).toBeUndefined();
		await f.bridge.refresh();
		f.bridge.setLabel(f.tip, "next-run");
		await f.bridge.flush();
		expect(f.bridge.getLabel(f.tip)).toBe("next-run");
	});

	it("awaits an in-flight checkpoint save on unload without issuing another write", async () => {
		const f = await fixture();
		const started = gate();
		const release = gate();
		const append = f.memory.append.bind(f.memory);
		let writes = 0;
		f.memory.append = async (path, data) => { writes++; started.resolve(); await release.promise; await append(path, data); };
		f.bridge.setLabel(f.start, "already-saving");
		f.bridge.setLabel(f.tip, "must-not-start");
		const pending = f.bridge.flush();
		await started.promise;
		f.bridge.dispose();
		let settled = false;
		const completion = f.bridge.settled().then(() => { settled = true; });
		await Promise.resolve();
		expect(settled).toBe(false);
		release.resolve();
		await expect(pending).rejects.toThrow("disposed");
		await completion;
		expect(writes).toBe(1);
		expect(await f.manager.getSessionFor(f.path).getLabel(f.start)).toBe("already-saving");
		expect(await f.manager.getSessionFor(f.path).getLabel(f.tip)).toBeUndefined();
	});

	it("does not start a prepared navigation after cancellation or disposal", async () => {
		const f = await fixture();
		const id = f.bridge.branchWithSummary(f.start, "Handoff");
		const pending = f.bridge.navigateTree(id, { summarize: false });
		f.bridge.cancel();
		await expect(pending).rejects.toThrow("cancelled");
		expect(f.navigations).toHaveLength(0);
		await f.bridge.refresh();
		const next = f.bridge.branchWithSummary(f.start, "Another handoff");
		f.bridge.dispose();
		await expect(f.bridge.navigateTree(next, { summarize: false })).rejects.toThrow("disposed");
		expect(f.navigations).toHaveLength(0);
	});

	it("projects custom messages for upstream timeline hiding without fabricating entries", async () => {
		const f = await fixture();
		const id = await f.manager.appendMessageFor(f.path, {
			role: "custom", customType: "pi-context", content: "Continue from the summary", display: false, timestamp: Date.now(),
		});
		await f.bridge.refresh();
		expect(f.bridge.getEntry(id)).toMatchObject({ type: "custom_message", id, display: false, customType: "pi-context" });
		expect((await f.manager.getSessionFor(f.path).getEntry(id))?.type).toBe("message");
	});

	it("checks bounds, unsupported navigation and owner lifetime before saving", async () => {
		const f = await fixture();
		expect(() => f.bridge.setLabel("unknown", "checkpoint")).toThrow("Unknown");
		expect(() => f.bridge.setLabel(f.tip, " ")).toThrow("1–160");
		expect(() => f.bridge.setLabel(f.tip, "x".repeat(161))).toThrow("1–160");
		expect(() => f.bridge.branchWithSummary("unknown", "summary")).toThrow("Unknown");
		expect(() => f.bridge.branchWithSummary(f.start, " ")).toThrow("1–128000");
		expect(() => f.bridge.branchWithSummary(f.start, "x".repeat(128001))).toThrow("1–128000");
		expect(() => f.bridge.branch(f.start)).toThrow("pending");
		const id = f.bridge.branchWithSummary(f.start, "summary");
		expect(() => f.bridge.branchWithSummary(f.start, "another")).toThrow("already pending");
		await expect(f.bridge.navigateTree(id, { summarize: true })).rejects.toThrow("prepared");
		f.forbid();
		await expect(f.bridge.navigateTree(id, { summarize: false })).rejects.toThrow("Owner unavailable");
		expect(f.navigations).toHaveLength(0);
	});
});
