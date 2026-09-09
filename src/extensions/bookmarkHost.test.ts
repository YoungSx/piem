import { afterEach, describe, expect, it } from "bun:test";
import type { DataAdapter } from "obsidian";
import type { AgentMessage, Session } from "@earendil-works/pi-agent-core";
import { ObsidianSessionManager } from "../session/ObsidianSessionManager";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { stubWindowTimers } from "../testUtils/windowStub";
import { BookmarkHost } from "./bookmarkHost";

const dispose: Array<() => void> = [];
afterEach(() => { for (const run of dispose.splice(0).reverse()) run(); });
const defaults = { provider: "test", modelId: "test", thinkingLevel: "off" as const };
const answer = (text: string): AgentMessage => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
async function fixture() {
	dispose.push(stubWindowTimers());
	const memory = new MemoryAdapter();
	memory.allowReplaceRemoval = true;
	const manager = new ObsidianSessionManager(memory as unknown as DataAdapter, "Piem/chats", "piem");
	const { path } = await manager.createSession(defaults);
	const id = await manager.appendMessageFor(path, answer("Saved answer"));
	let allowed = true;
	const host = new BookmarkHost({
		load: async () => { await manager.reconcileExternalDrift(path); return manager.getSessionFor(path); },
		assertAvailable: session => { if (!allowed || (session && session !== manager.getSessionFor(path))) throw new Error("Unavailable"); },
	});
	dispose.push(() => host.dispose());
	return { memory, manager, path, id, host, forbid: () => { allowed = false; } };
}

