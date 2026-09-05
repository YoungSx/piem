import { type App, Notice, parseLinktext, TFile } from "obsidian";
import { clampThinkingLevel, getSupportedThinkingLevels, type ImageContent, type Usage } from "@earendil-works/pi-ai";
import {
	Agent,
	collectEntriesForBranchSummary,
	convertToLlm,
	createBranchSummaryMessage,
	generateBranchSummary,
	type AgentEvent,
	type AgentLoopTurnUpdate,
	type AgentMessage,
	type AgentTool,
	type ExecutionEnv,
	type OperationStartedRecord,
	type PrepareNextTurnContext,
	type PromptTemplate,
	type StreamFn,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { PromptQueue, type QueuedPrompt } from "./promptQueue";
import { SessionRuntime, type SessionRunState } from "./SessionRuntime";
import { createObsidianModels, withRequestDefaults, type ObsidianModelsBundle } from "../net/streamFn";
import { toFetchFunction } from "../net/obsidianFetch";
import { matchVendorForModel } from "../net/vendorMatch";
import { vendorIconName } from "../net/vendorIcons";
import { compactIfNeeded, needsCompaction, DEFAULT_COMPACTION_RETRY, type CompactionEvent } from "./compaction";
import { measureContextFill, sumUsage, type ContextFill, type UsageTotals } from "./usage";
import { resolveCompactionSettings, type CompactionSettings } from "./compactionSettings";
import { createObsidianTools } from "../tools/obsidianTools";
import type { AskUserBroker } from "../tools/askUserBroker";
import { fetchQuickActionSuggestions, lastAssistantText, type SuggestionScope } from "./quickActionSuggestionRequest";
import { QuickActionSuggestionCache } from "./quickActionSuggestionCache";
import type { QuickAction } from "../ui/quickActionSuggestions";
import type { TraceExpandSetting } from "../ui/traceExpand";
import { DEFAULT_THINKING_LEVEL } from "../constants";
import {
	describeModelTarget,
	getApiKeyForProvider,
	getConfiguredApiKey,
	getSelectedModel,
	listModelChoices,
	resolveModelChoice,
	modelSupportsImages,
	type ModelChoice,
	type PiemSettings,
} from "../settings";
import {
	ObsidianSessionManager,
	type ActiveSessionInfo,
	type SessionContext,
	type SessionDefaults,
} from "../session/ObsidianSessionManager";
import { aggregateSessionSearchHits, type SessionSearchResult } from "../session/sessionSearch";
import { arrayBufferToBase64, extractImageRefs, mimeTypeForPath, sanitizeMessageForLog, stripImageRefs } from "../vault/image";
import { EMPTY_RUN_CONTEXT, injectContext, type FrozenRunContext, type InjectedNote } from "./contextInjection";
import { probeEnvironment, probeRunContext } from "./contextProbe";
import { noteFileName, renderTranscriptMarkdown, type ExportableMessage } from "./exportNote";
import { MAX_PINNED_REFS, type ContextRef } from "./contextRefs";
import { withEnvironment } from "./environmentPrompt";
import { createSubagentExtension } from "../subagent/extension";
import { OBSIDIAN_AGENT_SYSTEM_PROMPT } from "./systemPrompt";
import { composeSystemPrompt, emptySkillLoadReport, expandSkill, findSkill, loadVaultSkills, mergeSkills, type SkillLoadReport } from "./skillLoader";
import { loadUserSkills, type UserSkillsLoad } from "../skills/userSkills";
import type { Skill } from "@earendil-works/pi-agent-core";
import { describeAgentEvent } from "./agentEventLog";
import { stampReplyEnd } from "../ui/replyDuration";
import { summarizeToolContent } from "../ui/traceSummary";
import { NOOP_LOGGER, type LoggerLike } from "../logging/Logger";
import { getT, resolveLanguage, type Language, type LanguageHost, type Translator } from "../i18n";
import type { SendShortcut } from "../ui/keyboard";
import { VaultExecutionEnv } from "../vault/VaultExecutionEnv";
import { BUILTIN_PROMPT_TEMPLATES } from "./builtinTemplates";
import { createBuiltinSkills } from "./builtinSkills";
import {
	expandPromptTemplate,
	findPromptTemplate,
	loadVaultPromptTemplates,
	parsePromptCommand,
} from "./promptTemplates";

/** A tool call in flight, with whatever progress it has reported. */
export interface PendingToolCall {
	/**
	 * The provider's call id, which is what makes this list answerable per row.
	 *
	 * It is never rendered — `toolu_bdrk_01...` in front of the user is the defect
	 * that put names here in the first place — but the transcript needs it: a
	 * `ToolCall` block carries the same string, so a row can ask whether it is one
	 * of the calls still out instead of the renderer inferring it from position.
	 * That inference (the last block of the streaming message) can only ever be
	 * right about one call, so it went wrong the moment a turn issued two.
	 */
	id: string;
	/** Tool id as pi names it (`grep`), which the UI translates for display. */
	name: string;
	/**
	 * Newest progress line the tool reported, if any.
	 *
	 * One line rather than accumulated output: this renders inside the live
	 * status row in a 300px sidebar, and the full text is already on its way to
	 * the transcript as the tool result. Absent until the tool reports something,
	 * which is distinct from an empty string — a tool that reports a blank line
	 * has still said nothing worth showing.
	 */
	progress?: string;
}

export interface ChatSnapshot {
	messages: AgentMessage[];
	streamingMessage?: AgentMessage;
	isStreaming: boolean;
	/**
	 * The tools running right now, newest progress included.
	 *
	 * Each entry carries both the id pi tracks in `agent.state.pendingToolCalls`
	 * and the tool's name. The Set holds ids alone, so rendering it put
	 * `toolu_bdrk_01...` in front of the user; {@link ObsidianAgentService} keeps
	 * the id-to-name mapping from the execution events and resolves it here. The
	 * id stays on the entry because the transcript matches rows against it — see
	 * {@link PendingToolCall.id} — while only the name is ever drawn.
	 *
	 * `progress` carries what the tool has reported through pi's
	 * `tool_execution_update` event, which a tool emits by calling the `onUpdate`
	 * callback pi hands its `execute`. It is absent for a tool that reports
	 * nothing — every tool in this plugin today — so the row reads exactly as it
	 * did before for them, and a long-running tool that does report gains a live
	 * line without any other call site changing.
	 */
	pendingToolCalls: PendingToolCall[];
	errorMessage?: string;
	/**
	 * Whether the settings tab is the recovery for {@link errorMessage}. Carried
	 * beside the message rather than inferred in the UI: the banner cannot tell
	 * a missing credential from a provider refusal, and offering "Open
	 * settings" for a network error points the user at a screen that cannot
	 * help.
	 */
	errorOpensSettings?: boolean;
	/**
	 * Messages sent while the agent was already answering, waiting for pi to
	 * inject them — oldest first, each cancelable through
	 * {@link ObsidianAgentService.removeQueuedPrompt} by its id. Empty when the
	 * agent is idle, by construction: mid-run sends are the only way in.
	 */
	queuedPrompts: QueuedPrompt[];
	/**
	 * Whether the active model accepts image content. Staging (paste, drop,
	 * attach) is gated on this *before* anything is staged, so a text-only
	 * model never collects pictures it will refuse at send time. The send-time
	 * gate in `sendPrompt` stays as the backstop for a model switched in
	 * between staging and sending. Absent from older snapshots means "unknown";
	 * the gate treats that as allowed rather than blocking a working flow.
	 */
	supportsImages?: boolean;
	/**
	 * Informational message that is not a failure ("Nothing to compact yet.").
	 * Kept apart from `errorMessage` because the error banner is an
	 * `aria-live="assertive"` alert: routing a notice through it made a
	 * screen reader interrupt the user to report that nothing had happened.
	 */
	noticeMessage?: string;
	/**
	 * Messages that are on screen and not on disk, by identity.
	 *
	 * The one report in this panel that describes silent, irreversible loss:
	 * everything else here can be retried, and this one says a reply the reader is
	 * looking at will be absent after a reload, with no gap where it was. It used
	 * to ride the dismissible grey notice — ranked below "Nothing to tidy up yet."
	 * and cleared unconditionally by the next send, so the warning about the reply
	 * about to be lost was destroyed by the act of continuing the conversation.
	 *
	 * Identities rather than a message, so the transcript can mark the *reply it
	 * names*. `snapshot.messages` hands out the same objects, which is what makes
	 * the comparison work; `messageEntryIds` already keys on identity for the same
	 * reason. Empty on every healthy panel, so the array stays tiny.
	 */
	unpersistedMessages?: readonly object[];
	/**
	 * Whether the active lane's last load found a run the previous process never
	 * finished, with the user's words still the transcript's tail. The banner
	 * turns this into the "continue" offer; absent from older snapshots means
	 * "no", the same reading a fresh install has.
	 */
	canResumeInterrupted?: boolean;
	provider: string;
	modelId: string;
	/**
	 * The wire id of the model the live agent actually serves requests on, or
	 * the settings-resolved one before the agent exists. Differs from
	 * {@link modelId} only while a mid-run switch (issue #252) is waiting for
	 * the run to land — the gap the switcher's "takes effect after this reply"
	 * note reports.
	 */
	runningModelId: string;
	/**
	 * The resolved vendor mark for the active target, or undefined when neither
	 * its model id nor its endpoint names a vendor this plugin ships a mark for.
	 *
	 * Resolved here rather than in the switcher: the match tables live behind
	 * `matchVendorForModel`, and the component has no business re-deriving what
	 * the snapshot can hand it — or re-running it on every render.
	 */
	vendorIcon?: string;
	/**
	 * The level this conversation runs at, read from the live agent — which the
	 * session file drives — rather than from settings. A global field would
	 * masquerade as a default while every session carries its own.
	 */
	thinkingLevel: ThinkingLevel;
	/**
	 * A level chosen mid-run that has not been applied yet (issue #252), or
	 * undefined when nothing waits. The selector shows it as the intent; the
	 * live level stays in force until the run lands.
	 */
	pendingThinkingLevel?: ThinkingLevel;
	/**
	 * Levels the active model accepts, `"off"` included, in escalation order.
	 *
	 * A single entry means the model takes no reasoning at all (custom endpoints
	 * default conservative until their capability bit is set), which is the
	 * selector's signal to stay unrendered rather than offer one choice.
	 */
	thinkingLevels: ThinkingLevel[];
	/**
	 * Configured models the panel offers to switch between, in stored order.
	 *
	 * Named and joined here rather than in the component, so the switcher renders
	 * a list without holding `settings.providers` and `settings.models` and doing
	 * the lookup itself. Empty until the user configures one, which is not an
	 * error state: the builtin pair above still answers requests, and
	 * {@link activeModelId} is then absent.
	 */
	modelChoices: ModelChoice[];
	/** Which choice requests go out on, absent while the builtin pair serves. */
	activeModelId?: string;
	session?: ActiveSessionInfo;
	/**
	 * Bumped whenever the set of stored sessions or their labels changes. The
	 * active session's id cannot detect that: deleting a different session or
	 * renaming the current one leaves it untouched, so a list rendered from it
	 * alone would go stale.
	 */
	sessionRevision: number;
	/**
	 * One entry per session the service holds a runtime for (issue #235), so UI
	 * that lists sessions — the history picker — can mark which ones are mid-run
	 * without asking the service again. Every runtime's agent events already end
	 * in {@link ObsidianAgentService.notify}, so this stays live for sessions
	 * running in the background; idle sessions list too, but a reader that wants
	 * to keep rows clean simply ignores that state.
	 */
	sessionRunStates: ReadonlyArray<{ path: string; state: SessionRunState }>;
	usage: UsageTotals;
	/**
	 * How much of the model's context window the conversation occupies. The
	 * estimate is heuristic until the first assistant usage lands, which
	 * `ContextFill.heuristicOnly` reports so the UI never shows a made-up
	 * number as if the provider had measured it.
	 */
	contextFill: ContextFill | null;
	/**
	 * True while a compaction request is in flight (a real LLM call), before a
	 * prompt or between the turns of a run.
	 *
	 * The busy flag the send controls, the per-message actions and `aria-busy`
	 * gate on — derived from {@link compactionEvent} rather than tracked beside
	 * it, so the two cannot disagree about whether a tidy is running.
	 */
	isCompacting: boolean;
	/**
	 * The compaction attempt the transcript draws, if any: running, or failed and
	 * held until the next attempt supersedes it. A success leaves pi's summary
	 * message in the transcript instead of an event here.
	 */
	compactionEvent: CompactionEvent | null;
	/**
	 * How many messages the last compaction kept, so the transcript can draw its
	 * row where the cut happened.
	 *
	 * pi's context layout puts the summary message at index 0, because that is
	 * what replaces the history in the *request*. In time it belongs after the
	 * tail it retained — the tidy ran once those turns had already happened — and
	 * that is where the row goes. Zero when nothing has been compacted.
	 */
	compactionRetained: number;
	/**
	 * True while a retry or edit-resend is between its guards and the replacement
	 * send: the branch-summary request (a real LLM call that can run for seconds),
	 * the rewind itself, and the gap before the new turn's first event.
	 *
	 * This window is the panel's own doing — the agent is not streaming yet and
	 * no compaction is running, so without this flag the panel reports fully idle
	 * while the user's edit is quietly being processed. Everything the streaming
	 * state gates reads this too: the send controls, the status line, the
	 * per-message actions that would race the rewind.
	 */
	isRewinding: boolean;
	/** Whether the active model target has a credential ready for requests. */
	isConfigured?: boolean;
	/**
	 * Whether the panel may show agent-internal readouts (token counts, spend,
	 * context-window occupancy, raw tool arguments). Mirrors the user setting so
	 * the UI reads one snapshot rather than reaching for settings itself.
	 */
	showAgentDetails: boolean;
	/**
	 * How much machine traffic starts open in the transcript. Mirrored onto the
	 * snapshot for the same reason as {@link showAgentDetails}: the UI reads one
	 * snapshot, and a settings save already rides the notify path that makes the
	 * change visible mid-conversation.
	 */
	traceExpand: TraceExpandSetting;
	/**
	 * Language the panel renders in, already resolved from the user's setting.
	 *
	 * Resolved here rather than in the components for the same reason
	 * {@link showAgentDetails} is mirrored: the UI reads one snapshot, and
	 * `"auto"` needs the host vault to resolve, which a presentational component
	 * has no business reaching for.
	 */
	language: Language;
	/**
	 * Which keypress sends the draft.
	 *
	 * Mirrored onto the snapshot for the same reason as {@link showAgentDetails}:
	 * the composer prints the chord on its Send button and binds the key that
	 * matches, and both have to come from one place or the label can disagree with
	 * the behaviour.
	 */
	sendShortcut: SendShortcut;
	/**
	 * Notes named to the model on the next turn, active note first.
	 *
	 * The same list the injection sends, so the chip row cannot advertise context
	 * the model was not given. Empty when no Markdown note is active and nothing
	 * is pinned, which renders no row at all.
	 */
	contextRefs: ContextRef[];
	/**
	 * Whether the active note is being followed.
	 *
	 * Distinct from `contextRefs` being empty: following with nothing open looks
	 * the same in the list but offers a different control, since the user has
	 * nothing to re-enable.
	 */
	isFollowingActiveNote: boolean;
	/**
	 * Prompt templates and skills available as `/name` commands, for autocomplete.
	 *
	 * Full instruction bodies never reach the UI. Templates are listed first, then
	 * skills; `kind` supplies the source label, and `invocation` carries the
	 * disambiguated `/skill:name` form when a template owns the short name.
	 */
	availableCommands: {
		name: string;
		description: string;
		kind: "template" | "skill";
		invocation: string;
	}[];
}

/**
 * Mid-run compactions a single run may spend.
 *
 * The trigger is an estimate that leans on the newest assistant usage
 * (`estimateContextTokens`), and that usage still reports the pre-compaction
 * total until the next reply lands — so a run whose retained tail alone exceeds
 * the budget would ask for a summary at every turn boundary while shrinking
 * nothing. Four is past any honest run and still bounds the waste.
 */
const MAX_MID_RUN_COMPACTIONS = 4;

type SnapshotListener = (snapshot: ChatSnapshot) => void;

/**
 * Index of the user turn that produced the message at `index`.
 *
 * Walks backwards because tool results sit between a question and its answer.
 * Returns null when nothing precedes it, which happens for a transcript whose
 * head was replaced by a compaction summary — retrying there would resend a
 * prompt the model can no longer see in context.
 */
function findPromptIndex(messages: AgentMessage[], index: number): number | null {
	for (let cursor = Math.min(index, messages.length) - 1; cursor >= 0; cursor -= 1) {
		if (messages[cursor]?.role === "user") {
			return cursor;
		}
	}
	return null;
}

/**
 * Whether the transcript already reports this agent-state error, at the turn it
 * happened in.
 *
 * pi clears `state.errorMessage` when a run departs and its loop returns the
 * moment a turn ends in `error` or `aborted`, so the field always belongs to the
 * current run's last assistant turn. Both markers are required to agree — the
 * turn carries one of those two stop reasons *and* carries this exact text —
 * because that pair is what makes the attribution provable rather than inferred
 * from wording, which is provider-specific ("Request was aborted", "The
 * operation was aborted", …) and would misfile a provider message that merely
 * mentions cancellation. Any drift in that wiring degrades to showing the
 * banner rather than to swallowing an error.
 *
 * Two stop reasons, one rule, because the answer to "should the banner say
 * this?" is the same for both: the transcript says it better, in the one place
 * that can point at which turn it was.
 *
 * - `aborted` is the user pressing stop. The banner used to raise an
 *   `aria-live="assertive"` alert over something the user had just asked for,
 *   one line above the transcript's own "You stopped this reply."
 * - `error` is a provider failure. The banner's copy of it is destroyed by the
 *   next run's departure, while `describeReplyCutoff` reads the same text off
 *   the message — which is persisted, positioned, and sits directly above the
 *   regenerate control that is the actual recovery (#239).
 *
 * A failure with no assistant turn to anchor to is untouched and still reaches
 * the banner: nothing departed, so there is nothing to point at.
 */
function isReportedInTranscript(agent: Agent | null, agentError: string): boolean {
	const messages = agent?.state.messages;
	if (!messages) {
		return false;
	}
	const lastAssistant = lastAssistantTurn(messages);
	if (lastAssistant?.role !== "assistant" || lastAssistant.errorMessage !== agentError) {
		return false;
	}
	return lastAssistant.stopReason === "aborted" || lastAssistant.stopReason === "error";
}

/**
 * The transcript's last assistant turn, or `undefined` before the first one.
 *
 * Walks from the end rather than copying and reversing: the transcript grows
 * per token during a run, and both readers of this — the error filter and the
 * dispatch-failure guard — run on snapshots taken at failure time.
 */
function lastAssistantTurn(messages: readonly AgentMessage[]): AgentMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "assistant") {
			return message;
		}
	}
	return undefined;
}

