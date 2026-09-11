import { afterAll, afterEach, describe, expect, it } from "bun:test";
import type { App, DataAdapter } from "obsidian";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { installObsidianStub, requestUrlMock } from "../testUtils/obsidianStub";
import { stubWindowTimers } from "../testUtils/windowStub";

installObsidianStub();
afterAll(stubWindowTimers());
afterEach(() => requestUrlMock.mockReset());
const { ObsidianAgentService } = await import("./ObsidianAgentService");
const { ObsidianSessionManager } = await import("../session/ObsidianSessionManager");
const { DEFAULT_SETTINGS } = await import("../settings");
type SessionCompactFailedEvent = Extract<ExtensionEvent, { type: "session_compact_failed" }>;

function harness(factory: ExtensionFactory, tokens = 4) {
	const adapter = new MemoryAdapter();
	const sessions = new ObsidianSessionManager(adapter as unknown as DataAdapter, "Piem/sessions", "obsidian-vault:Compaction");
	const settings = {
		...DEFAULT_SETTINGS, networkTransport: "requestUrl" as const,
		providers: [{ id: "test", name: "Test", baseUrl: "https://compaction.test/v1", protocol: "openai-completions" as const,
			apiKey: "test-key", secretRef: "", source: "user" as const, oauthFlow: "" as const }],
		models: [{ id: "test", providerId: "test", modelApiId: "test", displayName: "Test", reasoning: false, supportsImages: false, contextWindow: 32_000 }],
		activeModelId: "test", compaction: { reserveTokens: 1024, keepRecentTokens: 1024 },
	};
	const app = {
		vault: { adapter, getName: () => "Compaction", getFiles: () => [], getFileByPath: () => null,
			getAbstractFileByPath: () => null, read: async () => "", cachedRead: async () => "" },
		workspace: { getActiveViewOfType: () => null, getActiveFile: () => null },
	} as unknown as App;
	const requests: Context[] = [];
	const streamFn: StreamFn = (model, context) => {
		requests.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) });
		const message: AssistantMessage = {
			role: "assistant", content: [{ type: "text", text: "Reply" }], api: model.api, provider: model.provider,
			model: model.id, timestamp: Date.now(), stopReason: "stop",
			usage: { input: tokens - 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: tokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
		return stream;
	};
	const service = new ObsidianAgentService(app, () => settings, sessions, {
		streamFn, extensionFactories: [{ id: "compaction-test", factory }],
		loadUserSkills: async () => ({ skills: [], diagnostics: [], searched: [] }),
	});
	return { service, sessions, adapter, requests };
}

