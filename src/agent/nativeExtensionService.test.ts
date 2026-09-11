import { afterAll, describe, expect, it } from "bun:test";
import type { App, DataAdapter } from "obsidian";
import type { Context, AssistantMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { installObsidianStub } from "../testUtils/obsidianStub";
import { stubWindowTimers } from "../testUtils/windowStub";

installObsidianStub();
const restoreTimers = stubWindowTimers();
afterAll(restoreTimers);

const { ObsidianAgentService } = await import("./ObsidianAgentService");
const { ObsidianSessionManager } = await import("../session/ObsidianSessionManager");
const { DEFAULT_SETTINGS } = await import("../settings");

/**
 * `reasoning` is opt-in because the default fixture model deliberately has none:
 * `setThinkingLevel` clamps to model capability, so a level asked for on a
 * non-reasoning model correctly records as "off" and would make a test that
 * asserts "medium" pass only by accident.
 */
function harness(factory: ExtensionFactory, options: { reasoning?: boolean } = {}) {
	const adapter = new MemoryAdapter() as unknown as DataAdapter;
	const sessions = new ObsidianSessionManager(adapter, "Piem/sessions", "obsidian-vault:Bridge test");
	const settings = {
		...DEFAULT_SETTINGS,
		providers: [{ id: "bridge-provider", name: "Test gateway", baseUrl: "https://bridge.test/v1",
			protocol: "openai-completions" as const, apiKey: "test-key", secretRef: "", source: "user" as const, oauthFlow: "" as const }],
		models: [{ id: "bridge-model", providerId: "bridge-provider", modelApiId: "test-model", displayName: "Test model", reasoning: options.reasoning === true, supportsImages: false }],
		activeModelId: "bridge-model",
	};
	const app = {
		vault: { adapter, getName: () => "Bridge test", getFiles: () => [], getFileByPath: () => null,
			getAbstractFileByPath: () => null, read: async () => "", cachedRead: async () => "" },
		workspace: { getActiveViewOfType: () => null, getActiveFile: () => null },
	} as unknown as App;
	const requests: Context[] = [];
	const streamFn: StreamFn = (model, context) => {
		requests.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) });
		const message: AssistantMessage = {
			role: "assistant", content: [{ type: "text", text: `Reply ${requests.length}` }],
			api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
			usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
		return stream;
	};
	const service = new ObsidianAgentService(app, () => settings, sessions, {
		streamFn, extensionFactories: [{ id: "bridge-test", factory }],
		loadUserSkills: async () => ({ skills: [], diagnostics: [], searched: [] }),
	});
	return { service, sessions, requests };
}

describe("native extension service lifecycle", () => {
	it.each(["message_end", "agent_end"] as const)("persists successful replies and closes the run when %s handlers fail", async eventType => {
		const { service, sessions, requests } = harness(pi => {
			if (eventType === "message_end") pi.on("message_end", event => {
				if (event.message.role === "assistant") throw new Error("Extension observer failed");
			});
			else pi.on("agent_end", () => { throw new Error("Extension observer failed"); });
		});
		try {
			const sent = await service.sendPrompt("First question");
			const entries = await sessions.getSession().findEntries({ order: "oldestFirst" });
			expect(JSON.stringify(entries)).toContain("Reply 1");
			expect(await sessions.findOpenRunOperations()).toHaveLength(0);
			expect(sent).toBe(true);
			expect(service.getSnapshot().isStreaming).toBe(false);
			expect(service.getSnapshot().messages.filter(message => message.role === "assistant")).toHaveLength(1);
			expect(await service.sendPrompt("Second question")).toBe(true);
			expect(requests).toHaveLength(2);
			expect(JSON.stringify(await sessions.getSession().findEntries({ order: "oldestFirst" }))).toContain("Reply 2");
			expect(await sessions.findOpenRunOperations()).toHaveLength(0);
		} finally { service.dispose(); }
	});

	it("keeps before_agent_start failures blocking without poisoning the next prompt", async () => {
		let fail = true;
		const prompts: string[] = [];
		const { service, sessions, requests } = harness(pi => {
			pi.on("before_agent_start", event => {
				prompts.push(event.systemPrompt);
				if (fail) throw new Error("Extension prompt failed");
				return { systemPrompt: `${event.systemPrompt}\nONE_PROMPT_OVERRIDE` };
			});
		});
		try {
			expect(await service.sendPrompt("Blocked question")).toBe(false);
			expect(requests).toHaveLength(0);
			expect(await sessions.findOpenRunOperations()).toHaveLength(0);
			fail = false;
			expect(await service.sendPrompt("Accepted question")).toBe(true);
			expect(requests[0]?.systemPrompt).toContain("ONE_PROMPT_OVERRIDE");
			expect(await service.sendPrompt("Following question")).toBe(true);
			expect(prompts).toHaveLength(3);
			expect(prompts.every(prompt => !prompt.includes("ONE_PROMPT_OVERRIDE"))).toBe(true);
			expect(await sessions.findOpenRunOperations()).toHaveLength(0);
		} finally { service.dispose(); }
	});

	it("persists custom prompt context before emitting one settled event with an idle, current branch", async () => {
		const settled: Array<{ idle: boolean; branch: string }> = [];
		let ready: (() => void) | undefined;
		const { service, sessions, requests } = harness(pi => {
			pi.on("before_agent_start", () => ({
				message: { customType: "native-context", content: "EXTENSION_CONTEXT", display: false },
			}));
			pi.on("agent_settled", (_event, ctx) => {
				settled.push({ idle: ctx.isIdle(), branch: JSON.stringify(ctx.sessionManager.getBranch()) });
				ready?.();
			});
		});
		try {
			for (const question of ["First question", "Second question"]) {
				const completed = new Promise<void>(resolve => { ready = resolve; });
				expect(await service.sendPrompt(question)).toBe(true);
				await completed;
			}
			expect(settled).toHaveLength(2);
			expect(settled.every(event => event.idle)).toBe(true);
			expect(settled[0]?.branch).toContain("Reply 1");
			expect(settled[0]?.branch).not.toContain("Reply 2");
			expect(settled[1]?.branch).toContain("Reply 2");
			expect(JSON.stringify(requests[0]?.messages)).toContain("EXTENSION_CONTEXT");
			const entries = await sessions.getSession().findEntries({ order: "oldestFirst" });
			const custom = entries.filter(entry => entry.type === "message" && entry.message.role === "custom");
			expect(custom).toHaveLength(2);
			expect(JSON.stringify(custom)).toContain("native-context");
			expect(await sessions.findOpenRunOperations()).toHaveLength(0);
		} finally { service.dispose(); }
	});
});

