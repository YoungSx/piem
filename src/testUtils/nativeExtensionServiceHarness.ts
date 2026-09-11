import type { App, DataAdapter } from "obsidian";
import type { Context, AssistantMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { MemoryAdapter } from "./memoryAdapter";
import { ObsidianAgentService } from "../agent/ObsidianAgentService";
import { ObsidianSessionManager } from "../session/ObsidianSessionManager";
import { DEFAULT_SETTINGS } from "../settings";

/**
 * `reasoning` is opt-in because the default fixture model deliberately has none:
 * `setThinkingLevel` clamps to model capability, so a level asked for on a
 * non-reasoning model correctly records as "off" and would make a test that
 * asserts "medium" pass only by accident.
 */
export function harness(factory: ExtensionFactory, options: { reasoning?: boolean } = {}) {
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
	return { service, sessions, requests, settings, adapter };
}
