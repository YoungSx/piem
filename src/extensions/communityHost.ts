import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionHostCallbacks, StaticExtension } from "./extensionHost";
import type { ImageContent, ProviderResponse } from "@earendil-works/pi-ai";
import type { SessionBeforeForkEvent, SessionBeforeSwitchEvent, SessionShutdownEvent, SessionStartEvent, ToolCallEvent, ToolCallEventResult, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIAdapter } from "./extensionUI";
import { NOOP_LOGGER, type LoggerLike } from "../logging/Logger";
import { createExtensionHost, type ExtensionHost } from "./extensionHost";
import { createExtensionPlatform, type BackgroundExtensionPlatform, type ExtensionPlatformCallbacks } from "./extensionPlatform";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createClarify, createContext, createOtel, createWebSearch, invisibleContinue, modelSwitch, provenance } from "./communityFactories.mjs";

export interface CommunityCallbacks extends Omit<ExtensionHostCallbacks, "sendMessage" | "sendUserMessage"> {
	platform: Omit<ExtensionPlatformCallbacks, "complete">;
	prepare(): Promise<void>;
	deliver(messages: AgentMessage[]): void;
	/** Configured values for the original OTel factory's private environment. */
	otelEnvironment?(): Readonly<Record<string, string>>;
	/**
	 * Where this host's load verdicts go.
	 *
	 * The extension host deliberately holds no logger — it is a bridge, and a
	 * bridge that reaches for the plugin's observability stack would carry the
	 * whole settings closure with it. So it returns `loadReports` and this class,
	 * which the service constructs and therefore can hand a logger, is the one
	 * that writes them down. Optional and defaulted to {@link NOOP_LOGGER} for
	 * the same reason the draft store and the MCP manager are: constructing one
	 * bare is a valid test configuration, and an `if` at the emit site is how
	 * logging quietly stops happening.
	 */
	logger?: LoggerLike;
}

/** A statically compiled factory; selecting its lifetime is an audited host decision. */
export type CommunityExtension = StaticExtension | { id: string; createFactory(platform: BackgroundExtensionPlatform): ExtensionFactory };

/** One conversation owns its factories, transport, pending actions and timers. */
export class CommunityHost {
	private host!: ExtensionHost;
	private platform!: ReturnType<typeof createExtensionPlatform>;
	private backgrounds = new Map<string, ReturnType<ReturnType<typeof createExtensionPlatform>["forBackgroundExtension"]>>();
	private closing: Promise<void> = Promise.resolve();
	private pending: AgentMessage[] = [];
	private disposed = false;
	private otelDisabled = false;
	private failure: { error?: Error } = {};
	private activeTools?: Set<string>;
	private navigationDispatches = 0;

	private needsContextReset = false;
	private contextReset?: Promise<void>;
	private ui?: ExtensionUIAdapter;
	private readonly log: LoggerLike;
	private constructor(private readonly callbacks: CommunityCallbacks, private readonly extensions?: readonly CommunityExtension[]) {
		this.log = (callbacks.logger ?? NOOP_LOGGER).child("extensions");
	}

	static async create(callbacks: CommunityCallbacks, extensions?: readonly CommunityExtension[]): Promise<CommunityHost> {
		const owner = new CommunityHost(callbacks, extensions);
		owner.platform = createExtensionPlatform({
			...callbacks.platform,
			complete: async (model, context, options) => {
				// Credentials and transport remain owned by the native model bridge.
				const response = await owner.host.complete(model, context, { signal: options?.signal, cacheRetention: "none" });
				if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Draft rewrite failed.");
				return response;
			},
			beforeTimer: async () => { await callbacks.waitForIdle?.(); await callbacks.prepare(); },
			afterTimer: async () => { await owner.flushWrites(); owner.deliver(); },
		});
		try { await owner.initialize(); return owner; }
		catch (error) { owner.platform.dispose(); throw error; }
	}

