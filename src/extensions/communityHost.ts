import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionHostCallbacks, StaticExtension } from "./extensionHost";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { SessionShutdownEvent, SessionStartEvent, ToolCallEvent, ToolCallEventResult, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIAdapter } from "./extensionUI";
import { NOOP_LOGGER, type LoggerLike } from "../logging/Logger";
import { createExtensionHost, type ExtensionHost } from "./extensionHost";
import { createExtensionPlatform, type ExtensionPlatformCallbacks } from "./extensionPlatform";
import { createClarify, createContext, createWebSearch, invisibleContinue, modelSwitch, provenance } from "./communityFactories.mjs";

export interface CommunityCallbacks extends Omit<ExtensionHostCallbacks, "sendMessage" | "sendUserMessage"> {
	platform: Omit<ExtensionPlatformCallbacks, "complete">;
	prepare(): Promise<void>;
	deliver(messages: AgentMessage[]): void;
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

/** One conversation owns its factories, transport, pending actions and timers. */
export class CommunityHost {
	private host!: ExtensionHost;
	private platform!: ReturnType<typeof createExtensionPlatform>;
	private pending: AgentMessage[] = [];
	private disposed = false;
	private failure: { error?: Error } = {};
	private activeTools?: Set<string>;

	private needsContextReset = false;
	private ui?: ExtensionUIAdapter;
	private readonly log: LoggerLike;
	private constructor(private readonly callbacks: CommunityCallbacks, private readonly extensions?: readonly StaticExtension[]) {
		this.log = (callbacks.logger ?? NOOP_LOGGER).child("extensions");
	}

	static async create(callbacks: CommunityCallbacks, extensions?: readonly StaticExtension[]): Promise<CommunityHost> {
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
		await owner.initialize();
		return owner;
	}

	private async initialize(): Promise<void> {
		const callbacks = this.callbacks;
		// Each scoped factory receives a view bound to its own id, so the config
		// namespace it can address comes from construction, not from the path it
		// asks for. Sharing one platform object would make them interchangeable.
		const scoped = (owner: string) => this.platform.forExtension(owner);
		this.host = await createExtensionHost(this.extensions ?? [
			{ id: "pi-invisible-continue", factory: invisibleContinue },
			{ id: "pi-assistant-provenance", factory: provenance },
			{ id: "pi-model-switch", factory: modelSwitch },
			{ id: "pi-web-search", factory: createWebSearch(scoped("pi-web-search")) },
			{ id: "pi-clarify", factory: createClarify(scoped("pi-clarify")) },
			{ id: "pi-context", factory: createContext(scoped("pi-context")) },
		], {
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
	emitAgentEvent(event: AgentEvent): Promise<void> {
		if (!this.host.hasHandlers(event.type)) return this.host.emitAgentEvent(event);
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
	async closed(): Promise<void> { await this.host.closed(); await this.callbacks.session?.settled(); }

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
	async emit(event: Parameters<ExtensionHost["emit"]>[0]): Promise<void> {
		if (!this.host.hasHandlers(event.type)) return;
		// A host action can emit an observation while its command owns the
		// platform. Its outer operation still owns flushing and delivery.
		if (this.platform.busy) { await this.host.emit(event); return; }
		await this.operate(async () => { await this.host.emit(event); });
		this.deliver();
	}
	transformContext(messages: AgentMessage[]): Promise<AgentMessage[]> { return this.host.transformContext(messages); }

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
		this.platform.dispose();
		this.callbacks.session?.dispose();
		this.host.dispose(reason);
		this.pending = [];
	}
	private async operate<T>(work: () => Promise<T>, signal?: AbortSignal, refresh = true): Promise<T> {
		if (this.disposed) throw new Error("Extension host was disposed.");
		if (this.needsContextReset) {
			await this.platform.drain();
			if (this.disposed) throw new Error("Extension host was disposed.");
			this.host.dispose("reload");
			await this.host.closed();
			await this.initialize();
			if (this.ui) this.host.attachUI(this.ui);
			this.needsContextReset = false;
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
	private takeMessages(): AgentMessage[] { const messages = this.pending; this.pending = []; return messages; }
	private deliver(): void { const messages = this.takeMessages(); if (messages.length) this.callbacks.deliver(messages); }
}