function extractUserText(message: AgentMessage | undefined): string {
	if (!message || message.role !== "user") {
		return "";
	}
	const { content } = message;
	if (typeof content === "string") {
		return content.trim();
	}
	return content
		.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/**
 * The line a tool's progress update contributes to the live status row.
 *
 * pi types `tool_execution_update.partialResult` as `any` — it is whatever the
 * tool passed to `onUpdate`, so nothing here may assume a shape. Anything that
 * is not an object with a content array reduces to `null` rather than throwing
 * out of an event handler, which would abort the run over a cosmetic detail.
 *
 * Summarizing goes through the same {@link summarizeToolContent} the finished
 * result rows use, so a tool's streamed progress and its settled result are
 * clipped and first-lined by one rule instead of two that can drift.
 */
function firstProgressLine(partialResult: unknown): string | null {
	if (partialResult === null || typeof partialResult !== "object") {
		return null;
	}
	const content = (partialResult as { content?: unknown }).content;
	if (!Array.isArray(content)) {
		return null;
	}
	return summarizeToolContent(content);
}

export interface ObsidianAgentServiceOptions {
	streamFn?: StreamFn;
	/**
	 * Where `ask_user` puts a question, shared with the chat panel that renders it.
	 *
	 * Injected rather than built here: the broker has to be the same object the
	 * panel subscribes to and the escalation modal settles, and only the plugin
	 * sees all three. Omitted — the default in tests — leaves `ask_user` out of the
	 * tool set entirely rather than offering a tool that would hang.
	 */
	askUserBroker?: AskUserBroker;
	/**
	 * User-level skill loader, overridable so tests stay out of the real home
	 * directory; defaults to {@link loadUserSkills}. Receives the configured
	 * extra folder, if any.
	 *
	 * Returns the loader's whole result, `searched` included, because the Skills
	 * settings tab reports on this load rather than running its own — see
	 * {@link SkillLoadReport}.
	 */
	loadUserSkills?: (customDir?: string) => Promise<UserSkillsLoad>;
	/**
	 * Root logger; the service logs under its `agent` child.
	 *
	 * Optional because the service predates logging and tests construct it
	 * bare. Omitted falls back to {@link NOOP_LOGGER}, so production wiring
	 * simply passes one and no call site has to care.
	 */
	logger?: LoggerLike;
	/**
	 * Writes the settings object this service reads back to disk.
	 *
	 * Needed because the chat panel can now change a setting — the active model —
	 * and the panel's only dependency is this service. The plugin's own
	 * `saveSettings` is what belongs here: it seals the secrets, persists, and
	 * calls {@link ObsidianAgentService.refreshConfiguration} on the way back, so
	 * a switch reaches the running conversation through exactly the path a
	 * settings-tab change already takes.
	 *
	 * Pass `{ reconfigure: false }` to persist without the reconfigure. This is
	 * the mid-run write (issue #252): the switcher records the choice while a
	 * run is answering, and the live agent's model and tools must not move until
	 * the run settles — the flush applies it. The persistence itself is never
	 * deferred; a reload from here on already names the new model.
	 *
	 * Omitted falls back to reconfiguring in memory alone, which is what a test
	 * holding the settings object directly wants.
	 */
	persistSettings?: (options?: { reconfigure?: boolean }) => Promise<void>;
	/**
	 * Gathers agent tools beyond the built-in vault ones — MCP servers today.
	 *
	 * The implementation owns when to connect: the service calls it whenever a
	 * conversation is built or reconfigured, and merges the result after the
	 * vault tools. Omitted (the default in tests) means no external tools.
	 */
	getExternalTools?: () => Promise<AgentTool[]>;
}

interface CompactionRunOptions {
	/** Summarize even when the context still fits; the command-palette path. */
	force?: boolean;
	/** Signal of the run a mid-run compaction belongs to, linked into the service's controller. */
	signal?: AbortSignal;
}

export class ObsidianAgentService {
	private readonly app: App;
	private readonly getSettings: () => PiemSettings;
	private readonly sessionManager: ObsidianSessionManager;
	private readonly streamFn: StreamFn | undefined;
	private readonly loadUserSkillsFn: (customDir?: string) => Promise<UserSkillsLoad>;
	/** See {@link ObsidianAgentServiceOptions.persistSettings}. */
	private readonly persistSettings: (options?: { reconfigure?: boolean }) => Promise<void>;
	/** See {@link ObsidianAgentServiceOptions.getExternalTools}. */
	private readonly getExternalToolsFn: () => Promise<AgentTool[]>;
	private readonly listeners = new Set<SnapshotListener>();
	/**
	 * Single vault execution env shared by the file tools and the prompt-template
	 * loader.
	 *
	 * Reused across `refreshConfiguration` and `initializeAgent` rather than
	 * rebuilt each time: pi's file mutation queue keys per-path locks off env
	 * object identity, and the template list survives a tool refresh only if the
	 * env it was read through is not replaced underneath it. Stateless by design
	 * — every call routes through the vault API — so one instance is safe to hold.
	 */
	private readonly env: ExecutionEnv;
	/**
	 * Delegation lives wholesale in the subagent extension; this service only
	 * plays host — vault tools, live model/transport getters — and tears it
	 * down with everything else in {@link dispose}.
	 */
	private readonly subagentExtension: ReturnType<typeof createSubagentExtension>;
	/**
	 * One runtime per open session file (issue #235). The service no longer
	 * carries per-session state as singletons: every field that belongs to a
	 * conversation lives on the {@link SessionRuntime} keyed by its file path,
	 * so a session switch re-points `currentPath` instead of tearing the
	 * previous conversation's run down.
	 */
	private readonly runtimes = new Map<string, SessionRuntime>();
	/** The session file the panel is showing; `null` before the first adopt. */
	private currentPath: string | null = null;
	/**
	 * The snapshot is the ACTIVE session's view, so these two mirror the active
	 * runtime's `sessionInfo` / `sessionRevision` for `getSnapshot` — and stand
	 * in for it while no runtime exists (after deleting the active session, for
	 * example). Per-session truth lives on the runtimes; these are only ever the
	 * focused session's copy.
	 */
	private sessionInfo: ActiveSessionInfo | null = null;
	private sessionRevision = 0;
	/**
	 * Which note the user is looking at right now. Workspace state, not
	 * conversation state — it survives a session switch and every runtime reads
	 * it; only the follow flag and the pinned set belong to a runtime.
	 */
	private activeNotePath: string | null = null;
	/**
	 * The runtime whose tools are executing right now.
	 *
	 * Subagent host getters are evaluated at spawn-execute time, and a spawn
	 * tool handed to session A's agent must read A's state even when the panel
	 * is showing session B. Tools are wrapped per runtime in {@link replaceAgent}
	 * — the wrapper brackets the call with the slot — and the synchronous
	 * prologue of a tool's `execute` reads the getters before any await, so the
	 * slot is always the spawning session's.
	 */
	private toolRuntime: SessionRuntime | null = null;
	private initialization: Promise<void> | null = null;
	/**
	 * Where the agent's lifecycle is logged. `NOOP_LOGGER` rather than nullable:
	 * a service without a logger is a valid test configuration, and an `if` at
	 * every emit site is how logging quietly stops happening.
	 */
	private readonly log: LoggerLike;
	/** Why the last {@link initialize} failed, if it did; rides the error banner until dismissed. */
	private initializationError: string | undefined;
	private modelsBundle: ObsidianModelsBundle | null = null;
	private modelsBundleKey: string | null = null;

	/**
	 * The empty screen's last answers, keyed by language and note path
	 * ({@link QuickActionSuggestionCache}). Fed by every successful empty-scope
	 * request and read by {@link peekQuickActionSuggestions}, so the panel can
	 * show the previous chips while a fresh request revalidates them — and keep
	 * them when the fresh request cannot. Plugin-lifetime, deliberately not
	 * persisted: chips are decoration, and the built-in row already covers the
	 * cold start a reload produces.
	 */
	private readonly suggestionCache = new QuickActionSuggestionCache();

	/**
	 * Loaded prompt templates: builtins first, then the vault's `Piem/prompts`.
	 *
	 * Reloaded each `initializeAgent` so a template file added mid-session is
	 * picked up on the next panel open. A `/name` that matches nothing here is
	 * reported as unknown rather than sent.
	 */
	private promptTemplates: PromptTemplate[] = [];
	/**
	 * Latches a new-session swap while its disk work is still landing: a second
	 * click inside that window would still see the previous session's messages
	 * and mint a duplicate blank session behind the first one.
	 */
	private newSessionInFlight = false;
	/**
	 * Bundled and vault skills, reloaded whenever the agent is (re)built.
	 *
	 * Kept here rather than folded straight into the prompt so the diagnostics
	 * can be reported once per load and the prompt composition stays
	 * synchronous from `replaceAgent`'s perspective — it reads the last
	 * finished load rather than awaiting one.
	 */
	private skills: Skill[] = [];
	/**
	 * Warnings from the last skill load, kept apart by layer.
	 *
	 * These are reports about the user's own files — a malformed `SKILL.md`, a
	 * home folder the filesystem refuses — so they belong to the panel that
	 * manages those files, not to the conversation. They used to ride the chat
	 * notice banner, which put raw OS text like
	 * `EACCES: permission denied, realpath '…'` in front of someone who was
	 * asking a question about their notes, and re-raised it on every send.
	 *
	 * Stored rather than passed through because the Skills settings tab reads
	 * *this* load rather than performing its own. That is what keeps the tab
	 * from describing a read the agent never did: two independent loads, a
	 * moment apart, can disagree — a network folder that reattaches between
	 * them would leave the panel reporting clean while the prompt was built
	 * without those skills.
	 *
	 * The two layers stay separate all the way to the UI. They are reported
	 * under different headings because their consequences differ: a vault file
	 * is one the user can open from the panel, and a home-directory folder is
	 * one only their operating system can explain.
	 */
	private lastSkillLoad: SkillLoadReport = emptySkillLoadReport();
	/**
	 * Fingerprint of the last logged diagnostic set, so a standing problem is
	 * logged once instead of once per turn.
	 *
	 * {@link reloadSkills} runs on every prompt send, so an unreadable folder
	 * would otherwise write one warning per user message — filling the 2000-record
	 * ring buffer and the log file with copies of the same line, and burying the
	 * detail the log panel exists to show. `undefined` means nothing has been
	 * logged yet, which is distinct from the empty string a clean load produces.
	 */
	private loggedDiagnosticsKey: string | undefined;
	/**
	 * Where `ask_user` questions go. Undefined in tests, which is what leaves the
	 * tool out of the set — see {@link ObsidianAgentServiceOptions.askUserBroker}.
	 */
	private readonly askUserBroker: AskUserBroker | undefined;

	constructor(app: App, getSettings: () => PiemSettings, sessionManager: ObsidianSessionManager, options: ObsidianAgentServiceOptions = {}) {
		this.app = app;
		this.getSettings = getSettings;
		this.sessionManager = sessionManager;
		this.streamFn = options.streamFn;
		this.askUserBroker = options.askUserBroker;
		this.loadUserSkillsFn = options.loadUserSkills ?? loadUserSkills;
		this.persistSettings = options.persistSettings ?? ((options?: { reconfigure?: boolean }) => (options?.reconfigure === false ? Promise.resolve() : this.refreshConfiguration()));
		this.getExternalToolsFn = options.getExternalTools ?? (async () => []);
		this.log = (options.logger ?? NOOP_LOGGER).child("agent");
		this.env = new VaultExecutionEnv(app);
		this.subagentExtension = createSubagentExtension({
			createVaultTools: () =>
				createObsidianTools(this.app, this.env, this.getSettings(), {
					getSkills: () => this.skills,
					// A subagent gets the same question surface as its parent: the user
					// has one attention, and the broker queues so two agents asking at
					// once produce two cards in turn rather than two dialogs stacked.
					askUserBroker: this.askUserBroker,
				}),
			getModel: () => getSelectedModel(this.getSettings()),
			getStreamFn: () => this.resolveStreamFn(),
			// Thinking level is session-owned now; a spawned subagent rides the
			// level of the runtime whose tool invoked the spawn, not of whichever
			// session the panel is currently showing. The slot is set by the
			// per-runtime tool wrappers built in `replaceAgent`.
			getThinkingLevel: () =>
				this.toolRuntime?.agent?.state.thinkingLevel
					?? this.current()?.agent?.state.thinkingLevel
					?? DEFAULT_THINKING_LEVEL,
			// The same list and the same join the model switcher uses, so a spawn
			// can only pick something the user could pick — and resolves it the way
			// the switcher would. Read per call, so a model configured after this
			// service was built is offered to the next agent build.
			listModels: () => listModelChoices(this.getSettings()).map((choice) => ({ id: choice.id, label: `${choice.name} (${choice.provider})` })),
			resolveModel: (choiceId) => resolveModelChoice(this.getSettings(), choiceId),
			// The same instance the parent's own compaction uses, rebuilt with it
			// when a provider registration changes. `withRequestDefaults` is not
			// optional here: compaction reaches `models.completeSimple` internally,
			// which takes neither an API key nor a `fetch`, so both have to be baked
			// into the instance or a child compacts against `globalThis.fetch`
			// without a key.
			getModels: () => withRequestDefaults(this.requireModelsBundle(), (provider) => this.getApiKey(provider)),
			getCompactionSettings: (contextWindow) => this.resolveCompaction(contextWindow),
			getApiKey: (provider) => this.getApiKey(provider),
			getSkills: () => this.skills,
		});
	}

	// --- runtime pool (issue #235) ---

	/**
	 * The session the panel is showing, or `null` before the first adopt.
	 *
	 * This is the accessor every "the conversation on screen" read goes through.
	 * Callbacks must never re-read it: anything running on behalf of a specific
	 * session captures that session's runtime at the start and uses the captured
	 * handle throughout, or a switch would repoint the work mid-flight.
	 */
	get agent(): Agent | null {
		return this.current()?.agent ?? null;
	}

	// The three accessors below keep the old singleton surface for the seams the
	// tests (and the UI helpers) reach into. They are the FOCUSED runtime's
	// members, which is exactly what the old fields pointed at; a background
	// session's members are reached through its runtime, never through these.

	/** Mirror of the focused session's queued mid-run sends. */
	private get promptQueue(): PromptQueue | undefined {
		return this.current()?.promptQueue;
	}

	/** Tool-name lookup for the calls the focused session has in flight. */
	private get pendingToolNames(): Map<string, string> | undefined {
		return this.current()?.pendingToolNames;
	}

	/** Tool start times for the calls the focused session has in flight. */
	private get pendingToolStarts(): Map<string, number> | undefined {
		return this.current()?.pendingToolStarts;
	}

	/** Tool progress for the calls the focused session has in flight. */
	private get pendingToolProgress(): Map<string, string> | undefined {
		return this.current()?.pendingToolProgress;
	}

	/** Agent-reported error the focused session's user already dismissed. */
	private get dismissedAgentError(): string | undefined {
		return this.current()?.dismissedAgentError;
	}

	private set dismissedAgentError(value: string | undefined) {
		const rt = this.current();
		if (rt) {
			rt.dismissedAgentError = value;
		}
	}

	/**
	 * The runtime of the session on screen, created on demand.
	 *
	 * Entry points that act on "the conversation being looked at" go through
	 * this; anything that already holds a runtime keeps using it.
	 */
	private runtimeForFocused(): SessionRuntime {
		const path = this.sessionManager.getActiveSessionPath();
		if (!path) {
			throw new Error("No active session.");
		}
		return this.runtimeFor(path);
	}

	/** The runtime of the session on screen, if one has been adopted. */
	private current(): SessionRuntime | null {
		return this.currentPath ? (this.runtimes.get(this.currentPath) ?? null) : null;
	}

	/**
	 * The runtime for `path`, created on first touch.
	 *
	 * Creation is what makes a session "known" to the service: a background
	 * session is hydrated here, and its interrupted runs are settled exactly
	 * once, at that first touch, not again on every focus. The claim that spares
	 * a mid-run background chat from a retention sweep is taken per run by
	 * {@link beginRunOperation} and handed back by {@link endRunOperation} —
	 * claiming at creation instead would pin every chat the panel ever touched,
	 * which would gut retention.
	 */
	private runtimeFor(path: string): SessionRuntime {
		const existing = this.runtimes.get(path);
		if (existing) {
			return existing;
		}
		const runtime = new SessionRuntime(path);
		this.runtimes.set(path, runtime);
		this.settleInterruptedRunsFor(runtime).catch((error) => {
			this.log.error("Failed to settle interrupted runs", () => ({
				path,
				error: error instanceof Error ? error.message : String(error),
			}));
		});
		return runtime;
	}

	/**
	 * Runs the crash-recovery sweep for one runtime, once, at its creation.
	 *
	 * A focus switch re-uses the existing runtime (`runtimeFor` above) and so
	 * deliberately skips this — the same rule the lane switcher already follows.
	 */
	private async settleInterruptedRunsFor(runtime: SessionRuntime): Promise<void> {
		const context = await this.sessionManager.buildSessionContextFor(runtime.sessionPath, runtime.activeLane);
		await this.settleInterruptedRuns(runtime, context);
	}

	/** Drops the runtime for a deleted session, cancelling whatever it holds. */
	private removeRuntime(runtime: SessionRuntime): void {
		// A pending mid-run choice must not outlive the session: the flush only
		// fires while the runtime exists, but clearing here keeps the invariant
		// explicit — a deleted session never applies anything.
		runtime.pendingConfiguration = null;
		runtime.dispose();
		this.runtimes.delete(runtime.sessionPath);
		this.sessionManager.releaseSession(runtime.sessionPath);
	}

	subscribe(listener: SnapshotListener): () => void {
		this.listeners.add(listener);
		listener(this.getSnapshot());
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Builds the agent on first use.
	 *
	 * Resolves even when starting fails: the reason is recorded on
	 * {@link initializationError} — which the error banner picks up through the
	 * snapshot — and `agent` stays null. Every caller here is a UI entry point,
	 * and a rejection used to surface as an unhandled rejection wherever the
	 * caller had no catch; the banner is where this panel reports everything
	 * else, so a start failure belongs there too rather than in the console.
	 * A caller that needs the agent checks `this.agent` after awaiting.
	 */
	async initialize(): Promise<void> {
		if (this.current()?.agent) {
			return;
		}
		if (this.initialization) {
			return this.initialization;
		}

		// The settle handlers ride the shared promise rather than the awaited
		// call: a concurrent caller that returns `this.initialization` directly
		// must never see a rejection, and the success path has to clear a
		// failure left by an earlier attempt in the same chain.
		this.initialization = this.initializeAgent().then(
			() => {
				this.initializationError = undefined;
			},
			(error: unknown) => {
				this.initializationError = error instanceof Error ? error.message : String(error);
				this.notify();
			},
		);
		try {
			await this.initialization;
		} finally {
			this.initialization = null;
		}
	}

	async sendPrompt(prompt: string, images: ImageContent[] = []): Promise<boolean> {
		const trimmedPrompt = prompt.trim();
		if (!trimmedPrompt) {
			return false;
		}

		// Initialization is what populates `promptTemplates`, so it has to run
		// before the command lookup below — otherwise the very first message of a
		// session would report every `/name` as unknown.
		await this.initialize();

		// A failed start leaves no agent, and the banner already carries why —
		// the snapshot falls back to `initializationError`. A second message
		// here would only paraphrase it, so the send is refused quietly.
		const agent = this.agent;
		if (!agent) {
			return false;
		}
		/*
		 * A send that arrives while the agent is already answering is not refused:
		 * it becomes a steered message (see `enqueueSteer`). Compaction and the
		 * rewind still hold the turn exclusively — those are states a steered
		 * message cannot join.
		 *
		 * Quiet, and named. This raised a red assertive alert reading "The agent is
		 * already responding.", which is false for both states that produce it: a
		 * send during streaming is queued, not refused, so the only way to reach
		 * this line is compaction or a rewind. Two states, two sentences, using the
		 * words the status bar is showing at that same moment.
		 */
		const rt = this.runtimeForFocused();
		if (rt.isCompacting || rt.retryInFlight) {
			this.setNotice(rt, this.t().t(rt.isCompacting ? "chat.busyTidying" : "chat.busyResending"));
			return false;
		}
		return await this.deliverPrompt(trimmedPrompt, images);
	}

	/**
	 * The credential gate a turn must pass before anything goes out, raising the
	 * banner itself. The missing credential is the one failure the settings tab
	 * fixes, so this is the error that earns the banner's settings shortcut.
	 *
	 * Shared between {@link deliverPrompt} and the rewind preflight
	 * ({@link rewindAndResend}) so the same refusal — same banner, same
	 * wording — fires whether the turn is a fresh send or a replacement, and so
	 * a wording change lands in one place.
	 */
	private ensureCredentialReady(rt: SessionRuntime): boolean {
		if (this.hasApiKey()) {
			return true;
		}
		const t = this.t();
		this.setError(rt, t.t("target.needsKeyToSend", { target: describeModelTarget(this.getSettings(), t) }), true);
		return false;
	}

	/**
	 * The multimodal gate: `images` on a text-only model is refused with a
	 * banner before the run, leaving both text and images with the user to
	 * reconsider. Empty arrays always pass — a text turn has nothing to gate.
	 *
	 * Shared for the same reason as {@link ensureCredentialReady}: the rewind
	 * must refuse an impossible replacement *before* it throws the original
	 * turn away, with the exact refusal a normal send would have raised.
	 */
	private ensureImagesSupported(rt: SessionRuntime, images: ImageContent[]): boolean {
		if (images.length === 0 || modelSupportsImages(getSelectedModel(this.getSettings()))) {
			return true;
		}
		// The same sentence the staging-time gate shows, on the same channel. It
		// used to be red here and grey there, differing only in *when* the model was
		// switched — one fact cannot mean two levels of alarm, and nothing is lost
		// either way: both text and images stay with the user.
		this.notifyImagesBlocked();
		return false;
	}

	/**
	 * The send itself, once the caller holds the turn.
	 *
	 * Split from {@link sendPrompt} so the retry/edit rewind can hand its
	 * replacement question to the exact send path a normal message takes — command
	 * expansion, embed resolution, the capability gates — without tripping the
	 * busy guards on the way in. The rewind already holds the exclusivity those
	 * guards enforce ({@link retryInFlight} is set for its whole body, and it
	 * refuses to start while anything else does): refusing here would not be
	 * protection, it would be the rewind blocking itself.
	 *
	 * The credential and image gates are deliberately *not* skipped. They are
	 * re-checked on this path so a key removed or a model switched while the
	 * branch summary ran still fails the send — loudly, with the same banner a
	 * normal send would raise — rather than half-completing a rewind that
	 * already threw the original turn away.
	 */
	private async deliverPrompt(prompt: string, images: ImageContent[] = []): Promise<boolean> {
		// Error boundary for the whole send. The composer clears its draft before
		// awaiting, so a rejection here would strand the send — words spent, and
		// staged image cards left hanging over an empty composer (issue #253).
		// The run's failures already resolve in band (pi's `prompt` never
		// rejects; the `catch` below banners the rest), but the prelude — the
		// configuration refresh, the vault reads — used to sit outside that
		// guard and could reject the call outright. Everything below now
		// resolves `false` and lands on the banner; nothing escapes.
		const rt = this.runtimeForFocused();
		try {
			return await this.resolveAndDeliver(rt, prompt, images);
		} catch (error) {
			this.setError(rt, error instanceof Error ? error.message : String(error));
			return false;
		}
	}

	private async resolveAndDeliver(rt: SessionRuntime, prompt: string, images: ImageContent[] = []): Promise<boolean> {
		const trimmedPrompt = prompt;
		// The runtime was captured by the boundary above, before any await: a
		// switch mid-resolution cannot retarget the ledger, the queue, or the
		// frozen context.
		const agent = rt.agent;
		if (!agent) {
			return false;
		}

		// A send that arrives while the agent is already answering is not
		// refused: it becomes a steered message (see `enqueueSteer`). The
		// streaming check runs twice on purpose — here, to skip the work only
		// a fresh run needs, and again at the departure point below, because
		// the resolution between the two awaits vault reads and the run may
		// end under them. What a queued send skips is deliberate:
		// `refreshConfiguration` swaps the live agent's model and tools, which
		// is safe while idle and a footgun mid-run; the banner clearing would
		// wipe feedback the running reply still owns.
		if (!agent.state.isStreaming) {
			// A real send ends the turn the suggestion was asked for — drop any
			// in-flight request instead of letting it bill tokens whose chips are
			// already superseded. A queued send leaves the suggestion alone: it
			// belongs to the turn still in flight.
			rt.suggestionController?.abort();
			// Stale banners are cleared exactly once, and before the work below rather
			// than after it. The command resolution and the image resolution further
			// down both raise notices — an unknown `/name`, a missing embed — and
			// clearing after either would erase a warning before it was ever seen. The
			// run's own error path still overwrites `panelError` in `catch`.
			//
			// Skill diagnostics used to be the other reason this order mattered. They
			// no longer reach the banner at all (see `reloadSkills`), so the ordering
			// now rests on the two per-turn notices alone.
			rt.panelError = undefined;
			rt.noticeMessage = undefined;
			await this.refreshConfiguration();
		}

		// Resolve slash commands only after the refresh above: skills are reloaded
		// from the vault on every turn, so a SKILL.md saved moments ago is callable
		// immediately. Templates keep the short name when both kinds collide; the
		// skill remains explicitly reachable through `/skill:name`. A queued send
		// skips the refresh, so it expands against the skills the running turn
		// already has — a moment-stale expansion is the price of not swapping a
		// live agent's tool list mid-run.
		let modelPrompt = trimmedPrompt;
		const command = parsePromptCommand(trimmedPrompt);
		if (command) {
			const explicitSkillName = command.name.startsWith("skill:") ? command.name.slice("skill:".length) : undefined;
			if (explicitSkillName !== undefined) {
				const skill = findSkill(this.skills, explicitSkillName);
				if (!skill) {
					this.setNotice(rt, this.describeUnknownCommand(command.name));
					return false;
				}
				modelPrompt = expandSkill(skill, command.additionalInstructions);
			} else {
				const template = findPromptTemplate(this.promptTemplates, command.name);
				const skill = findSkill(this.skills, command.name);
				if (template) {
					modelPrompt = expandPromptTemplate(template, command.args);
					if (skill) {
						this.appendNotice(rt, this.t().t("chat.commandConflict", { name: command.name }));
					}
				} else if (skill) {
					modelPrompt = expandSkill(skill, command.additionalInstructions);
				} else {
					this.setNotice(rt, this.describeUnknownCommand(command.name));
					return false;
				}
			}
		}

		if (!this.ensureCredentialReady(rt)) {
			return false;
		}

		// Phase 2: resolve `![[cat.png]]` embeds into ImageContent read from the
		// vault. The bytes travel alongside the text, so the embed syntax is
		// stripped from the prompt — leaving `![[cat.png]]` in would hand the
		// model a broken reference to a picture it has already been given. The
		// active note anchors the resolution: a shortest-path embed means "the
		// image this note links to", and the index resolves it from here.
		const refs = extractImageRefs(modelPrompt);
		const sourcePath = this.contextRefList(rt).find((ref) => ref.kind === "active")?.path ?? null;
		const vaultImages = await this.readVaultImages(rt, refs, sourcePath);
		const promptText = vaultImages.length > 0 ? stripImageRefs(modelPrompt) : modelPrompt;
		const allImages = images.length > 0 ? [...images, ...vaultImages] : vaultImages;

		// Phase 3: gate multimodal send on the active model's declared capability.
		// A text-only model cannot consume an image content array; block before
		// the run and leave both text and images with the user to reconsider.
		if (!this.ensureImagesSupported(rt, allImages)) {
			return false;
		}

		// The departure point, and the second streaming check. Still running:
		// steer into the live run and show the chip. The run ended while the
		// reads above were awaited: fall through to a plain send, and whatever
		// the mirror still holds rides along ahead of this message.
		if (agent.state.isStreaming) {
			return this.enqueueSteer(trimmedPrompt, promptText, allImages);
		}

		let sent = false;
		// The failed-turn shadow the dispatch-failure guard tests against; see
		// {@link reportDispatchFailure}. Declared out here because the catch
		// cannot see try-scoped locals, and captured as the first statement of
		// the block because everything in it — the snapshot notify, the
		// compaction — can throw before the run departs.
		let tailBefore: AgentMessage | undefined;
		try {
			tailBefore = lastAssistantTurn(agent.state.messages);
			rt.activeRunContext = this.freezeRunContext(rt);
			this.notify();
			await this.compactContextIfNeeded(rt, agent);
			// The budget is per run, and `compactBetweenTurns` spends it.
			rt.midRunCompactions = 0;
			const stranded = rt.promptQueue.drain();
			const message: AgentMessage = {
				role: "user",
				content: [{ type: "text", text: promptText }, ...allImages],
				timestamp: Date.now(),
			};
			const dispatch = stranded.length > 0 ? [...stranded.map((entry) => entry.message), message] : [message];
			// The ledger entry opens before the run departs: a crash between
			// this write and the run's own finish is the orphan signature
			// recovery reads on the next load. Filed against the lane it departs
			// on, so recovery reads the entry back where the run left it rather
			// than against a name assumed later.
			await this.beginRunOperation(rt, dispatch);
			if (stranded.length === 0) {
				await agent.prompt([message]);
			} else {
				// Queued messages a run never injected — a run that died before
				// its next drain point, most often on a provider error mid-
				// request — must not wait behind this one: the user typed the
				// correction first. Order of arrival is the order of dispatch.
				agent.clearAllQueues();
				await agent.prompt(dispatch);
			}
			sent = true;
			// A fresh send supersedes the continue offer: the user has moved on
			// and the crashed run's words are no longer this lane's transcript
			// tail.
			rt.resumableLanes.delete(rt.activeLane);
		} catch (error) {
			this.reportDispatchFailure(rt, error, tailBefore);
		} finally {
			rt.activeRunContext = null;
			await this.notifySettledState(rt);
		}
		return sent;
	}

	/**
	 * Hands a mid-run send to pi's steering queue and mirrors it for the panel.
	 *
	 * Always a steer, never a follow-up: the panel has one send button, and a
	 * correction ("not that file, the other one") is what a message typed
	 * mid-reply overwhelmingly is. pi's own tail covers the other shape — a
	 * steer arriving after the last drain point is rescued by
	 * {@link resumeQueuedPrompts} once the run ends, which is the same moment a
	 * follow-up would have fired. Splitting the two kinds would need an intent
	 * the composer cannot express.
	 *
	 * The mirror records what pi was handed because pi's queues are write-only
	 * from outside; `steer()` is the delivery, this is the bookkeeping.
	 */
	private enqueueSteer(originalText: string, resolvedText: string, images: ImageContent[]): boolean {
		const rt = this.runtimeForFocused();
		const agent = rt.agent;
		if (!agent) {
			return false;
		}
		const message: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: resolvedText }, ...images],
			timestamp: Date.now(),
		};
		rt.promptQueue.add({ kind: "steer", text: originalText, imageCount: images.length, message });
		agent.steer(message);
		this.notify();
		return true;
	}

	/**
	 * Dispatches messages the finished run never injected.
	 *
	 * Two windows strand a steer: a run that dies on a provider error never
	 * reaches its next drain point, and the last drain point itself races a
	 * steer typed during the final reply. Either way the mirror outlives the
	 * run while the words sit unseen by the model — waiting for a next send
	 * that may never come. When the run ended on its own, dispatching them is
	 * what the user asked for when they typed.
	 *
	 * A run that died on a provider error stops here: re-sending into the same
	 * failure would bill a second refusal, so the chips stay and the next
	 * direct send carries them ahead of itself. An aborted run never reaches
	 * this decision — {@link abort} empties the mirror first, and stopping is
	 * the user retracting the queued intent along with the run.
	 */
	/**
	 * Single-argument form: the finished run's messages, dispatched against the
	 * focused runtime's queue. Kept because a test reaches this seam directly.
	 */
	private async resumeQueuedPrompts(messages: readonly AgentMessage[]): Promise<void> {
		const focused = this.current();
		if (focused) {
			await this.dispatchQueuedPrompts(focused, messages);
		}
	}

	private async dispatchQueuedPrompts(rt: SessionRuntime, messages: readonly AgentMessage[]): Promise<void> {
		const runMessages = messages;
		if (rt.promptQueue.size === 0) {
			return;
		}
		const agent = rt.agent;
		if (!agent || agent.state.isStreaming) {
			return;
		}
		// A pending mid-run change applies before the queued words leave: pi
		// builds the request from `agent.state`, so dispatching first would put
		// the whole queue on the old model and defer the flush a second time.
		// `agent_end` schedules this dispatch off `waitForIdle()`, which can run
		// ahead of `sendPrompt`'s finally — the take-then-apply flush makes the
		// double call harmless instead of ordering the callers.
		await this.flushPendingConfiguration(rt);
		const lastAssistant = [...runMessages].reverse().find((message) => message.role === "assistant");
		if (lastAssistant?.stopReason === "error") {
			return;
		}
		const stranded = rt.promptQueue.drain();
		let tailBefore: AgentMessage | undefined;
		try {
			// Captured as the first statement of the block, before the notify
			// and the compaction can throw, for the same reason
			// {@link reportDispatchFailure} explains.
			tailBefore = lastAssistantTurn(agent.state.messages);
			rt.activeRunContext = this.freezeRunContext(rt);
			this.notify();
			await this.compactContextIfNeeded(rt, agent);
			// pi's own queues may still hold what this dispatch is re-sending;
			// draining them first keeps the run's first turn-end poll from
			// injecting the same words a second time.
			agent.clearAllQueues();
			await this.beginRunOperation(rt, stranded.map((entry) => entry.message));
			await agent.prompt(stranded.map((entry) => entry.message));
		} catch (error) {
			// Back onto the chips, oldest first: the words are still the
			// user's, and hiding them behind an error banner loses them.
			rt.promptQueue.restore(stranded);
			this.reportDispatchFailure(rt, error, tailBefore);
		} finally {
			rt.activeRunContext = null;
			await this.notifySettledState(rt);
		}
	}

	/**
	 * Continues the reply a crashed run never delivered on the active lane.
	 *
	 * The transcript's tail is the user's words — that is what made the offer —
	 * so `continue()` picks the reply up from exactly where the crash cut it,
	 * with the context pi already holds. A run like any other: ledgered before
	 * departure, settled by its own `agent_end`, interruptible through
	 * {@link abort}.
	 */
	async resumeInterruptedRun(): Promise<void> {
		const rt = this.runtimeForFocused();
		rt.resumableLanes.delete(rt.activeLane);
		const agent = rt.agent;
		if (!agent || agent.state.isStreaming) {
			return;
		}
		let tailBefore: AgentMessage | undefined;
		try {
			// Captured as the first statement of the block, before the notify
			// and the compaction can throw, for the same reason
			// {@link reportDispatchFailure} explains.
			tailBefore = lastAssistantTurn(agent.state.messages);
			rt.activeRunContext = this.freezeRunContext(rt);
			this.notify();
			await this.compactContextIfNeeded(rt, agent);
			// The budget is per run, and `compactBetweenTurns` spends it.
			rt.midRunCompactions = 0;
			const last = agent.state.messages.at(-1);
			await this.beginRunOperation(rt, last ? [last] : []);
			await agent.continue();
		} catch (error) {
			this.reportDispatchFailure(rt, error, tailBefore);
		} finally {
			rt.activeRunContext = null;
			await this.notifySettledState(rt);
		}
	}

	/** Withdraws the continue offer without acting on it. */
	dismissInterruptedRun(): void {
		const rt = this.runtimeForFocused();
		if (!rt.resumableLanes.delete(rt.activeLane)) {
			return;
		}
		this.notify();
	}

	/**
	 * Opens the session's run ledger for the run about to depart, on the active
	 * lane.
	 *
	 * The ledger is crash recovery's durable half: an `operation_started` record
	 * that survives the process, so a crash mid-run leaves the orphan a later
	 * load reads via {@link settleInterruptedRuns}. Best-effort by design — the
	 * ledger is diagnostics, not the product, and a failed write must never
	 * block the send the user asked for. The cost of a missing entry is only
	 * that a crash during that run leaves nothing for recovery to find.
	 */
	private async beginRunOperation(rt: SessionRuntime, originalPrompt: readonly AgentMessage[]): Promise<void> {
		const lane = rt.activeLane;
		rt.activeRunLedger = undefined;
		// Claimed for the run's whole life: a sweep that fires while this session
		// is in the background (a new chat, a create elsewhere) must not trash the
		// file the run is appending to. Released when the run settles. The loaded
		// check is belt-and-braces — a session reachable here is hydrated — but a
		// missed claim degrades to the old evictable contract, while a throw here
		// would surface as a failed prompt.
		if (this.sessionManager.isLoaded(rt.sessionPath)) {
			this.sessionManager.retainSession(rt.sessionPath);
		}
		try {
			rt.activeRunLedger = { runId: await this.sessionManager.beginRunOperationFor(rt.sessionPath, [...originalPrompt], lane), lane };
		} catch (error) {
			this.log.error("Failed to record run start", () => ({
				lane,
				error: error instanceof Error ? error.message : String(error),
			}));
		}
	}

	/**
	 * Closes the current run's ledger entry with `outcome`.
	 *
	 * A no-op without an open entry — a run whose open write failed has nothing
	 * to close, and closing twice is impossible because the entry clears as it is
	 * read. The lane comes from the entry rather than from {@link activeLane}: a
	 * user who switched lanes mid-run must not have the close filed against the
	 * lane they are now looking at, which would leave the real entry open.
	 */
	private async endRunOperation(rt: SessionRuntime, outcome: "completed" | "aborted" | "failed", error?: { code: string; message: string }): Promise<void> {
		const ledger = rt.activeRunLedger;
		rt.activeRunLedger = undefined;
		// Released before the ledger close: the run is over either way, and a
		// close that fails below (a session deleted mid-run has no file to write
		// to) must not leave a claim pinned on a chat that no longer exists.
		this.sessionManager.releaseSession(rt.sessionPath);
		if (!ledger) {
			return;
		}
		if (!this.sessionManager.isLoaded(rt.sessionPath)) {
			// The session was deleted while the run was winding down: deleteSession
			// aborts the run and drops the file, so there is no ledger entry left to
			// close — writing one can only fail and log noise nobody can act on.
			return;
		}
		try {
			await this.sessionManager.endRunOperationFor(rt.sessionPath, ledger.runId, outcome, error, ledger.lane);
		} catch (failure) {
			// The orphan this leaves is exactly what recovery looks for, so a failed
			// close degrades to a spurious recovery offer — never to a lost reply.
			this.log.error("Failed to record run finish", () => ({
				lane: ledger.lane,
				error: failure instanceof Error ? failure.message : String(failure),
			}));
		}
	}

	/**
	 * Closes the current run's ledger from the run's own last words.
	 *
	 * Runs on `agent_end`, which every run shape reaches: a completed reply
	 * (`stop`), a user abort (`aborted`), a provider failure (`error`, with the
	 * message the banner shows). `length` and any other stop reason mean the
	 * model said its piece — the run did what was asked.
	 */
	private async settleRunLedger(rt: SessionRuntime, messages: readonly AgentMessage[]): Promise<void> {
		const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
		if (lastAssistant?.stopReason === "error") {
			await this.endRunOperation(rt, "failed", {
				code: "provider_error",
				message: lastAssistant.errorMessage ?? "Provider error",
			});
			return;
		}
		await this.endRunOperation(rt, lastAssistant?.stopReason === "aborted" ? "aborted" : "completed");
	}

	/**
	 * Reads every lane's run ledger for runs the previous process never finished,
	 * and settles them.
	 *
	 * An open entry means a crash — or a killed Obsidian — cut a run mid-flight.
	 * pi's storage refuses a second `operation_started` on a lane while one is
	 * open, so these must close before anything new can depart *on that lane*.
	 * The sweep covers every lane rather than the one the panel reads: the A/B
	 * comparison that once wrote to two at a time is gone, but a log written by
	 * that release can still carry an orphan on a lane nothing opens anymore, and
	 * an unswept one is a file that never runs again. The close records `aborted`:
	 * the run reached no outcome, and neither `completed` nor `failed` would be
	 * honest.
	 *
	 * When the cut run's words are still that lane's transcript tail, the
	 * continue offer stands for it. pi persists the prompt before streaming
	 * starts, so a run killed mid-reply leaves the user message last, and
	 * `continue()` picks the reply up from exactly there. An assistant tail means
	 * the reply did arrive and only the close was lost; re-offering would invite a
	 * duplicate turn, so those close silently. The offer surfaces on the snapshot
	 * only for the active lane — switching to another resumable lane reveals its
	 * own offer without a second sweep.
	 */
	private async settleInterruptedRuns(rt: SessionRuntime, activeContext: SessionContext): Promise<void> {
		rt.resumableLanes.clear();
		let open: Map<string, OperationStartedRecord[]>;
		try {
			open = await this.sessionManager.findAllOpenRunOperationsFor(rt.sessionPath);
		} catch (error) {
			this.log.error("Failed to read the run ledger", () => ({
				error: error instanceof Error ? error.message : String(error),
			}));
			return;
		}
		for (const [lane, orphans] of open) {
			for (const orphan of orphans) {
				try {
					await this.sessionManager.endRunOperationFor(rt.sessionPath, orphan.id, "aborted", undefined, lane);
				} catch (error) {
					this.log.error("Failed to close an interrupted run's ledger entry", () => ({
						lane,
						error: error instanceof Error ? error.message : String(error),
					}));
				}
			}
			if (await this.laneEndsResumable(rt, lane, activeContext)) {
				rt.resumableLanes.add(lane);
			}
		}
	}

	/**
	 * Whether `lane`'s transcript ends where `continue()` can pick it up: on the
	 * user's words or a tool result, rather than on a reply that already arrived.
	 *
	 * The active lane is read from the context already built for it rather than
	 * re-projected, so the offer and the transcript on screen cannot disagree.
	 */
	private async laneEndsResumable(rt: SessionRuntime, lane: string, activeContext: SessionContext): Promise<boolean> {
		let last: AgentMessage | undefined;
		if (lane === rt.activeLane) {
			last = activeContext.messages.at(-1);
		} else {
			try {
				last = (await this.sessionManager.buildSessionContextFor(rt.sessionPath, lane)).messages.at(-1);
			} catch (error) {
				this.log.error("Failed to read an interrupted lane's transcript", () => ({
					lane,
					error: error instanceof Error ? error.message : String(error),
				}));
				return false;
			}
		}
		return last?.role === "user" || last?.role === "toolResult";
	}

	/**
	 * Clears the banner after the user dismisses it.
	 *
	 * `agent.state.errorMessage` is read-only, so a dismissal that only cleared
	 * this service's own field would be undone the moment the snapshot fell back
	 * to the agent's. `dismissedAgentError` records what was dismissed and the
	 * snapshot suppresses exactly that string, which a later, different failure
	 * naturally escapes. The start failure is cleared outright — a retry that
	 * fails again re-records it through {@link initialize}.
	 */
	dismissMessages(): void {
		const rt = this.runtimeForFocused();
		rt.panelError = undefined;
		rt.noticeMessage = undefined;
		this.initializationError = undefined;
		rt.dismissedAgentError = rt.agent?.state.errorMessage;
		this.notify();
	}

	/**
	 * Reports the image gate before anything is staged, as a notice rather than
	 * an error: nothing was lost and nothing failed — the model just cannot take
	 * what was offered. The panel's image handlers call this on a model without
	 * image support; the send-time gate stays as the backstop for a model
	 * switched in between staging and sending.
	 */
	notifyImagesBlocked(): void {
		const t = this.t();
		this.setNotice(this.runtimeForFocused(), t.t("chat.imagesNotSupported", { model: describeModelTarget(this.getSettings(), t) }));
	}

	/**
	 * Re-asks the question that produced the reply at `index`.
	 *
	 * The same rewind {@link editAndResend} performs, minus the edit: the question
	 * is re-sent exactly as it was asked, and the reply at `index` is replaced
	 * rather than appended to.
	 */
	async retryFrom(index: number): Promise<boolean> {
		await this.initialize();
		const rt = this.runtimeForFocused();
		const agent = rt.agent;
		if (!agent) {
			return false;
		}
		const promptIndex = findPromptIndex(agent.state.messages, index);
		if (promptIndex === null) {
			return false;
		}
		const prompt = extractUserText(agent.state.messages[promptIndex]);
		if (!prompt) {
			return false;
		}
		return await this.rewindAndResend(rt, agent, promptIndex, prompt);
	}

	/**
	 * Rewrites the question at `index` and re-asks it.
	 *
	 * The one correction a chat offers that "ask again" cannot: a typo, a missed
	 * condition, a different phrasing — the only alternative is re-typing the
	 * whole turn and letting the original stand. Semantically this is the retry
	 * rewind with the text swapped before it goes back out.
	 *
	 * `index` names the user turn itself, not a reply above it, so the message
	 * there must already be the question; there is nothing to walk back and find.
	 * The same "newest turn only" restraint the retry control observes lives on
	 * the caller (the panel offers the edit on the last answered question alone),
	 * but the role check here is not policy — it is what makes the index mean
	 * what this method assumes it means.
	 *
	 * `images` carries whatever the composer had staged when the edited turn was
	 * sent. The rewind discards the original turn — its images with it — and the
	 * staged ones are the only pictures the replacement turn shows, so dropping
	 * them here would send less than the composer promised.
	 */
	async editAndResend(index: number, prompt: string, images: ImageContent[] = []): Promise<boolean> {
		const trimmed = prompt.trim();
		if (!trimmed) {
			return false;
		}
		await this.initialize();
		const rt = this.runtimeForFocused();
		const agent = rt.agent;
		if (!agent) {
			return false;
		}
		if (agent.state.messages[index]?.role !== "user") {
			return false;
		}
		return await this.rewindAndResend(rt, agent, index, trimmed, images);
	}

	/**
	 * The rewind both {@link retryFrom} and {@link editAndResend} perform.
	 *
	 * Truncates the transcript to just before the question at `promptIndex` and
	 * sends `prompt` again, so the new turn replaces what followed rather than
	 * appending a second answer to a conversation the model would then see twice.
	 *
	 * The log is append-only and tree-shaped, so the discarded turns stay on disk
	 * and the replacement becomes a sibling rather than their child. Rewinding
	 * the leaf is what makes that true: truncating only the in-memory transcript
	 * would leave the log's leaf on the abandoned reply, the replacement would be
	 * appended below it, and reloading the session would show both.
	 *
	 * Before the rewind, {@link summarizeAbandonedBranch} generates a summary of
	 * the fork being abandoned and persists it on the new main line, so the model
	 * — and a reload — remember what was explored down it. A summary failure never
	 * blocks the rewind: the user asked to retry or edit, not to summarize, so the
	 * worst case is a fork forgotten, not a request that never happens.
	 *
	 * A turn the log cannot name is refused rather than rewound in memory alone.
	 * That covers messages a compaction absorbed, whose text survives only inside
	 * the summary — rewinding to before the compaction would discard the summary
	 * along with the turn.
	 *
	 * The conversation can move on while the summary is in flight: "New chat",
	 * opening another session, and deleting the active one each build a fresh
	 * agent through `replaceAgent`. Acting on the result then would truncate the
	 * dead transcript and send `prompt` into the *new* session's log below its
	 * untouched history. Compacting between turns widens that window from
	 * milliseconds to seconds, so the result is discarded when the agent it was
	 * asked on is no longer current — the same guard `performCompaction` keeps.
	 */
	private async rewindAndResend(
		rt: SessionRuntime,
		agent: Agent,
		promptIndex: number,
		prompt: string,
		images: ImageContent[] = [],
	): Promise<boolean> {
		if (agent.state.isStreaming || rt.isCompacting || rt.branchSummaryController || rt.retryInFlight) {
			return false;
		}
		// Preflight before anything destructive: the rewind throws the original
		// turn away, so a replacement that cannot legally go out (no credential,
		// pictures on a text-only model) must be refused while the transcript is
		// still intact. The checks mirror the send path exactly — same helpers,
		// same banners — so refusing here is never stricter than sending fresh.
		// The send-side checks stay; they are not redundant but the backstop for
		// the seconds the branch summary runs, during which a key can be removed
		// or the model switched.
		if (!this.ensureCredentialReady(rt) || !this.ensureImagesSupported(rt, images)) {
			return false;
		}
		rt.retryInFlight = true;
		// The window this flag opens is one the agent does not narrate: no stream
		// events, no compaction. Without a notify here the panel stays visually
		// idle for the whole branch-summary request — a real LLM call that can
		// run for seconds — which reads as the edit having done nothing at all.
		this.notify();
		try {
			const promptMessage = agent.state.messages[promptIndex];
			const entryId = promptMessage ? rt.messageEntryIds.get(promptMessage) : undefined;
			if (!entryId) {
				return false;
			}

			// `summarizeAbandonedBranch` performs the rewind itself, after collecting
			// the branch off the pre-rewind log, and returns the summary message (if
			// one was generated) to splice into the in-memory transcript.
			let summaryMessage: AgentMessage | null;
			try {
				summaryMessage = await this.summarizeAbandonedBranch(rt, entryId);
			} catch (error) {
				// Quiet, and it does not stop the retry: the rewind is unconditional
				// because the retry is what the user asked for, so all that is lost is
				// the note about the fork being left behind.
				this.setNotice(
					rt,
					this.t().t("chat.branchSummaryFailed", { error: error instanceof Error ? error.message : String(error) }),
				);
				return false;
			}
			if (rt.agent !== agent) {
				return false;
			}
			agent.state.messages = agent.state.messages.slice(0, promptIndex);
			if (summaryMessage) {
				agent.state.messages = [...agent.state.messages.slice(0, promptIndex), summaryMessage];
			}
			this.notify();
			return await this.deliverPrompt(prompt, images);
		} finally {
			rt.retryInFlight = false;
			// The flag's release is its own render: the notification inside the try
			// fired while the send was still pretending to be busy, so without this
			// one the panel could stay in the rewinding treatment through the first
			// events of the replacement run — or, on a refused send, indefinitely.
			this.notify();
		}
	}

	/**
	 * Summarizes the branch a rewind is about to abandon, then rewinds.
	 *
	 * The summary is generated from the repository's live pi {@link Session}
	 * before the rewind moves the leaf, because
	 * {@link collectEntriesForBranchSummary} walks the parent chain from the old
	 * leaf to the fork point, and that chain only exists while the abandoned
	 * branch is still the live one. Once the summary lands (or fails), the rewind
	 * proceeds and the summary entry is appended on the new main line, where
	 * {@link buildSessionContext} projects it into context on the next reload.
	 *
	 * Returns the branch-summary message to splice into the live transcript, or
	 * `null` when no summary was generated (no abandoned branch, a compaction was
	 * already running, or the request was aborted). Never throws on a summary
	 * failure — only on an unknown rewind target, which surfaces as a user error.
	 */
	private async summarizeAbandonedBranch(rt: SessionRuntime, entryId: string): Promise<AgentMessage | null> {
		const session = this.sessionManager.getSessionFor(rt.sessionPath);
		// Read through the panel's own lane rather than assuming main: the leaf
		// `collectEntriesForBranchSummary` walks back from has to be the one that
		// lane points at, which is what makes the rewind rewind this transcript.
		const oldLeafId = await session.view(rt.activeLane).getLeafId();
		// No leaf means a fresh log with nothing to abandon; `oldLeafId === entryId`
		// means the rewind targets the current tip, so there is no fork below it.
		if (!oldLeafId || oldLeafId === entryId) {
			await session.moveLane(rt.activeLane, (await session.getEntry(entryId))?.parentId ?? null);
			return null;
		}
		// A compaction in flight owns the log's summarization budget; a second
		// concurrent summarization request would race it for the same provider
		// keys and muddy the usage accounting, so the branch summary is skipped.
		// The rewind still happens — the user's intent is the retry, not the
		// summary.
		if (rt.isCompacting) {
			await session.moveLane(rt.activeLane, (await session.getEntry(entryId))?.parentId ?? null);
			return null;
		}

		const controller = new AbortController();
		rt.branchSummaryController = controller;
		try {
			const collected = await collectEntriesForBranchSummary(session, oldLeafId, entryId);
			if (collected.entries.length === 0) {
				await session.moveLane(rt.activeLane, (await session.getEntry(entryId))?.parentId ?? null);
				return null;
			}

			const model = getSelectedModel(this.getSettings());
			const result = await generateBranchSummary(collected.entries, {
				models: withRequestDefaults(this.requireModelsBundle(), (provider) => this.getApiKey(provider)),
				model,
				signal: controller.signal,
				retry: DEFAULT_COMPACTION_RETRY,
			});

			// The rewind is deferred until after the summary so the view walked a
			// still-live branch; it is unconditional because the retry was the
			// user's actual request. A failed or aborted summary simply means the
			// fork is forgotten, not that the retry is blocked.
			await session.moveLane(rt.activeLane, (await session.getEntry(entryId))?.parentId ?? null);

			if (!result.ok) {
				if (!controller.signal.aborted) {
					this.setNotice(rt, this.t().t("chat.branchSummaryFailed", { error: result.error.message }));
				}
				return null;
			}

			// Same side channel compaction uses, for the same reason: this was a
			// billed provider request, and the message it produces is a
			// `branchSummary` rather than an assistant turn, so `sumUsage` cannot
			// find its cost in the transcript. Recorded before the append so a
			// throw there cannot silently drop an amount the user was already
			// charged.
			this.recordOverheadUsage(rt, result.value.usage);
			await this.sessionManager.appendBranchSummaryFor(rt.sessionPath, result.value, oldLeafId, rt.activeLane);
			return createBranchSummaryMessage(result.value.summary, oldLeafId, Date.now());
		} finally {
			if (rt.branchSummaryController === controller) {
				rt.branchSummaryController = null;
			}
		}
	}

	/**
	 * The empty screen's previous answer, without sending anything.
	 *
	 * The stale half of the cache's stale-while-revalidate contract: the panel
	 * reads this synchronously to fill the row while a fresh request revalidates
	 * it. Undefined means no prior answer — the panel falls back to its built-in
	 * chips exactly as before. Reply-scope results are not cached, so a reply
	 * scope reads nothing here by construction.
	 */
	peekQuickActionSuggestions(scope: SuggestionScope): QuickAction[] | undefined {
		if (scope !== "empty") {
			return undefined;
		}
		const settings = this.getSettings();
		// The focused runtime if there is one, and "no prior answer" when there is
		// not. This is read synchronously from a render effect, and the window
		// between deleting the active session and its replacement being adopted
		// has no focused runtime at all — `runtimeForFocused` threw there, which
		// unmounted the entire panel from inside React's commit phase. A cache
		// read is also a pure query: minting a runtime as a side effect of it
		// would be wrong even if nothing threw.
		const rt = this.current();
		return this.suggestionCache.get({
			language: resolveLanguage(this.app.vault as LanguageHost, settings.language),
			notePath: this.contextRefList(rt).find((ref) => ref.kind === "active")?.path ?? null,
		});
	}

	/**
	 * Asks the active model for quick-action chips, as a best-effort side
	 * channel.
	 *
	 * The two placements the panel offers have different failure contracts, and
	 * both are the *caller's* to keep: the empty screen falls back to its
	 * built-in chips, while a settled reply simply shows nothing. This method
	 * only guarantees one thing either way — a null result means "nothing to
	 * show", never an error. A failed suggestion is not worth a banner: it is
	 * decoration, and an `aria-live` alert about missing decoration would
	 * interrupt the reader to say less than the transcript already does.
	 *
	 * Billed like every other side-channel request: the usage lands in
	 * {@link recordOverheadUsage} before the result returns, so a parse failure
	 * cannot spend the user's money invisibly.
	 */
	async suggestQuickActions(scope: SuggestionScope): Promise<QuickAction[] | null> {
		const settings = this.getSettings();
		// No focused runtime is one more "nothing to show", not an error: the
		// catch below promises the UI that this method never throws, and a throw
		// from above the `try` escaped that promise — as an unhandled rejection
		// here, and as a torn-down panel through the synchronous peek beside it.
		const rt = this.current();
		if (!rt || !this.hasApiKey() || !rt.agent || rt.agent.state.isStreaming || rt.isCompacting || rt.retryInFlight) {
			return null;
		}
		const subject =
			scope === "reply"
				? lastAssistantText(rt.agent.state.messages)
				: this.contextRefList(rt).find((ref) => ref.kind === "active")?.path ?? null;
		if (scope === "reply" && !subject) {
			return null;
		}

		// One suggestion request at a time: a new call supersedes the previous
		// one, which the abort also marks so the request stops billing.
		rt.suggestionController?.abort();
		const controller = new AbortController();
		rt.suggestionController = controller;
		try {
			const model = getSelectedModel(settings);
			const result = await fetchQuickActionSuggestions({
				streamSimple: this.resolveStreamFn(),
				model,
				scope,
				subject,
				language: resolveLanguage(this.app.vault as LanguageHost, settings.language),
				t: this.t(),
				apiKey: this.getApiKey(model.provider),
				signal: controller.signal,
			});
			if (rt.suggestionController !== controller) {
				// Superseded mid-flight: the caller that replaced this request owns
				// the row now, and a late answer must not resurrect stale chips.
				return null;
			}
			this.recordOverheadUsage(rt, result.usage);
			// Only the empty screen caches: its subject is the (path, language) pair
			// the next blank visit will reproduce, so the answer stays worth showing
			// again. A reply's subject is that conversation's newest text — no future
			// request will ask for it, so caching it would be dead weight.
			if (scope === "empty" && result.actions) {
				this.suggestionCache.set(
					{ language: resolveLanguage(this.app.vault as LanguageHost, settings.language), notePath: subject },
					result.actions,
				);
			}
			return result.actions;
		} catch (error) {
			// The contract with the UI is "null means nothing to show, never a
			// throw": the caller renders its fallback row and moves on. `fetch…`
			// holds that line, but `getSelectedModel` above it can reject for a
			// legacy endpoint no catalog entry covers — letting that escape would
			// turn a decorative miss into an unhandled rejection in the panel.
			this.log.debug("quick action suggestions failed", () => ({ error: String(error) }));
			return null;
		} finally {
			if (rt.suggestionController === controller) {
				rt.suggestionController = null;
			}
		}
	}

	abort(): void {
		const path = this.sessionManager.getActiveSessionPath();
		if (!path) {
			return;
		}
		void this.abortSession(path);
	}

	/**
	 * Stops exactly one session's run: the runtime named by `path`, whatever the
	 * panel is showing (issue #235). The focused stop is {@link abort} above.
	 */
	async abortSession(path: string): Promise<void> {
		const rt = this.runtimes.get(path);
		if (!rt) {
			return;
		}
		// A compaction before a prompt is only reachable through this controller,
		// because the agent is not streaming yet. One between turns is reachable
		// both ways — `runExclusiveCompaction` links the run's signal into this
		// controller — so aborting both is right and idempotent.
		rt.compactionController?.abort();
		rt.branchSummaryController?.abort();
		rt.suggestionController?.abort();
		// Stopping the run is also retracting what was queued for it. Cleared
		// before `agent.abort()` so the `agent_end` that follows sees an empty
		// mirror and does not dispatch the words the user just took back.
		rt.promptQueue.clear();
		const agent = rt.agent;
		if (!agent) {
			return;
		}
		agent.clearAllQueues();
		agent.abort();
		// Closure-captured on purpose: a session switch between here and idle
		// must settle THIS run's ledger, not whatever is on screen later.
		void agent.waitForIdle().then(async () => {
			// The run's own `agent_end` may not reach the settle: an abort that lands
			// before the reply's last events still fires the end event, but a race
			// against this handler leaves the close below as the only writer. Writing
			// both is idempotent — the ledger entry clears as it is read.
			await this.endRunOperation(rt, "aborted");
			await this.notifySettledState(rt);
		});
	}

	/**
	 * One entry per session the service knows about (issue #235).
	 */
	getSessionRunStates(): Array<{ path: string; state: SessionRunState }> {
		return [...this.runtimes.values()].map((rt) => ({ path: rt.sessionPath, state: this.deriveRunState(rt) }));
	}

	/**
	 * Lifecycle phase of one session, read off its runtime rather than stored.
	 *
	 * Deriving is race-free: a run that flips `isStreaming` between two readers
	 * is answered with whichever phase is true at read time, and a background
	 * session needs no event plumbing to keep its phase current. `error` covers
	 * both a panel failure and an agent-reported error — the aborted stream the
	 * run-state test pins lands as an `error` event on the message, so it must
	 * read as `error`, not as the `idle` the stop "succeeded".
	 */
	private deriveRunState(rt: SessionRuntime): SessionRunState {
		if (rt.panelError || rt.agent?.state.errorMessage) {
			return "error";
		}
		if (rt.agent?.state.isStreaming) {
			return "running";
		}
		if (rt.promptQueue.size > 0 || rt.resumableLanes.has(rt.activeLane)) {
			return "waiting-input";
		}
		return "idle";
	}

	async newSession(options?: { force?: boolean }): Promise<void> {
		if (this.newSessionInFlight) {
			return;
		}
		// A session with no turns and nothing running is already the blank sheet
		// a click is asking for: swapping in another one would mint a duplicate
		// empty session on disk and spend retention budget on it. Double-clicks
		// that outrun the first swap fall through to the in-flight latch above. A
		// run in flight is *not* blank — "new session" mid-run still means
		// abort-and-leave. `force` bypasses the blank check for the
		// delete-the-last-session fallback, where the agent still shows the
		// deleted session's state and must not count as content.
		const previous = this.current();
		if (
			!options?.force &&
			previous?.agent &&
			!previous.agent.state.isStreaming &&
			previous.agent.state.messages.length === 0
		) {
			return;
		}
		this.newSessionInFlight = true;
		try {
			// The session being left keeps its runtime and its run (issue #235):
			// a new chat abandons it for the panel but does not tear it down.
			// Suggestions belong to the conversation that prompted them; a fresh chat
			// must not inherit chips fetched for the last one.
			previous?.suggestionController?.abort();
			// The level is inherited from the conversation just left, not from a
			// global setting: the user tuned it there and a fresh chat should not
			// start from a value they never chose. Clamped to the model the new
			// session will run on, since the previous one may have run another.
			const inherited = await this.sessionManager.readLastSessionThinkingLevel();
			const seed = clampThinkingLevel(getSelectedModel(this.getSettings()), inherited ?? DEFAULT_THINKING_LEVEL);
			const defaults = this.getSessionDefaults();
			const info = await this.sessionManager.createSession({ ...defaults, thinkingLevel: seed });
			this.currentPath = info.path;
			const rt = this.runtimeFor(info.path);
			rt.sessionInfo = info;
			this.sessionInfo = info;
			rt.messageEntryIds = new WeakMap<object, string>();
			// A brand-new session has no ledger and no stranded reply; any offer the
			// session just left was its own.
			rt.activeLane = "main";
			rt.resumableLanes.clear();
			rt.activeRunLedger = undefined;
			rt.lastCompaction = undefined;
			rt.overheadUsage = [];
			// Pins and a dismissed follow belong to the conversation that collected them;
			// a fresh runtime starts clean (the old `contextRefs.reset()`), while the
			// workspace's active note is left alone because it describes the workspace.
			await this.replaceAgent(rt, [], seed);
			rt.panelError = undefined;
			rt.sessionRevision += 1;
			this.notify();
		} finally {
			this.newSessionInFlight = false;
		}
	}

	/**
	 * Copies the conversation up to and including the reply at `index` into a
	 * brand-new session, leaving the current one untouched.
	 *
	 * The anchor is the reply's own durable entry — looked up through the same
	 * `messageEntryIds` mapping the retry path uses, so a turn the log cannot
	 * name (one a compaction absorbed) is refused rather than forked in memory
	 * alone. `position: "at"` in the manager makes the copy end *on* that reply,
	 * which is the reader's mental model of "fork from this answer": the new
	 * session picks up exactly where this one shows, and continuing there
	 * appends to the reply rather than redoing the question.
	 *
	 * Adoption reuses {@link openSession}'s sequence by calling it on the copy's
	 * path: the copy is already hydrated, so the idempotent load branch just
	 * moves focus, and every per-session rebuild — transcript, tool mapping,
	 * compaction state, configuration, interrupted-run sweep — happens once, in
	 * the one place that knows how.
	 *
	 * Returns false when there is nothing to fork from or the panel is busy —
	 * the same refusals {@link retryFrom} makes, for the same reasons.
	 */
	async forkSessionAt(index: number): Promise<boolean> {
		await this.initialize();
		const rt = this.runtimeForFocused();
		const agent = rt.agent;
		if (!agent || agent.state.isStreaming || rt.isCompacting || rt.retryInFlight || rt.branchSummaryController) {
			return false;
		}
		const replyMessage = agent.state.messages[index];
		const replyEntryId = replyMessage ? rt.messageEntryIds.get(replyMessage) : undefined;
		if (!replyEntryId) {
			return false;
		}
		let forkedPath: string;
		try {
			forkedPath = (await this.sessionManager.forkSession(rt.sessionPath, replyEntryId)).path;
		} catch (error) {
			this.toast("chat.forkFailed", error);
			return false;
		}
		await this.openSession(forkedPath);
		return true;
	}

	/** Sessions for this vault, newest first. */
	async listSessions(): Promise<ActiveSessionInfo[]> {
		await this.initialize();
		return this.sessionManager.listSessions();
	}

	/**
	 * Chats whose content matches `text`, newest session first, one row each.
	 *
	 * Scans stored logs lazily through pi's scanning search rather than reading
	 * every session up front, so a superseded keystroke stops the scan at the next
	 * session boundary — `repo.open` itself cannot be cancelled mid-read.
	 */
	async searchSessions(text: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<SessionSearchResult[]> {
		await this.initialize();
		const query = text.trim();
		if (!query) {
			return [];
		}
		const maxSessions = options.limit ?? 20;
		const hits = [];
		const search = this.sessionManager.createStoredSessionSearch();
		// Entry budget, not a session budget: one chatty chat could otherwise fill
		// the whole list once the hits are folded per session.
		for await (const hit of search.search(query, { limit: maxSessions * 20, signal: options.signal })) {
			hits.push(hit);
		}
		return aggregateSessionSearchHits(hits, query, maxSessions);
	}

	/** Switches to a stored session, replacing the transcript with its history. */
	async openSession(path: string): Promise<void> {
		await this.initialize();
		if (this.sessionManager.getActiveSessionPath() === path) {
			return;
		}

		let info: ActiveSessionInfo;
		try {
			info = await this.sessionManager.loadSession(path);
		} catch (error) {
			// A toast, not the banner: the transcript on screen is still the one it
			// was a moment ago, and a red bar over a healthy conversation says the
			// damage is there rather than in the chat that would not open.
			this.toast("chat.sessionOpenFailed", error);
			return;
		}

		// Deliberately no abort of the session being left. Its runtime keeps
		// running in the background; `abortSession(path)` is the opt-in kill.
		this.currentPath = path;
		const rt = this.runtimeFor(path);
		rt.sessionInfo = info;
		this.sessionInfo = info;
		// The lane belongs to the session being left; the incoming one opens on its
		// own main line.
		rt.activeLane = "main";
		const context = await this.sessionManager.buildSessionContextFor(path, rt.activeLane);
		rt.lastCompaction = await this.sessionManager.getLastCompactionFor(path, rt.activeLane);
		// Usage is per-transcript, and a reloaded session's compaction cost was
		// already paid in an earlier run, so the running total starts from history.
		rt.overheadUsage = [];
		// Follow state and pins are per-runtime and adopted below; nothing to clear.
		await this.adoptSessionContext(rt, context);
		// Same placement as `initializeAgent`: the offer describes the transcript
		// now on screen, so it is settled only after adoption. The runtime's own
		// sweep already ran once at creation; this one covers a re-focus of an
		// existing runtime whose log may have moved since.
		await this.settleInterruptedRuns(rt, context);
		rt.panelError = undefined;
		await this.sessionManager.ensureConfigurationFor(path, this.getSessionDefaults(), rt.activeLane);
		this.sessionInfo = info;
		rt.sessionInfo = info;
		this.notify();
	}

	/**
	 * Takes one queued message back, by the chip's id.
	 *
	 * Unknown ids are a no-op, not an error: pi can inject the message in the
	 * moment between the render that produced the chip and the click, and a
	 * message that already went out is exactly what the user would have been
	 * told anyway.
	 *
	 * pi cannot drop a single queued message, so a live run's queue is rebuilt
	 * from the survivors — total clear, re-push in order. When the agent is
	 * idle the message never reached pi at all (the mirror alone was waiting
	 * for a dispatch), so there is nothing on the pi side to rebuild.
	 */
	removeQueuedPrompt(id: string): void {
		const rt = this.current();
		if (!rt) {
			return;
		}
		const removal = rt.promptQueue.remove(id);
		if (!removal) {
			return;
		}
		const agent = rt.agent;
		if (agent && agent.state.isStreaming) {
			agent.clearAllQueues();
			for (const survivor of removal.survivors) {
				if (removal.kind === "steer") {
					agent.steer(survivor);
				} else {
					agent.followUp(survivor);
				}
			}
		}
		this.notify();
	}

	/** Labels the active session; an empty name clears it back to the derived label. */
	async renameSession(name: string): Promise<void> {
		await this.initialize();
		const rt = this.current();
		if (!rt) {
			return;
		}

		const trimmedName = name.trim();
		await this.sessionManager.appendSessionInfoFor(rt.sessionPath, trimmedName || undefined);
		// Patch the cached summary in place: the manager summarises the active
		// path only, and a rename already knows the one field that moved.
		if (rt.sessionInfo) {
			rt.sessionInfo = { ...rt.sessionInfo, name: trimmedName || undefined };
		}
		if (rt.sessionPath === this.sessionManager.getActiveSessionPath()) {
			this.sessionInfo = rt.sessionInfo ?? null;
		}
		rt.sessionRevision += 1;
		this.notify();
	}

	/**
	 * Writes the active transcript into the vault as a Markdown note and returns
	 * its path — or null when there is nothing to write (no chat, no messages)
	 * or the write failed, the failure surfacing as a panel notice rather than a
	 * thrown error, since the caller's only follow-up on success is opening the
	 * note it gets a path back for.
	 *
	 * The note lands in the session directory, beside the `.jsonl` it mirrors:
	 * that folder is already the plugin's own territory, so an export never
	 * mixes a machine-named file into the reader's curated notes uninvited.
	 */
	async exportSessionAsNote(): Promise<string | null> {
		const rt = this.current();
		const transcript = (rt?.agent?.state.messages ?? []).filter(
			(message): message is ExportableMessage =>
				message.role === "user" || message.role === "assistant" || message.role === "toolResult",
		);
		const session = this.sessionInfo;
		if (transcript.length === 0 || !session) {
			return null;
		}

		const t = this.t();
		// ||, not ??: firstMessage is "" for an image-only opener, and noteFileName's
		// English fallback would leak past an empty-string title.
		const base = noteFileName(session.name || session.firstMessage || t.t("chat.exportUntitled"));
		const dir = this.getSettings().sessionDir;
		try {
			let path = `${dir}/${base}.md`;
			let suffix = 2;
			while (this.app.vault.getAbstractFileByPath(path)) {
				path = `${dir}/${base} ${suffix}.md`;
				suffix += 1;
			}
			if (!this.app.vault.getAbstractFileByPath(dir)) {
				await this.app.vault.createFolder(dir);
			}
			const model = getSelectedModel(this.getSettings());
			const content = renderTranscriptMarkdown(transcript, {
				title: session.name ?? base,
				exportedAt: new Date(),
				model: `${model.provider}/${model.id}`,
				roles: {
					user: t.t("chat.exportUser"),
					assistant: t.t("chat.exportAssistant"),
					tool: t.t("chat.exportTool"),
				},
			});
			await this.app.vault.create(path, content);
			return path;
		} catch (error) {
			// The same channel `ReplyActions` already uses for a failed vault write
			// (`notifyActionResult`), for the same class of failure.
			this.toast("chat.exportFailed", error);
			return null;
		}
	}

	/**
	 * Reconciles the active session's display name with what is on disk. The
	 * counterpart to {@link renameSession} for renames this plugin did not make:
	 * a second Obsidian window on the same vault, a pi CLI sharing the folder, or
	 * a hand edit appends a name fact to the JSONL that the live session's
	 * in-memory state never sees.
	 *
	 * The name comparison is the loop guard, not a nicety. Whether this plugin's
	 * own adapter writes surface as vault `modify` events is platform-dependent
	 * (desktop may; mobile has no disk watcher), so every event — self-written or
	 * external — funnels through here and only a genuinely different name is
	 * allowed to move state. A local `renameSession` already cached the name it
	 * wrote, so its own echo reads as unchanged and lands nowhere; without that
	 * guard, per-append events during a streaming turn would re-render the panel
	 * and thrash the session list effect on every message.
	 *
	 * Only the name is patched, never the rest of `sessionInfo`: a disk read taken
	 * mid-stream is behind the live session's in-flight appends, so copying
	 * `messageCount`/`updatedAt` across could only regress them. An external
	 * process appending *messages* (not names) to the active file stays out of
	 * scope — nothing in the panel renders that live, and the next settled
	 * refresh re-summarizes.
	 *
	 * Best-effort like retention: a read that throws (the file deleted or moved
	 * externally mid-read) leaves the current state alone rather than becoming an
	 * unhandled rejection from a vault event handler.
	 */
	async syncExternalSessionChange(): Promise<void> {
		const activePath = this.sessionManager.getActiveSessionPath();
		if (!activePath) {
			return;
		}
		let diskName: string | undefined;
		try {
			diskName = await this.sessionManager.readActiveSessionName();
		} catch {
			return;
		}
		if (diskName === this.sessionInfo?.name) {
			return;
		}
		if (this.sessionInfo) {
			this.sessionInfo = { ...this.sessionInfo, name: diskName };
			const rt = this.runtimes.get(activePath);
			if (rt) {
				rt.sessionInfo = this.sessionInfo;
			}
		}
		const rt = this.runtimes.get(activePath);
		if (rt) {
			rt.sessionRevision += 1;
		}
		this.notify();
	}

	/**
	 * Trashes a stored session. Deleting the active one leaves the manager without
	 * an active session, so a replacement is adopted here before anything reads
	 * `getActiveSessionInfo` — the next stored session, or a fresh one when the
	 * vault has none left.
	 */
	async deleteSession(path: string): Promise<void> {
		await this.initialize();
		const rt = this.runtimes.get(path);
		const wasActive = this.sessionManager.getActiveSessionPath() === path;
		try {
			await this.sessionManager.deleteSession(path);
		} catch (error) {
			this.toast("chat.sessionDeleteFailed", error);
			return;
		}
		// Only after the trash succeeded: a refused delete must leave the session
		// exactly as it was, run included. And only the deleted session is killed —
		// other runtimes, including the one the panel is about to focus, keep
		// whatever they were doing.
		if (rt) {
			await this.abortSession(path);
			this.removeRuntime(rt);
		}

		this.sessionRevision += 1;
		const focused = this.current();
		if (focused) {
			focused.sessionRevision += 1;
		}
		if (wasActive) {
			this.currentPath = null;
			// Drop the dead session's info with it: the window between here and the
			// replacement adopting (openSession or the forced newSession below) can
			// notify, and a snapshot whose `session` names a just-deleted file is a
			// lie every consumer would have to defend against.
			this.sessionInfo = null;
		}
		const replacement = (await this.sessionManager.listSessions())[0];
		if (wasActive && replacement) {
			await this.openSession(replacement.path);
			return;
		}
		if (wasActive) {
			this.notify();
		}
		if (!this.sessionManager.getActiveSessionPath()) {
			// Forced: the agent still shows the just-deleted session's transcript,
			// so the blank-sheet check would refuse and strand the panel on a dead
			// session with no active path behind it.
			await this.newSession({ force: true });
		}
	}

	/**
	 * Re-reads skill files after the settings panel changed them on disk.
	 *
	 * Imports, updates, and deletions land in the vault without touching
	 * settings, so {@link refreshConfiguration} — which rides `saveSettings`
	 * — never hears about them. This is the narrower half of that method: the
	 * skills reload and the subscriber notification, with none of the model
	 * and session bookkeeping a settings change needs.
	 *
	 * Also the panel's Reload button, which is why a failure is *not* contained
	 * here: someone pressed a control and is waiting for its verdict, so the
	 * rejection travels to them instead of being logged and swallowed. The
	 * startup path takes {@link reloadSkillsSafely} for the opposite reason.
	 *
	 * Awaiting this is how a caller makes {@link getSkillLoad} current: the
	 * promise resolves only once the load has finished and been stored.
	 */
	async refreshSkills(): Promise<void> {
		await this.reloadSkills();
		this.notify();
	}

	/**
	 * Repoints requests at one of the configured models.
	 *
	 * The write goes through here rather than through the settings tab because
	 * the switcher lives in the composer: the panel's only dependency is this
	 * service, and a chat-panel control that reached for the plugin object would
	 * be a second route to the same setting. Persistence is delegated — see
	 * {@link ObsidianAgentServiceOptions.persistSettings} — which also carries the
	 * reconfigure, so a switch lands on `agent.state.model` and is appended to
	 * the session log like any other configuration change.
	 *
	 * Mid-run (issue #252) the switch is allowed but deferred: the setting is
	 * written through immediately — `data.json` and the live snapshot agree at
	 * once, and a crash or reload picks the new model up — while the run in
	 * flight keeps the model it started on, so its remaining turns do not move
	 * onto a different endpoint halfway through. The choice waits in
	 * {@link SessionRuntime.pendingConfiguration} and
	 * {@link flushPendingConfiguration} applies it when the run settles. A
	 * second mid-run choice of either kind overwrites the first: last write
	 * wins, which is what the user last clicked.
	 *
	 * An id that names no configured model is ignored rather than stored. A
	 * dangling `activeModelId` does not fail loudly: {@link getSelectedModel}
	 * answers the next request from the builtin catalog instead, which is a
	 * different endpoint than the user believes they selected.
	 */
	async setActiveModel(modelId: string): Promise<void> {
		const settings = this.getSettings();
		if (settings.activeModelId === modelId || !settings.models.some((model) => model.id === modelId)) {
			return;
		}
		settings.activeModelId = modelId;
		const rt = this.current();
		if (rt && this.isBusy(rt)) {
			rt.pendingConfiguration = { ...rt.pendingConfiguration, modelId };
			await this.persistSettings({ reconfigure: false });
			this.notify();
			return;
		}
		await this.persistSettings();
	}

	/**
	 * Sets the level on the live conversation — the session's own property, not a
	 * global one. The change is recorded in the session file so a reload or
	 * another window replays it, exactly like a model change. A no-op when the
	 * level is already set (the selector's job) or there is no live agent.
	 *
	 * Mid-run (issue #252) the change is allowed but deferred, like
	 * {@link setActiveModel}: the pending level rides
	 * {@link SessionRuntime.pendingConfiguration} and
	 * {@link flushPendingConfiguration} applies it when the run settles, with
	 * {@link reconfigureRuntime} doing the clamp against the model then in force
	 * and the session-log append — the only writer, so no double entry and no
	 * unclamped value recorded. Accepted edge: choosing a level mid-run and then
	 * starting a *new* session before the run lands means the new session
	 * inherits the old recorded level, since the pending choice has not been
	 * appended anywhere yet.
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		const rt = this.current();
		const agent = rt?.agent;
		if (!rt || !agent || agent.state.thinkingLevel === level) {
			return;
		}
		if (this.isBusy(rt)) {
			rt.pendingConfiguration = { ...rt.pendingConfiguration, thinkingLevel: level };
			this.notify();
			return;
		}
		agent.state.thinkingLevel = level;
		if (this.sessionManager.isLoaded(rt.sessionPath)) {
			await this.sessionManager.appendThinkingLevelChangeFor(rt.sessionPath, level, rt.activeLane);
		}
		this.notify();
	}

	async refreshConfiguration(): Promise<void> {
		// A just-trashed session leaves nothing to append to; the session adopted in
		// its place runs `ensureConfiguration` itself. Subscribers are still told:
		// the snapshot is derived from live settings, so a setting the panel renders
		// directly — the language, the agent-details tier — has already changed even
		// when there is no agent to reconfigure.
		const rt = this.current();
		if (!rt || !rt.agent || !this.sessionManager.isLoaded(rt.sessionPath)) {
			this.notify();
			return;
		}
		await this.reconfigureRuntime(rt);
	}

	/**
	 * Reconfigures one runtime's live agent to match the current settings.
	 *
	 * The body {@link refreshConfiguration} used to carry, extracted so the
	 * operation can address a runtime directly: a deferred mid-run change (issue
	 * #252) applies when the run settles, and the runtime that settles may be one
	 * the panel is not showing — a background session left mid-stream — which the
	 * focused-only `current()` lookup could never name. Everything the settings
	 * path needs lives here unchanged: the model assignment, the thinking-level
	 * clamp with its session-log entry, the tool rebuild, the skill reload, and
	 * the configuration rows the session file records.
	 */
	private async reconfigureRuntime(rt: SessionRuntime): Promise<void> {
		const agent = rt.agent;
		if (!agent || !this.sessionManager.isLoaded(rt.sessionPath)) {
			return;
		}
		const defaults = this.getSessionDefaults();
		const model = getSelectedModel(this.getSettings());
		agent.state.model = model;
		// The level belongs to the session and is left alone here. Only a model
		// that can no longer express it forces a rewrite, and the session file is
		// told — an agent state silently diverging from the recorded level would
		// resurrect the old bug on the next reload.
		const clamped = clampThinkingLevel(model, agent.state.thinkingLevel);
		if (clamped !== agent.state.thinkingLevel) {
			agent.state.thinkingLevel = clamped;
			await this.sessionManager.appendThinkingLevelChangeFor(rt.sessionPath, clamped, rt.activeLane);
		}
		agent.state.tools = [
			...this.buildTools(rt),
			// Connect runs here, on the same settings-save path that rebuilt the
			// vault tool list — one road from "configuration changed" to "the agent
			// sees the new tools". The manager skips servers whose url+token are
			// unchanged, so routine saves do not reconnect anything.
			...(await this.fetchExternalTools()),
		];
		// Skills are read from the vault here too: `saveSettings` calls this after
		// every settings change, and the panel re-reads the folder with it, so a
		// newly saved skill reaches the running conversation without a reload.
		// Contained, for the reason `reloadSkillsSafely` documents: `sendPrompt`
		// awaits this outside its own `try`, so a throwing loader would reject the
		// send rather than merely arrive without skills. Prompt templates ride the
		// same call so an edited `/name` takes effect on the next message whichever
		// kind it is — the asymmetry where only skills did was not explicable.
		await this.reloadCommandsSafely();
		await this.sessionManager.ensureConfigurationFor(rt.sessionPath, defaults, rt.activeLane);
		await this.refreshSessionInfo(rt);
		this.notify();
	}

	/**
	 * Whether anything this runtime owns is in flight. Five flags, not one: a
	 * between-turns compaction is a real LLM call, a retry's branch summary is
	 * another, and `rt.compaction` is the single-flight promise those checks
	 * resolve through. Every mid-run deferral and every flush guard reads this
	 * one predicate, so the definition of "busy" lives in exactly one place.
	 */
	private isBusy(rt: SessionRuntime): boolean {
		const agent = rt.agent;
		return Boolean(agent?.state.isStreaming || rt.isCompacting || rt.retryInFlight || rt.branchSummaryController || rt.compaction);
	}

	/**
	 * Applies a change the user made mid-run, once the run has landed (issue
	 * #252).
	 *
	 * Everything typed during the run — the run itself, its steers — stays on
	 * the model it began on; the change lands for the dispatch that follows.
	 * `take-then-apply` is the whole concurrency story: the pending record is
	 * cleared before any await, so the two call sites ({@link
	 * notifySettledState} and {@link dispatchQueuedPrompts}, which can both fire
	 * for the same settle) cannot double-apply, and a change made between the
	 * take and the reconfigure simply becomes the next pending record.
	 *
	 * The level is written onto the agent state *before*
	 * {@link reconfigureRuntime} runs: the reconfigure's existing clamp reads
	 * `agent.state.thinkingLevel` against the model now in force, so an
	 * unsupported level for the pending model is clamped and logged there —
	 * one writer for the session file, not two.
	 *
	 * Refuses while still busy rather than throwing: the flush runs from settle
	 * paths, and a run that lands into another compaction (mid-run compact
	 * scheduled at turn end) must leave the change pending for the next settle,
	 * not fail the settle.
	 */
	private async flushPendingConfiguration(rt: SessionRuntime): Promise<void> {
		if (!rt.pendingConfiguration) {
			return;
		}
		if (!rt.agent || this.isBusy(rt)) {
			return;
		}
		const pending = rt.pendingConfiguration;
		rt.pendingConfiguration = null;
		if (pending.thinkingLevel !== undefined && rt.agent.state.thinkingLevel !== pending.thinkingLevel) {
			rt.agent.state.thinkingLevel = pending.thinkingLevel;
		}
		await this.reconfigureRuntime(rt);
	}

	dispose(): void {
		for (const rt of [...this.runtimes.values()]) {
			rt.agent?.abort();
			this.removeRuntime(rt);
		}
		// Orphaned subagents outlive their parent run otherwise: a run that ends
		// normally never aborts its signal, and a child has no deadline of its
		// own, so this is the backstop that actually collects them.
		this.subagentExtension.disposeAll();
		this.listeners.clear();
	}

	/** Modals are opened from the chat UI, whose only dependency is this service. */
	getApp(): App {
		return this.app;
	}

	/**
	 * Copy in the language the panel is currently rendering in.
	 *
	 * Resolved per call from live settings so an error raised after the user
	 * switches language is worded in the new one.
	 */
	private t(): Translator {
		return getT(resolveLanguage(this.app.vault as LanguageHost, this.getSettings().language));
	}

	/** The active session's vault path, or null when no chat is open. */
	getActiveSessionPath(): string | null {
		return this.sessionManager.getActiveSessionPath();
	}

	getSnapshot(): ChatSnapshot {
		const settings = this.getSettings();
		const rt = this.current();
		const agent = rt?.agent ?? null;
		const messages = agent?.state.messages ?? [];
		const model = getSelectedModel(settings);
		// Falls back to the selected model so the indicator exists before the agent
		// is built; the window is a static field of the model spec.
		const contextWindow = agent?.state.model.contextWindow ?? model.contextWindow;
		return {
			messages,
			streamingMessage: agent?.state.streamingMessage,
			isStreaming: agent?.state.isStreaming ?? false,
			// Both halves: the id pi tracks, and the tool name a reader needs. The
			// id is for matching, never for display — an id with no captured name
			// is dropped rather than shown raw, so a missed event cannot leak
			// `toolu_…` into the panel.
			pendingToolCalls: [...(agent?.state.pendingToolCalls ?? new Set<string>())]
				.map((id) => {
					const name = rt?.pendingToolNames.get(id);
					if (name === undefined) {
						return undefined;
					}
					const progress = rt?.pendingToolProgress.get(id);
					return progress === undefined ? { id, name } : { id, name, progress };
				})
				.filter((pending): pending is PendingToolCall => pending !== undefined),
			unpersistedMessages: [...(rt?.unpersistedMessages ?? [])],
			errorMessage: rt?.panelError?.message ?? this.visibleAgentError(rt, agent) ?? this.initializationError,
			errorOpensSettings: rt?.panelError?.opensSettings ?? false,
			// Mid-run sends, waiting for pi to inject. From the mirror rather
			// than from pi because pi's queues are write-only from outside —
			// the mirror is the only thing that can name them.
			queuedPrompts: rt?.promptQueue.list() ?? [],
			// Staging gate: the composer asks before collecting bytes the model
			// would refuse, instead of the send gate explaining the refusal after.
			supportsImages: modelSupportsImages(model),
			noticeMessage: rt?.noticeMessage,
			canResumeInterrupted: rt ? rt.resumableLanes.has(rt.activeLane) : false,
			provider: model.provider,
			modelId: model.id,
			// What the run in flight actually uses. Mid-run the settings already
			// carry the new choice while the agent keeps its model, and that gap —
			// not a flag — is what the switcher's pending note keys off.
			runningModelId: agent?.state.model.id ?? model.id,
			vendorIcon: vendorIconName(matchVendorForModel(model.id, model.baseUrl)),
			// The session's own level, not a settings fallback: with no agent yet
			// there is no conversation either, so "off" is the honest default.
			thinkingLevel: agent?.state.thinkingLevel ?? "off",
			pendingThinkingLevel: rt?.pendingConfiguration?.thinkingLevel,
			thinkingLevels: getSupportedThinkingLevels(model),
			modelChoices: listModelChoices(settings),
			activeModelId: settings.activeModelId,
			session: this.sessionInfo ?? undefined,
			sessionRevision: rt?.sessionRevision ?? this.sessionRevision,
			sessionRunStates: this.getSessionRunStates(),
			usage: sumUsage(messages, rt?.overheadUsage ?? []),
			contextFill: measureContextFill(messages, contextWindow, this.resolveCompaction(contextWindow)),
			isCompacting: rt?.isCompacting ?? false,
			compactionEvent: rt?.compactionEvent ?? null,
			compactionRetained: rt?.lastCompaction?.retainedTail.length ?? 0,
			isRewinding: rt?.retryInFlight ?? false,
			isConfigured: this.hasApiKey(),
			showAgentDetails: settings.showAgentDetails,
			traceExpand: settings.traceExpand,
			// `getLanguage` is newer than this plugin's minAppVersion, so the shipped
			// Vault declarations do not carry it; the cast is what lets the optional
			// call be feature-detected at runtime.
			language: resolveLanguage(this.app.vault as LanguageHost, settings.language),
			sendShortcut: settings.sendShortcut,
			contextRefs: this.contextRefList(rt),
			isFollowingActiveNote: rt?.pinnedNotes.followActive ?? true,
			availableCommands: [
				...this.promptTemplates.map((template) => ({
					name: template.name,
					description: template.description ?? "",
					kind: "template" as const,
					invocation: template.name,
				})),
				...this.skills.map((skill) => ({
					name: skill.name,
					description: skill.description,
					kind: "skill" as const,
					invocation: findPromptTemplate(this.promptTemplates, skill.name) ? `skill:${skill.name}` : skill.name,
				})),
			],
		};
	}

	/**
	 * Records the note the user is looking at, or `null` when the focused view is
	 * not a Markdown note.
	 *
	 * Driven by a workspace subscription, which also fires for the chat panel's own
	 * leaf and for repeated focus of the same file. Notifying only on a real change
	 * keeps those from re-rendering the panel, which matters because `notify`
	 * rebuilds the whole snapshot and React cannot bail out on a fresh object.
	 */
	setActiveNotePath(path: string | null): void {
		const next = path ?? null;
		if (this.activeNotePath === next) {
			return;
		}
		this.activeNotePath = next;
		this.notify();
	}

	/** Starts or stops naming the active note to the model. */
	setFollowActiveNote(follow: boolean): void {
		const rt = this.current();
		if (!rt || rt.pinnedNotes.followActive === follow) {
			return;
		}
		rt.pinnedNotes.followActive = follow;
		this.notify();
	}

	/** Keeps naming `path` even after the user navigates away. */
	pinContextRef(path: string): void {
		const rt = this.current();
		if (!rt || !path || rt.pinnedNotes.pinned.includes(path) || rt.pinnedNotes.pinned.length >= MAX_PINNED_REFS) {
			return;
		}
		rt.pinnedNotes.pinned = [...rt.pinnedNotes.pinned, path];
		this.notify();
	}

	/** Drops a pinned note. */
	unpinContextRef(path: string): void {
		const rt = this.current();
		if (!rt || !rt.pinnedNotes.pinned.includes(path)) {
			return;
		}
		rt.pinnedNotes.pinned = rt.pinnedNotes.pinned.filter((pinnedPath) => pinnedPath !== path);
		this.notify();
	}

	/** Keeps active and pinned context aligned with a vault rename. */
	renameContextPath(oldPath: string, newPath: string): void {
		if (!oldPath || !newPath || oldPath === newPath) {
			return;
		}
		let changed = false;
		const rewrite = (p: string): string => {
			if (p === oldPath) {
				changed = true;
				return newPath;
			}
			const prefix = `${oldPath}/`;
			if (p.startsWith(prefix)) {
				changed = true;
				return `${newPath}${p.slice(oldPath.length)}`;
			}
			return p;
		};
		if (this.activeNotePath) {
			this.activeNotePath = rewrite(this.activeNotePath);
		}
		for (const rt of this.runtimes.values()) {
			const next = [...new Set(rt.pinnedNotes.pinned.map(rewrite))];
			if (next.length !== rt.pinnedNotes.pinned.length || next.some((v, i) => v !== rt.pinnedNotes.pinned[i])) {
				rt.pinnedNotes.pinned = next;
				changed = true;
			}
		}
		if (changed) {
			this.notify();
		}
	}

	/** Removes deleted files or folders from active and pinned context. */
	forgetContextPath(path: string): void {
		if (!path) {
			return;
		}
		const matches = (candidate: string): boolean => candidate === path || candidate.startsWith(`${path}/`);
		let changed = false;
		if (this.activeNotePath && matches(this.activeNotePath)) {
			this.activeNotePath = null;
			changed = true;
		}
		for (const rt of this.runtimes.values()) {
			const next = rt.pinnedNotes.pinned.filter((pinnedPath) => !matches(pinnedPath));
			if (next.length !== rt.pinnedNotes.pinned.length) {
				rt.pinnedNotes.pinned = next;
				changed = true;
			}
		}
		if (changed) {
			this.notify();
		}
	}

	/**
	 * Everything the next turn for `rt` will name, active note first.
	 *
	 * The active path is the service-wide workspace fact; the follow flag and the
	 * pinned set are `rt`'s own. A pinned note that happens to be the active one
	 * is reported once, as the active entry.
	 */
	private contextRefList(rt: SessionRuntime | null): ContextRef[] {
		const refs: ContextRef[] = [];
		const active = rt && rt.pinnedNotes.followActive ? this.activeNotePath : null;
		if (active && rt) {
			refs.push({ kind: "active", path: active, isPinned: rt.pinnedNotes.pinned.includes(active) });
		}
		if (rt) {
			for (const path of rt.pinnedNotes.pinned) {
				if (path !== active) {
					refs.push({ kind: "pinned", path, isPinned: true });
				}
			}
		}
		return refs;
	}

	private async initializeAgent(): Promise<void> {
		await this.reloadCommandsSafely();
		const defaults = this.getSessionDefaults();
		const info = await this.sessionManager.continueRecentSession(defaults);
		const rt = this.runtimeForFocused();
		rt.sessionInfo = info;
		this.sessionInfo = info;
		this.currentPath = rt.sessionPath;
		// A stored session may have parked lanes in its log; the panel resumes on
		// main, which is the line the conversation's own history lives on.
		rt.activeLane = "main";
		const context = await this.sessionManager.buildSessionContext(rt.activeLane);
		rt.lastCompaction = await this.sessionManager.getLastCompaction(rt.activeLane);
		await this.adoptSessionContext(rt, context);
		// After the context is adopted — the offer is about the transcript this
		// panel now shows, so it must not stand before the messages are in.
		await this.settleInterruptedRuns(rt, context);
		this.notify();
	}

	/**
	 * Reloads prompt templates from the vault and merges them with the builtins.
	 *
	 * The diagnostics do not reach the chat panel, for the reason
	 * {@link reloadSkills} documents at length: they are warnings about the user's
	 * own files, and the banner carries no control that could act on one. They are
	 * stored on {@link lastSkillLoad} and logged. Builtins are constants, so only
	 * the vault half can produce warnings.
	 *
	 * Runs on every configuration refresh rather than only at startup. It used to
	 * load once in `initializeAgent`, so a template edited on disk did nothing
	 * until the plugin was reloaded — while an edited *skill* took effect on the
	 * very next message. Both are `.md` under a vault folder and both are `/name`
	 * commands in the same autocomplete menu, so nothing made that difference
	 * explicable. The cost is a non-recursive listing of one folder plus a read per
	 * `.md` child, set against the recursive skill walk and node-filesystem
	 * traversal already paid on the same call.
	 */
	private async refreshPromptTemplates(): Promise<void> {
		const loaded = await loadVaultPromptTemplates(this.env);
		this.promptTemplates = [...BUILTIN_PROMPT_TEMPLATES, ...loaded.templates];
		this.lastSkillLoad = { ...this.lastSkillLoad, templates: loaded.diagnostics };
		this.logCommandDiagnostics();
	}

	/**
	 * Both command loaders, with their failures contained.
	 *
	 * One method because the two always run together and the settings panel reports
	 * on them as a single load — see {@link SkillLoadReport}. Containment is what
	 * {@link reloadSkillsSafely} documents: on the startup and per-send paths a
	 * throwing loader must not take the agent, or the send, down with it. A vault
	 * whose template folder cannot be read still has its builtins.
	 */
	private async reloadCommandsSafely(): Promise<void> {
		await this.reloadSkillsSafely();
		try {
			await this.refreshPromptTemplates();
		} catch (error) {
			this.log.error("Prompt template load failed; continuing with builtins", () => ({ error: String(error) }));
			this.promptTemplates = [...BUILTIN_PROMPT_TEMPLATES];
			this.lastSkillLoad = { ...this.lastSkillLoad, templates: [] };
		}
	}

	/**
	 * Rebuilds the transcript from a session loaded off disk.
	 *
	 * Every message keeps a pointer back to the entry it was read from, so a
	 * retry in a reloaded session can rewind the log instead of being refused.
	 * Messages a compaction absorbed carry no entry and are left unmapped, which
	 * is what makes {@link retryFrom} decline them.
	 */
	/** Adopts a loaded session; async only to gather the tool list for the fresh agent. */
	private async adoptSessionContext(rt: SessionRuntime, context: SessionContext): Promise<void> {
		rt.messageEntryIds = new WeakMap<object, string>();
		context.messages.forEach((message, index) => {
			const entryId = context.messageOrigins[index];
			if (entryId) {
				rt.messageEntryIds.set(message, entryId);
			}
		});
		// The session's recorded level, clamped to the model requests will run on:
		// the conversation may have last run a model whose ceiling differs, and a
		// level the model cannot express is an error waiting for the next prompt.
		await this.replaceAgent(
			rt,
			context.messages,
			clampThinkingLevel(getSelectedModel(this.getSettings()), context.thinkingLevel),
		);
	}

	/**
	 * Reads the active note's current text for the context block.
	 *
	 * Obsidian's own `cachedRead` — the same call the vault tools use — because
	 * it serves from the metadata cache the editor keeps warm and never blocks on
	 * disk. A read that fails (the file vanished mid-run, a fake vault in a test
	 * that never registered it) degrades to `null`, which renders the path-only
	 * block; a missing note must not fail the whole request.
	 */
	private async readActiveNote(path: string): Promise<InjectedNote | null> {
		try {
			const abstract = this.app.vault.getAbstractFileByPath(path);
			// Only real Markdown notes carry injectable text. A folder, a canvas, or
			// an image at that path falls back to the path-only line.
			if (!(abstract instanceof TFile) || abstract.extension !== "md") {
				return null;
			}
			return { path, content: await this.app.vault.cachedRead(abstract), modifiedAt: abstract.stat.mtime };
		} catch (error) {
			// Degrades to the path-only block; debug level because the common case
			// (note closed mid-run) is routine, not a fault worth warning about.
			this.log.debug("Failed to read active note; sending the path-only context block", () => ({ path, error: String(error) }));
			return null;
		}
	}

	/**
	 * Freezes the half of the context that must not move during one user run.
	 *
	 * Both halves are read here, together: the workspace facts are derived from the
	 * same active note the refs name, and reading them at different moments is what
	 * would let the block name one note as active and a different note's folder as
	 * current.
	 *
	 * The workspace read degrades to nothing rather than failing the run. It is all
	 * in-memory reads off Obsidian's own caches, so a throw means the app handed
	 * over something structurally unexpected — worth a log line, never worth losing
	 * the user's turn over.
	 */
	private freezeRunContext(rt: SessionRuntime | null): FrozenRunContext {
		const refs = this.contextRefList(rt);
		return { refs, ...this.readRunContext(refs) };
	}

	private readRunContext(refs: readonly ContextRef[]): Omit<FrozenRunContext, "refs"> {
		try {
			return probeRunContext(this.app, refs);
		} catch (error) {
			this.log.debug("Failed to read the run context; sending the notes-only context block", () => ({ error: String(error) }));
			return EMPTY_RUN_CONTEXT;
		}
	}

	/**
	 * The base system prompt with the environment sentence appended.
	 *
	 * Composed here rather than inside `composeSystemPrompt`, whose job is skills
	 * and which the subagent runner shares. Degrades to the bare prompt if the read
	 * throws: an unnamed vault is a worse prompt, a failed session is a worse
	 * product.
	 */
	private promptWithEnvironment(): string {
		try {
			return withEnvironment(OBSIDIAN_AGENT_SYSTEM_PROMPT, probeEnvironment(this.app));
		} catch (error) {
			this.log.debug("Failed to read the environment facts; composing the prompt without them", () => ({ error: String(error) }));
			return OBSIDIAN_AGENT_SYSTEM_PROMPT;
		}
	}

	/**
	 * Builds the tool set the agent runs with.
	 *
	 * Vault tools come straight from the tools module; delegation rides in
	 * wholesale from the subagent extension, which owns the spawn/wait pair,
	 * the depth cap, and the registry — this service only supplies the host
	 * getters the extension resolves at execution time. MCP tools are appended
	 * by the callers, whose async gather may connect to servers.
	 */
	private buildTools(rt: SessionRuntime): AgentTool[] {
		// Each tool is wrapped so its execute runs with `toolRuntime` pointing at
		// the runtime that owns this agent. The subagent host getters are resolved
		// at spawn-execute time and must read the spawning session's state — a
		// focused panel on session B must not leak B's thinking level or skills
		// into a spawn started by session A.
		return this.subagentExtension.createTools().map((tool) => {
			if (!tool.execute) {
				return tool;
			}
			const execute = tool.execute;
			return {
				...tool,
				execute: (...args: Parameters<NonNullable<AgentTool["execute"]>>) => {
					const previous = this.toolRuntime;
					this.toolRuntime = rt;
					try {
						return execute(...args);
					} finally {
						this.toolRuntime = previous;
					}
				},
			} satisfies AgentTool;
		});
	}

	/**
	 * The subagent registry, for the read-only inspector surface.
	 *
	 * Same instance the delegation tools write: one source of truth, no mirror.
	 * Read-only in spirit — nothing in the UI layer should call `spawn`/`kill`
	 * on it, and the registry's own docs say observers copy what they render.
	 */
	getSubagentRegistry(): ReturnType<typeof createSubagentExtension>["registry"] {
		return this.subagentExtension.registry;
	}

	/** External tools for the current settings; empty when no provider is wired. */
	private fetchExternalTools(): Promise<AgentTool[]> {
		return this.getExternalToolsFn();
	}

	/**
	 * Builds a fresh agent over `messages`, wiring every seam the conversation
	 * needs.
	 *
	 * Async because the tool list now includes external tools — MCP today — and
	 * gathering them may connect to servers. Every caller already awaited other
	 * work on the way here, so the extra hop costs nothing.
	 */
	private async replaceAgent(rt: SessionRuntime, messages: AgentMessage[], thinkingLevel: ThinkingLevel): Promise<void> {
		rt.unsubscribeAgent?.();
		// A fresh agent's queues are empty by construction, so the mirror has to
		// say so too. Every caller of this method is a conversation switch
		// (new session, loaded session, thinking-level change) — queued words
		// belong to the conversation they were typed in, not the next one.
		rt.promptQueue.clear();
		// An aborted run never delivers `tool_execution_end`, so anything keyed by a
		// call that was in flight would otherwise accumulate for the life of the
		// panel. Both maps are keyed that way and both are only ever cleared by that
		// event, so they share the leak and have to share the fix. A fresh agent has
		// nothing in flight, which makes this the point where they are known to be
		// safe to drop.
		this.forgetPendingToolCalls(rt);
		const settings = this.getSettings();
		const model = getSelectedModel(settings);
		// Annotated because the `prepareNextTurnWithContext` closure below refers to
		// `agent`, and an inferred type would be circular.
		const agent: Agent = new Agent({
			// The custom endpoint rides the same transport as builtin providers;
			// only the provider registration differs. Resolved per request rather
			// than captured here, so an endpoint configured after this agent was
			// built is still reachable — see `resolveStreamFn`.
			streamFn: this.resolveStreamFn(),
			// pi's converter renders compaction summaries into the request. The agent's
			// default one silently filters that role out, which would discard every
			// compacted turn without surfacing an error.
			convertToLlm,
			// Names the active and pinned notes to the model on every turn, with the
			// active note's current text and the workspace around it riding along. pi
			// applies this per LLM request against a copy of the transcript, so the
			// block is re-derived for each turn of a tool loop and never reaches
			// `state.messages` — nothing lands in the session log or the panel. Refs
			// and workspace facts are read through a per-run snapshot while a prompt is
			// active, so a note switch cannot retarget a tool loop halfway through a
			// user request. The note body is re-read per request instead, which is what
			// makes it honest: an `edit` the model just made is visible to its next turn.
			transformContext: async (messages) => {
				const frozen = rt.activeRunContext ?? this.freezeRunContext(rt);
				const activePath = frozen.refs.find((ref) => ref.kind === "active")?.path;
				const note = activePath ? await this.readActiveNote(activePath) : null;
				// The date is read per request rather than frozen with the refs: a run
				// that spans midnight must not keep asserting yesterday's date.
				return injectContext(messages, {
					refs: frozen.refs,
					note,
					selection: frozen.selection,
					links: frozen.links,
					outlines: frozen.outlines,
					workspace: frozen.workspace,
					today: new Date(),
				});
			},
			initialState: {
				// Skills were loaded by the same async path that led here
				// (`initializeAgent` / `openSession` / `newSession` all await
				// `reloadSkills` first), so the composed prompt is current; a live
				// agent gets its prompt refreshed by `reloadSkills` itself.
				systemPrompt: composeSystemPrompt(this.promptWithEnvironment(), this.skills),
				model,
				// The caller resolves this: the loaded session's own level, or the
				// seed a new session was created with. Global settings have no say.
				thinkingLevel,
				tools: [...(await this.buildToolsAsync(rt)), ...(await this.fetchExternalTools())],
				messages,
			},
			getApiKey: (provider) => this.getApiKey(provider),
			// Fires after a turn's tool calls finish and before the next provider
			// request (`runLoop`, at its `prepareNextTurn` call) — the only point
			// inside a run where the context can still be replaced. The
			// `WithContext` variant is required because plain `prepareNextTurn`
			// receives no context, and pi prefers it when both are set
			// (`createLoopConfig`). Closing over this run's `agent` rather than
			// `this.agent` is what lets `performCompaction` tell a stale result
			// from a current one.
			prepareNextTurnWithContext: (turn, signal) => this.compactBetweenTurns(rt, agent, turn, signal),
			sessionId: rt.sessionInfo?.id,
			// pi's default is "one-at-a-time": of several messages steered in a
			// row, only the first is injected at the next turn boundary and the
			// rest wait for later runs. A chat panel's send button means "send
			// all of it", so every queued message reaches the next turn.
			steeringMode: "all",
			followUpMode: "all",
			// pi's per-tool `executionMode` marks only take effect once this is
			// "parallel": the loop short-circuits to sequential when either this
			// flag or any tool in the batch is marked sequential. Batches of pure
			// read tools (read/ls/find/grep/…) now run concurrently — the latency
			// win for long multi-tool turns — while every tool that mutates the
			// vault, the editor, the screen, the network, or a remote server is
			// pinned `executionMode: "sequential"` at its definition, so one such
			// call serializes its whole batch exactly as before. The subagent
			// runner keeps its own sequential default.
			toolExecution: "parallel",
		});
		rt.agent = agent;
		rt.unsubscribeAgent = agent.subscribe((event) => this.handleAgentEvent(rt, event));
	}

	/**
	 * `buildTools` plus the async external gather, for callers that are already
	 * asynchronous (agent construction is). Kept separate so the synchronous
	 * tool rebuild in `refreshConfiguration` stays synchronous in shape.
	 */
	private async buildToolsAsync(rt: SessionRuntime): Promise<AgentTool[]> {
		return this.buildTools(rt);
	}

	/**
	 * Reloads bundled and vault skills and pushes them into the live agent's system prompt.
	 *
	 * Runs before a new agent is built and again whenever configuration
	 * refreshes, so a skill the user just saved in the vault reaches the next
	 * turn without a plugin reload.
	 *
	 * The diagnostics do not reach the chat panel. They are warnings about the
	 * user's own files, and this method runs on every send, so routing them to
	 * the notice banner put raw filesystem text —
	 * `EACCES: permission denied, realpath '…'` — in front of someone asking a
	 * question about their notes, once per message, with no control anywhere near
	 * it that could act on the problem. They are stored for the Skills settings
	 * tab, which owns those files, and logged for the log panel. See
	 * {@link lastSkillLoad}.
	 */
	private async reloadSkills(): Promise<void> {
		const { skills: vaultSkills, diagnostics } = await loadVaultSkills(this.env);
		// User-level skills ride between builtins and vault unconditionally:
		// pi itself reads those directories, so a vault that already uses pi
		// picks up the skills it wrote there, and a vault skill of the same
		// name still wins.
		const userLoad = await this.loadUserSkillsFn(this.getSettings().userSkillsDir);
		const skills = mergeSkills(createBuiltinSkills(this.t()), userLoad.skills, vaultSkills);
		this.skills = skills;
		this.lastSkillLoad = { ...this.lastSkillLoad, vault: diagnostics, user: userLoad };
		this.logCommandDiagnostics();
		// Every live runtime is told: skills are an app-wide asset, and a
		// background session mid-conversation deserves the refreshed prompt too.
		for (const rt of this.runtimes.values()) {
			if (rt.agent) {
				rt.agent.state.systemPrompt = composeSystemPrompt(this.promptWithEnvironment(), skills);
			}
		}
	}

	/**
	 * "Unknown command", plus a pointer to the Skills tab when the last load
	 * had problems.
	 *
	 * This is the one place a skill-loading problem still speaks in chat, and it
	 * earns that by being per-turn and caused by what the user just typed —
	 * the same standard `chat.imageNotFound` meets. It exists because the bare
	 * refusal misattributes the cause. A `SKILL.md` pi refused to load — no
	 * `description`, unreadable frontmatter — is genuinely absent, so the command
	 * the user wrote in their own file really is unknown, and the answer reads as
	 * "you typed it wrong" when the truth is "your file did not load". A name that
	 * merely breaks pi's character rules is worse still: the skill loads under
	 * whatever the frontmatter said, so the *folder* name the user reached for is
	 * the one that fails. Either way the explanation is a diagnostic, and without
	 * this pointer its only copy is in a panel they have no reason to open.
	 *
	 * It names no path and quotes no filesystem text — the problems themselves
	 * stay in the Skills tab. Silent when the last load was clean, which is the
	 * ordinary case: a plain typo gets a plain answer.
	 */
	private describeUnknownCommand(name: string): string {
		const t = this.t();
		const unknown = t.t("chat.unknownCommand", { name });
		const { vault, user } = this.lastSkillLoad;
		const problems = vault.length + user.diagnostics.length;
		return problems === 0 ? unknown : `${unknown}\n${t.t("chat.unknownCommandSkillProblems")}`;
	}

	/**
	 * {@link reloadSkills} with the skill layer's failures contained.
	 *
	 * The loaders promise never to throw — every {@link NodeHomeEnv} operation
	 * returns a `Result` — but that is a contract, not a structural guarantee, and
	 * the seam is injectable. On the startup path the difference mattered: a throw
	 * from here reached {@link initialize}'s handler, became
	 * {@link initializationError}, and surfaced as the assertive red banner, which
	 * also gates sending. A folder the user's operating system refuses to read
	 * would have stopped the agent from existing.
	 *
	 * So a failure here degrades to no skills plus a logged error. Skills are an
	 * augmentation: an agent without them answers questions, and one that cannot
	 * start answers nothing. Only the startup path takes this route — a reload
	 * driven by the settings panel's Reload button lets the error out, because
	 * there someone is watching and asked for the result.
	 */
	private async reloadSkillsSafely(): Promise<void> {
		try {
			await this.reloadSkills();
		} catch (error) {
			this.log.error("Skill load failed; continuing without skills", () => ({ error: String(error) }));
			this.skills = createBuiltinSkills(this.t());
			this.lastSkillLoad = emptySkillLoadReport();
		}
	}

	/**
	 * Warnings from the last skill load, for the Skills settings tab.
	 *
	 * The panel renders this rather than loading the folders itself, so it can
	 * never describe a read the agent did not perform — see
	 * {@link lastSkillLoad}. Callers refresh it by awaiting
	 * {@link refreshSkills}, which resolves only after the load finishes.
	 */
	getSkillLoad(): SkillLoadReport {
		return this.lastSkillLoad;
	}

	/**
	 * Logs each command-load diagnostic once per distinct set, at warn.
	 *
	 * All three layers together, keyed as one set, because they load together and
	 * a fingerprint per layer would re-log every layer whenever any one of them
	 * changed. `code` and `path` are logged though no panel shows them: the code is
	 * jargon with no consequence attached, and the log is where a bug report gets
	 * assembled. The fingerprint is what keeps a standing problem — an unreadable
	 * folder that is still unreadable next turn — from writing one line per user
	 * message into a ring buffer that holds 2000 of them.
	 */
	private logCommandDiagnostics(): void {
		const { vault, user, templates } = this.lastSkillLoad;
		const all = [
			...vault.map((diagnostic) => ({ layer: "vault-skills", diagnostic })),
			...user.diagnostics.map((diagnostic) => ({ layer: "user-skills", diagnostic })),
			...templates.map((diagnostic) => ({ layer: "prompt-templates", diagnostic })),
		];
		const key = all.map(({ layer, diagnostic }) => `${layer}:${diagnostic.code}:${diagnostic.path}:${diagnostic.message}`).join("\n");
		if (key === this.loggedDiagnosticsKey) {
			return;
		}
		this.loggedDiagnosticsKey = key;
		for (const { layer, diagnostic } of all) {
			this.log.warn("Command load warning", () => ({
				layer,
				code: diagnostic.code,
				path: diagnostic.path,
				message: diagnostic.message,
			}));
		}
	}

	private async handleAgentEvent(rt: SessionRuntime, event: AgentEvent): Promise<void> {
		if (event.type === "tool_execution_start") {
			rt.pendingToolNames.set(event.toolCallId, event.toolName);
			rt.pendingToolStarts.set(event.toolCallId, Date.now());
		}
		// pi emits this whenever a tool calls the `onUpdate` callback handed to its
		// `execute`. Recording it is what lets a long-running tool report progress
		// instead of the panel showing an unchanging "Working…" until it returns.
		// A line the tool leaves blank is dropped rather than stored, so the row
		// falls back to the plain tool name instead of rendering an empty detail.
		if (event.type === "tool_execution_update") {
			const line = firstProgressLine(event.partialResult);
			if (line) {
				rt.pendingToolProgress.set(event.toolCallId, line);
			}
		}
		if (event.type === "tool_execution_end") {
			rt.pendingToolNames.delete(event.toolCallId);
			rt.pendingToolProgress.delete(event.toolCallId);
		}
		this.logAgentEvent(rt, event);
		try {
			if (event.type === "message_end") {
				// Stamp the reply's duration while `Date.now()` still is the settle
				// moment, before persistence copies the message into the session
				// log. pi only records when streaming started; this is where the
				// other end gets measured (#240). User messages pass through
				// untouched.
				stampReplyEnd(event.message, Date.now());
				// First duty: if this is a queued message pi just injected, take
				// its chip down. Identity matching means a user who queued the
				// same words twice gets the right one settled. The message
				// persists either way — an injected steer is transcript history
				// like any other turn.
				rt.promptQueue.settle(event.message);
				await this.persistMessage(rt, event.message);
			}
			if (event.type === "agent_end") {
				// Every message is attempted even after one fails: the realistic cause
				// is a log the host cannot write at all, and stopping at the first
				// would mark one reply while leaving the rest of the run silently
				// unrecorded. The first failure is rethrown after the sweep so the
				// ledger still stays open.
				let failure: Error | undefined;
				for (const message of event.messages) {
					try {
						await this.persistMessage(rt, message);
					} catch (error) {
						// Normalized on capture rather than at the throw: the original is
						// kept whenever it is already an `Error`, and a thrown string
						// still arrives at the outer handler as something with a message.
						failure ??= error instanceof Error ? error : new Error(String(error));
					}
				}
				if (failure) {
					throw failure;
				}
				await this.settleRunLedger(rt, event.messages);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// No banner message: {@link persistMessage} has already marked the
			// replies this is about, and the transcript reports it under each of
			// them — which is the only place that can say *which* reply is not on
			// disk, and the only report the next send cannot erase.
			this.log.error("Failed to persist agent output", () => ({ event: event.type, error: message }));
		}
		if (event.type === "agent_end") {
			// Outside the persist guard on purpose: the resume has its own
			// error path, and a dispatch failure must not surface disguised as
			// a persist failure. A run that ended on its own may leave steers
			// pi never injected — a run that died mid-request never reaches its
			// next drain point, and the final drain point races a steer typed
			// during the last reply. Dispatching them here is what the user
			// asked for when they typed. Runs the user aborted are excluded
			// inside the resume itself, and `abort()` also empties the mirror
			// directly, so the two guards are belt and braces.
			//
			// Not awaited, and not yet: pi awaits this listener inside the
			// run's executor, so at this moment `activeRun` is still held and
			// `state.isStreaming` still true — a prompt dispatched here dies on
			// "Agent is already processing" (or, worse, bails on the resume's
			// own streaming guard). `waitForIdle()` resolves exactly after
			// `finishRun()` has cleared that state, which pi documents as the
			// definition of "idle"; the resume picks the dispatch up from
			// there. Awaiting `waitForIdle()` here instead would deadlock — the
			// run cannot finish until this listener returns — so the promise is
			// deliberately left unchained into this handler's control flow.
			// The runtime is captured in the closure, never re-read from
			// `this.current()`: by the time pi goes idle, the panel may be on a
			// different session, and the stranded queue belongs to this run.
			void rt.agent
				?.waitForIdle()
				.then(() => this.dispatchQueuedPrompts(rt, event.messages))
				.catch((error) => {
					this.log.error("Failed to dispatch stranded queued prompts", () => ({
						error: error instanceof Error ? error.message : String(error),
					}));
				});
		}
		// Session info only changes when the session file does: a persisted
		// message (message_end) or the run's final sweep (agent_end). Gating on
		// those two is what keeps streaming cheap — a full-delta run used to
		// re-run `refreshSessionInfo` (a real `adapter.stat` plus a whole-file
		// entry read) once per streaming chunk, hundreds of disk round-trips
		// for a summary whose inputs had not changed. `notify` stays
		// unconditional: the streaming text and tool progress live in the
		// snapshot, and a delta that never notifies never renders.
		if (event.type === "message_end" || event.type === "agent_end") {
			await this.refreshSessionInfo(rt);
		}
		this.notify();
	}

	/**
	 * Drops the per-call bookkeeping both in-flight maps hold.
	 *
	 * One method rather than two `clear()` calls at the call site: the maps are
	 * two halves of one fact — what is running right now — and each is only ever
	 * emptied by `tool_execution_end`. A run that is aborted never delivers that
	 * event for the calls still in flight, so anything not cleared here survives
	 * for the life of the panel. Clearing them together is what keeps the next
	 * reader from having to notice that the second one exists.
	 */
	private forgetPendingToolCalls(rt: SessionRuntime): void {
		rt.pendingToolNames.clear();
		rt.pendingToolStarts.clear();
		rt.pendingToolProgress.clear();
	}

	/**
	 * Emits one agent event through the logger, if it is worth a record.
	 *
	 * The mapping lives in {@link describeAgentEvent} so it can be tested
	 * without an agent; here is only the timing bookkeeping the mapping cannot
	 * do — a tool's duration spans two events, so the start time has to be
	 * remembered until the end arrives.
	 */
	private logAgentEvent(rt: SessionRuntime, event: AgentEvent): void {
		// Duration is computed here, not by the mapping: it spans two events, so
		// only this side of the boundary knows both endpoints.
		let durationMs: number | undefined;
		if (event.type === "tool_execution_end") {
			const startedAt = rt.pendingToolStarts.get(event.toolCallId);
			rt.pendingToolStarts.delete(event.toolCallId);
			if (startedAt !== undefined) {
				durationMs = Math.max(0, Date.now() - startedAt);
			}
		}
		const entry = describeAgentEvent(event, durationMs);
		if (!entry) {
			return;
		}
		const { level, message, detail } = entry;
		if (level === "error") {
			this.log.error(message, () => detail ?? {});
		} else if (level === "warn") {
			this.log.warn(message, () => detail ?? {});
		} else if (level === "info") {
			this.log.info(message, () => detail ?? {});
		} else {
			this.log.debug(message, () => detail ?? {});
		}
	}

	/**
	 * Summarizes older history between the turns of a run that is already streaming.
	 *
	 * One prompt drives many provider requests: `runLoop` keeps calling
	 * `streamAssistantResponse` while tool calls arrive, each time with the whole
	 * accumulated context including every tool result. A long agentic turn can
	 * therefore outgrow the window that {@link compactContextIfNeeded} sized
	 * before the prompt went out, and without this the run dies on a provider
	 * context-length error with no way to recover.
	 *
	 * Returning a replacement context is what makes the next request *in this
	 * run* see the summary; assigning `agent.state.messages` alone would only fix
	 * the transcript the panel renders. Failure and cancellation both return
	 * undefined, which leaves pi's own context in place and lets the run continue
	 * against a context the provider judges — the same bargain struck before a
	 * prompt.
	 *
	 * Two structural facts make replacing the context here safe. The hook never
	 * fires between an assistant tool-call message and its results, because
	 * `runLoop` appends every result and emits `turn_end` first — and pi's
	 * `findValidCutPoints` refuses `toolResult` as a cut point, so the compacted
	 * list cannot begin with an orphaned result. And it still *ends* with one,
	 * because `retainedTail` is a suffix of its input, satisfying pi's rule that
	 * a continued context end in a user or tool-result message.
	 */
	private async compactBetweenTurns(
		rt: SessionRuntime,
		agent: Agent,
		turn: PrepareNextTurnContext,
		signal?: AbortSignal,
	): Promise<AgentLoopTurnUpdate | undefined> {
		if (!this.shouldCompactBetweenTurns(rt, agent, turn, signal)) {
			return undefined;
		}
		rt.midRunCompactions += 1;
		if (!(await this.runExclusiveCompaction(rt, agent, { signal }))) {
			return undefined;
		}
		// Derived from the transcript `performCompaction` just assigned rather
		// than computed alongside it: the compacted list exists in exactly one
		// place, which is what makes the two arrays impossible to get out of step.
		//
		// The `.slice()` is load-bearing. This array and `agent.state.messages`
		// are separate lists that track in parallel — the loop pushes into its own
		// as it streams and as tool results land, while `processEvents` pushes
		// into the state's on every `message_end`. Handing over the state's array
		// itself would have both writers appending to one list, duplicating every
		// later message.
		return { context: { ...turn.context, messages: agent.state.messages.slice() } };
	}

	/**
	 * Whether this turn boundary is worth a summarization request.
	 *
	 * Decided before {@link runExclusiveCompaction} is entered on purpose: that
	 * method raises `isCompacting` as soon as it is called and the composer
	 * renders it, so asking pi's threshold question afterwards would flash
	 * "Tidying up earlier messages…" at every turn boundary of every run.
	 * {@link needsCompaction} is the same predicate `compactIfNeeded` applies to
	 * itself, so the two cannot disagree.
	 */
	private shouldCompactBetweenTurns(rt: SessionRuntime, agent: Agent, turn: PrepareNextTurnContext, signal?: AbortSignal): boolean {
		if (signal?.aborted) {
			return false;
		}
		// No tool results means no further request in this run: the inner loop
		// only continues on tool calls or queued steering messages, and this
		// plugin never calls `steer()`/`followUp()`. Summarizing here would buy a
		// summary for a request that never goes out, and the next prompt's own
		// pre-prompt compaction covers that context anyway.
		if (turn.toolResults.length === 0) {
			return false;
		}
		if (rt.midRunCompactions >= MAX_MID_RUN_COMPACTIONS) {
			return false;
		}
		return needsCompaction(agent.state.messages, getSelectedModel(this.getSettings()));
	}

	/**
	 * Summarizes older history before prompting when the context is nearly full.
	 *
	 * This runs while the agent is still idle, so `agent.state.isStreaming` cannot
	 * guard it — concurrent callers are serialized on `compaction` instead. A
	 * failed compaction is surfaced but not fatal: the prompt still goes out and
	 * the provider decides whether the context fits.
	 *
	 * Sizes the context for the *first* request of the run only.
	 * {@link compactBetweenTurns} covers the rest.
	 */
	private async compactContextIfNeeded(rt: SessionRuntime, agent: Agent): Promise<void> {
		await this.runExclusiveCompaction(rt, agent);
	}

	/**
	 * Compacts on demand from the command palette, regardless of the threshold.
	 *
	 * "Skipped" is a real outcome worth reporting — a fresh conversation has
	 * nothing older than `keepRecentTokens` for pi to summarize — so it lands on
	 * the notice channel rather than vanishing. A failed compaction is already
	 * surfaced by {@link runCompaction} and must not be overwritten with
	 * "nothing".
	 */
	async compactNow(): Promise<void> {
		await this.initialize();
		const rt = this.runtimeForFocused();
		// A failed start leaves no agent, and the banner already carries why —
		// same reasoning as the matching guard in `sendPrompt`.
		const agent = rt.agent;
		if (!agent || agent.state.isStreaming) {
			return;
		}
		if (!this.hasApiKey()) {
			const t = this.t();
			// Same recovery as `needsKeyToSend` above: the fix lives in settings.
			this.setError(rt, t.t("target.needsKeyToCompact", { target: describeModelTarget(this.getSettings(), t) }), true);
			return;
		}

		try {
			rt.panelError = undefined;
			rt.noticeMessage = undefined;
			const compacted = await this.runExclusiveCompaction(rt, agent, { force: true });
			// A failure is already on its own transcript row, and "nothing to tidy" on
			// top of it would contradict it.
			if (!compacted && !rt.panelError && rt.compactionEvent === null) {
				this.setNotice(rt, this.t().t("chat.nothingToCompact"));
			}
		} finally {
			await this.notifySettledState(rt);
		}
	}

	/**
	 * Runs at most one compaction at a time and owns the `isCompacting`
	 * lifecycle around it: set before the request launches (the header needs to
	 * show "Compacting context…" while the LLM call is in flight), cleared in a
	 * finally so an abort or failure cannot leave the banner stuck.
	 *
	 * All three callers share this: before a prompt, on the command-palette path
	 * (`force`), and between the turns of a run (`signal`). Sharing it is what
	 * gives them one `isCompacting` lifecycle, one single-flight guard, and one
	 * set of success side effects.
	 *
	 * Returns whether anything was compacted; failures are surfaced, not thrown.
	 */
	private async runExclusiveCompaction(rt: SessionRuntime, agent: Agent, options: CompactionRunOptions = {}): Promise<boolean> {
		if (!rt.compaction) {
			rt.compactionController = new AbortController();
			rt.compaction = this.trackCompaction(rt, agent, rt.compactionController.signal, options.force === true);
		}
		// The run's signal is linked into this runtime's controller rather than
		// replacing it, so a compaction between turns stays reachable from every
		// existing cancel path — `abortSession()`, `dispose()` and `deleteSession()`
		// all abort `compactionController` — while `agent.abort()` also cancels it
		// through the run's own signal. `AbortSignal.any` would say this in one
		// line but postdates the WebView versions `minAppVersion` admits.
		const controller = rt.compactionController;
		const stop = (): void => controller?.abort();
		options.signal?.addEventListener("abort", stop, { once: true });
		try {
			return await rt.compaction;
		} finally {
			options.signal?.removeEventListener("abort", stop);
			rt.compaction = null;
			rt.compactionController = null;
		}
	}

	private async trackCompaction(rt: SessionRuntime, agent: Agent, signal: AbortSignal, force: boolean): Promise<boolean> {
		// The anchor is read here rather than in `performCompaction` because the row
		// has to appear at the tail the reader is looking at *now* — a prompt's
		// pre-flight tidy runs before the user's own message joins the transcript.
		rt.compactionEvent = { state: "running", anchor: agent.state.messages.length };
		try {
			this.notify();
			return await this.performCompaction(rt, agent, signal, force);
		} finally {
			/*
			 * `performCompaction` has already decided what the row says next: a
			 * failure worth reporting replaced this record with its own, and every
			 * other ending — success, nothing to do, abort — leaves the row nothing
			 * to say. Only the running record is cleared, so a failure recorded
			 * inside the try survives this block.
			 */
			if (rt.compactionEvent?.state === "running") {
				rt.compactionEvent = null;
			}
			this.notify();
		}
	}

	private async performCompaction(rt: SessionRuntime, agent: Agent, signal: AbortSignal, force: boolean): Promise<boolean> {
		const model = getSelectedModel(this.getSettings());
		const outcome = await compactIfNeeded({
			messages: agent.state.messages,
			model,
			models: withRequestDefaults(this.requireModelsBundle(), (provider) => this.getApiKey(provider)),
			thinkingLevel: agent.state.thinkingLevel,
			previous: rt.lastCompaction,
			// The same resolved settings the context meter reads, so the bar and the
			// trigger cannot disagree about where the line is.
			settings: this.resolveCompaction(agent.state.model.contextWindow ?? model.contextWindow),
			signal,
			force,
		});

		// The conversation can move on while the summary is in flight: "New chat",
		// opening another session, and deleting the active one each build a fresh
		// agent through `replaceAgent`. Acting on this result then would assign the
		// old transcript back and append its summary into the *new* session's log.
		// Compacting between turns widens that window from milliseconds to seconds.
		if (rt.agent !== agent) {
			return false;
		}

		if (outcome.status === "failed") {
			// A cancelled compaction is not a failure worth a banner: pi reports the
			// abort through this same `failed` outcome (`CompactionError` with code
			// "aborted", which `retryAssistantCall` treats as terminal and never
			// retries), and a user who pressed stop is already being told the run
			// stopped.
			if (signal.aborted) {
				return false;
			}
			/*
			 * Reported on the row the attempt already occupies, not in the banner.
			 *
			 * It used to go to the notice channel, on the reasoning that a compaction
			 * sits between two turns and so has nothing in the transcript to anchor
			 * it to. It does now: the attempt draws its own row from the moment it
			 * starts, so the failure lands where the reader last saw it working —
			 * which is also what keeps a quiet, non-blocking failure out of the
			 * banner, where nothing that leaves the panel usable belongs (issue
			 * #239).
			 *
			 * The anchor is the running record's, so the row does not jump on its way
			 * from working to failed.
			 */
			rt.compactionEvent = {
				state: "failed",
				anchor: rt.compactionEvent?.anchor ?? agent.state.messages.length,
				error: outcome.message,
			};
			return false;
		}
		if (outcome.status === "skipped") {
			return false;
		}

		agent.state.messages = outcome.messages;
		rt.lastCompaction = outcome.result;
		this.recordOverheadUsage(rt, outcome.result.usage);
		await this.sessionManager.appendCompactionFor(rt.sessionPath, outcome.result, rt.activeLane);
		await this.refreshSessionInfo(rt);
		this.notify();
		return true;
	}

	/**
	 * Books usage from a request that produced no assistant message.
	 *
	 * Both summarization paths call this rather than pushing onto
	 * {@link overheadUsage} themselves, so "a billed request outside a turn must
	 * be counted" is enforced in one place instead of being re-derived at each
	 * call site. Absent usage is a no-op: a provider that reports none is normal,
	 * and it must not be booked as a zero-cost request in the count.
	 */
	private recordOverheadUsage(rt: SessionRuntime, usage: Usage | undefined): void {
		if (!usage) {
			return;
		}
		rt.overheadUsage = [...rt.overheadUsage, usage];
	}

	/**
	 * Compaction settings for one context window.
	 *
	 * The single place the user's configuration is turned into what pi acts on.
	 * Both readers go through it — the meter in {@link getSnapshot} and the
	 * trigger in {@link performCompaction} — because a second resolution site is
	 * how the bar and the threshold drift apart.
	 */
	private resolveCompaction(contextWindow: number): CompactionSettings {
		return resolveCompactionSettings(this.getSettings().compaction, contextWindow);
	}

	private requireModelsBundle(): ObsidianModelsBundle {
		// Rebuilt when a provider registration would differ, cached otherwise
		// since transports are stateless. The key covers provider id, base URL,
		// and protocol because each of those changes what gets registered; API
		// keys are excluded, as they are supplied per request.
		//
		// The legacy endpoint contributes both fields `isCustomEndpointActive`
		// reads. Keying on its `baseUrl` alone let a user who typed the URL
		// first and the model id second keep a bundle built while the endpoint
		// still counted as inactive — so `custom` was never registered.
		const settings = this.getSettings();
		const providerKey = settings.providers.map((provider) => `${provider.id}|${provider.baseUrl}|${provider.protocol}`).join(",");
		const legacyKey = `${settings.customEndpoint?.baseUrl ?? ""}|${settings.customEndpoint?.modelId ?? ""}`;
		const bundleKey = `${settings.networkTransport}:${providerKey}:${legacyKey}`;
		if (!this.modelsBundle || this.modelsBundleKey !== bundleKey) {
			this.modelsBundle = createObsidianModels({
				transport: settings.networkTransport,
				providers: settings.providers,
				customEndpoint: settings.customEndpoint,
			});
			this.modelsBundleKey = bundleKey;
		}
		return this.modelsBundle;
	}

	/**
	 * Stream function for ordinary turns, resolved per request.
	 *
	 * An earlier revision captured `createObsidianStreamFn(...)` once inside
	 * `replaceAgent`, which froze the provider registry at whatever the settings
	 * were when the agent was constructed. Configuring a custom endpoint
	 * afterwards updated `agent.state.model` to `provider: "custom"` through
	 * `refreshConfiguration`, but the captured `Models` instance had never
	 * registered that provider and could not learn about it — so every send
	 * failed with pi-ai's `Unknown provider: custom`.
	 *
	 * Routing through {@link requireModelsBundle} means both the turn path and
	 * the compaction path share one cache with one invalidation rule, so neither
	 * can go stale while the other stays fresh.
	 */
	private resolveStreamFn(): StreamFn {
		if (this.streamFn) {
			return this.streamFn;
		}
		return (model, context, streamOptions) => {
			const { models, fetch: fetchImpl } = this.requireModelsBundle();
			return models.streamSimple(model, context, { ...streamOptions, fetch: toFetchFunction(fetchImpl) });
		};
	}

	private async persistMessage(rt: SessionRuntime, message: AgentMessage): Promise<void> {
		const key = message as object;
		if (rt.messageEntryIds.has(key)) {
			return;
		}
		// The agent keeps `message` in `state.messages`; persisting it raw would
		// write base64 image bytes into the JSONL session log (bloat, and a
		// violation of issue #32), and mutating it in place to strip the image
		// would erase the picture from the live transcript the next provider
		// request reads. Sanitize to a deep copy with image blocks replaced by a
		// text placeholder; dedup still keys on the original object identity.
		const logged = sanitizeMessageForLog(message);
		try {
			rt.messageEntryIds.set(key, await this.sessionManager.appendMessageFor(rt.sessionPath, logged, rt.activeLane));
			rt.unpersistedMessages.delete(key);
		} catch (error) {
			// Marked here, where the identity is, so the transcript can put the
			// warning under the reply it is about rather than at the top of the panel
			// where it cannot say which one. Rethrown so the caller's own handling —
			// notably the run ledger staying open, which degrades to a spurious
			// recovery offer rather than to a lost reply — is unchanged.
			rt.unpersistedMessages.add(key);
			throw error;
		}
	}

	/**
	 * Reads `![[...]]` image embeds from the vault as `ImageContent`.
	 *
	 * Each path is resolved independently: a missing or unreadable image is
	 * skipped (never thrown) so one bad embed does not block the whole send, and a
	 * notice names it so the user knows what was dropped. Vault access stays on
	 * the service side of the existing boundary — the UI never touches the vault.
	 *
	 * Resolution is two-step, exact lookup first. `getFileByPath` answers the
	 * embeds that already carry a full vault path, and running it first means the
	 * link index below can only ever be asked about a lookup that already failed —
	 * an unready or stale index cannot demote a path the vault itself would have
	 * answered. What it *can* answer is the shortest-path embed `![[cat.png]]`
	 * written into a note whose image lives in an attachment folder: no folder in
	 * the reference, and the exact lookup only knows full paths.
	 */
	private async readVaultImages(
		rt: SessionRuntime,
		paths: readonly string[],
		sourcePath: string | null
	): Promise<ImageContent[]> {
		if (paths.length === 0) {
			return [];
		}
		const t = this.t();
		const images: ImageContent[] = [];
		for (const path of paths) {
			const file = this.app.vault.getFileByPath(path) ?? this.resolveLinkpathDest(path, sourcePath);
			if (!file) {
				// `appendNotice`, not `setNotice`: this runs once per embed, and
				// assigning meant three missing images reported as one — the last.
				this.appendNotice(rt, t.t("chat.imageNotFound", { path }));
				this.appendNotice(rt, t.t("chat.imageNotFound", { path }));
				continue;
			}
			try {
				const buffer = await this.app.vault.readBinary(file);
				// The MIME type reads off the file that was found, not the reference
				// that named it: the two carry the same extension for a full path, but
				// a shortest-path embed resolved through the index may spell the
				// folder differently and the file is what the bytes came from.
				images.push({ type: "image", data: arrayBufferToBase64(buffer), mimeType: mimeTypeForPath(file.path) });
			} catch {
				this.appendNotice(rt, t.t("chat.imageNotFound", { path }));
				this.appendNotice(rt, t.t("chat.imageNotFound", { path }));
			}
		}
		return images;
	}

	/**
	 * Resolves an embed reference the way Obsidian itself would, once the exact
	 * vault lookup has already missed.
	 *
	 * `parseLinktext` splits the reference into its linkpath and any heading or
	 * block subpath (an image embed has neither, but the split is the official
	 * entry point and costs nothing), and `getFirstLinkpathDest` asks the
	 * metadata cache for the file that linkpath best resolves to from
	 * `sourcePath` — the active note the embed was written in, so a name shared
	 * by several files resolves the way the note's own links do. That cache also
	 * knows the shortest-path and frontmatter-alias forms `getFileByPath` cannot
	 * see, which is exactly the embed shape the exact lookup misses.
	 *
	 * `null` — no note open, an index still building, or a genuinely broken link —
	 * is a plain miss: `readVaultImages` reports it like any other unresolvable
	 * embed, never as an error.
	 */
	private resolveLinkpathDest(path: string, sourcePath: string | null): TFile | null {
		const linkpath = parseLinktext(path).path;
		return this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath ?? "");
	}

	private getSessionDefaults(): SessionDefaults {
		const model = getSelectedModel(this.getSettings());
		return {
			provider: model.provider,
			modelId: model.id,
		};
	}

	private getApiKey(provider: string): string | undefined {
		return getApiKeyForProvider(this.getSettings(), provider);
	}

	private hasApiKey(): boolean {
		return !!getConfiguredApiKey(this.getSettings());
	}

	private requireAgent(): Agent {
		if (!this.agent) {
			throw new Error("Agent is not initialized.");
		}
		return this.agent;
	}

	/**
	 * The agent's own error, unless the user dismissed that exact message — or
	 * unless the transcript already reports it where it happened.
	 *
	 * pi reports both an abort and a provider failure through the same field: the
	 * stream throws, the API layer stamps the partial message with a stop reason
	 * plus the thrown text, and `turn_end` copies that text into
	 * `state.errorMessage`. Neither belongs in the banner — an abort is something
	 * the user just asked for, and a provider failure belongs to one turn and
	 * outlives this field — so both are filtered here rather than reworded, and
	 * `replyCutoff.ts` reports them under the reply they ended.
	 *
	 * What is left for the banner is the class that has no turn to sit under: a
	 * failure raised before anything departed, or one whose markers disagree.
	 * See {@link isReportedInTranscript}.
	 */
	private visibleAgentError(rt: SessionRuntime | null, agent: Agent | null): string | undefined {
		const agentError = agent?.state.errorMessage;
		if (!agentError || !rt || agentError === rt.dismissedAgentError) {
			return undefined;
		}
		return isReportedInTranscript(agent, agentError) ? undefined : agentError;
	}

	/**
	 * Records a dispatch failure in the banner, unless the transcript has it.
	 *
	 * A run that dies mid-request ends with pi stamping a failed assistant turn
	 * onto the transcript; the same failure already sits under that turn via
	 * `describeReplyCutoff`. Reporting it here as well pinned one timeout twice —
	 * once under the reply, once above the conversation — which is the duplication
	 * #239 exists to end.
	 *
	 * The guard is two gates, both of which must hold before the banner stays
	 * quiet. The identity gate asks whether the failed tail *grew during this
	 * dispatch*: `tailBefore` is the last assistant turn captured as the first
	 * statement inside each dispatch's `try` — before the notify and the
	 * compaction, both of which can throw — so a tail that was already failed
	 * before the block began (the previous turn's timeout, still on screen)
	 * cannot shadow a throw raised before anything new was appended. The text
	 * gate then asks whether the tail reports *this failure*: when the throw is
	 * pi re-stamping an error a failed turn already carries, compaction may have
	 * rebuilt the tail as a fresh object in between, and identity alone would
	 * then swallow the old turn's report as if it were new. Both gates are read
	 * off `state.messages`; a throw that leaves no failed assistant turn behind
	 * has nowhere else to be seen and always reaches the banner.
	 */
	private reportDispatchFailure(rt: SessionRuntime, error: unknown, tailBefore: AgentMessage | undefined): void {
		const message = error instanceof Error ? error.message : String(error);
		const lastAssistant = lastAssistantTurn(rt.agent?.state.messages ?? []);
		if (
			lastAssistant?.role === "assistant" &&
			lastAssistant.stopReason === "error" &&
			lastAssistant !== tailBefore &&
			lastAssistant.errorMessage === message
		) {
			return;
		}
		rt.panelError = { message, opensSettings: false };
	}

	private setError(rt: SessionRuntime, message: string, opensSettings = false): void {
		rt.panelError = { message, opensSettings };
		rt.dismissedAgentError = undefined;
		this.notify();
	}

	/**
	 * Reports the outcome of a control the reader just pressed.
	 *
	 * The third channel, and the rule that picks between the three: a message that
	 * belongs to one *turn* goes in the transcript (`replyCutoff.ts`), one that
	 * describes a standing state of the *panel* goes in the banner, and one that is
	 * the outcome of a *command* goes here. A command outcome touches nothing in
	 * the conversation — the transcript on screen is still the one it was — so
	 * pinning it above that conversation misattributes the damage, and it has no
	 * reason to outlive the moment it is read.
	 *
	 * `new Notice` rather than a channel of this panel's own: it is what Obsidian
	 * users already expect from a command that failed, and what `ReplyActions`
	 * already uses for the analogous vault-write failure.
	 */
	private toast(key: Parameters<Translator["t"]>[0], cause: unknown): void {
		new Notice(this.t().t(key, { error: cause instanceof Error ? cause.message : String(cause) }));
	}

	/** Reports a non-failure outcome without raising the error banner's alert. */
	private setNotice(rt: SessionRuntime, message: string): void {
		rt.noticeMessage = message;
		this.notify();
	}

	/** Adds a second non-failure message without hiding an earlier loader warning. */
	private appendNotice(rt: SessionRuntime, message: string): void {
		rt.noticeMessage = rt.noticeMessage ? `${rt.noticeMessage}\n${message}` : message;
		this.notify();
	}

	/**
	 * Publishes the post-run state and refreshes the session summary.
	 *
	 * Best-effort by design, and the guard lives here rather than at each call
	 * site because every one of those sites has already finished its real work:
	 * a run was delivered, aborted, or compacted. A settle-time failure —
	 * `refreshSessionInfo` reading a broken session file, say — must not reject
	 * the operation that succeeded, or the composer hands words back for a
	 * message that already went out (issue #253's shadow path: `sent` flipped
	 * to a rejection after the run completed). The failure is logged, the panel
	 * still settles, and the summary simply stays stale until the next refresh.
	 */
	private async notifySettledState(rt: SessionRuntime): Promise<void> {
		// First, not last: the flush's own notify rides the reconfigure, and a
		// change applied after this call's notify would leave the panel showing
		// the pre-flush snapshot until the next unrelated event.
		//
		// Both halves carry #253's settle contract: every caller has already
		// finished its real work, so a failure here must not reject the
		// operation that succeeded. A failed flush has already spent the hold
		// (take-then-apply); the next idle-path reconfigure is the self-heal.
		try {
			await this.flushPendingConfiguration(rt);
		} catch (error) {
			this.log.error("Failed to apply the pending configuration after settling a run", () => ({ error: String(error) }));
		}
		try {
			await this.refreshSessionInfo(rt);
		} catch (error) {
			this.log.error("Failed to refresh session info after settling a run", () => ({ error: String(error) }));
		}
		this.notify();
	}

	/**
	 * Re-reads the session summary for the panel. Only the focused session's read
	 * is allowed to move the snapshot's `sessionInfo` — a background runtime's
	 * append must not overwrite what the user is looking at — but the runtime's
	 * own copy is kept current either way so a later switch shows fresh data.
	 */
	private async refreshSessionInfo(rt: SessionRuntime): Promise<void> {
		// The manager summarises the active path only. A background runtime keeps
		// its cached summary until focus makes it readable again — `openSession`
		// re-reads it on the way in — and must never overwrite the snapshot's
		// `sessionInfo` with its own stale copy.
		if (rt.sessionPath !== this.sessionManager.getActiveSessionPath()) {
			return;
		}
		const info = await this.sessionManager.getActiveSessionInfo();
		rt.sessionInfo = info;
		this.sessionInfo = info;
	}

	private notify(): void {
		const snapshot = this.getSnapshot();
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}
}