	private async initialize(): Promise<void> {
		const callbacks = this.callbacks;
		// Each scoped factory receives a view bound to its own id, so the config
		// namespace it can address comes from construction, not from the path it
		// asks for. Sharing one platform object would make them interchangeable.
		const scoped = (owner: string) => this.platform.forExtension(owner);
		const extensions: readonly CommunityExtension[] = this.extensions ?? [
			{ id: "pi-invisible-continue", factory: invisibleContinue },
			{ id: "pi-assistant-provenance", factory: provenance },
			{ id: "pi-model-switch", factory: modelSwitch },
			{ id: "pi-web-search", factory: createWebSearch(scoped("pi-web-search")) },
			{ id: "pi-clarify", factory: createClarify(scoped("pi-clarify")) },
			{ id: "pi-context", factory: createContext(scoped("pi-context")) },
			{ id: "pi-otel", createFactory: platform => {
				Object.assign(platform.process.env, this.otelDisabled ? {} : callbacks.otelEnvironment?.() ?? {});
				return createOtel(platform);
			} },
		];
		const factories = extensions.map(extension => {
			if ("factory" in extension) return extension;
			if (this.backgrounds.has(extension.id)) throw new Error(`Duplicate background extension: ${extension.id}`);
			const resources = this.platform.forBackgroundExtension(extension.id);
			this.backgrounds.set(extension.id, resources);
			return {
				id: extension.id,
				factory: (pi: Parameters<ExtensionFactory>[0]) => extension.createFactory(resources.platform)(pi),
				onLoadFailure: () => { resources.dispose(); this.backgrounds.delete(extension.id); },
			};
		});
		this.host = await createExtensionHost(factories, {
			...callbacks,
			...(this.extensions ? { getAuth: undefined } : { assertOperation: () => this.assertActive() }),
			refreshSession: () => callbacks.prepare(),
			trackRequest: settled => { if (this.platform.busy) this.platform.trackRequest(settled); },
			setActiveTools: names => { this.activeTools = new Set(names); callbacks.setActiveTools?.(names); },
			setEditorText: text => { this.assertActive(); callbacks.setEditorText?.(text); },
			notify: (message, type) => {
				this.assertActive();
				if (type === "error" || message === "Cancelled") this.failure.error ??= new Error(message);
				callbacks.notify(message, type);
			},
			sendMessage: (message, options) => {
				this.assertActive();
				if (!options?.triggerTurn || options.deliverAs !== "followUp") throw new Error("Only queued follow-up turns are supported.");
				if (this.pending.length >= 16) throw new Error("Too many extension messages in one operation.");
				this.pending.push({ ...structuredClone(message), role: "custom", timestamp: Date.now() });
			},
			sendUserMessage: (content, options) => {
				this.assertActive();
				if (content === "/acm" && options?.expandPromptTemplates) {
					void this.host.run("acm").catch(error => callbacks.platform.onError(error));
					return;
				}
				if (options?.deliverAs !== "followUp" || this.pending.length >= 16) throw new Error("Only bounded follow-up messages are supported.");
				this.pending.push({ role: "user", content, timestamp: Date.now() });
			},
		});
		// A settings change may have retired the previous host while this one
		// awaited factory loading. Apply that decision to its replacement too.
		if (this.otelDisabled) this.disableOtel();
		// The host's own doc comment refuses a silent no-op, and a report nobody
		// reads is exactly that. Warn for an extension that is not running: it is
		// gone, nothing else in the UI says so, and a missing tool or command is
		// what the user will notice first. Info for one that loaded reduced — the
		// same call the MCP manager makes for a mount, and for the same reason: it
		// happens once per host, and it is the anchor for the later "why did my
		// transformer never run" question. Not warn, because the extension is
		// working; not debug, because nothing else records it at all.
		for (const { id, error, ignored } of this.host.loadReports) {
			if (error) this.log.warn(`Extension skipped: ${id}`, () => ({ error: error.message }));
			else this.log.info(`Extension loaded degraded: ${id}`, () => ({ ignored: ignored.join(", ") }));
		}
		for (const tool of this.host.tools) {
			if (tool.name === "switch_model") tool.description += " In Piem, only unambiguous configured models are available. A switch changes the next request in this conversation and saves the default choice; that provider receives the conversation. Pricing is unknown. Local aliases.json is not mounted.";
			if (tool.name === "web_search") tool.description += " Sends the search query and supplied URLs to the configured model provider through Obsidian. Requires a provider endpoint supporting native search; search may incur extra charges. Never silently switches providers.";
			if (tool.name === "context_checkpoint") tool.description += " Checkpoint names must contain 1–160 characters. Changes are saved before success is returned.";
			if (tool.name === "context_compact") tool.description += " Summary must contain 1–128000 characters. A saved summary branch is selected after the current run ends; stopping cancels pending continuation. Existing vault files are never reverted.";
			const bounds = tool.name === "context_checkpoint" ? { name: "Must contain 1–160 characters." }
				: tool.name === "context_compact" ? { summary: "The handoff, including its source prefix, must contain 1–128000 characters.", backupCheckpoint: "If supplied, must contain 1–160 characters." } : {};
			for (const [name, description] of Object.entries(bounds)) {
				const properties: unknown = Reflect.get(tool.parameters, "properties");
				const parameter: unknown = properties && typeof properties === "object" ? Reflect.get(properties, name) : undefined;
				if (!parameter || typeof parameter !== "object") throw new Error(`Missing audited tool parameter: ${tool.name}.${name}`);
				const previous: unknown = Reflect.get(parameter, "description");
				Reflect.set(parameter, "description", `${typeof previous === "string" ? previous : ""} ${description}`.trim());
			}
		}
	}

