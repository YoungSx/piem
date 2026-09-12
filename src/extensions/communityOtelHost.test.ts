import { afterEach, describe, expect, it } from "bun:test";
import { webcrypto } from "node:crypto";
import { clearTimeout as nativeClearTimeout, setTimeout as nativeSetTimeout } from "node:timers";
import { Event, EventTarget } from "happy-dom";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { Logger } from "../logging/Logger";
import { stubWindowMembers } from "../testUtils/windowStub";
import { createExtensionConfigStore } from "./extensionConfigStore";
import { CommunityHost } from "./communityHost";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const model: Model<string> = {
	provider: "fixture", id: "fixture-model", name: "Fixture", api: "openai-completions", baseUrl: "https://model.invalid",
	reasoning: false, input: ["text"], contextWindow: 8000, maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const message: AssistantMessage = {
	role: "assistant", content: [{ type: "text", text: "private reply" }], stopReason: "stop", timestamp: 1,
	provider: model.provider, model: model.id, api: model.api,
	usage: { input: 3, output: 2, totalTokens: 5, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
};
const environment = {
	OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.invalid",
	OTEL_METRIC_EXPORT_INTERVAL: "100",
	OTEL_EXPORTER_OTLP_TIMEOUT: "5000",
};
interface Receipt { url: string; body: string; signal: AbortSignal | null | undefined }

function fixture(shortShutdown = false) {
	const target = new EventTarget();
	const timers = new Map<number, ReturnType<typeof nativeSetTimeout>>();
	const listeners = { added: 0, removed: 0 };
	const hosts: CommunityHost[] = [];
	const errors: unknown[] = [], warnings: string[] = [];
	let nextTimer = 0, visibilityState = "visible", block = false;
	const restore = stubWindowMembers({
		crypto: webcrypto, performance,
		setTimeout: (callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
			const id = ++nextTimer;
			timers.set(id, nativeSetTimeout(() => { timers.delete(id); callback(...args); }, shortShutdown && delay === 1000 ? 5 : delay));
			return id;
		},
		clearTimeout: (id?: number) => {
			if (id === undefined) return;
			const timer = timers.get(id);
			if (timer !== undefined) nativeClearTimeout(timer);
			timers.delete(id);
		},
		document: {
			get visibilityState() { return visibilityState; },
			addEventListener: (...args: Parameters<EventTarget["addEventListener"]>) => { listeners.added++; target.addEventListener(...args); },
			removeEventListener: (...args: Parameters<EventTarget["removeEventListener"]>) => { listeners.removed++; target.removeEventListener(...args); },
		},
	});
	cleanups.push(async () => {
		block = false;
		try { for (const host of hosts) { host.dispose(); await host.closed().catch(() => {}); } }
		finally { for (const timer of timers.values()) nativeClearTimeout(timer); timers.clear(); restore(); }
	});
	return {
		timers, errors, warnings,
		get listenerCount() { return listeners.added - listeners.removed; },
		set block(value: boolean) { block = value; },
		hide() { visibilityState = "hidden"; target.dispatchEvent(new Event("visibilitychange")); },
		async host(id: string, values: Readonly<Record<string, string>> = {}) {
			const receipts: Receipt[] = [];
			let environmentReads = 0;
			// No custom extension list: exercise the production registration and reset path.
			const host = await CommunityHost.create({
				getEntries: () => [], getBranch: () => [], getSessionId: () => id, getSessionFile: () => `Piem/${id}.jsonl`,
				getModel: () => model, getModels: () => [model], getThinkingLevel: () => "off", isIdle: () => true,
				notify: (text, type) => { if (type === "error") errors.push(text); },
				prepare: async () => {}, deliver: () => {},
				logger: new Logger({ level: () => "debug", sinks: [record => { if (record.level === "warn") warnings.push(record.message); }] }),
				otelEnvironment: () => { environmentReads++; return values; },
				platform: {
					fetch: async () => { throw new Error("Unexpected foreground request"); },
					backgroundFetch: async (input, init) => {
						const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
						receipts.push({ url, body: await new Response(init?.body).text(), signal: init?.signal });
						if (block) return await new Promise<Response>((_resolve, reject) => {
							const abort = () => { init?.signal?.removeEventListener("abort", abort); reject(new DOMException("Stopped fixture request", "AbortError")); };
							if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener("abort", abort, { once: true });
						});
						return new Response("{}", { headers: { "content-type": "application/json" } });
					},
					config: createExtensionConfigStore({ getData: () => undefined, setData: () => {}, persist: async () => {}, queue: work => work() }),
					onError: error => errors.push(error),
				},
			});
			hosts.push(host);
			await host.start();
			return { host, receipts, get environmentReads() { return environmentReads; } };
		},
	};
}

async function round(host: CommunityHost) {
	await host.beforeAgentStart("private prompt", undefined, "private system");
	await host.emitAgentEvent({ type: "agent_start" });
	await host.emitAgentEvent({ type: "turn_start" });
	await host.beforeProviderRequest({ prompt: "private provider body" });
	await host.afterProviderResponse({ status: 200, headers: { "x-private": "provider response" } });
	await host.emitAgentEvent({ type: "tool_execution_start", toolName: "read", toolCallId: "read-1", args: { path: "private-note.md" } });
	await host.emitAgentEvent({ type: "tool_execution_end", toolName: "read", toolCallId: "read-1", isError: false, result: { content: [{ type: "text", text: "private note contents" }], details: {} } });
	await host.emitAgentEvent({ type: "turn_end", message, toolResults: [] });
	await host.emitAgentEvent({ type: "agent_end", messages: [message] });
}

async function until(check: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for original OTel exporters");
		await new Promise(resolve => nativeSetTimeout(resolve, 5));
	}
}
function signals(receipts: Receipt[]) { return [...new Set(receipts.map(receipt => new URL(receipt.url).pathname))].sort(); }

describe("original OTel in the default community host", () => {
	it("stays offline without configuration, including after Stop and restart", async () => {
		const f = fixture();
		const current = await f.host("unconfigured");
		await round(current.host);
		current.host.cancel();
		await round(current.host);
		current.host.dispose(); await current.host.closed();
		expect(current.environmentReads).toBe(2);
		expect(current.receipts).toEqual([]);
		expect(f.timers.size).toBe(0);
		expect(f.listenerCount).toBe(0);
		expect(f.errors).toEqual([]); expect(f.warnings).toEqual([]);
	});

	it("exports three signals for separate chats and retires the old generation after Stop", async () => {
		const f = fixture();
		const one = await f.host("first-chat", environment), two = await f.host("second-chat", environment);
		await round(one.host); await round(two.host);
		f.hide();
		await until(() => signals(one.receipts).length === 3 && signals(two.receipts).length === 3);
		expect(f.listenerCount).toBe(8);
		expect(one.host.busy).toBe(false); expect(two.host.busy).toBe(false);
		one.host.cancel();
		await round(one.host);
		expect(one.environmentReads).toBe(2); expect(two.environmentReads).toBe(1);
		expect(f.listenerCount).toBe(8);
		one.host.dispose(); await one.host.closed();
		expect(f.listenerCount).toBe(4);
		const firstCount = one.receipts.length;
		await round(two.host);
		two.host.dispose(); await two.host.closed();
		expect(f.listenerCount).toBe(0); expect(f.timers.size).toBe(0);
		expect(one.receipts).toHaveLength(firstCount);
		for (const [current, own, other] of [[one, "first-chat", "second-chat"], [two, "second-chat", "first-chat"]] as const) {
			expect(signals(current.receipts)).toEqual(["/v1/logs", "/v1/metrics", "/v1/traces"]);
			const content = current.receipts.map(receipt => receipt.body).join("\n");
			expect(content).toContain(own); expect(content).not.toContain(other);
			expect(content).toContain("pi.session.shutdown");
			expect(content).not.toContain("private prompt"); expect(content).not.toContain("private note contents");
		}
		expect(f.errors).toEqual([]); expect(f.warnings).toEqual([]);
	});

	it("allows the next operation after a shutdown timeout and cancels retired requests", async () => {
		const f = fixture(true);
		const current = await f.host("slow-chat", { ...environment, OTEL_METRIC_EXPORT_INTERVAL: "60000" });
		await round(current.host);
		f.block = true;
		current.host.cancel();
		await current.host.input("continue after the timeout");
		const retired = current.receipts.slice();
		expect(retired.length).toBeGreaterThan(0);
		expect(retired.every(receipt => receipt.signal?.aborted)).toBe(true);
		expect(current.environmentReads).toBe(2);
		expect(f.warnings).toContain("Extension cleanup failed during reload");
		// Input dispatch does not start a session; the original SDK stays lazy.
		expect(f.listenerCount).toBe(0);
		f.block = false;
		await round(current.host);
		expect(f.listenerCount).toBe(4);
		current.host.dispose(); await current.host.closed();
		expect(current.receipts.length).toBeGreaterThan(retired.length);
		expect(f.listenerCount).toBe(0); expect(f.timers.size).toBe(0);
		expect(f.errors).toEqual([]);
	});

	it("retires a replacement factory if the conversation closes while it is loading", async () => {
		const f = fixture();
		let reads = 0;
		const current = await f.host("closed-during-reload", {
			...environment,
			get OTEL_EXPORTER_OTLP_ENDPOINT() {
				if (++reads === 2) current.host.dispose();
				return environment.OTEL_EXPORTER_OTLP_ENDPOINT;
			},
		});
		await round(current.host);
		current.host.cancel();
		await expect(current.host.input("restart")).rejects.toThrow("disposed");
		await current.host.closed();
		expect(reads).toBe(2);
		expect(f.listenerCount).toBe(0); expect(f.timers.size).toBe(0);
		expect(f.errors).toEqual([]);
	});
});
