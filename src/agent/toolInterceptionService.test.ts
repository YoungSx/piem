import { afterAll, describe, expect, it } from "bun:test";
import type { App, DataAdapter } from "obsidian";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { installObsidianStub } from "../testUtils/obsidianStub";
import { stubWindowTimers } from "../testUtils/windowStub";

installObsidianStub();
const restoreTimers = stubWindowTimers();
afterAll(restoreTimers);

const { ObsidianAgentService } = await import("./ObsidianAgentService");
const { ObsidianSessionManager } = await import("../session/ObsidianSessionManager");
const { DEFAULT_SETTINGS } = await import("../settings");

/** One tool call in the first reply, then a plain answer. */
interface ToolScript { name: string; arguments: Record<string, unknown> }

/**
 * The service, wired to a stream that asks for `script` on its first request.
 *
 * Deliberately the full service rather than the host alone: the point of these
 * tests is that a tool call in a real conversation reaches the extension through
 * pi's own agent loop, which is the seam `beforeToolCall`/`afterToolCall` hang
 * off. A host-level test cannot tell whether the hooks were wired at all.
 */
function harness(factory: ExtensionFactory, script: ToolScript) {
	const adapter = new MemoryAdapter() as unknown as DataAdapter;
	const sessions = new ObsidianSessionManager(adapter, "Piem/sessions", "obsidian-vault:Interception test");
	const settings = {
		...DEFAULT_SETTINGS,
		providers: [{ id: "p", name: "Test gateway", baseUrl: "https://bridge.test/v1",
			protocol: "openai-completions" as const, apiKey: "test-key", secretRef: "", source: "user" as const, oauthFlow: "" as const }],
		models: [{ id: "m", providerId: "p", modelApiId: "test-model", displayName: "Test model", reasoning: false, supportsImages: false }],
		activeModelId: "m",
	};
	const app = {
		vault: { adapter, getName: () => "Interception test", getFiles: () => [], getFileByPath: () => null,
			getAbstractFileByPath: () => null, read: async () => "", cachedRead: async () => "" },
		workspace: { getActiveViewOfType: () => null, getActiveFile: () => null },
	} as unknown as App;
	const requests: Context[] = [];
	const streamFn: StreamFn = (model: Model<string>, context: Context) => {
		requests.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) });
		const base = {
			role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
			usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const message: AssistantMessage = requests.length === 1
			? { ...base, content: [{ type: "toolCall", id: "call-1", ...script }], stopReason: "toolUse" }
			: { ...base, content: [{ type: "text", text: "Done" }], stopReason: "stop" };
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
		stream.end(message);
		return stream;
	};
	const service = new ObsidianAgentService(app, () => settings, sessions, {
		streamFn, extensionFactories: [{ id: "interception-test", factory }],
		loadUserSkills: async () => ({ skills: [], diagnostics: [], searched: [] }),
	});
	return { service, sessions, requests };
}

/**
 * An extension tool that records the params it was handed.
 *
 * Recording inside `execute` is the only honest way to test the mutation
 * contract end to end: it is the arguments the tool *receives* that decide
 * whether a `tool_call` handler's patch had any effect.
 */
function echoTool(seen: Array<Record<string, unknown>>) {
	return {
		name: "echo", label: "Echo", description: "Echoes its text back.",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_id: string, params: { text: string }) => {
			seen.push({ ...params });
			return { content: [{ type: "text" as const, text: `echo:${params.text}` }], details: { ok: true } };
		},
	};
}

