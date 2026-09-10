import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { stubWindowTimers } from "../testUtils/windowStub";
import { createExtensionPlatform, type ExtensionPlatformCallbacks } from "./extensionPlatform";

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
const model: Model<string> = {
	id: "test-model", name: "Test model", provider: "fixture", api: "openai-completions", baseUrl: "https://example.invalid/v1",
	reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const response: AssistantMessage = {
	role: "assistant", content: [{ type: "text", text: "refined draft" }], api: model.api, provider: model.provider, model: model.id,
	stopReason: "stop", timestamp: 1,
	usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};
let restoreTimers: () => void;
const hosts: ReturnType<typeof createExtensionPlatform>[] = [];
beforeEach(() => { restoreTimers = stubWindowTimers(); });
afterEach(async () => {
	for (const host of hosts.splice(0)) { host.dispose(); await host.drain(); }
	restoreTimers();
});
function setup(options: Partial<ExtensionPlatformCallbacks> = {}) {
	const errors: unknown[] = [];
	const activities: boolean[] = [];
	const host = createExtensionPlatform({
		fetch: async () => new Response("{}"), complete: async () => response, readConfig: () => undefined,
		onError: error => errors.push(error), activityChanged: busy => activities.push(busy), ...options,
	});
	hosts.push(host);
	return { host, errors, activities };
}

describe("extension platform lifetime", () => {
	it("keeps parallel platforms separate and rejects overlapping or nested operations", async () => {
		const one = setup({ readConfig: () => '{"owner":"one"}' });
		const two = setup({ readConfig: () => '{"owner":"two"}' });
		const gate = deferred<void>();
		const first = one.host.withOperation(async signal => {
			expect(signal).toBe(one.host.getSignal());
			await expect(one.host.withOperation(() => 0)).rejects.toThrow("already running");
			await gate.promise;
			return one.host.platform.readFileSync("/extensions/config/clarify.json", "utf8");
		});
		await expect(one.host.withOperation(() => 0)).rejects.toThrow("already running");
		const second = await two.host.withOperation(() => two.host.platform.readFileSync("/extensions/config/clarify.json", "utf8"));
		gate.resolve();
		expect(await first).toBe('{"owner":"one"}');
		expect(second).toBe('{"owner":"two"}');
		expect(one.activities).toEqual([true, false]);
	});

	it("holds cancellation until the injected transport actually settles and blocks late writes", async () => {
		const started = deferred<AbortSignal>();
		const wire = deferred<Response>();
		const { host, activities } = setup({ fetch: async (_input, init) => {
			started.resolve(init!.signal!);
			return await wire.promise;
		} });
		let wrote = false;
		const run = host.withOperation(async () => {
			await host.platform.fetch("https://example.invalid/search");
			wrote = true;
		});
		const signal = await started.promise;
		host.cancel();
		await expect(run).rejects.toMatchObject({ name: "AbortError" });
		expect(signal.aborted).toBe(true);
		expect(host.busy).toBe(true);
		let drained = false;
		const draining = host.drain().then(() => { drained = true; });
		await Promise.resolve();
		expect(drained).toBe(false);
		wire.resolve(new Response("{}"));
		await draining;
		expect(wrote).toBe(false);
		expect(host.busy).toBe(false);
		expect(activities).toEqual([true, false]);
		expect(await host.withOperation(() => "next")).toBe("next");
	});

	it("tracks fire-and-forget network requests beyond the command's return", async () => {
		const wire = deferred<Response>();
		const { host } = setup({ fetch: () => wire.promise });
		let request: Promise<Response> | undefined;
		await host.withOperation(() => { request = host.platform.fetch("https://example.invalid/search"); });
		expect(host.busy).toBe(true);
		wire.resolve(new Response("done"));
		expect(await (await request!).text()).toBe("done");
		await host.drain();
		expect(host.busy).toBe(false);
	});

	it("passes cancellation to complete and never publishes a late model answer", async () => {
		const started = deferred<AbortSignal>();
		const answer = deferred<AssistantMessage>();
		const { host } = setup({ complete: async (_model, _context, options) => {
			started.resolve(options!.signal!);
			return await answer.promise;
		} });
		const run = host.withOperation(() => host.platform.complete(model, { messages: [] }, { apiKey: "fixture" }));
		const signal = await started.promise;
		host.dispose();
		await expect(run).rejects.toMatchObject({ name: "AbortError" });
		expect(signal.aborted).toBe(true);
		answer.resolve(response);
		await host.drain();
		await expect(host.withOperation(() => undefined)).rejects.toThrow("disposed");
		expect(() => host.assertActive()).toThrow("disposed");
	});

	it("honors request cancellation without aborting a recoverable parent operation", async () => {
		const cancelled = new AbortController();
		cancelled.abort();
		let calls = 0;
		const { host } = setup({ fetch: async () => { calls++; return new Response("{}"); } });
		await host.withOperation(async () => {
			await expect(host.platform.fetch("https://example.invalid/search", { signal: cancelled.signal })).rejects.toMatchObject({ name: "AbortError" });
			expect(host.getSignal().aborted).toBe(false);
		});
		expect(calls).toBe(0);
	});

	it("aborts on its parent signal and removes the listener after settling", async () => {
		const parent = new AbortController();
		const work = deferred<void>();
		const started = deferred<void>();
		const { host } = setup();
		const running = host.withOperation(async () => { started.resolve(); await work.promise; }, parent.signal);
		await started.promise;
		parent.abort();
		await expect(running).rejects.toMatchObject({ name: "AbortError" });
		work.resolve();
		await host.drain();
		expect(await host.withOperation(() => 42)).toBe(42);
	});

	it("retains a timer, its async callback and a nested timer until all finish", async () => {
		const invoked = deferred<void>();
		const gate = deferred<void>();
		const calls: string[] = [];
		const { host } = setup({
			beforeTimer: async () => { calls.push("before"); }, afterTimer: async () => { calls.push("after"); },
		});
		await host.withOperation(() => {
			host.platform.setTimeout(async () => {
				calls.push("callback"); invoked.resolve(); await gate.promise;
				host.platform.setTimeout(() => { calls.push("nested"); }, 0);
			}, 0);
		});
		expect(host.busy).toBe(true);
		await invoked.promise;
		await expect(host.withOperation(() => 0)).rejects.toThrow("already running");
		gate.resolve();
		await host.drain();
		expect(calls).toEqual(["before", "callback", "after", "before", "nested", "after"]);
		expect(host.busy).toBe(false);
	});

	it("cancels scheduled timers without leaving background work", async () => {
		let called = false;
		const { host, activities } = setup();
		await host.withOperation(() => { host.platform.setTimeout(() => { called = true; }, 60_000); });
		host.cancel();
		await host.drain();
		expect(called).toBe(false);
		expect(activities).toEqual([true, false]);
	});

	it("rechecks cancellation after an asynchronous timer precondition", async () => {
		const entered = deferred<void>();
		const gate = deferred<void>();
		let called = false;
		const { host } = setup({ beforeTimer: async () => { entered.resolve(); await gate.promise; } });
		await host.withOperation(() => { host.platform.setTimeout(() => { called = true; }, 0); });
		await entered.promise;
		host.cancel();
		expect(host.busy).toBe(true);
		gate.resolve();
		await host.drain();
		expect(called).toBe(false);
	});

	it("reports a rejected timer callback once and still drains", async () => {
		const failure = new Error("callback failed");
		const { host, errors } = setup();
		await host.withOperation(() => { host.platform.setTimeout(async () => { await Promise.resolve(); throw failure; }, 0); });
		await host.drain();
		await Promise.resolve();
		expect(errors).toEqual([failure]);
	});

	it("ignores a timer's late rejection after cancellation and skips its success hook", async () => {
		const entered = deferred<void>();
		const gate = deferred<void>();
		let afterCalls = 0;
		const { host, errors } = setup({ afterTimer: async () => { afterCalls++; } });
		await host.withOperation(() => {
			host.platform.setTimeout(async () => { entered.resolve(); await gate.promise; }, 0);
		});
		await entered.promise;
		host.cancel();
		gate.reject(new Error("late callback failure"));
		await host.drain();
		await Promise.resolve();
		expect(afterCalls).toBe(0);
		expect(errors).toEqual([]);
	});

	it("absorbs an error sink failure instead of creating another rejected timer", async () => {
		let reports = 0;
		const { host } = setup({ onError: () => { reports++; throw new Error("sink failed"); } });
		await host.withOperation(() => { host.platform.setTimeout(() => { throw new Error("timer failed"); }, 0); });
		await host.drain();
		await Promise.resolve();
		expect(reports).toBe(1);
	});

	it("clearTimeout only clears timers belonging to this host", async () => {
		const one = setup();
		const two = setup();
		let id = 0;
		await one.host.withOperation(() => { id = one.host.platform.setTimeout(() => undefined, 60_000); });
		two.host.platform.clearTimeout(id);
		expect(one.host.busy).toBe(true);
		one.host.platform.clearTimeout(id);
		await one.host.drain();
		expect(one.host.busy).toBe(false);
	});

	it("exposes only read-only JSON snapshots and a private empty environment", () => {
		const reads: string[] = [];
		const { host } = setup({ readConfig: path => { reads.push(path); return path.endsWith("clarify.json") ? "{}" : undefined; } });
		expect(host.platform.getAgentDir()).toBe("/extensions/config");
		expect(host.platform.readFileSync("/extensions/config/clarify.json", "utf8")).toBe("{}");
		expect(host.platform.existsSync("/extensions/config/missing.json")).toBe(false);
		expect(() => host.platform.readFileSync("/extensions/config/missing.json", "utf8")).toThrow("No extension config snapshot");
		try { host.platform.readFileSync("/extensions/config/missing.json", "utf8"); } catch (error) { expect(error).toMatchObject({ code: "ENOENT" }); }
		expect(() => host.platform.readFileSync("/extensions/config/../../secret.json", "utf8")).toThrow("outside");
		expect(() => host.platform.readFileSync("/extensions/config/script.js", "utf8")).toThrow("outside");
		expect(() => host.platform.readFileSync("/extensions/config/clarify.json", "base64")).toThrow("non-UTF-8");
		expect(reads.every(path => path.startsWith("/extensions/config/"))).toBe(true);
		expect(host.platform.getEnvApiKey("openai")).toBeUndefined();
		expect(Object.keys(host.platform.process.env)).toEqual([]);
		expect(Object.isFrozen(host.platform.process)).toBe(true);
		expect(Object.isFrozen(host.platform.process.env)).toBe(true);
		for (const action of [host.platform.mkdirSync, host.platform.writeFileSync, host.platform.unlinkSync]) expect(action).toThrow("does not support");
		expect(() => new host.platform.Text()).toThrow("terminal UI");
		expect(() => new host.platform.BorderedLoader()).toThrow("terminal UI");
	});
});