	get hasBeforeAgentStart() { return this.host.hasBeforeAgentStart; }
	get tools(): AgentTool[] {
		return this.host.tools.filter(tool => !this.activeTools || this.activeTools.has(tool.name)).map(tool => ({
			...tool,
			// Agent tool lists can outlive a cancelled runner. Resolve the current
			// implementation after operate has recreated its private extension state.
			execute: (...args) => this.operate(async () => {
				const current = this.host.tools.find(candidate => candidate.name === tool.name);
				if (!current) throw new Error(`Unknown extension tool: ${tool.name}`);
				const result = await current.execute(...args);
				// Upstream search encodes failures in details; Pi core expects a throw.
				const details: unknown = result.details;
				if ((tool.name === "web_search" || tool.name === "url_context") && details && typeof details === "object" && Reflect.get(details, "error")) {
					throw new Error(result.content.filter(part => part.type === "text").map(part => part.text).join("\n"));
				}
				return result;
			}, args[2]),
		}));
	}
	get commands() { return this.host.commands.filter(command => command.name !== "acm"); }
	get busy() { return this.platform.busy; }
	get isStarting() { return this.host.isStarting; }
	/** A selection can arrive while another handler awaits input; never wait for that handler's own idle. */
	async beforeSessionChange(event: SessionBeforeForkEvent | SessionBeforeSwitchEvent): Promise<boolean> {
		if (!this.host.hasHandlers(event.type)) return false;
		// A startup callback must finish initialization before any veto handler;
		// waiting on its own startup promise would deadlock an indirect selection.
		if (this.host.isStarting) return true;
		// An existing operation already owns a refreshed read view. Refreshing it
		// again can wait on a ContextSession navigation that is calling us itself.
		const emit = async () => { await this.host.start(); return this.host.emit(event, false); };
		this.navigationDispatches++;
		try {
			let result;
			if (this.platform.busy) {
				const work = emit().then(async result => { await this.flushWrites(); this.assertActive(); return result; });
				this.platform.trackRequest(work.then(() => undefined));
				result = await work;
			} else result = await this.operate(emit);
			// This matches Pi's runtime: skipConversationRestore remains in its types,
			// but the upstream fork path only consumes cancel.
			return result?.cancel === true;
		} finally { this.navigationDispatches--; }
	}
	async syncModel(): Promise<void> {
		if (!this.host.hasHandlers("model_select")) return;
		const emit = () => this.host.emit({ type: "model_select", model: this.callbacks.getModel!()!, previousModel: undefined, source: "set" });
		if (this.platform.busy) await emit();
		else await this.operate(emit);
	}
	attachUI(adapter: ExtensionUIAdapter | undefined): void { this.ui = adapter; this.host.attachUI(adapter); }
	start(reason?: SessionStartEvent["reason"]): Promise<void> {
		return this.host.start(reason);
	}
	beforeAgentStart(prompt: string, images: ImageContent[] | undefined, systemPrompt: string) {
		return this.operate(() => this.host.beforeAgentStart(prompt, images, systemPrompt));
	}
	/** Provider hooks refresh once per request, not per streamed token. */
	beforeProviderRequest(payload: unknown): Promise<unknown> {
		if (!this.host.hasHandlers("before_provider_request")) return Promise.resolve(undefined);
		this.assertActive();
		return this.host.beforeProviderRequest(payload);
	}
	afterProviderResponse(response: ProviderResponse): Promise<void> {
		if (!this.host.hasHandlers("after_provider_response")) return Promise.resolve();
		this.assertActive();
		return this.host.afterProviderResponse(response);
	}
	emitAgentEvent(event: AgentEvent): Promise<void> {
		if (!this.host.hasHandlers(event.type)) return this.host.emitAgentEvent(event);
		if (this.navigationDispatches && this.platform.busy) {
			// A pending switch dialog must not suppress the source chat's live
			// message/tool observers. Reuse its captured view and retain each task
			// until writes settle, even if the navigation handler finishes first.
			this.navigationDispatches++;
			const work = this.host.emitAgentEvent(event, false).then(() => this.flushWrites()).finally(() => { this.navigationDispatches--; });
			this.platform.trackRequest(work);
			return work;
		}
		return this.operate(() => this.host.emitAgentEvent(event), undefined,
			event.type !== "message_update" && event.type !== "tool_execution_update");
	}
	/**
	 * Intercepts a tool call before it executes.
	 *
	 * Deliberately not wrapped in {@link operate}. A parallel tool batch finalizes
	 * several calls at once — measured: two `afterToolCall` invocations in flight
	 * for one batch — and `operate` is exclusive, so the second would be rejected
	 * with "An extension operation is already running" and the tool result of a
	 * perfectly good call would be replaced by that error. These two hooks are
	 * also already inside the agent's own run: the Vault refresh `operate` exists
	 * to perform has just happened for this turn, and a tool call is the hot path
	 * the refresh policy explicitly excludes elsewhere (`message_update`,
	 * `tool_execution_update`). The host's own lifetime scope still bounds them,
	 * so a stopped conversation's handler cannot affect a later call.
	 *
	 * `event.input` is passed through unchanged so in-place mutation reaches the
	 * tool; see the host's own comment for why it is not cloned or re-validated.
	 */
	toolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
		if (!this.host.hasHandlers("tool_call")) return Promise.resolve(undefined);
		this.assertActive();
		return this.host.toolCall(event);
	}
	toolResult(event: ToolResultEvent): ReturnType<ExtensionHost["toolResult"]> {
		if (!this.host.hasHandlers("tool_result")) return Promise.resolve(undefined);
		this.assertActive();
		return this.host.toolResult(event);
	}
	settled(): Promise<void> {
		if (!this.host.hasHandlers("agent_settled")) return Promise.resolve();
		return this.host.settled();
	}
	cancelInvocation(): void { this.host.cancel(); }
	async closed(): Promise<void> { await this.closing; await this.host.closed(); await this.callbacks.session?.settled(); }

	/**
	 * Persists everything this operation staged, before any success is reported.
	 *
	 * A staged config value is not a saved one. `writeFileSync` is synchronous
	 * and cannot await the settings write, so the actual save is awaited here —
	 * at the same boundary the session flush already uses. Config goes first:
	 * its rejection has to reach the caller as a failure rather than be masked
	 * by a later step, since an extension that was told "saved" and was not is
	 * the one outcome worse than an error.
	 */
	private async flushWrites(): Promise<void> {
		await this.callbacks.platform.config?.flush();
		await this.callbacks.session?.flush();
	}

	assertActive(): void { if (this.disposed) throw new Error("Extension host was disposed."); this.platform.assertActive(); }
	getSignal(): AbortSignal { return this.platform.getSignal(); }
	async drain(): Promise<void> { await this.platform.drain(); await this.callbacks.session?.settled(); }

	async run(name: string, args = ""): Promise<AgentMessage[]> {
		await this.operate(() => this.host.run(name, args));
		return this.takeMessages();
	}
	async input(text: string) { return this.operate(() => this.host.input(text)); }
	async emit(event: Parameters<ExtensionHost["emit"]>[0], detached = false): Promise<void> {
		if (!this.host.hasHandlers(event.type)) return;
		// A host action can emit an observation while its command owns the
		// platform. Its outer operation still owns flushing and delivery.
		if (this.platform.busy) {
			const work = this.host.emit(event).then(async () => {
				// Compaction completes independently of its triggering command.
				// That command may have already collected its follow-ups, so this
				// observation must flush and deliver its own queued effects.
				if (detached) { await this.flushWrites(); this.assertActive(); this.deliver(); }
			});
			if (detached) this.platform.trackRequest(work);
			await work;
			return;
		}
		await this.operate(async () => { await this.host.emit(event); });
		this.deliver();
	}
	transformContext(messages: AgentMessage[]): Promise<AgentMessage[]> { return this.host.transformContext(messages); }

	/** Stop reporting now; discard the queued data instead of a final shutdown export. */
	disableOtel(): void {
		this.otelDisabled = true;
		this.backgrounds.get("pi-otel")?.dispose();
		this.backgrounds.delete("pi-otel");
		this.host?.removeObserver("pi-otel");
	}

	cancel(): void {
		this.host.cancel();
		this.platform.cancel();
		this.pending = [];
		// Native factories retain completed startup callbacks. The audited context
		// factory alone requires rebuilding its private pending-compaction state.
		this.needsContextReset = this.extensions === undefined;
	}
	dispose(reason?: SessionShutdownEvent["reason"]): void {
		if (this.disposed) return;
		this.disposed = true;
		// A reload still racing with this dispose must not surface its own
		// disposed rejection as an unhandled error after the owner is gone.
		void this.contextReset?.catch(() => undefined);
		// A reload still racing with this dispose must not surface its own
		// disposed rejection as an unhandled error after the owner is gone.
		void this.contextReset?.catch(() => undefined);
		this.platform.cancel();
		for (const resources of this.backgrounds.values()) resources.beginShutdown();
		this.callbacks.session?.dispose();
		this.host.dispose(reason);
		this.closing = this.host.closed().finally(() => {
			this.platform.dispose();
			this.backgrounds.clear();
		});
		void this.closing.catch(() => undefined);
		this.pending = [];
	}
	private async operate<T>(work: () => Promise<T>, signal?: AbortSignal, refresh = true): Promise<T> {
		if (this.disposed) throw new Error("Extension host was disposed.");
		if (this.needsContextReset) {
			this.contextReset ??= this.resetContext().finally(() => { this.contextReset = undefined; });
			await this.contextReset;
		}
		return this.platform.withOperation(async () => {
			this.failure = {};
			if (refresh) await this.callbacks.prepare();
			this.assertActive();
			try {
				const result = await work();
				this.assertActive();
				await this.flushWrites();
				const failure = this.failure.error;
				if (failure) throw failure;
				return result;
			} catch (error) { this.pending = []; throw error; }
		}, signal);
	}
	private async resetContext(): Promise<void> {
		await this.platform.drain();
		if (this.disposed) throw new Error("Extension host was disposed.");
		for (const resources of this.backgrounds.values()) resources.beginShutdown();
		this.host.dispose("reload");
		try { await this.host.closed(); }
		catch (error) {
			// A slow exporter must not strand the next chat operation on a retired host.
			this.log.warn("Extension cleanup failed during reload", () => ({ error: error instanceof Error ? error.message : String(error) }));
		} finally {
			for (const resources of this.backgrounds.values()) resources.dispose();
			this.backgrounds.clear();
		}
		if (this.disposed) throw new Error("Extension host was disposed.");
		await this.initialize();
		if (this.disposed) { this.host.dispose(); await this.host.closed(); throw new Error("Extension host was disposed."); }
		if (this.ui) this.host.attachUI(this.ui);
		this.needsContextReset = false;
	}
	private takeMessages(): AgentMessage[] { const messages = this.pending; this.pending = []; return messages; }
	private deliver(): void { const messages = this.takeMessages(); if (messages.length) this.callbacks.deliver(messages); }
}
