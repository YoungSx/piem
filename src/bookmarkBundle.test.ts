import { afterEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { installDom } from "./testUtils/dom";
import { MemoryAdapter } from "./testUtils/memoryAdapter";
import { createObsidianHostModule, createStubApp, type PluginHostRecord } from "./testUtils/pluginLoader";
import { loadBrowserPluginBundle } from "./testUtils/browserPluginLoader";

installDom();
const cleanup: Array<() => void> = [];
afterEach(() => { for (const run of cleanup.splice(0).reverse()) run(); });
const platform = { isDesktop: false, isDesktopApp: false, isMobile: true, isMobileApp: true, isIosApp: true, isAndroidApp: false };
interface Service {
	initialize(): Promise<void>;
	openSession(path: string): Promise<void>;
	newSession(options?: { force?: boolean }): Promise<void>;
	getActiveSessionPath(): string | null;
	runBookmark(path: string, command: "bookmark" | "unbookmark", label?: string): Promise<{ kind: string }>;
	listBookmarks(path: string): Promise<Array<{ label: string; text: string }>>;
	deleteSession(path: string): Promise<void>;
}
interface LoadedPlugin {
	onload(): Promise<void>;
	onunload(): void;
	agentService: Service;
	sessionManager: {
		appendMessageFor(path: string, message: AgentMessage): Promise<string>;
		materializeIfBlank(path: string, defaults: { provider: string; modelId: string; thinkingLevel?: string }): Promise<{ path: string }>;
	};
}
const message = (text: string): AgentMessage => ({ role: "assistant", api: "openai-completions", provider: "test", model: "test", stopReason: "stop", timestamp: 1, content: [{ type: "text", text }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
async function load(memory: MemoryAdapter) {
	const record: PluginHostRecord = { views: [], commands: [], ribbonIcons: [], icons: new Map(), settingTabs: 0, savedData: [] };
	const required: string[] = [];
	const dynamic: string[] = [];
	const realm = loadBrowserPluginBundle({ modules: { obsidian: createObsidianHostModule(record, platform) }, onRequire: id => required.push(id), onDynamicImport: id => dynamic.push(id) });
	const output = realm.exports;
	const Plugin = (output as { default: new (app: unknown, manifest: unknown) => LoadedPlugin }).default;
	const app = createStubApp() as { vault: { adapter: MemoryAdapter } };
	app.vault.adapter = memory;
	const plugin = new Plugin(app, { id: "piem", version: "smoke" });
	cleanup.push(() => plugin.onunload());
	await plugin.onload();
	await plugin.agentService.initialize();
	return { plugin, record, required, dynamic, realm };
}

/** The sheet a fresh plugin opens is in-memory until its first message. */
async function makeStored(plugin: LoadedPlugin, path: string): Promise<void> {
	await plugin.sessionManager.materializeIfBlank(path, { provider: "test", modelId: "test" });
}


describe("shipped bookmark extension without Node", () => {
	it("registers commands, persists through the real service and survives reloading the bundle", async () => {
		const memory = new MemoryAdapter();
		const first = await load(memory);
		expect(first.record.commands).toEqual(expect.arrayContaining(["bookmark-reply", "unbookmark-reply", "view-bookmarks"]));
		const path = first.plugin.agentService.getActiveSessionPath()!;
		await makeStored(first.plugin, path);
		await first.plugin.sessionManager.appendMessageFor(path, message("Remember this"));
		expect(await first.realm.evaluate('Promise.resolve().then(() => [typeof process, typeof Buffer, typeof globalThis.require, typeof window.process, typeof window.Buffer, typeof Bun])')).toEqual(Array(6).fill("undefined"));
		await first.plugin.agentService.newSession({ force: true });
		const other = first.plugin.agentService.getActiveSessionPath()!;
		const requirementsBefore = first.required.length;
		expect((await first.plugin.agentService.runBookmark(path, "bookmark", "From mobile")).kind).toBe("saved");
		expect(await first.plugin.agentService.listBookmarks(other)).toEqual([]);
		expect(first.required.slice(requirementsBefore)).toEqual([]);
		expect(new Set(first.required)).toEqual(new Set(["obsidian"]));
		expect(first.dynamic).toEqual([]);
		const second = await load(memory);
		await second.plugin.agentService.openSession(path);
		expect(await second.plugin.agentService.listBookmarks(path)).toMatchObject([{ label: "From mobile", text: "Remember this" }]);
		expect((await second.plugin.agentService.runBookmark(path, "unbookmark")).kind).toBe("removed");
		expect(await second.plugin.agentService.listBookmarks(path)).toEqual([]);
	});
	it("rejects failed writes and recovers without a phantom label", async () => {
		const memory = new MemoryAdapter();
		const { plugin } = await load(memory);
		const path = plugin.agentService.getActiveSessionPath()!;
		await makeStored(plugin, path);
		await plugin.sessionManager.appendMessageFor(path, message("Saved answer"));
		const append = memory.append.bind(memory);
		memory.append = async () => { throw new Error("Disk full"); };
		await expect(plugin.agentService.runBookmark(path, "bookmark", "Unsaved")).rejects.toThrow("Disk full");
		memory.append = append;
		expect(await plugin.agentService.listBookmarks(path)).toEqual([]);
		expect((await plugin.agentService.runBookmark(path, "bookmark", "Retry")).kind).toBe("saved");
	});
});
