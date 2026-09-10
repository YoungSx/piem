import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { AssistantMessage, Context, Model, ModelsApiStreamOptions } from "@earendil-works/pi-ai";
import { stubWindowMembers } from "../testUtils/windowStub";
import { ExtensionLifetime } from "./extensionLifetime";
import { createExtensionModels, EXTENSION_COMPLETION_DEFAULT_MAX_TOKENS, EXTENSION_COMPLETION_TIMEOUT_MS, type ExtensionComplete } from "./extensionModels";

const configuredModel: Model<string> = {
	id: "configured-model", name: "Configured model", provider: "configured-provider", api: "openai-completions",
	baseUrl: "https://configured.example/v1", headers: { Authorization: "private-credential" },
	reasoning: true, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768, maxTokens: 8_192,
};
const context: Context = { messages: [{ role: "user", content: "Summarize the note.", timestamp: 0 }] };
const answer: AssistantMessage = {
	role: "assistant", content: [{ type: "text", text: "Summary" }], api: configuredModel.api,
	provider: configuredModel.provider, model: configuredModel.id, stopReason: "stop", timestamp: 0,
	usage: { input: 2, output: 1, totalTokens: 3, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};

function deferred() {
	let resolve!: (value: AssistantMessage) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<AssistantMessage>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

const lifetimes = new Set<ExtensionLifetime>();
const timers = new Map<number, { callback: () => void; delay: number }>();
let restoreTimers: () => void;
beforeEach(() => {
	let timerId = 0;
	restoreTimers = stubWindowMembers({
		setTimeout: (callback: () => void, delay: number) => { timers.set(++timerId, { callback, delay }); return timerId; },
		clearTimeout: (id: number) => { timers.delete(id); },
	});
});
afterEach(() => {
	for (const lifetime of lifetimes) lifetime.dispose();
	lifetimes.clear();
	restoreTimers();
	timers.clear();
});

function harness(implementation: ExtensionComplete = async () => answer, models = [structuredClone(configuredModel)]) {
	const lifetime = new ExtensionLifetime();
	lifetimes.add(lifetime);
	const complete = mock(implementation);
	const api = createExtensionModels({ lifetime, getModels: () => models, complete, assertAvailable: () => lifetime.assertActive() });
	return { api, lifetime, complete, models };
}

describe("extension model bridge", () => {
	it("returns detached metadata without credentials and resolves authoritative model configuration", async () => {
		const { api, complete, models } = harness();
		const metadata = api.getAvailable()[0]!;
		expect(metadata.headers).toBeUndefined();
		expect(api.getAll()[0]!.headers).toBeUndefined();
		expect(api.find(configuredModel.provider, configuredModel.id)!.headers).toBeUndefined();
		metadata.name = "Tampered";
		metadata.cost.input = 999;
		const forged = { ...metadata, baseUrl: "https://other.example", api: "other-api", headers: { Authorization: "other-key" }, maxTokens: 999_999 };
		await api.complete(forged, context);
		expect(complete.mock.calls[0]![0]).toEqual(configuredModel);
		expect(complete.mock.calls[0]![0]).not.toBe(models[0]);
		expect(complete.mock.calls[0]![2].maxTokens).toBe(configuredModel.maxTokens);
		expect(models[0]).toEqual(configuredModel);
	});

	it("rejects unknown, removed and ambiguous models before calling transport", async () => {
		const { api, complete, models } = harness();
		const unknown = { ...configuredModel, id: "unconfigured" };
		expect(api.find(unknown.provider, unknown.id)).toBeUndefined();
		expect(api.hasConfiguredAuth(unknown)).toBe(false);
		await expect(api.complete(unknown, context)).rejects.toThrow("configured, unambiguous");
		models.push(structuredClone(configuredModel));
		expect(api.hasConfiguredAuth(configuredModel)).toBe(false);
		await expect(api.complete(configuredModel, context)).rejects.toThrow("configured, unambiguous");
		models.length = 0;
		await expect(api.complete(configuredModel, context)).rejects.toThrow("configured, unambiguous");
		expect(complete).not.toHaveBeenCalled();
		expect(timers.size).toBe(0);
	});

	it("rejects transport, credential, payload and unknown option overrides explicitly", async () => {
		const { api, complete } = harness();
		for (const key of ["apiKey", "headers", "fetch", "env", "onPayload", "onResponse", "transformHeaders", "samplingParams", "maxRetries", "timeoutMs", "transport", "futureOption"]) {
			await expect(api.complete(configuredModel, context, { [key]: "override" })).rejects.toThrow(`extension model option ${key}`);
		}
		await expect(api.complete(configuredModel, context, { [Symbol("override")]: true })).rejects.toThrow("extension model option Symbol(override)");
		expect(complete).not.toHaveBeenCalled();
	});

	it("validates allowed values without coercing objects or malformed inputs", async () => {
		const { api, complete } = harness();
		const invalid: Array<[string, unknown]> = [
			["maxTokens", 0], ["maxTokens", 1.5], ["maxTokens", 8_193], ["maxTokens", "100"], ["maxTokens", Infinity],
			["temperature", -1], ["temperature", 3], ["temperature", NaN],
			["reasoningEffort", "unlimited"], ["cacheRetention", "forever"],
			["sessionId", {}], ["sessionId", "header\r\ninjection"],
			["signal", { aborted: false }], ["toolChoice", { toString: () => "auto" }],
		];
		for (const [key, value] of invalid) {
			await expect(api.complete(configuredModel, context, { [key]: value })).rejects.toThrow(key);
		}
		for (const malformed of [null, [], "options"]) {
			await expect(api.complete(configuredModel, context, malformed as unknown as ModelsApiStreamOptions<string>)).rejects.toThrow("must be an object");
		}
		expect(complete).not.toHaveBeenCalled();
	});

	it("forwards common generation options and applies model-sized default output limits", async () => {
		const { api, complete, models } = harness();
		const options: ModelsApiStreamOptions<string> = { temperature: 0.25, maxTokens: 6_144, reasoningEffort: "low", cacheRetention: "short", sessionId: "extension-session", toolChoice: "none" };
		await api.complete(configuredModel, context, options);
		expect(complete.mock.calls[0]![2]).toMatchObject(options);
		models[0]!.maxTokens = NaN;
		await api.complete(configuredModel, context);
		expect(complete.mock.calls[1]![2].maxTokens).toBe(EXTENSION_COMPLETION_DEFAULT_MAX_TOKENS);
		expect(timers.size).toBe(0);
	});

	it("snapshots validated options and context before transport dispatch", async () => {
		const { api, complete } = harness();
		const request: ModelsApiStreamOptions<string> = { maxTokens: 512 };
		const suppliedContext = structuredClone(context);
		const pending = api.complete(configuredModel, suppliedContext, request);
		request.maxTokens = 1_000_000;
		request.apiKey = "late-injected-key";
		suppliedContext.messages.length = 0;
		await pending;
		expect(complete.mock.calls[0]![2].maxTokens).toBe(512);
		expect(complete.mock.calls[0]![2].apiKey).toBeUndefined();
		expect(complete.mock.calls[0]![1]).toEqual(context);
	});

	it("does not dispatch requests cancelled before or immediately after invocation", async () => {
		const { api, complete, lifetime } = harness();
		const controller = new AbortController();
		controller.abort();
		await expect(api.complete(configuredModel, context, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
		const pending = api.complete(configuredModel, context);
		lifetime.cancel();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(complete).not.toHaveBeenCalled();
		expect(timers.size).toBe(0);
	});

	it("holds both concurrency slots after Stop until the real transports settle", async () => {
		const firstWork = deferred(), secondWork = deferred(), nextWork = deferred();
		const work = [firstWork, secondWork, nextWork];
		const { api, complete, lifetime } = harness(() => work.shift()!.promise);
		let published = 0;
		const first = api.complete(configuredModel, context).then(() => { published++; });
		const second = api.complete(configuredModel, context).then(() => { published++; });
		const cancelled = Promise.allSettled([first, second]);
		await expect(api.complete(configuredModel, context)).rejects.toThrow("At most 2");
		expect(complete).toHaveBeenCalledTimes(2);
		lifetime.cancel();
		expect((await cancelled).map(result => result.status)).toEqual(["rejected", "rejected"]);
		expect(complete.mock.calls.every(call => call[2].signal!.aborted)).toBe(true);
		expect(timers.size).toBe(0);
		await expect(api.complete(configuredModel, context)).rejects.toThrow("At most 2");
		firstWork.resolve(answer);
		await firstWork.promise;
		await Promise.resolve();
		const next = api.complete(configuredModel, context);
		secondWork.reject(new Error("late transport failure"));
		nextWork.resolve(answer);
		await expect(next).resolves.toEqual(answer);
		expect(complete).toHaveBeenCalledTimes(3);
		expect(published).toBe(0);
	});

	it("aborts on caller cancellation and removes its signal listener and timer", async () => {
		const work = deferred();
		const controller = new AbortController();
		const added = spyOn(controller.signal, "addEventListener");
		const removed = spyOn(controller.signal, "removeEventListener");
		const { api, complete } = harness(() => work.promise);
		try {
			const pending = api.complete(configuredModel, context, { signal: controller.signal });
			await Promise.resolve();
			controller.abort();
			await expect(pending).rejects.toMatchObject({ name: "AbortError" });
			expect(complete.mock.calls[0]![2].signal!.aborted).toBe(true);
			expect(removed.mock.calls[0]![1]).toBe(added.mock.calls[0]![1]);
			expect(timers.size).toBe(0);
		} finally {
			work.resolve(answer);
			await work.promise;
			added.mockRestore(); removed.mockRestore();
		}
	});

	it("times out at sixty seconds, aborts transport and clears the timer", async () => {
		const work = deferred();
		const { api, complete } = harness(() => work.promise);
		const pending = api.complete(configuredModel, context);
		await Promise.resolve();
		const timer = [...timers.values()][0]!;
		expect(timer.delay).toBe(60_000);
		expect(timer.delay).toBe(EXTENSION_COMPLETION_TIMEOUT_MS);
		timer.callback();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(complete.mock.calls[0]![2].signal!.aborted).toBe(true);
		expect(timers.size).toBe(0);
		work.resolve(answer);
		await work.promise;
	});

	it("aborts unfinished work on unload and denies retained model capabilities", async () => {
		const work = deferred();
		const { api, complete, lifetime } = harness(() => work.promise);
		const pending = api.complete(configuredModel, context);
		await Promise.resolve();
		lifetime.dispose();
		await expect(pending).rejects.toThrow();
		expect(complete.mock.calls[0]![2].signal!.aborted).toBe(true);
		expect(() => api.getAvailable()).toThrow("disposed");
		await expect(api.complete(configuredModel, context)).rejects.toThrow("disposed");
		expect(timers.size).toBe(0);
		work.resolve(answer);
		await work.promise;
	});

	it("cleans listeners on success and releases slots on synchronous and asynchronous failure", async () => {
		const controller = new AbortController();
		const added = spyOn(controller.signal, "addEventListener");
		const removed = spyOn(controller.signal, "removeEventListener");
		let invocation = 0;
		const { api } = harness(() => {
			if (++invocation === 1) throw new Error("sync failure");
			if (invocation === 2) return Promise.reject(new Error("async failure"));
			return Promise.resolve(answer);
		});
		try {
			await expect(api.complete(configuredModel, context)).rejects.toThrow("sync failure");
			await expect(api.complete(configuredModel, context)).rejects.toThrow("async failure");
			await expect(api.complete(configuredModel, context, { signal: controller.signal })).resolves.toEqual(answer);
			expect(removed.mock.calls[0]![1]).toBe(added.mock.calls[0]![1]);
			expect(timers.size).toBe(0);
		} finally { added.mockRestore(); removed.mockRestore(); }
	});
});
