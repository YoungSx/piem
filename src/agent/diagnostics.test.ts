import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { webcrypto } from "node:crypto";
import { clearTimeout as nativeClearTimeout, setTimeout as nativeSetTimeout } from "node:timers";
import { Event, EventTarget } from "happy-dom";
import type { App, DataAdapter, RequestUrlParam } from "obsidian";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { PiemSettings } from "../settings";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { installObsidianStub, requestUrlMock } from "../testUtils/obsidianStub";
import { stubWindowMembers } from "../testUtils/windowStub";

installObsidianStub();
const { ObsidianAgentService } = await import("./ObsidianAgentService");
const { ObsidianSessionManager } = await import("../session/ObsidianSessionManager");
const { CommunityHost } = await import("../extensions/communityHost");
const { normalizeSettings } = await import("../settings");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
	finally { requestUrlMock.mockReset(); }
});

async function until(check: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for diagnostics lifecycle");
		await new Promise(resolve => nativeSetTimeout(resolve, 5));
	}
}

function fixture(beforeReply?: (sequence: number) => Promise<void>) {
	const adapter = new MemoryAdapter() as unknown as DataAdapter;
	const settings = normalizeSettings({
		providers: [{ id: "diagnostics-provider", name: "Test", baseUrl: "https://model.invalid/v1", protocol: "openai-completions",
			apiKey: "private-provider-key", secretRef: "", source: "user", oauthFlow: "" }],
		models: [{ id: "configured", providerId: "diagnostics-provider", modelApiId: "fixture-model", displayName: "Test", reasoning: false, supportsImages: false }],
		activeModelId: "configured",
	});
	const app = {
		vault: { adapter, getName: () => "Diagnostics", getFiles: () => [], getFileByPath: () => null,
			getAbstractFileByPath: () => null, read: async () => "", cachedRead: async () => "" },
		workspace: { getActiveViewOfType: () => null, getActiveFile: () => null },
	} as unknown as App;
	const timers = new Map<number, ReturnType<typeof nativeSetTimeout>>();
	const target = new EventTarget();
	const services: InstanceType<typeof ObsidianAgentService>[] = [];
	const pending: Promise<void>[] = [];
	const receipts: Array<{ url: string; body: string }> = [];
	let nextTimer = 0, listeners = 0, sequence = 0, visibilityState = "visible";
	const lifecycle = {
		get visibilityState() { return visibilityState; },
		addEventListener: (...args: Parameters<EventTarget["addEventListener"]>) => { listeners++; target.addEventListener(...args); },
		removeEventListener: (...args: Parameters<EventTarget["removeEventListener"]>) => { listeners--; target.removeEventListener(...args); },
	};
	// React work from earlier tests can still need the real happy-dom document.
	// Override only lifecycle methods, leaving its DOM/cache internals intact.
	const nativeDocument = typeof window === "undefined" ? undefined : window.document;
	const descriptors = new Map(Object.keys(lifecycle).map(key => [key, nativeDocument && Object.getOwnPropertyDescriptor(nativeDocument, key)]));
	if (nativeDocument) Object.defineProperties(nativeDocument, Object.getOwnPropertyDescriptors(lifecycle));
	const restore = stubWindowMembers({
		crypto: webcrypto, performance,
		setTimeout: (callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
			const id = ++nextTimer;
			timers.set(id, nativeSetTimeout(() => { timers.delete(id); callback(...args); }, delay));
			return id;
		},
		clearTimeout: (id?: number) => {
			if (id === undefined) return;
			const timer = timers.get(id);
			if (timer !== undefined) nativeClearTimeout(timer);
			timers.delete(id);
		},
		...(!nativeDocument ? { document: lifecycle } : {}),
	});
	requestUrlMock.mockImplementation(async params => {
		const request = params as RequestUrlParam;
		receipts.push({ url: request.url, body: typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body) });
		return { status: 200, headers: { "content-type": "application/json" }, arrayBuffer: new TextEncoder().encode("{}").buffer };
	});
	const streamFn: StreamFn = (model, _context, options) => {
		const call = ++sequence;
		const message: AssistantMessage = {
			role: "assistant", content: [{ type: "text", text: `private reply ${call}` }], api: model.api,
			provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
			usage: { input: 3, output: 2, totalTokens: 5, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const stream = createAssistantMessageEventStream();
		pending.push((async () => {
			try {
				await options?.onPayload?.({ prompt: "private provider payload" }, model);
				await beforeReply?.(call);
				await options?.onResponse?.({ status: 200, headers: { "x-fixture": "private provider header" } }, model);
				stream.push({ type: "done", reason: "stop", message });
			} finally { stream.end(message); }
		})());
		return stream;
	};
	cleanups.push(async () => {
		try {
			services.forEach(service => service.dispose());
			await Promise.all(pending);
			await until(() => timers.size === 0 && listeners === 0);
		} finally {
			timers.forEach(timer => nativeClearTimeout(timer)); timers.clear(); restore();
			if (nativeDocument) for (const [key, descriptor] of descriptors) {
				if (descriptor) Object.defineProperty(nativeDocument, key, descriptor); else Reflect.deleteProperty(nativeDocument, key);
			}
		}
	});
	return {
		settings, receipts,
		get listenerCount() { return listeners; },
		get timerCount() { return timers.size; },
		hide() { visibilityState = "hidden"; target.dispatchEvent(new Event("visibilitychange")); },
		create(configuration: PiemSettings = settings) {
			const sessions = new ObsidianSessionManager(adapter, "Piem/sessions", "obsidian-vault:Diagnostics");
			// The production list compiles the unmodified upstream OTel factory.
			const service = new ObsidianAgentService(app, () => configuration, sessions, {
				streamFn, pluginVersion: "fixture-version", loadUserSkills: async () => ({ skills: [], diagnostics: [], searched: [] }),
			});
			services.push(service);
			return { service, sessions };
		},
	};
}

describe("diagnostics sharing in the real agent service", () => {
	it("defaults to the project gateway and exports three signals without prompt content or provider secrets", async () => {
		const f = fixture();
		const { service } = f.create();
		expect(f.settings.shareDiagnostics).toBe(true);
		expect(await service.sendPrompt("private prompt marker")).toBe(true);
		expect(f.listenerCount).toBe(4);
		service.dispose();
		await until(() => f.timerCount === 0 && f.listenerCount === 0);
		expect([...new Set(f.receipts.map(receipt => receipt.url))].sort()).toEqual([
			"https://otlp.piem.shangxin.me/v1/logs", "https://otlp.piem.shangxin.me/v1/metrics", "https://otlp.piem.shangxin.me/v1/traces",
		]);
		const bodies = f.receipts.map(receipt => receipt.body).join("\n");
		for (const value of ["pi.session.start", "pi.session.shutdown", "gen_ai.client.token.usage", "fixture-model", "fixture-version"]) expect(bodies).toContain(value);
		for (const value of ["private prompt marker", "private reply", "private-provider-key", "private provider payload", "private provider header"]) expect(bodies).not.toContain(value);
	});

	it("stops reporting for both visible and running background chats while both can continue", async () => {
		const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
		const f = fixture(async sequence => { if (sequence === 1) { started.resolve(); await release.promise; } });
		const { service, sessions } = f.create();
		const background = service.sendPrompt("Background question");
		try {
			await started.promise;
			const firstPath = service.getActiveSessionPath()!;
			await service.newSession();
			expect(await service.sendPrompt("Visible question")).toBe(true);
			expect(f.listenerCount).toBe(8);
			f.settings.shareDiagnostics = false;
			service.refreshDiagnostics();
			const sent = f.receipts.length;
			expect(f.listenerCount).toBe(0);
			release.resolve();
			expect(await background).toBe(true);
			expect(await service.sendPrompt("Visible follow-up")).toBe(true);
			await service.openSession(firstPath);
			expect(await service.sendPrompt("Background follow-up")).toBe(true);
			expect(await sessions.findOpenRunOperations()).toHaveLength(0);
			f.settings.shareDiagnostics = true;
			await service.refreshConfiguration();
			expect(await service.sendPrompt("Re-enabled before reload")).toBe(true);
			f.hide();
			service.dispose();
			await until(() => f.timerCount === 0);
			expect(f.receipts).toHaveLength(sent);
		} finally { release.resolve(); await background; }
	});

	it.each(["reject", "503"] as const)("keeps chatting when the diagnostics transport returns %s", async failure => {
		const f = fixture();
		const { service } = f.create();
		let attempts = 0;
		requestUrlMock.mockImplementation(async () => {
			attempts++;
			if (failure === "reject") throw new Error("Collector transport unavailable");
			return { status: 503, headers: {}, arrayBuffer: new ArrayBuffer(0) };
		});
		expect(await service.sendPrompt("First question")).toBe(true);
		f.hide();
		await until(() => attempts > 0);
		expect(await service.sendPrompt("Continue despite reporting failure")).toBe(true);
		expect(service.getSnapshot()).toMatchObject({ isStreaming: false, errorMessage: undefined });
		expect(JSON.stringify(service.getSnapshot().messages)).toContain("private reply 2");
		f.settings.shareDiagnostics = false;
		service.refreshDiagnostics();
		expect(f.listenerCount).toBe(0);
	});

	it("persists explicit off and only resumes sharing after the service reloads", async () => {
		const f = fixture();
		f.settings.shareDiagnostics = false;
		const saved = normalizeSettings(JSON.parse(JSON.stringify(f.settings)) as PiemSettings);
		const { service } = f.create(saved);
		expect(await service.sendPrompt("Saved preference")).toBe(true);
		expect(f.listenerCount).toBe(0);
		saved.shareDiagnostics = true;
		await service.refreshConfiguration();
		expect(await service.sendPrompt("Waiting for reload")).toBe(true);
		await service.newSession();
		expect(await service.sendPrompt("New chat before reload")).toBe(true);
		service.dispose();
		await until(() => f.timerCount === 0);
		expect(f.receipts).toEqual([]);
		const reloaded = f.create(saved).service;
		expect(await reloaded.sendPrompt("After reload")).toBe(true);
		expect(f.listenerCount).toBe(4);
		reloaded.dispose();
		await until(() => f.timerCount === 0 && f.listenerCount === 0);
		expect(f.receipts.length).toBeGreaterThan(0);
	});

	it("honors off while the default host is still being initialized", async () => {
		const f = fixture();
		const { service } = f.create();
		const loaded = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
		const create = CommunityHost.create.bind(CommunityHost);
		const spy = spyOn(CommunityHost, "create").mockImplementation(async (...args) => {
			const host = await create(...args);
			loaded.resolve();
			await release.promise;
			return host;
		});
		const initializing = service.initialize();
		try {
			await loaded.promise;
			f.settings.shareDiagnostics = false;
			service.refreshDiagnostics();
			release.resolve();
			await initializing;
			expect(await service.sendPrompt("Continue after initialization")).toBe(true);
			f.hide();
			service.dispose();
			await until(() => f.timerCount === 0);
			expect(f.listenerCount).toBe(0);
			expect(f.receipts).toEqual([]);
		} finally { release.resolve(); spy.mockRestore(); await initializing; }
	});
});
