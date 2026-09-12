import { afterEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PiemSettings } from "./settings";
import type { ChatSnapshot } from "./agent/ObsidianAgentService";
import { installDom } from "./testUtils/dom";
import { MemoryAdapter } from "./testUtils/memoryAdapter";
import { createObsidianHostModule, createStubApp, type PluginHostRecord } from "./testUtils/pluginLoader";
import { loadBrowserPluginBundle } from "./testUtils/browserPluginLoader";

installDom();
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const mobile = { isDesktop: false, isDesktopApp: false, isMobile: true, isMobileApp: true, isIosApp: true, isAndroidApp: false };
interface Service {
	initialize(): Promise<void>;
	sendPrompt(text: string): Promise<boolean>;
	runExtensionCommand(name: string, args?: string): Promise<boolean>;
	getSnapshot(): ChatSnapshot;
	getActiveSessionPath(): string;
	openSession(path: string): Promise<void>;
	newSession(): Promise<void>;
	abortSession(path: string): Promise<void>;
}
interface Plugin {
	onload(): Promise<void>;
	onunload(): void;
	settings: PiemSettings;
	saveSettings(options?: { reconfigure?: boolean }): Promise<void>;
	saveData(data: unknown): Promise<void>;
	loadData(): Promise<unknown>;
	agentService: Service;
	sessionManager: {
		buildSessionContextFor(path: string): Promise<{ messages: AgentMessage[]; model?: { provider: string; modelId: string } }>;
		findOpenRunOperationsFor(path: string): Promise<unknown[]>;
	};
}
interface RequestBody { model: string; messages: Array<{ role: string; content: unknown }>; tools: Array<{ function: { name: string } }> }
function response(body: RequestBody, call?: { name: string; arguments: Record<string, unknown> }) {
	const delta = call ? { tool_calls: [{ index: 0, id: "switch-1", type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: `Reply from ${body.model}` };
	const chunk = { id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] };
	const done = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
	const text = `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`;
	return { status: 200, headers: { "content-type": "text/event-stream" }, text, json: {}, arrayBuffer: new TextEncoder().encode(text).buffer };
}

async function fixture(options: { memory?: MemoryAdapter; settings?: PiemSettings; handler?: (body: RequestBody, index: number) => ReturnType<typeof response> | Promise<ReturnType<typeof response>> } = {}) {
	const memory = options.memory ?? new MemoryAdapter();
	memory.allowReplaceRemoval = true;
	const record: PluginHostRecord = { views: [], commands: [], ribbonIcons: [], icons: new Map(), settingTabs: 0, savedData: [] };
	const host = createObsidianHostModule(record, mobile) as Record<string, unknown>;
	const requests: RequestBody[] = [];
	host.requestUrl = async (request: { url: string; body?: string }) => {
		if (!request.url.startsWith("https://bridge.test/")) throw new Error(`Unexpected network request: ${request.url}`);
		const body = JSON.parse(request.body!) as RequestBody;
		requests.push(body);
		return options.handler?.(body, requests.length) ?? response(body);
	};
	const required: string[] = [], dynamic: string[] = [];
	const realm = loadBrowserPluginBundle({ modules: { obsidian: host }, onRequire: id => required.push(id), onDynamicImport: id => dynamic.push(id) });
	const PluginClass = (realm.exports as { default: new (app: unknown, manifest: unknown) => Plugin }).default;
	const app = createStubApp() as { vault: { adapter: MemoryAdapter } };
	app.vault.adapter = memory;
	const plugin = new PluginClass(app, { id: "piem", version: "smoke" });
	cleanups.push(() => plugin.onunload());
	// Keep unrelated bundle scenarios offline; diagnostics has its own coverage.
	plugin.loadData = async () => ({ shareDiagnostics: false });
	await plugin.onload();
	if (options.settings) Object.assign(plugin.settings, structuredClone(options.settings));
	else Object.assign(plugin.settings, {
		language: "en", networkTransport: "requestUrl",
		providers: [{ id: "test", name: "Bridge", baseUrl: "https://bridge.test/v1", protocol: "openai-completions", apiKey: "fixture-key", secretRef: "", source: "user", oauthFlow: "" }],
		models: [
			{ id: "a", providerId: "test", modelApiId: "alpha", displayName: "Alpha", reasoning: false, supportsImages: false },
			{ id: "b", providerId: "test", modelApiId: "beta", displayName: "Beta", reasoning: false, supportsImages: false },
		], activeModelId: "a",
	});
	await plugin.agentService.initialize();
	return { plugin, service: plugin.agentService, record, memory, requests, realm, required, dynamic };
}

describe("shipped community extensions in a permanently Node-free mobile realm", () => {
	it("switches the next real protocol request, persists the choice, and annotates model handoff", async () => {
		const f = await fixture({ handler: (body, index) => response(body, index === 1 ? { name: "switch_model", arguments: { action: "switch", search: "beta" } } : undefined) });
		expect(await f.service.sendPrompt("Use Beta to finish this task")).toBe(true);
		expect(f.requests.map(request => request.model)).toEqual(["alpha", "beta"]);
		expect(f.requests[0]!.tools.some(tool => tool.function.name === "switch_model")).toBe(true);
		expect(f.plugin.settings.activeModelId).toBe("b");
		const path = f.service.getActiveSessionPath();
		expect((await f.plugin.sessionManager.buildSessionContextFor(path)).model).toEqual({ provider: "test", modelId: "beta" });
		expect(JSON.stringify(f.service.getSnapshot().messages)).toContain("Switched to test/beta");
		expect(f.service.getSnapshot().errorMessage).toBeUndefined();
		// A regular user turn after a switch is where provenance inserts its note.
		f.plugin.settings.activeModelId = "a";
		await f.plugin.saveSettings();
		await f.service.sendPrompt("Carry on");
		expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain("test/beta");
		expect(JSON.stringify(f.service.getSnapshot().messages)).not.toContain("assistant-model-provenance");
		expect(new Set(f.required)).toEqual(new Set(["obsidian"]));
		expect(f.dynamic).toEqual([]);
		expect(await f.realm.evaluate('Promise.resolve().then(() => [typeof process, typeof Buffer, typeof globalThis.require, typeof window.process, typeof Bun])')).toEqual(Array(5).fill("undefined"));
	});

	it("continues with no extra provider prompt, restores the hidden marker and continues after reload", async () => {
		const f = await fixture();
		expect(f.record.commands).toContain("continue-task");
		expect(f.service.getSnapshot().availableCommands).toContainEqual({ name: "continue", description: "Continue current task", kind: "extension", invocation: "continue" });
		expect(await f.service.runExtensionCommand("continue")).toBe(false);
		expect(f.requests).toHaveLength(0);
		await f.service.sendPrompt("Make a plan");
		expect(await f.service.sendPrompt("/continue")).toBe(true);
		expect(f.requests).toHaveLength(2);
		expect(f.requests[1]!.messages.filter(message => message.role === "user")).toEqual(f.requests[0]!.messages.filter(message => message.role === "user"));
		expect(JSON.stringify(f.requests[1])).not.toContain("pi-invisible-continue");
		expect(JSON.stringify(f.requests[1])).not.toContain("/continue");
		const path = f.service.getActiveSessionPath();
		const saved = await f.plugin.sessionManager.buildSessionContextFor(path);
		expect(saved.messages.some(message => message.role === "custom" && message.display === false)).toBe(true);
		const reopened = await fixture({ memory: f.memory, settings: f.plugin.settings });
		await reopened.service.openSession(path);
		expect(await reopened.service.runExtensionCommand("continue")).toBe(true);
		expect(reopened.requests).toHaveLength(1);
		expect(JSON.stringify(reopened.requests[0])).not.toContain("pi-invisible-continue");
		expect(reopened.requests[0]!.messages.filter(message => message.role === "user")).toEqual(f.requests[0]!.messages.filter(message => message.role === "user"));
	});

	it("keeps a model switch and queued continue on the source chat after focus moves", async () => {
		let release!: () => void;
		let entered!: () => void;
		const waiting = new Promise<void>(resolve => { entered = resolve; });
		const gate = new Promise<void>(resolve => { release = resolve; });
		const f = await fixture({ handler: async (body, index) => {
			if (index === 1) { entered(); await gate; }
			return response(body, index === 1 ? { name: "switch_model", arguments: { action: "switch", search: "beta" } } : undefined);
		} });
		const run = f.service.sendPrompt("A only");
		await waiting;
		const a = f.service.getActiveSessionPath();
		expect(await f.service.runExtensionCommand("continue")).toBe(true);
		await f.service.newSession();
		const b = f.service.getActiveSessionPath();
		release();
		await run;
		for (let i = 0; i < 100 && f.requests.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 5));
		expect(f.requests.map(request => request.model)).toEqual(["alpha", "beta", "beta"]);
		expect(f.service.getActiveSessionPath()).toBe(b);
		expect(f.service.getSnapshot().messages).toHaveLength(0);
		expect((await f.plugin.sessionManager.buildSessionContextFor(a)).model?.modelId).toBe("beta");
		expect((await f.plugin.sessionManager.buildSessionContextFor(b)).model?.modelId).toBe("alpha");
	});

	it("records the model actually used when continuing an older chat after another chat changed defaults", async () => {
		let inspect: (() => Promise<void>) | undefined;
		const f = await fixture({ handler: async body => { await inspect?.(); return response(body); } });
		await f.service.sendPrompt("Conversation A");
		const a = f.service.getActiveSessionPath();
		await f.service.newSession();
		f.plugin.settings.activeModelId = "b";
		await f.plugin.saveSettings();
		await f.service.sendPrompt("Conversation B");
		await f.service.openSession(a);
		let recordedDuringRequest: string | undefined;
		inspect = async () => { recordedDuringRequest = (await f.plugin.sessionManager.buildSessionContextFor(a)).model?.modelId; };
		expect(await f.service.runExtensionCommand("continue")).toBe(true);
		const actual = f.requests.at(-1)!.model;
		expect(actual).toBe("alpha");
		expect(recordedDuringRequest).toBe(actual);
		expect((await f.plugin.sessionManager.buildSessionContextFor(a)).model?.modelId).toBe(actual);
	});

	it("closes a late run registration when stop arrived while the registration was writing", async () => {
		const f = await fixture();
		await f.service.sendPrompt("Already answered");
		const path = f.service.getActiveSessionPath();
		let entered!: () => void;
		let release!: () => void;
		const waiting = new Promise<void>(resolve => { entered = resolve; });
		const gate = new Promise<void>(resolve => { release = resolve; });
		const append = f.memory.append.bind(f.memory);
		f.memory.append = async (file, value) => {
			if (value.includes('"type":"operation_started"')) { entered(); await gate; }
			return append(file, value);
		};
		const continuing = f.service.runExtensionCommand("continue");
		await waiting;
		await f.service.abortSession(path);
		await new Promise(resolve => setTimeout(resolve, 0));
		release();
		await continuing;
		expect(f.requests).toHaveLength(1);
		expect(await f.plugin.sessionManager.findOpenRunOperationsFor(path)).toEqual([]);
		f.memory.append = append;
		expect(await f.service.runExtensionCommand("continue")).toBe(true);
		expect(f.requests).toHaveLength(2);
		expect(await f.plugin.sessionManager.findOpenRunOperationsFor(path)).toEqual([]);
	});

	it("does not claim a model switch when persistence fails", async () => {
		const f = await fixture({ handler: (body, index) => response(body, index === 1 ? { name: "switch_model", arguments: { action: "switch", search: "beta" } } : undefined) });
		const append = f.memory.append.bind(f.memory);
		f.memory.append = async (path, value) => {
			if (value.includes('"type":"model_change"') && value.includes('"modelId":"beta"')) throw new Error("Fixture disk full");
			return append(path, value);
		};
		await f.service.sendPrompt("Try switching");
		expect(f.plugin.settings.activeModelId).toBe("a");
		expect(f.requests.every(request => request.model === "alpha")).toBe(true);
		expect(JSON.stringify(f.service.getSnapshot().messages)).toContain("Fixture disk full");
		expect(JSON.stringify(f.service.getSnapshot().messages)).not.toContain("Switched to test/beta");
	});

	it("does not start a settings rollback after its plugin was unloaded", async () => {
		const f = await fixture({ handler: (body, index) => response(body, index === 1 ? { name: "switch_model", arguments: { action: "switch", search: "beta" } } : undefined) });
		let entered!: () => void;
		let release!: () => void;
		const waiting = new Promise<void>(resolve => { entered = resolve; });
		const gate = new Promise<void>(resolve => { release = resolve; });
		const writes: unknown[] = [];
		f.plugin.saveData = async data => {
			writes.push(data);
			if (writes.length === 1) { entered(); await gate; }
		};
		const run = f.service.sendPrompt("Switch while saving");
		await waiting;
		f.plugin.onunload();
		release();
		await run;
		expect(writes).toHaveLength(1);
	});

	it("refuses models whose provider has no key without exposing configured credentials", async () => {
		const f = await fixture({ handler: (body, index) => response(body, index === 1 ? { name: "switch_model", arguments: { action: "list" } } : undefined) });
		f.plugin.settings.providers.push({ ...f.plugin.settings.providers[0]!, id: "no-key", apiKey: "" });
		f.plugin.settings.models.push({ ...f.plugin.settings.models[0]!, id: "unavailable", providerId: "no-key", modelApiId: "unavailable" });
		await f.service.sendPrompt("List usable models");
		const result = f.service.getSnapshot().messages.find(message => message.role === "toolResult");
		expect(JSON.stringify(result)).toContain("test/alpha");
		expect(JSON.stringify(result)).not.toContain("no-key/unavailable");
		expect(JSON.stringify(result)).not.toContain("fixture-key");
	});

	it("keeps a queued continuation with its owner and removes it on stop", async () => {
		let release!: () => void;
		let entered!: () => void;
		const waiting = new Promise<void>(resolve => { entered = resolve; });
		const gate = new Promise<void>(resolve => { release = resolve; });
		const f = await fixture({ handler: async (body, index) => { if (index === 1) { entered(); await gate; } return response(body); } });
		const run = f.service.sendPrompt("Wait for me");
		await waiting;
		const path = f.service.getActiveSessionPath();
		expect(await f.service.runExtensionCommand("continue")).toBe(true);
		expect(f.service.getSnapshot().queuedPrompts).toHaveLength(1);
		await f.service.abortSession(path);
		expect(f.service.getSnapshot().queuedPrompts).toHaveLength(0);
		release();
		await run;
		expect(f.requests).toHaveLength(1);
	});
});