function summaryResponse() {
	const frames = [
		{ id: "c1", choices: [{ delta: { content: "SUMMARY" }, finish_reason: null }] },
		{ id: "c1", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } },
	];
	return { status: 200, headers: { "content-type": "text/event-stream" },
		arrayBuffer: new TextEncoder().encode(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n").buffer };
}

describe("extension compaction failure observations", () => {
	it("reports one manual failure and delivers ctx.compact onError inside a command", async () => {
		const seen: SessionCompactFailedEvent[] = [];
		const errors: string[] = [];
		const completed = Promise.withResolvers<void>();
		const observed = Promise.withResolvers<void>();
		const { service } = harness(pi => {
			pi.on("session_compact_failed", event => { seen.push(event); observed.resolve(); });
			pi.registerCommand("tidy", { handler: async (_args, ctx) => { ctx.compact({ onError: error => { errors.push(error.message); completed.resolve(); } }); } });
		});
		try {
			await service.sendPrompt("Hello");
			requestUrlMock.mockResolvedValue({ status: 400, headers: {}, arrayBuffer: new TextEncoder().encode("summary rejected").buffer });
			expect(await service.runExtensionCommand("tidy")).toBe(true);
			await Promise.all([completed.promise, observed.promise]);
			expect(seen).toHaveLength(1);
			expect(seen[0]).toMatchObject({ type: "session_compact_failed", reason: "manual", aborted: false, willRetry: false, fromExtension: false });
			expect(seen[0]?.errorMessage).toContain("summary rejected");
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain("summary rejected");
		} finally { service.dispose(); }
	});

	it("reports threshold failures without letting a broken observer block the next prompt", async () => {
		const seen: SessionCompactFailedEvent[] = [];
		const { service, requests } = harness(pi => {
			pi.on("session_compact_failed", event => { seen.push(event); throw new Error("observer failed"); });
		}, 31_000);
		try {
			requestUrlMock.mockResolvedValue({ status: 400, headers: {}, arrayBuffer: new TextEncoder().encode("summary rejected").buffer });
			await service.sendPrompt("First");
			expect(await service.sendPrompt("Second")).toBe(true);
			expect(requests).toHaveLength(2);
			expect(seen).toHaveLength(1);
			expect(seen[0]).toMatchObject({ reason: "threshold", aborted: false, willRetry: false, fromExtension: false });
		} finally { service.dispose(); }
	});

	it("reports user cancellation once without an error message or failed row", async () => {
		const seen: SessionCompactFailedEvent[] = [];
		const { service } = harness(pi => { pi.on("session_compact_failed", event => { seen.push(event); }); });
		let release!: () => void;
		const entered = Promise.withResolvers<void>();
		try {
			await service.sendPrompt("Hello");
			requestUrlMock.mockImplementation(() => new Promise((_resolve, reject) => {
				release = () => reject(new DOMException("The request was aborted.", "AbortError")); entered.resolve();
			}));
			const compacting = service.compactNow();
			await entered.promise;
			await service.abortSession(service.getActiveSessionPath()!);
			release();
			await compacting;
			expect(seen).toEqual([{ type: "session_compact_failed", reason: "manual", aborted: true, willRetry: false, fromExtension: false }]);
			expect(service.getSnapshot().compactionEvent).toBeNull();
		} finally { release?.(); service.dispose(); }
	});

	it("reports a persistence failure without replacing the live transcript", async () => {
		const seen: SessionCompactFailedEvent[] = [];
		const { service, adapter } = harness(pi => { pi.on("session_compact_failed", event => { seen.push(event); }); });
		try {
			await service.sendPrompt("Hello");
			const original = structuredClone(service.getSnapshot().messages);
			requestUrlMock.mockResolvedValue(summaryResponse());
			const append = adapter.append.bind(adapter);
			adapter.append = async (path, data) => {
				if (data.includes('"type":"compaction"')) throw new Error("Disk full");
				await append(path, data);
			};
			await service.compactNow();
			expect(seen).toHaveLength(1);
			expect(seen[0]?.errorMessage).toContain("Disk full");
			expect(service.getSnapshot().messages).toEqual(original);
		} finally { service.dispose(); }
	});

	it("does not report a failure for a skipped or successful compaction", async () => {
		const seen: SessionCompactFailedEvent[] = [];
		const { service } = harness(pi => { pi.on("session_compact_failed", event => { seen.push(event); }); });
		try {
			await service.compactNow();
			await service.sendPrompt("Hello");
			requestUrlMock.mockResolvedValue(summaryResponse());
			await service.compactNow();
			expect(service.getSnapshot().messages[0]?.role).toBe("compactionSummary");
			expect(seen).toHaveLength(0);
		} finally { service.dispose(); }
	});

	it("lets a failure observer await a retry without waiting on its own attempt", async () => {
		let failures = 0;
		let retryError = "";
		const { service } = harness(pi => {
			pi.on("session_compact_failed", async (_event, ctx) => {
				if (++failures === 1) await new Promise<void>(resolve => {
					ctx.compact({ onError: error => { retryError = error.message; resolve(); } });
				});
			});
		});
		try {
			await service.sendPrompt("Hello");
			requestUrlMock.mockResolvedValue({ status: 400, headers: {}, arrayBuffer: new ArrayBuffer(0) });
			await service.compactNow();
			expect(retryError).not.toBe("");
			expect(failures).toBe(2);
		} finally { service.dispose(); }
	});

	it("delivers a failure observer's follow-up after its triggering command returned", async () => {
		const entered = Promise.withResolvers<void>();
		const response = Promise.withResolvers<{ status: number; headers: Record<string, string>; arrayBuffer: ArrayBufferLike }>();
		const continued = Promise.withResolvers<void>();
		let failures = 0;
		let replies = 0;
		const { service, requests } = harness(pi => {
			pi.registerCommand("tidy", { handler: async (_args, ctx) => { ctx.compact({ onError: () => {} }); } });
			pi.on("session_compact_failed", () => {
				if (++failures === 1) pi.sendUserMessage("Explain the failed summary", { deliverAs: "followUp" });
			});
			pi.on("message_end", event => { if (event.message.role === "assistant" && ++replies === 2) continued.resolve(); });
		});
		try {
			await service.sendPrompt("Hello");
			requestUrlMock.mockImplementation(() => { entered.resolve(); return response.promise; });
			expect(await service.runExtensionCommand("tidy")).toBe(true);
			await entered.promise;
			response.resolve({ status: 400, headers: {}, arrayBuffer: new TextEncoder().encode("summary rejected").buffer });
			await continued.promise;
			expect(requests).toHaveLength(2);
			expect(JSON.stringify(requests[1]?.messages)).toContain("Explain the failed summary");
		} finally { response.resolve({ status: 400, headers: {}, arrayBuffer: new ArrayBuffer(0) }); service.dispose(); }
	});

	it("emits cancellation after a command's aborted operation releases, with old callbacks still revoked", async () => {
		const entered = Promise.withResolvers<void>();
		const response = Promise.withResolvers<never>();
		const seen: SessionCompactFailedEvent[] = [];
		let staleRead: (() => unknown) | undefined;
		const { service } = harness(pi => {
			pi.on("session_compact_failed", event => { seen.push(event); });
			pi.registerCommand("tidy", { handler: async (_args, ctx) => {
				staleRead = () => ctx.sessionManager.getBranch();
				ctx.compact({ onError: () => {} });
				await response.promise;
			} });
		});
		try {
			await service.sendPrompt("Hello");
			requestUrlMock.mockImplementation(() => { entered.resolve(); return response.promise; });
			const command = service.runExtensionCommand("tidy");
			await entered.promise;
			const joining = service.compactNow();
			await service.abortSession(service.getActiveSessionPath()!);
			response.reject(new DOMException("The request was aborted.", "AbortError"));
			await Promise.all([joining, command]);
			expect(seen).toEqual([{ type: "session_compact_failed", reason: "manual", aborted: true, willRetry: false, fromExtension: false }]);
			expect(staleRead).toThrow();
		} finally { response.reject(new DOMException("Cancelled", "AbortError")); service.dispose(); }
	});
});