describe("native extension writes reach the owning conversation", () => {
	it("renames the conversation its host belongs to, not the one on screen", async () => {
		const { service, sessions } = harness(pi => {
			pi.registerCommand("name", { handler: async (args) => { pi.setSessionName(args); } });
		});
		try {
			await service.initialize();
			const first = service.getActiveSessionPath()!;
			// A turn first: `newSession` treats an empty conversation as already the
			// blank sheet a switch is asking for, and would no-op below.
			expect(await service.sendPrompt("First question")).toBe(true);
			expect(await service.runExtensionCommand("name", "Named from an extension")).toBe(true);
			expect(service.getSnapshot().session?.name).toBe("Named from an extension");

			// Switch the panel elsewhere, then reopen: the name has to have been
			// written to the first conversation's own log, not to whichever chat was
			// focused at write time.
			await service.newSession();
			expect(service.getActiveSessionPath()).not.toBe(first);
			expect(service.getSnapshot().session?.name).toBeUndefined();
			// The name is durable on the first conversation, not on whichever chat
			// was focused when the extension asked. Read through `getName()` rather
			// than off the metadata: a rename is a fact in the log, so the log is
			// where it lives — the same read `readActiveSessionName` does, trimmed
			// and collapsing empty to undefined.
			expect((await sessions.getSessionFor(first).getName())?.trim() || undefined).toBe("Named from an extension");
			await service.openSession(first);
			expect(service.getSnapshot().session?.name).toBe("Named from an extension");
		} finally { service.dispose(); }
	});

	it("reads its own conversation's tools and commands, and leaks no executable", async () => {
		let tools: unknown;
		let commands: unknown;
		const { service } = harness(pi => {
			pi.registerTool({
				name: "bridge_probe", label: "Probe", description: "A registered extension tool.",
				parameters: { type: "object", properties: {} } as never,
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
			pi.registerCommand("inspect", { handler: async () => { tools = pi.getAllTools(); commands = pi.getCommands(); } });
		});
		try {
			await service.initialize();
			expect(await service.runExtensionCommand("inspect")).toBe(true);
			// The agent's own list, so `getActiveTools` and `getAllTools` cannot
			// disagree about which tools this conversation holds.
			const names = (tools as Array<{ name: string }>).map(tool => tool.name);
			expect(names).toContain("bridge_probe");
			expect(names.length).toBeGreaterThan(1);
			expect((commands as Array<{ name: string }>).map(command => command.name)).toContain("inspect");
			// The property that matters: nothing reachable from either result can be
			// called. `execute` closes over this runtime — its session path, its agent
			// state, its transport — so a single leaked function is a route around
			// every ownership check the host makes.
			const functions: string[] = [];
			const seen = new WeakSet<object>();
			const walk = (value: unknown, path: string): void => {
				if (typeof value === "function") { functions.push(path); return; }
				if (!value || typeof value !== "object" || seen.has(value)) return;
				seen.add(value);
				for (const [key, member] of Object.entries(value)) walk(member, `${path}.${key}`);
			};
			walk(tools, "tools");
			walk(commands, "commands");
			expect(functions).toEqual([]);
			expect(JSON.stringify([tools, commands])).not.toContain("test-key");
		} finally { service.dispose(); }
	});
});
