import { afterAll, afterEach, describe, expect, it } from "bun:test";
import type { App, DataAdapter, RequestUrlParam } from "obsidian";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CommunityExtension } from "../extensions/communityHost";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { installObsidianStub, requestUrlMock } from "../testUtils/obsidianStub";
import { stubWindowTimers } from "../testUtils/windowStub";

installObsidianStub();
afterAll(stubWindowTimers());
afterEach(() => requestUrlMock.mockReset());
const { ObsidianAgentService } = await import("./ObsidianAgentService");
const { ObsidianSessionManager } = await import("../session/ObsidianSessionManager");
const { DEFAULT_SETTINGS } = await import("../settings");

function harness(extension: CommunityExtension) {
	const adapter = new MemoryAdapter() as unknown as DataAdapter;
	const sessions = new ObsidianSessionManager(adapter, "Piem/sessions", "obsidian-vault:Shutdown");
	const settings = {
		...DEFAULT_SETTINGS,
		providers: [{ id: "shutdown-provider", name: "Test", baseUrl: "https://shutdown.test/v1", protocol: "openai-completions" as const,
			apiKey: "provider-secret", secretRef: "", source: "user" as const, oauthFlow: "" as const }],
		models: [{ id: "configured", providerId: "shutdown-provider", modelApiId: "test-model", displayName: "Test", reasoning: true, supportsImages: false }],
		activeModelId: "configured",
	};
	const app = {
		vault: { adapter, getName: () => "Shutdown", getFiles: () => [], getFileByPath: () => null,
			getAbstractFileByPath: () => null, read: async () => "", cachedRead: async () => "" },
		workspace: { getActiveViewOfType: () => null, getActiveFile: () => null },
	} as unknown as App;
	const streamFn: StreamFn = model => {
		const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "Reply" }], api: model.api,
			provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
			usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
		return stream;
	};
	const service = new ObsidianAgentService(app, () => settings, sessions, {
		streamFn, extensionFactories: [extension], loadUserSkills: async () => ({ skills: [], diagnostics: [], searched: [] }),
	});
	return { service, sessions };
}

describe("shutdown after the real service retires its sessions", () => {
	it("reads safe session metadata and flushes after service.dispose while retained actions stay revoked", async () => {
		const done = Promise.withResolvers<void>();
		const flushes: RequestUrlParam[] = [];
		let current!: ExtensionContext;
		let shutdown!: ExtensionContext;
		let failure: unknown;
		let observed: unknown;
		const { service, sessions } = harness({
			id: "shutdown", createFactory: platform => pi => {
				pi.on("session_start", (_event, ctx) => { current = ctx; });
				pi.on("session_shutdown", async (_event, ctx) => {
					shutdown = ctx;
					try {
						expect(() => current.sessionManager.getSessionId()).toThrow();
						expect(() => pi.setSessionName("Too late")).toThrow();
						expect(() => ctx.compact()).toThrow();
						observed = { id: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile(), name: ctx.sessionManager.getSessionName(),
							model: ctx.model, thinking: ctx.thinkingLevel, cwd: ctx.cwd, system: ctx.getSystemPrompt(),
							models: ctx.modelRegistry.getAvailable() };
						expect(ctx.signal?.aborted).toBe(false);
						await expect(ctx.modelRegistry.complete(ctx.model!, { messages: [] })).rejects.toThrow("disposed");
						await platform.fetch("https://collector.test/flush", { method: "POST", body: JSON.stringify(observed) });
					} catch (error) { failure = error; }
					finally { done.resolve(); }
				});
			},
		});
		try {
			requestUrlMock.mockImplementation(async params => { flushes.push(params as RequestUrlParam); return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0) }; });
			await service.sendPrompt("First question");
			await service.renameSession("Latest session name");
			await service.setThinkingLevel("high");
			await service.sendPrompt("Second question");
			const info = await sessions.getActiveSessionInfo();
			service.dispose();
			await done.promise;
			expect(failure).toBeUndefined();
			expect(flushes).toHaveLength(1);
			expect(observed).toMatchObject({ id: info.id, file: info.path, name: "Latest session name", thinking: "high", cwd: "/vault",
				model: { id: "test-model", provider: "shutdown-provider" } });
			expect(JSON.stringify(observed)).not.toContain("provider-secret");
			expect(flushes[0]?.url).toBe("https://collector.test/flush");
			expect(flushes[0]?.body).toBe(JSON.stringify(observed));
			// Cleanup finishes asynchronously but still revokes the fresh read view.
			for (let i = 0; i < 12; i++) await Promise.resolve();
			expect(() => shutdown.sessionManager.getSessionId()).toThrow();
		} finally { service.dispose(); }
	});

	it("keeps shutdown identities separate when two sessions are retired together", async () => {
		const done = Promise.withResolvers<void>();
		const ids: string[] = [];
		const failures: unknown[] = [];
		const { service, sessions } = harness({ id: "shutdown-ids", factory: pi => {
			pi.on("session_shutdown", (_event, ctx) => {
				try { ids.push(ctx.sessionManager.getSessionId()); }
				catch (error) { failures.push(error); }
				finally { if (ids.length + failures.length === 2) done.resolve(); }
			});
		} });
		try {
			await service.sendPrompt("First session");
			const first = (await sessions.getActiveSessionInfo()).id;
			await service.newSession();
			await service.sendPrompt("Second session");
			const second = (await sessions.getActiveSessionInfo()).id;
			service.dispose();
			await done.promise;
			expect(failures).toEqual([]);
			expect(ids.sort()).toEqual([first, second].sort());
		} finally { service.dispose(); }
	});
});
