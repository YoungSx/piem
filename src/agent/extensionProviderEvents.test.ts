import { afterAll, afterEach, describe, expect, it } from "bun:test";
import type { App, DataAdapter, RequestUrlParam } from "obsidian";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { installObsidianStub, requestUrlMock } from "../testUtils/obsidianStub";
import { stubWindowTimers } from "../testUtils/windowStub";

installObsidianStub();
afterAll(stubWindowTimers());
afterEach(() => requestUrlMock.mockReset());
const { ObsidianAgentService } = await import("./ObsidianAgentService");
const { ObsidianSessionManager } = await import("../session/ObsidianSessionManager");
const { DEFAULT_SETTINGS } = await import("../settings");

function harness(factory: ExtensionFactory, streamFn?: StreamFn) {
	const adapter = new MemoryAdapter() as unknown as DataAdapter;
	const sessions = new ObsidianSessionManager(adapter, "Piem/sessions", "obsidian-vault:Provider events");
	const settings = {
		...DEFAULT_SETTINGS, networkTransport: "requestUrl" as const, retry: { maxRetries: 0 },
		providers: [{ id: "provider-test", name: "Test", baseUrl: "https://provider-events.test/v1", protocol: "openai-completions" as const,
			apiKey: "provider-secret", secretRef: "", source: "user" as const, oauthFlow: "" as const }],
		models: [{ id: "model-test", providerId: "provider-test", modelApiId: "test", displayName: "Test", reasoning: false, supportsImages: false }],
		activeModelId: "model-test",
	};
	const app = {
		vault: { adapter, getName: () => "Provider events", getFiles: () => [], getFileByPath: () => null,
			getAbstractFileByPath: () => null, read: async () => "", cachedRead: async () => "" },
		workspace: { getActiveViewOfType: () => null, getActiveFile: () => null },
	} as unknown as App;
	const service = new ObsidianAgentService(app, () => settings, sessions, {
		streamFn,
		extensionFactories: [{ id: "provider-events", factory }],
		loadUserSkills: async () => ({ skills: [], diagnostics: [], searched: [] }),
	});
	return { service, sessions };
}