describe("official bookmark on the existing Pi session", () => {
	it("keeps the captured owner, persists a label, and reopens it", async () => {
		const f = await fixture();
		const other = await f.manager.createSession(defaults);
		expect(await f.host.run("bookmark", "Important")).toMatchObject({ kind: "saved", changed: true });
		expect(await f.manager.getSessionFor(f.path).getLabel(f.id)).toBe("Important");
		expect(await f.manager.getSessionFor(other.path).getLabel(f.id)).toBeUndefined();
		const reopened = new ObsidianSessionManager(f.memory as unknown as DataAdapter, "Piem/chats", "piem");
		await reopened.loadSession(f.path);
		expect(await reopened.getSessionFor(f.path).getLabel(f.id)).toBe("Important");
		expect(await f.host.list()).toEqual([{ entryId: f.id, label: "Important", text: "Saved answer" }]);
	});
	it("serializes commands and removes the label through the original extension", async () => {
		const f = await fixture();
		const results = await Promise.all([f.host.run("bookmark", "First"), f.host.run("bookmark", "Second"), f.host.run("unbookmark")]);
		expect(results.map(item => item.kind)).toEqual(["saved", "saved", "removed"]);
		expect(await f.host.list()).toEqual([]);
		expect((await f.host.run("unbookmark")).kind).toBe("none");
	});
	it("rejects persistence failure and recovers on the next command", async () => {
		const f = await fixture();
		const append = f.memory.append.bind(f.memory);
		f.memory.append = async () => { throw new Error("Storage failed"); };
		await expect(f.host.run("bookmark", "Unsaved")).rejects.toThrow("Storage failed");
		expect(await f.manager.getSessionFor(f.path).getLabel(f.id)).toBeUndefined();
		f.memory.append = append;
		expect((await f.host.run("bookmark", "Saved")).kind).toBe("saved");
	});
	it("reads label-only changes from another device before a command", async () => {
		const f = await fixture();
		const external = new ObsidianSessionManager(f.memory as unknown as DataAdapter, "Piem/chats", "piem");
		await external.loadSession(f.path);
		await external.getSessionFor(f.path).setLabel(f.id, "Synced");
		expect(await f.host.list()).toEqual([{ entryId: f.id, label: "Synced", text: "Saved answer" }]);
		await f.host.run("unbookmark");
		expect(await f.host.list()).toEqual([]);
	});
	it("does not lose a label when forking a conversation", async () => {
		const f = await fixture();
		await f.host.run("bookmark", "Fork point");
		const fork = await f.manager.forkSession(f.path, f.id);
		expect(await f.manager.getSessionFor(fork.path).getLabel(f.id)).toBe("Fork point");
	});
	it("preserves official all-entries selection after rewind", async () => {
		const f = await fixture();
		const newer = await f.manager.appendMessageFor(f.path, answer("Later branch"));
		await f.manager.getSessionFor(f.path).moveLane("main", f.id);
		const before = await f.memory.read(f.path);
		await f.host.run("bookmark", "Last appended");
		expect(await f.manager.getSessionFor(f.path).getLabel(newer)).toBe("Last appended");
		expect(await f.manager.getSessionFor(f.path).getLabel(f.id)).toBeUndefined();
		expect(await f.manager.getSessionFor(f.path).getLanes()).toEqual([{ lane: "main", leafId: f.id }]);
		expect(await f.memory.read(f.path)).toStartWith(before);
	});
	it("keeps local and foreign labels when sync delivers a label-only overwrite", async () => {
		const f = await fixture();
		const newer = await f.manager.appendMessageFor(f.path, answer("Other answer"));
		await f.manager.getSessionFor(f.path).moveLane("main", f.id);
		const base = await f.memory.read(f.path);
		await f.manager.getSessionFor(f.path).setLabel(newer, "Local branch label");
		await f.memory.write(f.path, base);
		const external = new ObsidianSessionManager(f.memory as unknown as DataAdapter, "Piem/chats", "piem");
		await external.loadSession(f.path);
		await external.getSessionFor(f.path).setLabel(f.id, "Foreign label");
		const foreign = await f.memory.read(f.path);
		expect((await f.host.list()).map(item => item.label)).toEqual(["Local branch label", "Foreign label"]);
		expect(await f.memory.read(f.path)).toStartWith(foreign);
		expect(await f.manager.getSessionFor(f.path).getLanes()).toEqual([{ lane: "main", leafId: f.id }]);
		const reopened = new ObsidianSessionManager(f.memory as unknown as DataAdapter, "Piem/chats", "piem");
		await reopened.loadSession(f.path);
		expect(await reopened.getSessionFor(f.path).getLabel(newer)).toBe("Local branch label");
		expect(await reopened.getSessionFor(f.path).getLabel(f.id)).toBe("Foreign label");
	});
	it("does not start a queued write after disposal", async () => {
		const f = await fixture();
		const pending = f.host.run("bookmark", "Cancelled");
		f.host.dispose();
		await expect(pending).rejects.toThrow("disposed");
		expect(await f.manager.getSessionFor(f.path).getLabel(f.id)).toBeUndefined();
	});
	it("waits for an already-started write when disposed, without claiming rollback", async () => {
		const f = await fixture();
		let release!: () => void;
		let started!: () => void;
		const entered = new Promise<void>(resolve => { started = resolve; });
		const gate = new Promise<void>(resolve => { release = resolve; });
		const append = f.memory.append.bind(f.memory);
		f.memory.append = async (path, data) => { started(); await gate; await append(path, data); };
		const pending = f.host.run("bookmark", "Committed");
		await entered;
		f.host.dispose();
		release();
		await expect(pending).rejects.toThrow("disposed");
		await f.host.settled();
		expect(await f.manager.getSessionFor(f.path).getLabel(f.id)).toBe("Committed");
	});
	it("checks availability and label bounds before creating a write", async () => {
		const f = await fixture();
		await expect(f.host.run("bookmark", " ")).rejects.toThrow("1–160");
		await expect(f.host.run("bookmark", "x".repeat(161))).rejects.toThrow("1–160");
		f.forbid();
		await expect(f.host.run("bookmark", "No")).rejects.toThrow("Unavailable");
	});
});
