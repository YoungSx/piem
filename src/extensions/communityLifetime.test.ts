import { afterAll, describe, expect, it } from "bun:test";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { CommunityHost } from "./communityHost";
import { stubWindowMembers, stubWindowTimers } from "../testUtils/windowStub";

const restore = stubWindowTimers();
afterAll(restore);

async function fixture(factory: ExtensionFactory) {
	let reads = 0;
	const host = await CommunityHost.create({
		getEntries: () => [], getBranch: () => [], getModel: () => undefined,
		getThinkingLevel: () => "off", isIdle: () => true, notify: () => {},
		prepare: async () => { reads++; }, deliver: () => {},
		platform: { fetch: async () => { throw new Error("No network expected"); }, onError: error => { throw error; } },
	}, [{ id: "native-lifetime", factory }]);
	return { host, reads: () => reads };
}

describe("community host preserves native lifetime contracts", () => {
	it("keeps joined observers active after the navigation handler has finished", async () => {
		let enterNavigation!: () => void, releaseNavigation!: () => void, enterObserver!: () => void, releaseObserver!: () => void;
		const enteredNavigation = new Promise<void>(resolve => { enterNavigation = resolve; });
		const navigationGate = new Promise<void>(resolve => { releaseNavigation = resolve; });
		const enteredObserver = new Promise<void>(resolve => { enterObserver = resolve; });
		const observerGate = new Promise<void>(resolve => { releaseObserver = resolve; });
		let ended = 0;
		const f = await fixture(pi => {
			pi.on("session_before_switch", async () => { enterNavigation(); await navigationGate; return { cancel: true }; });
			pi.on("tool_execution_update", async () => { enterObserver(); await observerGate; });
			pi.on("tool_execution_end", () => { ended++; });
		});
		try {
			const navigation = f.host.beforeSessionChange({ type: "session_before_switch", reason: "resume", targetSessionFile: "target" });
			await enteredNavigation;
			const observing = f.host.emitAgentEvent({ type: "tool_execution_update", toolCallId: "one", toolName: "read", args: {}, partialResult: { content: [], details: {} } });
			await enteredObserver;
			releaseNavigation();
			expect(await navigation).toBe(true);
			expect(f.host.busy).toBe(true);
			await f.host.emitAgentEvent({ type: "tool_execution_end", toolCallId: "two", toolName: "read", result: { content: [], details: {} }, isError: false });
			expect(ended).toBe(1);
			releaseObserver();
			await observing;
			await f.host.drain();
			expect(f.host.busy).toBe(false);
		} finally { releaseNavigation(); releaseObserver(); f.host.dispose(); await f.host.closed(); }
	});

	it("returns a completion timeout while retaining its unfinished native request", async () => {
		let expire!: () => void;
		const restoreTimeout = stubWindowMembers({
			setTimeout: ((callback: () => void, ms: number) => { expect(ms).toBe(60_000); expire = callback; return 1; }) as typeof window.setTimeout,
			clearTimeout: (() => {}) as typeof window.clearTimeout,
		});
		let entered!: () => void, release!: (message: AssistantMessage) => void;
		const started = new Promise<void>(resolve => { entered = resolve; });
		const wire = new Promise<AssistantMessage>(resolve => { release = resolve; });
		const model: Model<string> = { provider: "fixture", id: "one", name: "One", api: "openai-completions", baseUrl: "https://example.invalid", reasoning: false, input: ["text"], contextWindow: 8000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
		const answer: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "late" }], api: model.api, provider: model.provider, model: model.id, timestamp: 0, stopReason: "stop", usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } };
		const host = await CommunityHost.create({
			getEntries: () => [], getModels: () => [model], getModel: () => model, notify: () => {},
			prepare: async () => {}, deliver: () => {}, complete: async () => { entered(); return await wire; },
			platform: { fetch: async () => { throw new Error("Unexpected fetch"); }, onError: () => {} },
		}, [{ id: "timeout", factory: pi => { pi.registerCommand("complete", { handler: async (_args, ctx) => { await ctx.modelRegistry.complete(model, { messages: [] }); } }); } }]);
		try {
			const command = host.run("complete");
			await started;
			expire();
			await expect(command).rejects.toMatchObject({ name: "AbortError" });
			expect(host.busy).toBe(true);
			let drained = false;
			const draining = host.drain().then(() => { drained = true; });
			await Promise.resolve();
			expect(drained).toBe(false);
			release(answer);
			await draining;
			expect(host.busy).toBe(false);
		} finally { release(answer); host.dispose(); await host.closed(); restoreTimeout(); }
	});
	it("does not repeat startup or revoke completed callbacks on Stop", async () => {
		let starts = 0, callback: (() => boolean) | undefined;
		const f = await fixture(pi => {
			pi.on("session_start", (_event, ctx) => { starts++; callback = () => ctx.isIdle(); });
			pi.registerCommand("again", { handler: async () => { expect(callback?.()).toBe(true); } });
		});
		try {
			await f.host.start();
			f.host.cancel();
			await f.host.run("again");
			expect(starts).toBe(1);
			expect(callback?.()).toBe(true);
		} finally { f.host.dispose(); await f.host.closed(); }
	});

	it("does not refresh Vault history for subscribed tool progress events", async () => {
		let updates = 0;
		const f = await fixture(pi => { pi.on("tool_execution_update", () => { updates++; }); });
		try {
			await f.host.start();
			const before = f.reads();
			const event: AgentEvent = { type: "tool_execution_update", toolCallId: "one", toolName: "read", args: {}, partialResult: { content: [{ type: "text", text: "progress" }], details: {} } };
			await f.host.emitAgentEvent(event);
			await f.host.emitAgentEvent(event);
			expect(updates).toBe(2);
			expect(f.reads()).toBe(before);
		} finally { f.host.dispose(); await f.host.closed(); }
	});
});
