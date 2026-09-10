import type { AgentMessage, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { Extension, ExtensionActions, ExtensionContextActions, ExtensionFactory, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { ExtensionRunner } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { createEventBus } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";
import { wrapRegisteredTools } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/wrapper.js";
import { unavailable } from "./node/unavailable";

export interface ExtensionEntry {
	id: string;
	type: string;
	message?: { role: string; content?: unknown };
}
export interface StaticExtension {
	id: string;
	factory: ExtensionFactory;
}
export interface ExtensionHostCallbacks {
	getEntries(): ExtensionEntry[];
	notify(message: string): void;
	getLabel?(id: string): string | undefined;
	setLabel?(id: string, label: string | undefined): void;
	getModel?(): Model<string> | undefined;
	getModels?(): Model<string>[];
	setModel?(model: Pick<Model<string>, "provider" | "id">): Promise<boolean>;
	getThinkingLevel?(): ThinkingLevel;
	isIdle?(): boolean;
	getActiveTools?(): string[];
	sendMessage?: ExtensionActions["sendMessage"];
}

/** No silent no-ops: even reading an unsupported member identifies the missing capability. */
function limited<T extends object>(members: T, name: string): T {
	return new Proxy(members, {
		get(target, key, receiver): unknown {
			if (Object.prototype.hasOwnProperty.call(target, key)) return Reflect.get(target, key, receiver);
			return unavailable(`${name}.${String(key)}`);
		},
	});
}

function validateRegistration(extension: Extension): void {
	for (const event of extension.handlers.keys()) {
		if (event !== "context") unavailable(`extension event ${event}`);
	}
	if (extension.shortcuts.size || extension.flags.size || extension.messageRenderers.size || extension.entryRenderers?.size || extension.markdownTransformer) {
		unavailable("terminal shortcuts, flags or renderers");
	}
}

/**
 * Static Pi factories share the real loader, runner and tool adapter. The host owns
 * their lifetime and the supported contract; the caller owns its authoritative
 * session, persistence and transport. No filesystem or provider registry is created.
 */
export async function createExtensionHost(factories: readonly StaticExtension[], callbacks: ExtensionHostCallbacks) {
	const runtime = createExtensionRuntime();
	const events = createEventBus();
	let disposed = false;
	const assertActive = () => { if (disposed) throw new Error("Extension host was disposed."); };
	const requireCallback = <K extends keyof ExtensionHostCallbacks>(name: K): NonNullable<ExtensionHostCallbacks[K]> => {
		assertActive();
		const callback = callbacks[name];
		if (!callback) return unavailable(`host.${name}`);
		return callback;
	};
	try {
		const extensions: Extension[] = [];
		const ids = new Set<string>();
		const commands = new Set<string>();
		const tools = new Set<string>();
		for (const { id, factory } of factories) {
			if (ids.has(id)) throw new Error(`Duplicate extension: ${id}`);
			ids.add(id);
			const extension = await loadExtensionFromFactory(factory, "/vault", events, runtime, `<builtin:${id}>`);
			validateRegistration(extension);
			for (const [names, registered, kind] of [[commands, extension.commands, "command"], [tools, extension.tools, "tool"]] as const) {
				for (const name of registered.keys()) {
					if (names.has(name)) throw new Error(`Duplicate extension ${kind}: ${name}`);
					names.add(name);
				}
			}
			extensions.push(extension);
		}
		if (runtime.pendingProviderRegistrations.length || runtime.pendingNativeProviderRegistrations.length) unavailable("extension provider registration");
		const session = limited({
			getEntries: () => structuredClone(requireCallback("getEntries")()),
			getLabel: (id: string) => requireCallback("getLabel")(id),
		}, "session");
		const models = limited({ getAvailable: () => structuredClone(requireCallback("getModels")()) }, "models");
		// Upstream types name concrete CLI classes, although Runner only passes these
		// read views through. Keep that structural mismatch at this single seam.
		const candidate: unknown = Reflect.construct(ExtensionRunner, [extensions, runtime, "/vault", session, models]);
		if (!(candidate instanceof ExtensionRunner)) throw new Error("Pi did not construct an extension runner.");
		const runner = candidate;
		const deny = (): never => unavailable("this extension action");
		const actions: ExtensionActions = {
			sendMessage: (message, options) => requireCallback("sendMessage")(message, options),
			sendUserMessage: deny, appendEntry: deny, setSessionName: deny, getSessionName: deny,
			setLabel: (id, label) => requireCallback("setLabel")(id, label),
			getActiveTools: () => callbacks.getActiveTools?.() ?? [...tools],
			getAllTools: deny, setActiveTools: deny, refreshTools: deny, getCommands: deny,
			setModel: model => requireCallback("setModel")({ provider: model.provider, id: model.id }),
			getThinkingLevel: () => requireCallback("getThinkingLevel")(), setThinkingLevel: deny,
		};
		const context: ExtensionContextActions = {
			getModel: () => requireCallback("getModel")(), getScopedModels: deny,
			isIdle: () => requireCallback("isIdle")(), isProjectTrusted: () => true,
			getSignal: deny, abort: deny, hasPendingMessages: deny, shutdown: deny,
			getContextUsage: deny, compact: deny, getSystemPrompt: deny,
		};
		runner.bindCore(actions, context, { registerProvider: deny, registerNativeProvider: deny, unregisterProvider: deny });
		runner.bindCommandContext({ waitForIdle: deny, newSession: deny, fork: deny, navigateTree: deny, switchSession: deny, reload: deny });
		const ui: ExtensionUIContext = {
			notify: message => requireCallback("notify")(message), select: deny, confirm: deny, input: deny,
			onTerminalInput: deny, setStatus: deny, setWorkingMessage: deny, setWorkingVisible: deny,
			setWorkingIndicator: deny, setHiddenThinkingLabel: deny, setWidget: deny, setFooter: deny,
			setHeader: deny, setTitle: deny, custom: deny, pasteToEditor: deny, setEditorText: deny,
			getEditorText: deny, editor: deny, addAutocompleteProvider: deny, setEditorComponent: deny,
			getEditorComponent: deny, get theme(): never { return unavailable("terminal theme"); },
			getAllThemes: deny, getTheme: deny, setTheme: deny, getToolsExpanded: deny, setToolsExpanded: deny,
		};
		runner.setUIContext(ui, "print");
		const unsubscribe = runner.onError(error => {
			// A failed context filter must stop the request, not leak hidden markers.
			throw new Error(`${error.extensionPath} (${error.event}): ${error.error}`);
		});
		const registeredTools: AgentTool[] = wrapRegisteredTools(runner.getAllRegisteredTools(), runner).map(tool => {
			const execute = tool.execute;
			return { ...tool, executionMode: "sequential", execute: async (...args) => {
				assertActive();
				const result = await execute(...args);
				assertActive();
				return result;
			} };
		});
		return {
			commands: runner.getRegisteredCommands().map(command => ({ name: command.invocationName, description: command.description })),
			tools: registeredTools,
			run: async (name: string, args = ""): Promise<void> => {
				assertActive();
				const command = runner.getCommand(name);
				if (!command) throw new Error(`Unknown extension command: ${name}`);
				await command.handler(args, runner.createCommandContext());
				assertActive();
			},
			transformContext: async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
				assertActive();
				const result = await runner.emitContext(messages);
				assertActive();
				return result;
			},
			dispose: () => {
				if (disposed) return;
				disposed = true;
				runner.invalidate();
				unsubscribe();
				events.clear();
			},
		};
	} catch (error) {
		disposed = true;
		runtime.invalidate();
		events.clear();
		throw error;
	}
}
export type ExtensionHost = Awaited<ReturnType<typeof createExtensionHost>>;