function response(text = "Reply", requestId = "server-id") {
	const frames = [
		{ id: "completion", choices: [{ delta: { content: text }, finish_reason: null }] },
		{ id: "completion", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
	];
	return { status: 200, headers: { "content-type": "text/event-stream", "request-id": requestId },
		arrayBuffer: new TextEncoder().encode(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n").buffer };
}

describe("provider callbacks in a real service request", () => {
	it("rewrites the actual HTTP body and observes headers before any assistant content", async () => {
		const order: string[] = [];
		const observed: unknown[] = [];
		const { service, sessions } = harness(pi => {
			pi.on("before_provider_request", (event, ctx) => {
				order.push("payload");
				observed.push({ event: structuredClone(event), model: ctx.model, branch: ctx.sessionManager.getBranch() });
				const payload = event.payload as { temperature?: number; user?: string };
				payload.temperature = 0.3;
				return { ...payload, user: "extension-tag" };
			});
			pi.on("after_provider_response", event => { order.push("response"); observed.push(structuredClone(event)); });
			pi.on("message_end", event => { if (event.message.role === "assistant") order.push("assistant"); });
		});
		let wire: RequestUrlParam | undefined;
		try {
			requestUrlMock.mockImplementation(async params => { order.push("http"); wire = params as RequestUrlParam; return response(); });
			expect(await service.sendPrompt("Hello")).toBe(true);
			expect(JSON.parse(wire!.body as string)).toMatchObject({ temperature: 0.3, user: "extension-tag" });
			expect(order).toEqual(["payload", "http", "response", "assistant"]);
			expect(observed[1]).toMatchObject({ type: "after_provider_response", status: 200, headers: { "request-id": "server-id" } });
			expect(JSON.stringify(observed)).not.toContain("provider-secret");
			expect(JSON.stringify(Reflect.get(observed[0] as object, "branch"))).toContain("Hello");
			expect(Object.entries(wire!.headers ?? {}).find(([key]) => key.toLowerCase() === "authorization")?.[1]).toBe("Bearer provider-secret");
			expect(JSON.stringify(service.getSnapshot().messages)).toContain("Reply");
			expect(await sessions.findOpenRunOperations()).toHaveLength(0);
		} finally { service.dispose(); }
	});

	it.each(["before_provider_request", "after_provider_response"] as const)("settles a failing %s callback and allows the following prompt", async event => {
		let fail = true;
		const { service, sessions } = harness(pi => {
			const handler = () => { if (fail) throw new Error("Provider handler exploded"); };
			if (event === "before_provider_request") pi.on("before_provider_request", handler);
			else pi.on("after_provider_response", handler);
		});
		try {
			requestUrlMock.mockResolvedValue(response());
			await service.sendPrompt("Fails");
			expect(requestUrlMock).toHaveBeenCalledTimes(event === "before_provider_request" ? 0 : 1);
			expect(service.getSnapshot().isStreaming).toBe(false);
			expect(JSON.stringify(service.getSnapshot().messages)).toContain("Provider handler exploded");
			expect(await sessions.findOpenRunOperations()).toHaveLength(0);
			fail = false;
			expect(await service.sendPrompt("Works next")).toBe(true);
			expect(JSON.stringify(service.getSnapshot().messages)).toContain("Reply");
			expect(await sessions.findOpenRunOperations()).toHaveLength(0);
		} finally { service.dispose(); }
	});

	it("prevents HTTP after Stop overtakes a waiting payload callback", async () => {
		const entered = Promise.withResolvers<void>();
		const held = Promise.withResolvers<void>();
		let wait = true;
		let staleRead: (() => unknown) | undefined;
		const { service, sessions } = harness(pi => { pi.on("before_provider_request", async (_event, ctx) => {
			if (!wait) return;
			staleRead = () => ctx.sessionManager.getSessionId();
			entered.resolve();
			await held.promise;
			return { late: true };
		}); });
		try {
			requestUrlMock.mockResolvedValue(response());
			const pending = service.sendPrompt("Stop before sending");
			await entered.promise;
			await service.abortSession(service.getActiveSessionPath()!);
			await pending;
			expect(requestUrlMock).not.toHaveBeenCalled();
			expect(staleRead).toThrow();
			expect(service.getSnapshot().isStreaming).toBe(false);
			expect(await sessions.findOpenRunOperations()).toHaveLength(0);
			wait = false;
			held.resolve();
			expect(await service.sendPrompt("Fresh request")).toBe(true);
			expect(requestUrlMock).toHaveBeenCalledTimes(1);
		} finally { held.resolve(); service.dispose(); }
	});

	it("keeps concurrent replies attached to their original sessions after focus changes", async () => {
		const entered = Promise.withResolvers<void>();
		const held = Promise.withResolvers<ReturnType<typeof response>>();
		const seen: Array<{ id: string; requestId: string | undefined }> = [];
		const { service, sessions } = harness(pi => { pi.on("after_provider_response", (event, ctx) => {
			seen.push({ id: ctx.sessionManager.getSessionId(), requestId: event.headers["request-id"] });
		}); });
		let requests = 0;
		try {
			requestUrlMock.mockImplementation(() => { if (++requests === 1) { entered.resolve(); return held.promise; } return Promise.resolve(response("Second reply", "second")); });
			const first = service.sendPrompt("First chat");
			await entered.promise;
			const firstPath = service.getActiveSessionPath()!;
			const firstId = (await sessions.getActiveSessionInfo()).id;
			await service.newSession();
			expect(await service.sendPrompt("Second chat")).toBe(true);
			const secondId = (await sessions.getActiveSessionInfo()).id;
			held.resolve(response("First reply", "first"));
			await first;
			expect(seen).toEqual([{ id: secondId, requestId: "second" }, { id: firstId, requestId: "first" }]);
			expect(JSON.stringify(service.getSnapshot().messages)).toContain("Second reply");
			expect(JSON.stringify(service.getSnapshot().messages)).not.toContain("First reply");
			await service.openSession(firstPath);
			expect(JSON.stringify(service.getSnapshot().messages)).toContain("First reply");
			expect(await sessions.findOpenRunOperations()).toHaveLength(0);
		} finally { held.resolve(response()); service.dispose(); }
	});

	it("does not let a retired request's callbacks enter the next run", async () => {
		const firstEntered = Promise.withResolvers<void>();
		const secondEntered = Promise.withResolvers<void>();
		const releaseSecond = Promise.withResolvers<void>();
		const pending: Promise<void>[] = [];
		const captured: SimpleStreamOptions[] = [];
		let events = 0;
		const streamFn: StreamFn = (model, _context, options) => {
			captured.push(options!);
			const sequence = captured.length;
			const stream = createAssistantMessageEventStream();
			const finish = (reason: "stop" | "aborted") => {
				const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "Reply" }],
					api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: reason,
					usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				stream.end(message);
			};
			if (sequence === 1) {
				options!.signal!.addEventListener("abort", () => finish("aborted"), { once: true });
				firstEntered.resolve();
			} else {
				secondEntered.resolve();
				pending.push(releaseSecond.promise.then(() => finish("stop")));
			}
			return stream;
		};
		const { service } = harness(pi => {
			pi.on("before_provider_request", () => { events++; });
			pi.on("after_provider_response", () => { events++; });
		}, streamFn);
		try {
			const first = service.sendPrompt("First");
			await firstEntered.promise;
			await service.abortSession(service.getActiveSessionPath()!);
			await first;
			const second = service.sendPrompt("Second");
			await secondEntered.promise;
			// Model is deliberately never forwarded by the bridge; these callbacks
			// can be tested with the provider's unused second argument omitted.
			const old = captured[0]!;
			await expect(Reflect.apply(old.onPayload!, undefined, [{}])).rejects.toMatchObject({ name: "AbortError" });
			await Reflect.apply(old.onResponse!, undefined, [{ status: 200, headers: {} }]);
			expect(events).toBe(0);
			releaseSecond.resolve();
			await second;
		} finally { releaseSecond.resolve(); service.dispose(); await Promise.all(pending); }
	});
});