/** The tool-result messages the run persisted, oldest first. */
async function toolResults(sessions: InstanceType<typeof ObsidianSessionManager>): Promise<Array<{ text: string; isError: boolean }>> {
	const entries = await sessions.getSession().findEntries({ order: "oldestFirst" });
	return entries.flatMap(entry => {
		if (entry.type !== "message" || entry.message.role !== "toolResult") return [];
		const message = entry.message as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
		const text = (message.content ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
		return [{ text, isError: message.isError === true }];
	});
}

describe("tool interception in a real conversation", () => {
	it("blocks the call, never runs the tool, and tells the model why", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const { service, sessions, requests } = harness(pi => {
			pi.registerTool(echoTool(seen));
			pi.on("tool_call", event => event.toolName === "echo" ? { block: true, reason: "Blocked by policy" } : undefined);
		}, { name: "echo", arguments: { text: "original" } });
		try {
			expect(await service.sendPrompt("Use the tool")).toBe(true);
			// The tool never ran…
			expect(seen).toEqual([]);
			// …and the reason is what the model reads back as the call's error.
			const results = await toolResults(sessions);
			expect(results).toHaveLength(1);
			expect(results[0]!.text).toBe("Blocked by policy");
			expect(results[0]!.isError).toBe(true);
			// The run continued: pi asked again with the error in context.
			expect(requests).toHaveLength(2);
			expect(JSON.stringify(requests[1]!.messages)).toContain("Blocked by policy");
		} finally { service.dispose(); }
	});

	it("forwards an in-place input mutation to the executing tool", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const { service, sessions } = harness(pi => {
			pi.registerTool(echoTool(seen));
			pi.on("tool_call", event => { (event.input as { text: string }).text = "patched"; });
		}, { name: "echo", arguments: { text: "original" } });
		try {
			expect(await service.sendPrompt("Use the tool")).toBe(true);
			// The mutation reached the tool, which is the whole contract.
			expect(seen).toEqual([{ text: "patched" }]);
			expect((await toolResults(sessions))[0]!.text).toBe("echo:patched");
			// The transcript still records the call the model actually made: the
			// mutated object is pi's per-call clone, not the stored arguments.
			const entries = await sessions.getSession().findEntries({ order: "oldestFirst" });
			const calls = entries.filter(entry => entry.type === "message" && entry.message.role === "assistant"
				&& JSON.stringify(entry.message).includes("toolCall"));
			expect(JSON.stringify(calls)).toContain("original");
			expect(JSON.stringify(calls)).not.toContain("patched");
		} finally { service.dispose(); }
	});

	it("rewrites the executed result the model reads back", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const { service, sessions, requests } = harness(pi => {
			pi.registerTool(echoTool(seen));
			pi.on("tool_result", event => ({ content: [{ type: "text", text: `rewritten(${event.input.text as string})` }] }));
		}, { name: "echo", arguments: { text: "original" } });
		try {
			expect(await service.sendPrompt("Use the tool")).toBe(true);
			// The tool did run; only what the model reads was replaced.
			expect(seen).toEqual([{ text: "original" }]);
			const results = await toolResults(sessions);
			expect(results[0]!.text).toBe("rewritten(original)");
			expect(results[0]!.isError).toBe(false);
			expect(JSON.stringify(requests[1]!.messages)).toContain("rewritten(original)");
			expect(JSON.stringify(requests[1]!.messages)).not.toContain("echo:original");
		} finally { service.dispose(); }
	});

	it("marks a successful result as an error when the handler says so", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const { service, sessions } = harness(pi => {
			pi.registerTool(echoTool(seen));
			pi.on("tool_result", () => ({ isError: true }));
		}, { name: "echo", arguments: { text: "original" } });
		try {
			expect(await service.sendPrompt("Use the tool")).toBe(true);
			const results = await toolResults(sessions);
			// Content untouched, error flag replaced: field-by-field merge.
			expect(results[0]!.text).toBe("echo:original");
			expect(results[0]!.isError).toBe(true);
		} finally { service.dispose(); }
	});

	it("leaves the call untouched when the extension subscribes to neither event", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const { service, sessions, requests } = harness(pi => { pi.registerTool(echoTool(seen)); },
			{ name: "echo", arguments: { text: "original" } });
		try {
			expect(await service.sendPrompt("Use the tool")).toBe(true);
			expect(seen).toEqual([{ text: "original" }]);
			const results = await toolResults(sessions);
			expect(results[0]!.text).toBe("echo:original");
			expect(results[0]!.isError).toBe(false);
			expect(requests).toHaveLength(2);
			expect(await sessions.findOpenRunOperations()).toHaveLength(0);
		} finally { service.dispose(); }
	});

	it("turns a failing tool_call handler into that call's error without running the tool", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const { service, sessions } = harness(pi => {
			pi.registerTool(echoTool(seen));
			pi.on("tool_call", () => { throw new Error("Vetting failed"); });
		}, { name: "echo", arguments: { text: "original" } });
		try {
			// The run itself still completes; only the one call is refused.
			expect(await service.sendPrompt("Use the tool")).toBe(true);
			expect(seen).toEqual([]);
			const results = await toolResults(sessions);
			expect(results).toHaveLength(1);
			expect(results[0]!.isError).toBe(true);
			expect(results[0]!.text).toContain("Vetting failed");
			expect(await sessions.findOpenRunOperations()).toHaveLength(0);
		} finally { service.dispose(); }
	});

	it("turns a failing tool_result handler into an error rather than keeping the raw result", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const { service, sessions } = harness(pi => {
			pi.registerTool(echoTool(seen));
			pi.on("tool_result", () => { throw new Error("Rewrite failed"); });
		}, { name: "echo", arguments: { text: "original" } });
		try {
			expect(await service.sendPrompt("Use the tool")).toBe(true);
			expect(seen).toEqual([{ text: "original" }]);
			const results = await toolResults(sessions);
			expect(results[0]!.isError).toBe(true);
			expect(results[0]!.text).toContain("Rewrite failed");
			expect(await sessions.findOpenRunOperations()).toHaveLength(0);
		} finally { service.dispose(); }
	});
});
