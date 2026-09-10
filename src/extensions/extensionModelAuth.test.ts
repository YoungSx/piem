import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { stubWindowMembers } from "../testUtils/windowStub";
import { complete } from "./compat/piAI";
import { ExtensionLifetime } from "./extensionLifetime";
import { EXTENSION_AUTH_CAPABILITY_LIMIT } from "./extensionModelAuth";
import { createExtensionModels, type ExtensionComplete } from "./extensionModels";

const configured: Model<string> = {
	id: "configured", name: "Configured", provider: "provider", api: "openai-completions",
	baseUrl: "https://configured.example/v1", headers: { Authorization: "private-key" },
	reasoning: true, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768, maxTokens: 8_192,
};
const context: Context = { messages: [{ role: "user", content: "A note", timestamp: 0 }] };
const answer: AssistantMessage = {
	role: "assistant", content: [{ type: "text", text: "A result" }], api: configured.api,
	provider: configured.provider, model: configured.id, stopReason: "stop", timestamp: 0,
	usage: { input: 2, output: 1, totalTokens: 3, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};
const cleanup = new Set<() => void>();
const timers = new Map<number, { callback: () => void; delay: number }>();
let restoreTimers: () => void;
beforeEach(() => {
	let id = 0;
	restoreTimers = stubWindowMembers({
		setTimeout: (callback: () => void, delay: number) => { timers.set(++id, { callback, delay }); return id; },
		clearTimeout: (id: number) => { timers.delete(id); },
	});
});
afterEach(() => {
	for (const close of cleanup) close();
	cleanup.clear(); restoreTimers(); timers.clear();
});

function harness(implementation: ExtensionComplete = async () => answer) {
	const lifetime = new ExtensionLifetime();
	const models = [structuredClone(configured)];
	const transport = mock(implementation);
	let closing = false;
	const api = createExtensionModels({
		lifetime, getModels: () => models, complete: transport,
		assertAvailable: () => lifetime.assertActive(),
		assertCanComplete: () => { lifetime.assertActive(); if (closing) throw new Error("Extension host was disposed."); },
	});
	cleanup.add(() => { api.revokeAuth(); lifetime.dispose(); });
	return {
		api, lifetime, transport, models,
		close: () => { closing = true; api.revokeAuth(); lifetime.revoke(); },
	};
}

function deferred() {
	let resolve!: (value: AssistantMessage) => void;
	const promise = new Promise<AssistantMessage>(yes => { resolve = yes; });
	return { promise, resolve };
}

describe("Pi complete compatibility", () => {
	it("passes opaque auth through unchanged and reuses it with a freshly cloned current model", async () => {
		const { api, lifetime, transport } = harness();
		await lifetime.run(async scope => {
			const model = api.snapshot(configured);
			const auth = await api.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(auth.error);
			expect(auth.apiKey).not.toContain("private-key");
			expect(auth.headers).toEqual({});
			expect(model.headers).toBeUndefined();
			const legacyKey = await lifetime.withScope(scope, () => api.getApiKey(api.find(configured.provider, configured.id)!));
			expect(legacyKey).toBe(auth.apiKey);
			const currentModel = api.snapshot(configured);
			expect(currentModel).not.toBe(model);
			await expect(complete(currentModel, context, { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 64 })).resolves.toEqual(answer);
			await expect(complete({ ...currentModel, baseUrl: "https://tampered.example", headers: { Authorization: "fake" } }, context, { apiKey: legacyKey })).resolves.toEqual(answer);
		});
		expect(transport).toHaveBeenCalledTimes(2);
		expect(transport.mock.calls.every(([model]) => model.baseUrl === configured.baseUrl && model.headers?.Authorization === "private-key")).toBe(true);
		expect(transport.mock.calls[0]![2]).toMatchObject({ maxTokens: 64 });
		expect(transport.mock.calls.every(([, , options]) => options.apiKey === undefined && options.headers === undefined)).toBe(true);
		expect(timers.size).toBe(0);
	});

	it("routes simultaneous conversation requests by credentials and rejects crossed snapshots and headers", async () => {
		const a = harness(), b = harness(async () => ({ ...answer, content: [{ type: "text", text: "B" }] }));
		const modelA = a.api.getAvailable()[0]!, modelB = b.api.getAvailable()[0]!;
		const authA = await a.api.getApiKeyAndHeaders(modelA), authB = await b.api.getApiKeyAndHeaders(modelB);
		if (!authA.ok || !authB.ok) throw new Error("Expected configured auth");
		await expect(complete(modelB, context, { apiKey: authA.apiKey })).rejects.toThrow("another conversation");
		await expect(complete(modelA, context, { apiKey: authB.apiKey })).rejects.toThrow("another conversation");
		await expect(complete(modelA, context, { apiKey: authA.apiKey, headers: authB.headers })).rejects.toThrow("another conversation");
		await expect(b.api.getApiKey(modelA)).rejects.toThrow("another conversation");
		const result = await Promise.all([
			complete(a.api.snapshot(configured), context, { apiKey: authA.apiKey }),
			complete(b.api.snapshot(configured), context, { apiKey: authB.apiKey, headers: { ...authB.headers } }),
		]);
		expect(result.map(message => message.content)).toEqual([answer.content, [{ type: "text", text: "B" }]]);
		expect(a.transport).toHaveBeenCalledTimes(1);
		expect(b.transport).toHaveBeenCalledTimes(1);
	});

	it("rejects missing auth, model changes, removed models and arbitrary auth or transport overrides", async () => {
		const { api, transport, models } = harness();
		models.push({ ...configured, id: "second" });
		const model = api.getAvailable()[0]!, other = api.getAvailable()[1]!;
		const apiKey = await api.getApiKey(model);
		await expect(complete(model, context)).rejects.toThrow("current modelRegistry auth capability");
		await expect(complete(model, context, { apiKey: "an-actual-API-key" })).rejects.toThrow("current modelRegistry auth capability");
		await expect(complete(other, context, { apiKey })).rejects.toThrow("another model");
		for (const headers of [{ Authorization: "replacement" }, { "x-custom": "value" }, { Authorization: null }, []]) {
			await expect(complete(model, context, { apiKey, headers: headers as unknown as Record<string, string | null> })).rejects.toThrow("unchanged modelRegistry auth headers");
		}
		for (const key of ["baseUrl", "env", "fetch", "onPayload", "transformHeaders", "futureOption"]) {
			await expect(complete(model, context, { apiKey, [key]: "override" })).rejects.toThrow(`extension model option ${key}`);
		}
		models.length = 0;
		await expect(complete(model, context, { apiKey })).rejects.toThrow("configured, unambiguous");
		await expect(api.getApiKey(model)).resolves.toBeUndefined();
		await expect(api.getApiKeyAndHeaders(model)).resolves.toMatchObject({ ok: false });
		expect(transport).not.toHaveBeenCalled();
	});

	it("keeps the originating callback scope across awaits and never falls back to a newer invocation", async () => {
		const { api, lifetime, transport } = harness();
		const wait = deferred();
		let retained: string | undefined;
		const model = api.snapshot(configured);
		const old = lifetime.run(async () => {
			retained = await api.getApiKey(model);
			await wait.promise;
			return complete(api.snapshot(configured), context, { apiKey: retained });
		});
		await Promise.resolve();
		lifetime.cancel();
		await expect(old).rejects.toMatchObject({ name: "AbortError" });
		await expect(complete(model, context, { apiKey: retained })).rejects.toThrow("current modelRegistry auth capability");
		await lifetime.run(async () => {
			const apiKey = await api.getApiKey(model);
			await expect(complete(model, context, { apiKey })).resolves.toEqual(answer);
		});
		wait.resolve(answer);
		await wait.promise;
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it("snapshots model identity before an accessor can select a different configured model", async () => {
		const { api, models, transport } = harness();
		models.push({ ...configured, id: "second" });
		const model = api.snapshot(configured), apiKey = await api.getApiKey(model);
		let reads = 0;
		const selector = { ...model, get id() { return ++reads <= 2 ? configured.id : "second"; } };
		await complete(selector, context, { apiKey });
		expect(transport.mock.calls[0]![0].id).toBe(configured.id);
	});

	it("does not dispatch an already aborted caller and aborts active transport on Stop", async () => {
		const work = deferred();
		const { api, lifetime, transport } = harness(() => work.promise);
		const model = api.snapshot(configured), apiKey = await api.getApiKey(model);
		const caller = new AbortController(); caller.abort();
		await expect(complete(model, context, { apiKey, signal: caller.signal })).rejects.toMatchObject({ name: "AbortError" });
		expect(transport).not.toHaveBeenCalled();
		const pending = complete(model, context, { apiKey });
		await Promise.resolve();
		api.revokeAuth(); lifetime.cancel();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(transport.mock.calls[0]![2].signal!.aborted).toBe(true);
		await expect(complete(model, context, { apiKey })).rejects.toThrow("current modelRegistry auth capability");
		expect(timers.size).toBe(0);
		work.resolve(answer); await work.promise;
	});

	it("reuses per-conversation limits and keeps slots occupied until cancelled transports settle", async () => {
		const work = deferred();
		const { api, lifetime, transport } = harness(() => work.promise);
		const model = api.snapshot(configured), apiKey = await api.getApiKey(model);
		const first = complete(model, context, { apiKey }), second = api.complete(model, context);
		const settled = Promise.allSettled([first, second]);
		await expect(complete(model, context, { apiKey })).rejects.toThrow("At most 2");
		expect(transport).toHaveBeenCalledTimes(2);
		lifetime.cancel(); api.revokeAuth();
		expect((await settled).map(item => item.status)).toEqual(["rejected", "rejected"]);
		const freshKey = await api.getApiKey(model);
		await expect(complete(model, context, { apiKey: freshKey })).rejects.toThrow("At most 2");
		work.resolve(answer); await work.promise; await Promise.resolve();
		await expect(complete(model, context, { apiKey: freshKey })).resolves.toEqual(answer);
	});

	it("applies the existing timeout and releases timers after a facade request", async () => {
		const work = deferred();
		const { api, transport } = harness(() => work.promise);
		const model = api.snapshot(configured), apiKey = await api.getApiKey(model);
		const pending = complete(model, context, { apiKey });
		await Promise.resolve();
		const timer = [...timers.values()][0]!;
		expect(timer.delay).toBe(60_000); timer.callback();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(transport.mock.calls[0]![2].signal!.aborted).toBe(true);
		expect(timers.size).toBe(0);
		work.resolve(answer); await work.promise;
	});

	it("revokes completed callback credentials on detach and forbids issuing credentials during shutdown", async () => {
		const { api, lifetime, close, transport } = harness();
		const model = api.snapshot(configured);
		const key = await lifetime.run(async () => api.getApiKey(model));
		api.revokeAuth();
		await expect(complete(model, context, { apiKey: key })).rejects.toThrow("current modelRegistry auth capability");
		const current = await api.getApiKey(model);
		close();
		await expect(complete(model, context, { apiKey: current })).rejects.toThrow("current modelRegistry auth capability");
		await expect(api.getApiKey(model)).rejects.toThrow("disposed");
		await expect(api.complete(model, context)).rejects.toThrow("disposed");
		expect(api.getAvailable()).toHaveLength(1);
		lifetime.dispose();
		await expect(api.getApiKey(model)).rejects.toThrow("disposed");
		expect(transport).not.toHaveBeenCalled();
	});

	it("removes captured-scope abort listeners and retired credentials on direct disposal", async () => {
		const { api, lifetime, transport } = harness();
		const model = api.snapshot(configured);
		let key: string | undefined;
		await lifetime.run(async scope => {
			const added = spyOn(scope.signal, "addEventListener");
			const removed = spyOn(scope.signal, "removeEventListener");
			try {
				await api.getApiKey(model);
				const listener = added.mock.calls[0]![1];
				api.revokeAuth();
				expect(removed.mock.calls.some(call => call[1] === listener)).toBe(true);
			} finally { added.mockRestore(); removed.mockRestore(); }
		});
		key = await lifetime.run(async () => api.getApiKey(model));
		lifetime.dispose();
		await expect(complete(model, context, { apiKey: key })).rejects.toThrow("current modelRegistry auth capability");
		expect(transport).not.toHaveBeenCalled();
	});

	it("bounds retained credentials, preserves old credentials at the limit and reclaims on cancellation", async () => {
		const { api, lifetime } = harness();
		const model = api.snapshot(configured);
		const keys: string[] = [];
		for (let i = 0; i < EXTENSION_AUTH_CAPABILITY_LIMIT; i++) {
			keys.push((await lifetime.run(async () => api.getApiKey(model)))!);
		}
		await expect(lifetime.run(async () => api.getApiKey(model))).rejects.toThrow(`At most ${EXTENSION_AUTH_CAPABILITY_LIMIT}`);
		await expect(complete(model, context, { apiKey: keys[0] })).resolves.toEqual(answer);
		api.revokeAuth();
		await expect(complete(model, context, { apiKey: keys.at(-1) })).rejects.toThrow("current modelRegistry auth capability");
		await expect(lifetime.run(async () => api.getApiKey(model))).resolves.toBeString();
	});
});
