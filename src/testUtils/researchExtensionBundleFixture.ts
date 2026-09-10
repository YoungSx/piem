import type { ExtensionUIAdapter } from "../extensions/extensionUI";
import type { Session } from "@earendil-works/pi-agent-core";
import type { ChatSnapshot } from "../agent/ObsidianAgentService";
import type { SessionRuntime } from "../agent/SessionRuntime";
import type { PiemSettings } from "../settings";
import { MemoryAdapter } from "./memoryAdapter";
import { loadBrowserPluginBundle } from "./browserPluginLoader";
import { createObsidianHostModule, createStubApp, type PluginHostRecord } from "./pluginLoader";
import { openaiChat, responsesChat, searchResponse } from "../../scripts/smoke-research-extensions-fixtures.mjs";

export interface ResearchService {
	initialize(): Promise<void>;
	sendPrompt(text: string): Promise<boolean>;
	runExtensionCommand(name: string, args?: string): Promise<boolean>;
	attachExtensionUI(path: string, adapter: ExtensionUIAdapter): () => void;
	isExtensionInput(text: string): boolean;
	getSnapshot(): ChatSnapshot;
	getActiveSessionPath(): string;
	openSession(path: string): Promise<void>;
	newSession(): Promise<void>;
	abortSession(path: string): Promise<void>;
	runtimes: Map<string, SessionRuntime>;
}
interface ResearchPlugin {
	onload(): Promise<void>;
	onunload(): void;
	loadData(): Promise<unknown>;
	saveSettings(options?: { reconfigure?: boolean }): Promise<void>;
	settings: PiemSettings;
	agentService: ResearchService;
	sessionManager: {
		getSessionFor(path: string): Session;
		buildSessionContextFor(path: string): Promise<{ messages: ChatSnapshot["messages"] }>;
	};
}
export interface WireStep { text?: string; tool?: { name: string; args: Record<string, unknown> }; error?: number }
export interface WirePlan { chat?: WireStep[]; clarify?: WireStep; search?: WireStep }
interface RequestBody {
	model: string;
	tools?: Array<{ type: string; name?: string; function?: { name: string } }>;
	messages?: unknown[];
	input?: unknown[];
}
export interface ResearchRequest {
	kind: "search" | "clarify" | "chat" | "auxiliary";
	url: string;
	body: RequestBody;
	headers: Record<string, string>;
}

export async function waitForResearch(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
	const end = Date.now() + 3000;
	while (!await check()) {
		if (Date.now() >= end) throw new Error(`Timed out waiting for ${label}`);
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}

export function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

export async function researchFixture(options: {
	protocol?: "openai-responses" | "openai-completions";
	memory?: MemoryAdapter;
	settings?: PiemSettings;
	plan?: WirePlan;
	beforeResponse?(request: ResearchRequest): Promise<void>;
}, cleanup: Array<() => void>) {
	const memory = options.memory ?? new MemoryAdapter();
	memory.allowReplaceRemoval = true;
	const record: PluginHostRecord = { views: [], commands: [], ribbonIcons: [], icons: new Map(), settingTabs: 0, savedData: [] };
	const host = createObsidianHostModule(record, { isDesktop: false, isDesktopApp: false, isMobile: true, isMobileApp: true, isIosApp: true, isAndroidApp: false }) as Record<string, unknown>;
	const requests: ResearchRequest[] = [];
	let plan = options.plan ?? {};
	host.requestUrl = async (request: { url: string; body: string; headers?: Record<string, string> }) => {
		if (!request.url.startsWith("https://research.test/v1/")) throw new Error(`Unexpected network request: ${request.url}`);
		const body = JSON.parse(request.body) as RequestBody;
		const kind = body.tools?.some(tool => tool.type === "web_search") ? "search"
			: JSON.stringify(body).includes("You rewrite rough, plain-language user prompts") ? "clarify"
				: body.tools?.length ? "chat" : "auxiliary";
		const recorded: ResearchRequest = { kind, url: request.url, body, headers: request.headers ?? {} };
		requests.push(recorded);
		const step = kind === "chat" ? plan.chat?.shift() : kind === "clarify" ? plan.clarify : kind === "search" ? plan.search : { text: "[]" };
		if (!step) throw new Error(`Unexpected ${kind} provider request`);
		await options.beforeResponse?.(recorded);
		const error = step.error;
		const text = error ? JSON.stringify({ error: { message: "Fixture authentication denied", type: "authentication_error" } })
			: kind === "search" ? searchResponse("responses")
				: request.url.endsWith("/responses") ? responsesChat(body.model, step, `research-${requests.length}`)
					: openaiChat(body.model, step, `research-${requests.length}`);
		return { status: error ?? 200, headers: { "content-type": error ? "application/json" : "text/event-stream" }, text, json: error ? JSON.parse(text) as unknown : {}, arrayBuffer: new TextEncoder().encode(text).buffer };
	};
	const required: string[] = [], dynamic: string[] = [];
	const realm = loadBrowserPluginBundle({ modules: { obsidian: host }, onRequire: id => required.push(id), onDynamicImport: id => dynamic.push(id) });
	const Plugin = (realm.exports as { default: new (app: unknown, manifest: unknown) => ResearchPlugin }).default;
	const app = createStubApp() as { vault: { adapter: MemoryAdapter } };
	app.vault.adapter = memory;
	const plugin = new Plugin(app, { id: "piem", version: "smoke" });
	plugin.loadData = async () => options.settings ? structuredClone(options.settings) : {
		language: "en", networkTransport: "requestUrl",
		providers: [{ id: "research", name: "Research", baseUrl: "https://research.test/v1", protocol: options.protocol ?? "openai-responses", apiKey: "research-fixture-key", secretRef: "", source: "user", oauthFlow: "" }],
		models: [
			{ id: "alpha", providerId: "research", modelApiId: "alpha", displayName: "Alpha", reasoning: false, supportsImages: false },
			{ id: "beta", providerId: "research", modelApiId: "beta", displayName: "Beta", reasoning: false, supportsImages: false },
		], activeModelId: "alpha",
	};
	let unloaded = false;
	const unload = () => { if (!unloaded) { unloaded = true; plugin.onunload(); } };
	cleanup.push(unload);
	await plugin.onload();
	const service = plugin.agentService;
	await service.initialize();
	const idle = (path = service.getActiveSessionPath()) => waitForResearch(() => {
		const rt = service.runtimes.get(path);
		return Boolean(rt && !rt.agent?.state.isStreaming && !rt.extensionBusy && !rt.extensionCommand && !rt.activeRunContext
			&& !rt.activeRunLedger && !rt.promptPreparations && !rt.sessionOperations && !rt.promptQueue.size
			&& !rt.sessionRefreshing && !rt.isCompacting && !rt.retryInFlight);
	}, "research conversation to become idle");
	await idle();
	const bindEditor = (path: string, editor: { read(): string; replace(text: string): void }) => service.attachExtensionUI(path, {
		getEditorText: editor.read, setEditorText: editor.replace,
		pasteToEditor: text => editor.replace(editor.read() + text),
		select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined,
		setStatus: () => {}, setWidget: () => {}, addAutocompleteProvider: () => {}, reset: () => {},
	});
	return { plugin, service, memory, record, requests, required, dynamic, realm, idle, unload, bindEditor, setPlan: (next: WirePlan) => { plan = next; } };
}
