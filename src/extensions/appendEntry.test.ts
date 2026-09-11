import { afterAll, describe, expect, it } from "bun:test";
import type { DataAdapter } from "obsidian";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ObsidianSessionManager } from "../session/ObsidianSessionManager";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { stubWindowTimers } from "../testUtils/windowStub";
import { CommunityHost } from "./communityHost";
import { ContextSession } from "./contextSession";
import type { ExtensionUIAdapter } from "./extensionUI";

const restore = stubWindowTimers();
afterAll(restore);

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

async function fixture(factory: ExtensionFactory) {
	const memory = new MemoryAdapter();
	const sessions = new ObsidianSessionManager(memory as unknown as DataAdapter, "Piem/chats", "piem");
	const { path } = await sessions.createSession({ provider: "test", modelId: "test", thinkingLevel: "off" });
	await sessions.appendMessageFor(path, { role: "user", content: "Hello", timestamp: 0 });
	const session = new ContextSession({
		load: async () => sessions.getSessionFor(path),
		assertAvailable: source => { if (source && source !== sessions.getSessionFor(path)) throw new Error("Retired session"); },
		navigate: async () => { throw new Error("Unexpected navigation"); },
	});
	const host = await CommunityHost.create({
		// A deliberately empty legacy cache proves that both Pi read APIs use
		// the synchronous session snapshot that owns the pending custom entry.
		getEntries: () => [], getBranch: () => [], getModel: () => undefined,
		getThinkingLevel: () => "off", isIdle: () => true, notify: () => {},
		session, prepare: () => session.refresh(), deliver: () => {},
		platform: { fetch: async () => { throw new Error("Unexpected network"); }, onError: () => {} },
	}, [{ id: "append-state", factory }]);
	await session.refresh();
	return {
		host, session, sessions, memory, path,
		stored: () => sessions.getSessionFor(path).findEntries({ type: "custom", order: "oldestFirst" }),
		close: async () => { host.dispose(); await host.closed(); },
	};
}

