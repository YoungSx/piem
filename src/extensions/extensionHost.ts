import type { AgentEvent, AgentMessage, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import type { Extension, ExtensionActions, ExtensionContextActions, ExtensionFactory, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { ExtensionRunner } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { createEventBus } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";
import { wrapRegisteredTools } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/wrapper.js";
import { unavailable } from "./node/unavailable";
import { ExtensionLifetime, abortable, type ExtensionScope } from "./extensionLifetime";
import { bindScopedContexts } from "./extensionContext";
import { ExtensionAgentEvents, SUPPORTED_EXTENSION_EVENTS } from "./extensionEvents";
import { createExtensionModels, extensionModelSnapshot, type ExtensionComplete } from "./extensionModels";
import { createExtensionSession } from "./extensionSession";
import { createNativeExtensionUI } from "./nativeExtensionUI";
import type { ExtensionUIAdapter } from "./extensionUI";

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
	getBranch?(): ExtensionEntry[];
	getSessionId?(): string;
	getSessionFile?(): string | undefined;
	getSessionName?(): string | undefined;
	/** Refresh the synchronous branch read view from the owning Vault session. */
	refreshSession?(): Promise<void>;
	notify(message: string): void;
	getLabel?(id: string): string | undefined;
	setLabel?(id: string, label: string | undefined): void;
	getModel?(): Model<string> | undefined;
	getModels?(): Model<string>[];
	complete?: ExtensionComplete;
	setModel?(model: Pick<Model<string>, "provider" | "id">): Promise<boolean>;
	getThinkingLevel?(): ThinkingLevel;
	isIdle?(): boolean;
	getSignal?(): AbortSignal | undefined;
	abort?(): void;
	hasPendingMessages?(): boolean;
	getSystemPrompt?(): string;
	waitForIdle?(): Promise<void>;
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
		if (!SUPPORTED_EXTENSION_EVENTS.has(event)) unavailable(`extension event ${event}`);
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
	const lifetime = new ExtensionLifetime();
	let disposed = false;
	let uiAdapter: ExtensionUIAdapter | undefined;
	const assertActive = () => { lifetime.assertActive(); if (disposed) throw new Error("Extension host was disposed."); };
	const requireCallback = <K extends keyof ExtensionHostCallbacks>(name: K): NonNullable<ExtensionHostCallbacks[K]> => {
		assertActive();
		const callback = callbacks[name];
		if (!callback) return unavailable(`host.${name}`);
		return callback;
	};
	const readCallback = <K extends keyof ExtensionHostCallbacks>(name: K): NonNullable<ExtensionHostCallbacks[K]> => {
		lifetime.assertActive();
		return callbacks[name] ?? unavailable(`host.${name}`);
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
		const session = limited(createExtensionSession(callbacks, lifetime.assertActive.bind(lifetime)), "session");
		const modelMembers = createExtensionModels({
			lifetime,
			getModels: () => readCallback("getModels")(),
			complete: (...args) => requireCallback("complete")(...args),
			assertAvailable: lifetime.assertActive.bind(lifetime),
		});
		const models = limited({
			...modelMembers,
			complete: async (...args: Parameters<typeof modelMembers.complete>) => {
				assertActive();
				return modelMembers.complete(...args);
			},
		}, "models");
		// Upstream types name concrete CLI classes, although Runner only passes these
		// read views through. Keep that structural mismatch at this single seam.
		const candidate: unknown = Reflect.construct(ExtensionRunner, [extensions, runtime, "/vault", session, models]);
		if (!(candidate instanceof ExtensionRunner)) throw new Error("Pi did not construct an extension runner.");
		const runner = candidate;
		const deny = (): never => unavailable("this extension action");
		const actions: ExtensionActions = {
			sendMessage: (message, options) => { lifetime.assertInvocation(); requireCallback("sendMessage")(message, options); },
			sendUserMessage: deny, appendEntry: deny, setSessionName: deny, getSessionName: () => requireCallback("getSessionName")(),
			setLabel: (id, label) => { lifetime.assertInvocation(); requireCallback("setLabel")(id, label); },
			getActiveTools: () => callbacks.getActiveTools?.() ?? [...tools],
			getAllTools: deny, setActiveTools: deny, refreshTools: deny, getCommands: deny,
			setModel: model => { lifetime.assertInvocation(); return requireCallback("setModel")({ provider: model.provider, id: model.id }); },
			getThinkingLevel: () => requireCallback("getThinkingLevel")(), setThinkingLevel: deny,
		};
		const context: ExtensionContextActions = {
			getModel: () => {
				const model = readCallback("getModel")();
				return model && extensionModelSnapshot(model);
			}, getScopedModels: deny,
			isIdle: () => readCallback("isIdle")(), isProjectTrusted: () => true,
			getSignal: () => (disposed ? undefined : callbacks.getSignal?.()) ?? lifetime.capture().signal,
			abort: () => requireCallback("abort")(), hasPendingMessages: () => readCallback("hasPendingMessages")(), shutdown: deny,
			getContextUsage: deny, compact: deny, getSystemPrompt: () => readCallback("getSystemPrompt")(),
		};
		runner.bindCore(actions, context, { registerProvider: deny, registerNativeProvider: deny, unregisterProvider: deny });
		runner.bindCommandContext({ waitForIdle: () => requireCallback("waitForIdle")(), newSession: deny, fork: deny, navigateTree: deny, switchSession: deny, reload: deny });
		const nativeUI = createNativeExtensionUI(lifetime, () => uiAdapter, message => requireCallback("notify")(message));
		runner.setUIContext(nativeUI.ui, "print");
		// Upstream considers any UI object available, even in print mode. Our
		// notice-only context must not claim a mounted Obsidian editor exists.
		bindScopedContexts(runner, lifetime, {
			hasUI: () => uiAdapter !== undefined,
			getThinkingLevel: () => readCallback("getThinkingLevel")(),
		}, extensions);
		const unsubscribe = runner.onError(error => {
			// A failed context filter must stop the request, not leak hidden markers.
			throw new Error(`${error.extensionPath} (${error.event}): ${error.error}`);
		});
		const agentEvents = new ExtensionAgentEvents(runner);
		const invoke = <T>(work: (scope: ExtensionScope) => Promise<T>, refresh = true): Promise<T> => lifetime.run(async scope => {
			assertActive();
			if (refresh) await callbacks.refreshSession?.();
			scope.assertActive();
			return lifetime.withScope(scope, () => work(scope));
		});
		let started: Promise<void> | undefined;
		let startCancelled = false;
		let closing: Promise<void> = Promise.resolve();
		const start = (reason: SessionStartEvent["reason"] = "startup"): Promise<void> => {
			assertActive();
			// Stop may cancel a startup dialog. The event remains once-only, but
			// its rejected promise must not permanently disable every command.
			if (startCancelled) return Promise.resolve();
			started ??= runner.hasHandlers("session_start")
				? invoke(async () => { await runner.emit({ type: "session_start", reason }); }).catch((error: unknown) => {
					if (error instanceof Error && error.name === "AbortError") startCancelled = true;
					throw error;
				})
				: Promise.resolve();
			return started;
		};
		const registeredTools: AgentTool[] = wrapRegisteredTools(runner.getAllRegisteredTools(), runner).map(tool => {
			const execute = tool.execute;
			return { ...tool, executionMode: "sequential", execute: async (...args) => {
				await start();
				return invoke(() => execute(...args));
			} };
		});
		return {
			hasBeforeAgentStart: runner.hasHandlers("before_agent_start"),
			commands: runner.getRegisteredCommands().map(command => ({ name: command.invocationName, description: command.description })),
			tools: registeredTools,
			run: async (name: string, args = ""): Promise<void> => {
				await start();
				const command = runner.getCommand(name);
				if (!command) throw new Error(`Unknown extension command: ${name}`);
				await invoke(async () => { await command.handler(args, runner.createCommandContext()); });
			},
			transformContext: async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
				await start();
				if (!runner.hasHandlers("context")) return structuredClone(messages);
				return invoke(() => runner.emitContext(structuredClone(messages)));
			},
			start,
			attachUI: (adapter: ExtensionUIAdapter | undefined): void => {
				assertActive();
				if (uiAdapter === adapter) return;
				lifetime.cancel();
				uiAdapter?.reset();
				uiAdapter = adapter;
				runner.setUIContext(nativeUI.ui, adapter ? "rpc" : "print");
				if (adapter) nativeUI.restore(adapter);
			},
			beforeAgentStart: async (prompt: string, images: ImageContent[] | undefined, systemPrompt: string) => {
				await start();
				if (!runner.hasHandlers("before_agent_start")) return undefined;
				return invoke(() => runner.emitBeforeAgentStart(prompt, images, systemPrompt, { cwd: "/vault" }));
			},
			emitAgentEvent: async (event: AgentEvent): Promise<void> => {
				await start();
				if (!runner.hasHandlers(event.type)) { agentEvents.observe(event); return; }
				// Streaming updates do not change the stored branch; no Vault read
				// per token. The service awaits this before persisting message_end.
				await invoke(scope => agentEvents.emit(event, () => scope.assertActive()), event.type !== "message_update" && event.type !== "tool_execution_update");
			},
			settled: async (): Promise<void> => {
				await start();
				if (!runner.hasHandlers("agent_settled")) return;
				await invoke(async () => { await runner.emit({ type: "agent_settled" }); });
			},
			cancel: (): void => lifetime.cancel(),
			closed: (): Promise<void> => closing,
			dispose: (reason: SessionShutdownEvent["reason"] = "quit"): void => {
				if (disposed) return;
				disposed = true;
				lifetime.revoke();
				uiAdapter?.reset();
				uiAdapter = undefined;
				nativeUI.clear();
				// Retire pi.* immediately. Shutdown handlers still receive a fresh
				// read-only ctx while local cleanup runs, bounded to one second.
				runtime.invalidate();
				events.clear();
				if (!started || !runner.hasHandlers("session_shutdown")) {
					lifetime.dispose(); runner.invalidate(); unsubscribe(); return;
				}
				closing = lifetime.run(async scope => {
					const timer = window.setTimeout(() => lifetime.cancel(), 1000);
					try { await abortable(runner.emit({ type: "session_shutdown", reason }), scope.signal); }
					finally { window.clearTimeout(timer); }
				}).finally(() => { lifetime.dispose(); runner.invalidate(); unsubscribe(); });
				// Disposal is synchronous; callers wanting cleanup evidence await
				// closed(). Observe here too so an omitted await cannot leak a rejection.
				void closing.catch(() => undefined);
			},
		};
	} catch (error) {
		disposed = true;
		lifetime.dispose();
		runtime.invalidate();
		events.clear();
		throw error;
	}
}
export type ExtensionHost = Awaited<ReturnType<typeof createExtensionHost>>;
