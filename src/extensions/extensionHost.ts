import type { AgentEvent, AgentMessage, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import type { ContextUsage, Extension, ExtensionActions, ExtensionContextActions, ExtensionFactory, ExtensionUIContext, SessionShutdownEvent, SessionStartEvent, ToolCallEvent, ToolCallEventResult, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { ContextSession } from "./contextSession";
import { ExtensionRunner } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { createEventBus, type EventBusController } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";
import { wrapRegisteredTools } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/wrapper.js";
import { unavailable } from "./node/unavailable";

import { ExtensionLifetime, abortable, type ExtensionScope } from "./extensionLifetime";
import { bindScopedContexts } from "./extensionContext";
import { ExtensionAgentEvents, SUPPORTED_EXTENSION_EVENTS } from "./extensionEvents";
import { createExtensionModels, type ExtensionComplete } from "./extensionModels";
import { createExtensionSession } from "./extensionSession";
import { commandInfoList, toolInfoList, type CommandEntry } from "./extensionRegistry";
import { createNativeExtensionUI } from "./nativeExtensionUI";
import type { ExtensionUIAdapter } from "./extensionUI";
import { parseKey } from "./compat/keys";

/** Not re-exported from the package root, unlike its `tool_call` counterpart. */
type ToolResultEventResult = NonNullable<Awaited<ReturnType<ExtensionRunner["emitToolResult"]>>>;

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
	notify: ExtensionUIContext["notify"];
	getLabel?(id: string): string | undefined;
	setLabel?(id: string, label: string | undefined): void;
	getModel?(): Model<string> | undefined;
	getModels?(): Model<string>[];
	complete?: ExtensionComplete;
	trackRequest?(settled: Promise<void>): void;
	setModel?(model: Pick<Model<string>, "provider" | "id">): Promise<boolean>;
	getThinkingLevel?(): ThinkingLevel;
	/**
	 * Applies a thinking level to the owning conversation.
	 *
	 * Pi's `setThinkingLevel` is synchronous `void`, and piem's write is not: it
	 * clamps to model capability, appends to the session log, and defers behind
	 * `pendingConfiguration` mid-run. The bridge resolves that seam by launching
	 * the write and routing its failure to {@link ExtensionHostCallbacks.notify},
	 * never by dropping it — see the `setThinkingLevel` action.
	 */
	setThinkingLevel?(level: ThinkingLevel): Promise<void>;
	/** Renames the owning conversation; rejects rather than reporting a write that did not happen. */
	setSessionName?(name: string): Promise<void>;
	/**
	 * Compacts the owning conversation, resolving to whether anything was summarized.
	 *
	 * Piem's own guards decide whether a compaction runs at all, and the promise
	 * says which happened: `false` is "nothing needed tidying", a rejection is a
	 * real failure. The bridge reports the first through `onComplete` and the
	 * second through `onError`, and never awaits either — see the `compact` action.
	 */
	compact?(): Promise<boolean>;
	/**
	 * Every tool the owning conversation's agent is currently holding.
	 *
	 * Live {@link AgentTool} objects, because the host owns the projection: only
	 * {@link ./extensionRegistry} decides what an extension may see, so an
	 * executable cannot reach an extension by a caller forgetting to strip it.
	 */
	getAllTools?(): readonly AgentTool[];
	/** Every slash command the owning conversation offers, projected the same way. */
	getCommands?(): readonly CommandEntry[];
	isIdle?(): boolean;
	getSignal?(): AbortSignal | undefined;
	abort?(): void;
	hasPendingMessages?(): boolean;
	getSystemPrompt?(): string;
	waitForIdle?(): Promise<void>;
	getActiveTools?(): string[];
	sendMessage?: ExtensionActions["sendMessage"];
	sendUserMessage?: ExtensionActions["sendUserMessage"];
	/** Audited scoped factories own one asynchronous operation, including its timers. */
	assertOperation?(): void;
	getAuth?(model: Model<string>): Promise<{ ok: true; apiKey?: string; headers?: Record<string, string>; baseUrl?: string } | { ok: false; error: string }>;
	setActiveTools?(names: string[]): void;
	getContextUsage?(): ContextUsage | undefined;
	getEditorText?(): string;
	setEditorText?(text: string): void;
	session?: ContextSession;
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

/**
 * What one extension gave up to load here, for the caller to log.
 *
 * `skipped` means the extension is not running at all; `degraded` means it is
 * running with a capability this host cannot serve. Both are reported, never
 * swallowed — the same rule {@link unavailable} and {@link limited} enforce for
 * a call, applied to a load.
 */
export interface ExtensionLoadReport {
	id: string;
	/** Present when the extension was skipped; absent when it merely degraded. */
	error?: Error;
	/** Capabilities registered but never asked for. Empty for a skipped extension. */
	ignored: string[];
}

/**
 * Registrations this host will not serve, split by whether that is visible.
 *
 * Refusing the extension outright — which is what this used to do for all of
 * these — is a worse answer than it looks. The bridge exists to run community
 * extensions on mobile Obsidian, and a package written for the CLI reaches for
 * CLI things incidentally: one `registerFlag` for a `--verbose` nobody can pass
 * in Obsidian used to cost the extension its tools, its commands, and (through
 * the host-wide catch) every *other* extension's too.
 *
 * So the three cases are told apart:
 *
 * - An unsupported **event** still skips the extension. A handler that never
 *   runs is a behavioural hole the extension cannot detect: it registered for
 *   `before_provider_request` because it intends to rewrite the request, and
 *   silently not calling it makes the extension wrong rather than reduced.
 * - **Flags** keep Pi's registered defaults; an unknown flag returns undefined.
 *   Obsidian has no command-line arguments to override those defaults.
 * - **Renderers and markdown transformers** are ignored *and recorded*. Pi
 *   stores them and hands them back through `runner.getMessageRenderer` /
 *   `getEntryRenderer` / `getMarkdownTransformers`; this host never calls those,
 *   because the transcript is rendered in React (`src/ui/MessageList.tsx`). So
 *   the registration succeeds and is then never consulted, which is exactly the
 *   silent capability loss worth a diagnostic: a transformer that was supposed
 *   to rewrite every reply is simply absent, and only this report says so.
 */
function validateRegistration(extension: Extension): string[] {
	for (const event of extension.handlers.keys()) {
		if (!SUPPORTED_EXTENSION_EVENTS.has(event)) unavailable(`extension event ${event}`);
	}
	// Flags use the native loader's defaults, so there is no degraded capability.
	const ignored: string[] = [];
	// Ignored and the extension may misbehave: registration succeeds, nothing
	// ever asks for the result.
	if (extension.messageRenderers.size) ignored.push("message renderers");
	if (extension.entryRenderers?.size) ignored.push("entry renderers");
	if (extension.markdownTransformer) ignored.push("markdown transformer");
	return ignored;
}

/**
 * Tracks one extension's claims on state shared with every other extension, so
 * rejecting it can leave the host as though it had never been offered.
 *
 * Three things outlive the `Extension` object a rejected load produces, which is
 * why dropping that object is not enough:
 *
 * - **Event-bus subscriptions.** `pi.events.on` reaches the bus directly, and
 *   the runtime only unsubscribes on `invalidate()` — i.e. host teardown. A
 *   skipped extension would keep hearing every channel and keep running its
 *   handlers. So each load gets its own `on`, recording the unsubscribers.
 * - **Flag defaults**, written into the shared `runtime.flagValues` by
 *   `commit()`. Left behind, they would answer another extension's `getFlag`
 *   for the same name.
 * - **Queued provider registrations**, which `bindCore` would later flush on
 *   behalf of an extension that is not running.
 */
function claim(events: EventBusController, runtime: ReturnType<typeof createExtensionRuntime>) {
	const unsubscribes: Array<() => void> = [];
	const flagsBefore = new Set(runtime.flagValues.keys());
	const providersBefore = runtime.pendingProviderRegistrations.length;
	const nativeProvidersBefore = runtime.pendingNativeProviderRegistrations.length;
	return {
		// Only `on` is wrapped. `emit` is shared by design — that is how two
		// cooperating extensions talk — and wrapping it would change delivery.
		events: {
			emit: (channel: string, data: unknown) => { events.emit(channel, data); },
			on: (channel: string, handler: (data: unknown) => void) => {
				const unsubscribe = events.on(channel, handler);
				unsubscribes.push(unsubscribe);
				return unsubscribe;
			},
		},
		registeredProvider: (): boolean =>
			runtime.pendingProviderRegistrations.length !== providersBefore
			|| runtime.pendingNativeProviderRegistrations.length !== nativeProvidersBefore,
		release: (): void => {
			for (const unsubscribe of unsubscribes) unsubscribe();
			for (const name of runtime.flagValues.keys()) if (!flagsBefore.has(name)) runtime.flagValues.delete(name);
			runtime.pendingProviderRegistrations.length = providersBefore;
			runtime.pendingNativeProviderRegistrations.length = nativeProvidersBefore;
		},
	};
}

/**
 * Static Pi factories share the real loader, runner and tool adapter. The host owns
 * their lifetime and the supported contract; the caller owns its authoritative
 * session, persistence and transport. No filesystem or provider registry is created.
 *
 * One extension's failure is that extension's failure. A factory that throws, or
 * that registers something this bridge cannot serve, is skipped and reported
 * through `loadReports`; the rest load and the host is usable. Only a genuinely
 * host-wide fault — the runner refusing to construct — takes the host down.
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
		const reports: ExtensionLoadReport[] = [];
		const ids = new Set<string>();
		const commands = new Set<string>();
		const tools = new Set<string>();
		const shortcutKeys = new Set<string>();
		for (const { id, factory } of factories) {
			// A duplicate id is a defect in *our* static list, not a collision
			// between two independent packages: the ids are literals in
			// `communityHost.ts`, one per audited factory. Skipping the second
			// would hide a copy-paste mistake behind a log line and leave the
			// host quietly missing an extension we shipped on purpose.
			if (ids.has(id)) throw new Error(`Duplicate extension: ${id}`);
			ids.add(id);
			// Every claim this extension staked on shared state, so a rejection
			// can put all of it back. Pi's loader already unwinds a factory that
			// *throws* (`load.discard()`), but one that returns and then fails
			// validation here has been committed: its event-bus subscriptions are
			// live, its flag defaults are in the shared `runtime.flagValues`, and
			// its provider registrations are queued. Undoing that is this host's
			// job, and it cannot be done by dropping the Extension object.
			const claimed = claim(events, runtime);
			try {
				const extension = await loadExtensionFromFactory(factory, "/vault", claimed.events, runtime, `<builtin:${id}>`);
				const ignored = validateRegistration(extension);
				// Provider registrations are checked per extension rather than once
				// after the loop, so the extension that queued one is the extension
				// that pays for it. Checked before the name reservations below so a
				// rejected extension has claimed no names.
				if (claimed.registeredProvider()) unavailable("extension provider registration");
				const keys = new Set<string>();
				for (const shortcut of extension.shortcuts.values()) {
					const key = parseKey(shortcut.shortcut);
					if (!key) unavailable(`extension shortcut ${shortcut.shortcut}`);
					// Two community extensions binding the same chord is a conflict
					// between strangers, and neither is wrong. Skip the loser.
					if (shortcutKeys.has(key)) throw new Error(`Duplicate extension shortcut: ${key}`);
					keys.add(key);
				}
				const claimedNames: Array<[Set<string>, string]> = [];
				for (const [names, registered, kind] of [[commands, extension.commands, "command"], [tools, extension.tools, "tool"]] as const) {
					for (const name of registered.keys()) {
						// Same reasoning as shortcuts, and the reason this is not a
						// host-wide failure: two packages that never heard of each
						// other can both offer `/search`. The first one loaded keeps
						// the name; the second is skipped whole, because a partly
						// registered extension is worse than an absent one.
						if (names.has(name)) throw new Error(`Duplicate extension ${kind}: ${name}`);
						claimedNames.push([names, name]);
					}
				}
				for (const [names, name] of claimedNames) names.add(name);
				for (const key of keys) shortcutKeys.add(key);
				extensions.push(extension);
				if (ignored.length) reports.push({ id, ignored });
			} catch (error) {
				// The extension is out. Release everything it took so the host it
				// is not part of cannot be affected by it.
				claimed.release();
				reports.push({ id, error: error instanceof Error ? error : new Error(String(error)), ignored: [] });
			}
		}
		const session = limited({
			...createExtensionSession(callbacks, lifetime.assertActive.bind(lifetime)),
			...(callbacks.session ? {
				getEntries: () => callbacks.session!.getEntries(),
				getBranch: (id?: string) => callbacks.session!.getBranch(id),
				getTree: () => callbacks.session!.getTree(),
				getChildren: (id: string) => callbacks.session!.getChildren(id),
				getLeafId: () => callbacks.session!.getLeafId(),
				getLeafEntry: () => callbacks.session!.getEntry(callbacks.session!.getLeafId() ?? ""),
				getEntry: (id: string) => callbacks.session!.getEntry(id),
				branchWithSummary: (id: string, summary: string) => callbacks.session!.branchWithSummary(id, summary),
				branch: (id: string) => callbacks.session!.branch(id),
			} : {}),
		}, "session");
		const modelMembers = createExtensionModels({
			lifetime,
			getModels: () => readCallback("getModels")(),
			complete: (...args) => requireCallback("complete")(...args),
			assertAvailable: lifetime.assertActive.bind(lifetime),
			assertCanComplete: assertActive,
			onRequest: settled => callbacks.trackRequest?.(settled),
		});
		const { snapshot: snapshotModel, revokeAuth, ...publicModelMembers } = modelMembers;
		const cancel = (): void => { revokeAuth(); lifetime.cancel(); callbacks.session?.cancel(); };
		const models = limited({
			...publicModelMembers,
			...(callbacks.getAuth ? { getApiKeyAndHeaders: (model: Model<string>) => requireCallback("getAuth")(model) } : {}),
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
		const assertAction = () => callbacks.assertOperation ? callbacks.assertOperation() : lifetime.assertInvocation();
		/**
		 * Hands a fire-and-forget write to the host so its failure still surfaces.
		 *
		 * Pi types `setSessionName`, `setThinkingLevel` and `compact` as synchronous
		 * `void`; every piem implementation behind them writes to the Vault. The
		 * asymmetry is resolved by returning early — which is upstream's own
		 * contract, `compact` says so in its doc comment — while keeping the promise
		 * observable: `trackRequest` makes the owning operation await it, so the
		 * service does not report a settled turn before the write lands, and a
		 * rejection reaches the panel through the same `notify` channel every other
		 * extension failure uses. A dropped `.catch` here would be a silent failed
		 * write, which this repo does not allow.
		 */
		const settle = (work: Promise<unknown>): void => {
			const observed = work.then(() => undefined, (error: unknown) => {
				// Cancellation is not a failure worth a banner: the user stopped the
				// run, and every other path in this host reports an abort the same way.
				if (error instanceof DOMException && error.name === "AbortError") return;
				if (lifetime.isDisposed()) return;
				try { callbacks.notify(error instanceof Error ? error.message : String(error), "error"); }
				catch { /* A retired notify sink must not raise an unhandled rejection. */ }
			});
			callbacks.trackRequest?.(observed);
		};
		const actions: ExtensionActions = {
			sendMessage: (message, options) => { assertAction(); requireCallback("sendMessage")(message, options); },
			sendUserMessage: (message, options) => { assertAction(); requireCallback("sendUserMessage")(message, options); },
			appendEntry: (customType, data) => { assertAction(); requireCallback("session").appendEntry(customType, data); },
			// Pi types both of these as synchronous `void` while the Vault writes
			// behind them are asynchronous. `settle` is the whole seam: the write is
			// started inside the caller's still-valid scope, then handed to the host's
			// operation tracker so the service awaits it before reporting success and
			// routes a rejection to `notify`. Returning before the write lands is
			// upstream's contract; *losing* the failure would not be.
			setSessionName: name => { assertAction(); settle(requireCallback("setSessionName")(name)); }, getSessionName: () => requireCallback("getSessionName")(),
			setLabel: (id, label) => { assertAction(); requireCallback("setLabel")(id, label); },
			getActiveTools: () => callbacks.getActiveTools?.() ?? [...tools],
			// Metadata only. `toolInfoList` rebuilds each entry from Pi's declared
			// ToolInfo members rather than copying and stripping the AgentTool, so
			// `execute` — and the conversation, agent state and transport it closes
			// over — cannot reach an extension. Read, not an action: an extension may
			// inspect the tool list after an await.
			getAllTools: () => toolInfoList(readCallback("getAllTools")()),
			setActiveTools: names => { assertAction(); requireCallback("setActiveTools")(names); }, refreshTools: deny,
			getCommands: () => commandInfoList(readCallback("getCommands")()),
			setModel: model => { assertAction(); return requireCallback("setModel")({ provider: model.provider, id: model.id }); },
			getThinkingLevel: () => requireCallback("getThinkingLevel")(),
			setThinkingLevel: level => { assertAction(); settle(requireCallback("setThinkingLevel")(level)); },
		};
		const context: ExtensionContextActions = {
			getModel: () => {
				const model = readCallback("getModel")();
				return model && snapshotModel(model);
			}, getScopedModels: deny,
			isIdle: () => readCallback("isIdle")(), isProjectTrusted: () => true,
			getSignal: () => (disposed ? undefined : callbacks.getSignal?.()) ?? lifetime.capture().signal,
			abort: () => requireCallback("abort")(), hasPendingMessages: () => readCallback("hasPendingMessages")(), shutdown: deny,
			getContextUsage: () => readCallback("getContextUsage")(),
			/*
			 * "Trigger compaction without awaiting completion" is upstream's own
			 * wording, so returning before the summary lands is the contract rather
			 * than a compromise. `settle` keeps the promise observable so a failure
			 * still reaches the panel.
			 *
			 * Two members of `CompactOptions` are refused rather than ignored, and
			 * the refusals are the honest part of this wiring:
			 *
			 * - `customInstructions` has nowhere truthful to go. piem's pipeline
			 *   passes `undefined` for pi's own `customInstructions` argument (see
			 *   {@link ../agent/compaction.ts}), and the single-flight guard makes
			 *   plumbing it through worse than absent: `runExclusiveCompaction`
			 *   collapses a concurrent request onto the compaction already running,
			 *   so a second caller's instructions would be silently replaced by the
			 *   first caller's. Accepting the field would promise a summary written
			 *   to an instruction that never reached the summarizer.
			 * - `onComplete` receives pi's `CompactionResult`, which is keyed by
			 *   `firstKeptEntryId` — a pointer to the session entry the cut kept.
			 *   piem's compaction entry does not have one: it stores the retained
			 *   messages on the entry itself (`retainedTail`), because the transcript
			 *   is the agent's message list rather than a log cursor. There is no
			 *   value for that field that is not invented, and a fabricated entry id
			 *   is worse than a missing callback — an extension would resolve it
			 *   against a session that never had it.
			 *
			 * `onError` is real and wired: a compaction that failed says so.
			 */
			compact: options => {
				assertAction();
				if (options?.customInstructions !== undefined) unavailable("extension compaction instructions");
				if (options?.onComplete) unavailable("extension compaction result callbacks");
				const request = requireCallback("compact");
				settle(request().then(() => undefined, (error: unknown) => {
					if (!options?.onError) throw error;
					// The extension's own closure. Raised through `settle` so a throwing
					// handler surfaces as an extension failure, never as an unhandled
					// rejection, and cannot swallow the compaction's own error silently.
					options.onError(error instanceof Error ? error : new Error(String(error)));
				}));
			},
			getSystemPrompt: () => readCallback("getSystemPrompt")(),
		};
		runner.bindCore(actions, context, { registerProvider: deny, registerNativeProvider: deny, unregisterProvider: deny });
		runner.bindCommandContext({ waitForIdle: () => requireCallback("waitForIdle")(), newSession: deny, fork: deny,
			navigateTree: async (id, options) => {
				const session = callbacks.session ?? deny();
				const scope = lifetime.capture();
				const oldLeafId = session.getLeafId();
				const result = await session.navigateTree(id, options);
				scope.assertActive();
				if (!result.cancelled && runner.hasHandlers("session_tree")) {
					const summaryEntry = session.getEntry(id);
					// The navigation queue has finished before entering a handler,
					// whose reads and writes can use this same ContextSession.
					await invoke(() => runner.emit({
						type: "session_tree", oldLeafId, newLeafId: session.getLeafId(), fromExtension: true,
						...(summaryEntry?.type === "branch_summary" ? { summaryEntry } : {}),
					}));
				}
				return result;
			}, switchSession: deny, reload: deny });
		const nativeUI = createNativeExtensionUI(lifetime, () => uiAdapter, (message, type) => requireCallback("notify")(message, type));
		if (callbacks.getEditorText) nativeUI.ui.getEditorText = () => requireCallback("getEditorText")();
		if (callbacks.setEditorText) nativeUI.ui.setEditorText = text => requireCallback("setEditorText")(text);
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
			try { return await lifetime.withScope(scope, () => work(scope)); }
			finally {
				// start, context filters and parallel tool hooks also pass here;
				// CommunityHost.operate alone would leave their writes unsaved.
				scope.assertActive();
				await callbacks.session?.flush();
				scope.assertActive();
			}
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
		const shortcuts = extensions.flatMap(extension => [...extension.shortcuts.values()]);
		let shortcutRunning = false;
		let attachmentRevision = 0;
		const attachShortcuts = (adapter: ExtensionUIAdapter): void => {
			if (!shortcuts.length) return;
			if (!adapter.setShortcuts) unavailable("native extension shortcut actions in this UI adapter");
			const revision = attachmentRevision;
			adapter.setShortcuts(shortcuts.map(shortcut => ({
				key: parseKey(shortcut.shortcut)!, description: shortcut.description ?? shortcut.shortcut,
				run: async (): Promise<void> => {
					assertActive();
					if (uiAdapter !== adapter || revision !== attachmentRevision) throw new Error("Extension shortcut belongs to an inactive panel.");
					if (shortcutRunning) throw new Error("An extension shortcut is already running.");
					shortcutRunning = true;
					try {
						await start();
						if (uiAdapter !== adapter || revision !== attachmentRevision) throw new Error("Extension shortcut belongs to an inactive panel.");
						await invoke(async () => { await shortcut.handler(runner.createContext()); });
					} finally { shortcutRunning = false; }
				},
			})));
		};
		return {
			/**
			 * Extensions that did not load, and extensions that loaded reduced.
			 *
			 * Read once by the caller after construction and logged there — the
			 * host has no logger and should not grow one, but a skipped extension
			 * that nothing reports is the silent no-op this file exists to refuse.
			 */
			loadReports: reports as readonly ExtensionLoadReport[],
			hasHandlers: (name: string) => runner.hasHandlers(name),
			emit: (event: Parameters<ExtensionRunner["emit"]>[0]) => invoke(() => runner.emit(event)),
			input: (text: string, images?: ImageContent[]) => invoke(() => runner.emitInput(text, images, "interactive")),
			complete: models.complete,
			hasBeforeAgentStart: runner.hasHandlers("before_agent_start"),
			commands: runner.getRegisteredCommands().map(command => ({ name: command.invocationName, description: command.description })),
			tools: registeredTools,
			run: async (name: string, args = ""): Promise<void> => {
				await start();
				const command = runner.getCommand(name);
				if (!command) throw new Error(`Unknown extension command: ${name}`);
				await invoke(async () => { await command.handler(args, runner.createCommandContext()); });
			},
			/**
			 * Runs `tool_call` handlers before a tool executes.
			 *
			 * `event.input` is mutable by contract: Pi's docs say handlers patch
			 * arguments by mutating it in place, later handlers observe earlier
			 * mutations, and no re-validation follows. So this must not clone —
			 * the object handed in is the one the caller forwards to the tool, and
			 * cloning here would accept mutations and then silently discard them,
			 * which is worse than refusing the event. It is the one host operation
			 * that deliberately breaks the structuredClone habit, and the caller
			 * owns choosing an input object it is willing to have mutated.
			 *
			 * Not re-validated against the tool schema afterwards, matching
			 * upstream. Re-validating would be a different contract from the one
			 * extensions are written against — `validateToolArguments` coerces and
			 * throws, so a handler that legitimately widens an argument would have
			 * its call fail here but succeed under Pi's own CLI. The tools that
			 * care re-check their own inputs anyway: every vault path goes through
			 * `normalizeVaultPath` inside the tool, so a mutated path cannot
			 * escape the vault regardless of what the schema said.
			 */
			toolCall: async (event: ToolCallEvent): Promise<ToolCallEventResult | undefined> => {
				await start();
				if (!runner.hasHandlers("tool_call")) return undefined;
				return invoke(async scope => {
					const result = await runner.emitToolCall(event);
					// A cancelled conversation must not block or unblock a call
					// that now belongs to a later run — mirrors message_end.
					scope.assertActive();
					return result;
				}, false);
			},
			/** Runs `tool_result` handlers; the returned fields replace the executed result. */
			toolResult: async (event: ToolResultEvent): Promise<ToolResultEventResult | undefined> => {
				await start();
				if (!runner.hasHandlers("tool_result")) return undefined;
				return invoke(async scope => {
					const result = await runner.emitToolResult(structuredClone(event));
					scope.assertActive();
					return result;
				}, false);
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
				attachmentRevision++;
				nativeUI.detach();
				cancel();
				uiAdapter?.reset();
				uiAdapter = adapter;
				runner.setUIContext(nativeUI.ui, adapter ? "rpc" : "print");
				if (adapter) { nativeUI.restore(adapter); attachShortcuts(adapter); }
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
			cancel,
			closed: (): Promise<void> => closing,
			dispose: (reason: SessionShutdownEvent["reason"] = "quit"): void => {
				if (disposed) return;
				disposed = true;
				nativeUI.retire();
				nativeUI.detach();
				revokeAuth();
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