describe("Pi appendEntry host boundaries", () => {
	it("makes command state readable immediately and durable before success", async () => {
		let id: string | null = null;
		const f = await fixture(pi => {
			pi.registerCommand("remember", { handler: async (_args, ctx) => {
				pi.appendEntry("counter", { value: 1 });
				id = ctx.sessionManager.getLeafId();
				expect(ctx.sessionManager.getEntries().at(-1)).toEqual(ctx.sessionManager.getBranch().at(-1));
				expect(ctx.sessionManager.getLeafEntry()).toMatchObject({ id, type: "custom", customType: "counter", data: { value: 1 } });
			} });
		});
		const entered = gate(), release = gate();
		const append = f.memory.append.bind(f.memory);
		f.memory.append = async (path, data) => { entered.resolve(); await release.promise; await append(path, data); };
		try {
			let completed = false;
			const run = f.host.run("remember").then(result => { completed = true; return result; });
			await entered.promise;
			expect(completed).toBe(false);
			release.resolve();
			await run;
			expect(await f.stored()).toMatchObject([{ id, customType: "counter", data: { value: 1 } }]);
		} finally { release.resolve(); await f.close(); }
	});

	it("flushes startup, start hooks, context filters, tools and observation events", async () => {
		const f = await fixture(pi => {
			pi.on("session_start", () => { pi.appendEntry("startup"); });
			pi.on("before_agent_start", () => { pi.appendEntry("before-start"); });
			pi.on("context", () => { pi.appendEntry("context-filter"); });
			pi.on("agent_settled", () => { pi.appendEntry("settled"); });
			pi.on("agent_start", () => { pi.appendEntry("agent-event"); });
			pi.registerTool({
				name: "state_tool", label: "State tool", description: "Test entry durability", parameters: Type.Object({}),
				execute: async () => { pi.appendEntry("tool"); return { content: [{ type: "text", text: "Saved" }], details: {} }; },
			});
		});
		try {
			await f.host.start();
			expect(await f.stored()).toHaveLength(1);
			await f.host.beforeAgentStart("Hello", undefined, "system");
			await f.host.transformContext([]);
			await f.host.tools[0]!.execute("call", {}, undefined);
			await f.host.settled();
			await f.host.emitAgentEvent({ type: "agent_start" });
			expect((await f.stored()).map(entry => entry.type === "custom" ? entry.customType : entry.type)).toEqual(["startup", "before-start", "context-filter", "tool", "settled", "agent-event"]);
		} finally { await f.close(); }
	});

	it("flushes concurrent tool hooks without making them exclusive operations", async () => {
		const both = gate();
		let calls = 0;
		const f = await fixture(pi => {
			pi.on("tool_call", async event => {
				pi.appendEntry("call", { id: event.toolCallId });
				if (++calls === 2) both.resolve();
				await both.promise;
			});
			pi.on("tool_result", () => { pi.appendEntry("result"); });
		});
		try {
			await Promise.all(["one", "two"].map(toolCallId => f.host.toolCall({ type: "tool_call", toolName: "read", toolCallId, input: {} })));
			await f.host.toolResult({ type: "tool_result", toolName: "read", toolCallId: "one", input: {}, content: [], details: {}, isError: false });
			expect(await f.stored()).toHaveLength(3);
		} finally { both.resolve(); await f.close(); }
	});

	it("fails the command on storage failure and still saves writes made before a handler throws", async () => {
		const f = await fixture(pi => {
			pi.registerCommand("write", { handler: async () => { pi.appendEntry("state"); } });
			pi.registerCommand("throw", { handler: async () => { pi.appendEntry("before-error"); throw new Error("Handler failed"); } });
		});
		const append = f.memory.append.bind(f.memory);
		try {
			f.memory.append = async () => { throw new Error("Disk full"); };
			await expect(f.host.run("write")).rejects.toThrow("Disk full");
			expect(await f.stored()).toEqual([]);
			f.memory.append = append;
			await expect(f.host.run("throw")).rejects.toThrow("Handler failed");
			expect(await f.stored()).toMatchObject([{ customType: "before-error" }]);
		} finally { await f.close(); }
	});

	it("cancels staged writes and refuses escaped async or timer mutations", async () => {
		const entered = gate(), release = gate();
		let api!: ExtensionAPI;
		let lateFailure: unknown;
		const f = await fixture(pi => {
			api = pi;
			pi.registerCommand("hold", { handler: async () => {
				pi.appendEntry("cancelled");
				entered.resolve();
				await release.promise;
				try { pi.appendEntry("escaped"); } catch (error) { lateFailure = error; }
			} });
			pi.registerCommand("next", { handler: async () => { pi.appendEntry("next"); } });
		});
		try {
			const run = f.host.run("hold");
			await entered.promise;
			f.host.cancel();
			await expect(run).rejects.toMatchObject({ name: "AbortError" });
			release.resolve();
			await f.host.drain();
			await f.host.run("next");
			expect(String(lateFailure)).toContain("synchronously");
			expect(await f.stored()).toMatchObject([{ customType: "next" }]);
			await new Promise<void>(resolve => window.setTimeout(() => {
				expect(() => api.appendEntry("unscoped-timer")).toThrow("synchronously");
				resolve();
			}, 0));
			f.host.dispose();
			expect(() => api.appendEntry("disposed")).toThrow();
		} finally { release.resolve(); await f.close(); }
	});

	it("drains an append already in progress on Stop without starting the next entry", async () => {
		const f = await fixture(pi => {
			pi.registerCommand("write", { handler: async () => { pi.appendEntry("in-flight"); pi.appendEntry("cancelled"); } });
		});
		const entered = gate(), release = gate();
		const append = f.memory.append.bind(f.memory);
		f.memory.append = async (path, data) => { entered.resolve(); await release.promise; await append(path, data); };
		try {
			const run = f.host.run("write");
			await entered.promise;
			f.host.cancel();
			await expect(run).rejects.toMatchObject({ name: "AbortError" });
			let drained = false;
			const drain = f.host.drain().then(() => { drained = true; });
			await Promise.resolve();
			expect(drained).toBe(false);
			release.resolve();
			await drain;
			expect(await f.stored()).toMatchObject([{ customType: "in-flight" }]);
		} finally { release.resolve(); await f.close(); }
	});

	it("does not flush a cancelled interception into the next prompt", async () => {
		const entered = gate(), release = gate();
		const f = await fixture(pi => {
			pi.on("tool_call", async () => { pi.appendEntry("cancelled-hook"); entered.resolve(); await release.promise; });
			pi.registerCommand("next", { handler: async () => { pi.appendEntry("next"); } });
		});
		try {
			const hook = f.host.toolCall({ type: "tool_call", toolName: "read", toolCallId: "old", input: {} });
			await entered.promise;
			f.host.cancelInvocation();
			await expect(hook).rejects.toMatchObject({ name: "AbortError" });
			release.resolve();
			await f.host.run("next");
			expect(await f.stored()).toMatchObject([{ customType: "next" }]);
		} finally { release.resolve(); await f.close(); }
	});

	it("drops staged state when a panel attachment cancels its unfinished handler", async () => {
		const entered = gate(), release = gate();
		const f = await fixture(pi => {
			pi.registerCommand("hold", { handler: async () => { pi.appendEntry("old-panel"); entered.resolve(); await release.promise; } });
			pi.registerCommand("next", { handler: async () => { pi.appendEntry("new-panel"); } });
		});
		const ui: ExtensionUIAdapter = {
			select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined,
			setStatus: () => {}, setWidget: () => {}, getEditorText: () => "", setEditorText: () => {}, pasteToEditor: () => {},
			addAutocompleteProvider: () => {}, reset: () => {},
		};
		try {
			const run = f.host.run("hold");
			await entered.promise;
			f.host.attachUI(ui);
			await expect(run).rejects.toMatchObject({ name: "AbortError" });
			release.resolve();
			await f.host.drain();
			await f.host.run("next");
			expect(await f.stored()).toMatchObject([{ customType: "new-panel" }]);
		} finally { release.resolve(); await f.close(); }
	});
});
