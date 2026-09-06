import {
	Agent,
	calculateContextTokens,
	convertToLlm,
	shouldCompact,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type ShouldStopAfterTurnContext,
	type Skill,
	type StreamFn,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { isContextOverflow, type Model } from "@earendil-works/pi-ai";
import type { Models, Usage } from "@earendil-works/pi-ai";
import { compactIfNeeded, DEFAULT_COMPACTION_SETTINGS, needsCompaction, type CompactResult } from "../agent/compaction";
import type { CompactionSettings } from "../agent/compactionSettings";
import { sumUsage, type UsageTotals } from "../agent/usage";
import { composeSystemPrompt } from "../agent/skillLoader";
import { throwIfAborted } from "../tools/toolResult";
import { composeSubagentPrompt, type SubagentRole } from "./roles";

export interface SubagentRunOptions {
	task: string;
	role: SubagentRole;
	/** Caller-supplied standing framing, appended after the role appendix. */
	instructions?: string;
	tools: AgentTool[];
	model: Model<string>;
	streamFn: StreamFn;
	thinkingLevel: ThinkingLevel;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/**
	 * Skills listed in the subagent's system prompt, mirroring the parent's
	 * `<available_skills>` block; `read_skill` then resolves a full skill body.
	 * Omitted for tests — an empty list renders the base prompt untouched.
	 */
	skills?: readonly Skill[];
	/**
	 * The provider registry compaction summarizes through.
	 *
	 * Absent means no compaction: a run that fills its window then dies with a
	 * context-overflow report, which is what every child did before this existed.
	 * It arrives as a value rather than being built here because `Models` is a
	 * pi-ai type but the Obsidian transport baked into it is not — the host
	 * assembles it, the same way `streamFn` already crosses that seam.
	 */
	models?: Models;
	/**
	 * The user's resolved compaction settings. Omitted falls back to pi's
	 * defaults, which is the honest choice for a child when the host has no
	 * opinion to pass on.
	 */
	compactionSettings?: CompactionSettings;
	/**
	 * Context to continue from, for an errand handed to a child that already ran.
	 *
	 * Absent starts the child empty, which is every spawn. Present is a follow-up:
	 * the transcript is seeded, the new task lands after it as the next thing said,
	 * and the child answers with everything it already worked out still in view.
	 * Repaired on the way in — see {@link resumableTranscript} — because a run that
	 * died mid-turn is not a transcript any provider will accept another message
	 * after.
	 */
	initialMessages?: readonly AgentMessage[];
	/** The parent run's signal; aborting it aborts the subagent immediately. */
	signal?: AbortSignal;
	/** Escape hatch for tests and logging; the runner itself stays event-blind. */
	onEvent?: (event: AgentEvent) => void;
}

export interface SubagentRunResult {
	/** The subagent's final report: the text of its last assistant message. */
	text: string;
	/** Assistant turns the subagent took, for the parent's tool-result details. */
	turns: number;
	usage: UsageTotals;
	/**
	 * Why a report is less than the whole answer, when it is.
	 *
	 * A run cut short still holds whatever the child had already written, and
	 * throwing that away is the one thing none of the peer implementations do —
	 * a long sweep stopped one step from the end has findings worth reading.
	 * Absent on a run that finished on its own, so the common case carries no
	 * field the parent has to interpret.
	 *
	 * A flag, not a reason: every stop is now somebody's decision, and the
	 * registry records whose in `killedBy`. Naming a cause here too would give
	 * two fields one job and let them disagree.
	 */
	incomplete?: true;
	/**
	 * The child's full context when the run ended, seeded history included.
	 *
	 * The wait tool never needed this — the report text is its whole answer — but
	 * the inspector shows the process, and a transcript read from the entry after
	 * settlement is the only way to show it without streaming plumbing through
	 * every turn. It is also what a later errand continues from, which is why it is
	 * the *whole* context and not this run's share of it: everything above is the
	 * child's memory. Session memory only, never written to disk, and bounded by
	 * the same lifetime the entry already has: it dies with the service.
	 */
	messages: readonly AgentMessage[];
}

/**
 * A run-ending failure that still carries the transcript the child died holding.
 *
 * The transcript is the whole reason this type exists. A failed run's messages
 * are what another errand resumes from — the network-interruption case
 * `follow_up_subagent` was added for — and what the panel's process record shows
 * instead of claiming nothing was recorded. Before this, every failure path threw
 * a bare `Error` and the messages went out of scope with the stack frame.
 *
 * Every failure the runner raises travels as one of these, including the wrapped
 * ones: a path that threw something else would be a path where a resume silently
 * starts the child over, and that is exactly the failure mode this is here to
 * prevent.
 */
export class SubagentRunError extends Error {
	/** The child's context when the run died; empty when it died before its first turn. */
	readonly messages: readonly AgentMessage[];

	constructor(message: string, messages: readonly AgentMessage[]) {
		super(message);
		this.name = "SubagentRunError";
		this.messages = messages;
	}
}

/**
 * The longest prefix of a transcript another message may be appended to.
 *
 * A run that broke partway — the case a follow-up exists for — can leave tool
 * calls nothing ever answered: the provider stream reports an error before the
 * loop executes them, so the assistant message asking for them is the last thing
 * in the transcript. Every provider rejects that. Anthropic requires a
 * `tool_result` for every `tool_use`, and OpenAI the matching `tool` messages, so
 * seeding one back verbatim would turn a resumable child into a 400.
 *
 * Unanswered calls are dropped block by block rather than by the message, so the
 * text and thinking a killed sweep had already written ("Found two so far…") stay
 * as context. A message left with nothing in it goes: an aborted turn that wrote
 * no blocks at all is a message some providers reject for being empty, and none
 * of them learn anything from.
 */
export function resumableTranscript(messages: readonly AgentMessage[]): AgentMessage[] {
	const answered = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") {
			answered.add(message.toolCallId);
		}
	}
	const kept: AgentMessage[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") {
			kept.push(message);
			continue;
		}
		const content = message.content.filter((block) => block.type !== "toolCall" || answered.has(block.id));
		if (content.length === 0) {
			continue;
		}
		kept.push(content.length === message.content.length ? message : { ...message, content });
	}
	return kept;
}

export interface LinkedSignals {
	signal: AbortSignal;
	/** Fires the controller; how external callers kill the linked run. */
	abort: () => void;
	/** Must be called in a finally; drops the parent listener. */
	dispose: () => void;
}

/**
 * Re-exposes the parent's signal as a controller this side can also fire.
 *
 * A run ends only when this controller fires or the model stops on its own. The
 * caller must still call `dispose` in a finally even on success: the listener on
 * the parent otherwise outlives the run, and a long-lived parent signal would
 * accumulate one per child it ever started.
 */
export function linkSignals(parent: AbortSignal | undefined): LinkedSignals {
	const controller = new AbortController();

	// `AbortSignal.any` would say this in one line but postdates the WebView
	// versions `minAppVersion` admits — the same reason the agent service
	// hand-rolls its signal linking.
	const forwardAbort = (): void => controller.abort();
	if (parent?.aborted) {
		forwardAbort();
	} else {
		parent?.addEventListener("abort", forwardAbort, { once: true });
	}

	return {
		signal: controller.signal,
		abort: () => controller.abort(),
		dispose: () => {
			parent?.removeEventListener("abort", forwardAbort);
		},
	};
}

function extractAssistantText(message: AgentMessage | undefined): string {
	// An assistant message's content is always a block array (pi-ai types it so);
	// the text of the final one is the whole deliverable.
	if (!message || message.role !== "assistant") {
		return "";
	}
	return textOfBlocks(message.content);
}

/** The last failed tool result's `toolName: text`, or undefined when none errored. */
function lastToolError(messages: readonly AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role === "toolResult" && message.isError) {
			return `${message.toolName}: ${textOfBlocks(message.content)}`;
		}
	}
	return undefined;
}

/**
 * A run-ending failure in words the parent can act on.
 *
 * The provider's own overflow message ("prompt is too long: 213000 tokens >
 * 200000 maximum") is technically complete and practically useless to a parent
 * deciding what to do next, because it does not say the child ran out of room
 * rather than hitting a bad request. pi ships the detector — `isContextOverflow`
 * knows ~25 provider phrasings and excludes the ones that merely look like
 * overflow — and nothing was using it. The child has no compaction, so this is
 * the difference between a diagnosable ceiling and an opaque death.
 */
function describeFailure(
	failure: string,
	lastAssistant: AgentMessage | undefined,
	model: Model<string>,
	turns: number,
): string {
	if (lastAssistant?.role !== "assistant" || !isContextOverflow(lastAssistant, model.contextWindow)) {
		return failure;
	}
	return `ran out of context after ${turns} ${turns === 1 ? "turn" : "turns"} — the task is too large for one subagent. Narrow it, or split it across several spawns. (${failure})`;
}

/**
 * The text blocks of an assistant or tool-result message, joined.
 *
 * Both message kinds carry the same `{type, ...}` block array; image blocks
 * simply contribute nothing.
 */
function textOfBlocks(content: ReadonlyArray<{ type: string; text?: string }>): string {
	return content
		.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
		.join("\n")
		.trim();
}

/**
 * Runs one delegated task on an isolated in-memory `Agent`.
 *
 * The child shares the parent's model, transport, and API-key resolution but
 * nothing else: its transcript is never persisted and dies with this call. It
 * starts empty on a spawn, and from the child's own earlier context when a
 * follow-up errand hands one over.
 *
 * The run has no deadline. A child that is still working is nobody's emergency,
 * and from out here a thorough sweep and a wedged one are the same silence — so
 * a wall-clock cap can only ever cut off honest work. What bounds a forgotten
 * child is ownership, not time: the parent's signal kills it, `kill_subagent`
 * kills it, and `disposeAll` kills every live child when the service or plugin
 * tears down.
 */
export async function runSubagent(options: SubagentRunOptions): Promise<SubagentRunResult> {
	const { task, role, tools, model, streamFn, thinkingLevel } = options;
	// Repaired here rather than at the call site: a caller that forgot would hand
	// the provider a transcript with unanswered tool calls in it, which fails as a
	// 400 nobody would read as "the seed was malformed".
	const seeded = resumableTranscript(options.initialMessages ?? []);
	const linked = linkSignals(options.signal);
	// Compaction bookkeeping, run-local because the run is one function call: the
	// parent needs fields on a service for the same state because its run outlives
	// any single method.
	let lastCompaction: CompactResult | undefined;
	const compactionUsage: Usage[] = [];
	// Set by the hook below when it ends the run for a tidy; consumed by the
	// tidy-continue loop after `prompt`, which clears it before acting so a stale
	// claim cannot outlive its run.
	let compactionPending = false;
	/**
	 * The futility latch — the replacement for the old `SUBAGENT_MAX_COMPACTIONS`
	 * counter, same three states as the parent's {@link SessionRuntime
	 * .compactionGate}: `null` judges every boundary normally, `"awaiting"` holds
	 * from a tidy attempt until the first reply whose `usage` describes the
	 * compacted context, and `"futile"` means that floor reading still sits over
	 * the line, so no summary can shrink this context and the hook stops ending
	 * the run for compaction entirely.
	 *
	 * A child needs the latch more than the parent does, not less: nobody is
	 * watching it, and a run has no deadline, so a futile loop would bill until
	 * someone noticed rather than until a clock ran out.
	 */
	let compactionGate: "awaiting" | "futile" | null = null;
	/**
	 * Whether the run should end at this turn boundary so a tidy can happen
	 * outside it. The parent's {@link shouldStopForCompaction} makes the same
	 * decision with the same reasoning; this one keeps the state local.
	 */
	const shouldStopForCompaction = (
		turn: ShouldStopAfterTurnContext,
		signal?: AbortSignal,
	): boolean => {
		// A run already dead must not be ended for a summary it will never use.
		if (signal?.aborted || linked.signal.aborted) {
			return false;
		}
		// No tool results means nothing to continue from: `continue()` requires a
		// user or tool-result tail, and pi's inner loop only runs on further tool
		// calls anyway, so there is nothing to tidy for.
		if (!options.models || turn.toolResults.length === 0) {
			return false;
		}
		const settings = options.compactionSettings ?? DEFAULT_COMPACTION_SETTINGS;
		if (compactionGate === "futile") {
			// The compacted context's floor is over the line: summaries cannot
			// shrink it, so the run never stops for compaction again — until a
			// new tidy attempt sets `"awaiting"` and re-asks the question.
			return false;
		}
		if (compactionGate === "awaiting") {
			// Consumed here: this turn's reply is the first post-tidy request whose
			// `usage` names the context as it now stands, so the gate's question is
			// answered once. If that floor is already over the line, another
			// summary cannot save the run — the provider gets the context-overflow
			// report and the salvage path decides what to keep. A reply without
			// usage keeps the latch in `"awaiting"`: there is still no reading,
			// and the estimate alone would re-derive the stale pre-compaction
			// total the latch exists to refuse.
			const usage = turn.message.usage;
			const floor = usage === undefined ? undefined : calculateContextTokens(usage);
			if (floor !== undefined && shouldCompact(floor, model.contextWindow, settings)) {
				compactionGate = "futile";
				return false;
			}
			compactionGate = null;
		}
		if (!needsCompaction(agent.state.messages, model, settings)) {
			return false;
		}
		compactionPending = true;
		return true;
	};

	const agent = new Agent({
		streamFn,
		convertToLlm,
		initialState: {
			// Same composition the parent uses, so the child sees the skill listing
			// its `read_skill` tool serves; without it that tool points at a list
			// the model was never shown.
			systemPrompt: composeSystemPrompt(composeSubagentPrompt(role, options.instructions), options.skills ?? []),
			model,
			thinkingLevel,
			tools,
			// Copied because pi's setter copies the top-level array anyway and the
			// seed belongs to the entry that lent it; element identity is preserved,
			// which is what the `produced` split below relies on.
			messages: [...seeded],
		},
		getApiKey: options.getApiKey,
		toolExecution: "sequential",
		// Unlike the parent — which uses this hook to end the run on any tool
		// error to protect the panel — the child feeds the error back and only
		// stops when the run itself is dead. The abort half is still load-bearing:
		// pi's loop never re-checks its signal between turns, so a completed
		// request followed by tool results would run on forever and a kill would
		// never land. `linked.signal` is the run's only abort source (parent
		// abort, `kill_subagent`, and teardown all fire it, and its listener is
		// what calls `agent.abort()`), so reading it here is the between-turns
		// abort check the loop lacks. The compaction half is pi's README pattern:
		// end the run at a tool-result boundary instead of swapping its context
		// underneath it; the loop after `prompt` tidies outside the run and
		// `continue()`s back in.
		shouldStopAfterTurn: (context, signal) => {
			if (linked.signal.aborted) {
				return true;
			}
			return shouldStopForCompaction(context, signal);
		},
	});
	if (options.onEvent) {
		const onEvent = options.onEvent;
		agent.subscribe((event) => {
			onEvent(event);
		});
	}

	// The linked controller above is the subagent's real kill switch: pi's
	// `Agent` takes no signal of its own, so every kill — parent abort,
	// `kill_subagent`, teardown — reaches the run through `agent.abort()`, the
	// same path the chat panel uses.
	const stopAgent = (): void => agent.abort();
	linked.signal.addEventListener("abort", stopAgent, { once: true });

	try {
		// An already-aborted controller never fires the listener above, so the
		// pre-prompt check is what keeps a race from launching a doomed run.
		throwIfAborted(linked.signal);
		await agent.prompt(task);
		// pi's README pattern, second half: each run the hook ended for a tidy
		// gets summarized outside any run and continued back in from the
		// tool-result tail that ended it. Looping rather than running once, so a
		// continuation that crosses the line again gets the same treatment; the
		// futility gate in the hook is what bounds the loop, and the parent's
		// bargain holds here too — a tidy that fails does not block the resume,
		// the provider decides whether the context fits. A kill between the stop
		// and the resume skips both.
		while (compactionPending && !linked.signal.aborted) {
			compactionPending = false;
			const models = options.models;
			// Mirrors the hook's precondition; asserted non-null by it, but the
			// loop body must not lean on a hook that may never have run.
			if (models) {
				const outcome = await compactIfNeeded({
					messages: agent.state.messages,
					model,
					models,
					thinkingLevel,
					previous: lastCompaction,
					settings: options.compactionSettings,
					signal: linked.signal,
				});
				// The attempt itself — failed ones included, since a failed tidy
				// is still an attempt — lifts a `"futile"` latch back to
				// `"awaiting"`; a skipped tidy changed nothing and is not an
				// attempt, and an aborted one was called off by the kill, whose
				// listener already broke out of the loop.
				if (outcome.status !== "skipped" && !linked.signal.aborted) {
					compactionGate = "awaiting";
				}
				if (outcome.status === "compacted") {
					lastCompaction = outcome.result;
					// The summarization request produces no transcript message, so
					// `sumUsage` cannot find what it cost; recorded here or not at
					// all. pi types the usage optional — a provider that reported
					// none simply contributes nothing rather than an entry of
					// zeroes, which would inflate the request count.
					if (outcome.result.usage) {
						compactionUsage.push(outcome.result.usage);
					}
					agent.state.messages = outcome.messages;
				}
			}
			// Whatever the tidy's outcome, the reply that follows is the first
			// whose `usage` describes the context as it now stands — which is
			// exactly what the `"awaiting"` latch set above asks the hook to
			// wait for.
			await agent.continue();
		}
	} catch (error) {
		// An abort is not a failure to report — the salvage path below decides
		// whether the run left anything worth handing back. Anything else is a real
		// fault, and travels on under its own words rather than its own type: what
		// a later reader and a later resume both need is the transcript, and pi's
		// `StreamFn` contract keeps genuine exceptions off this path anyway
		// (provider failures arrive as a `stopReason: "error"` turn, below). The
		// tidy-continue loop shares this path: a `continue()` that throws comes
		// here under the same words.
		if (!linked.signal.aborted) {
			throw new SubagentRunError(error instanceof Error ? error.message : String(error), agent.state.messages);
		}
	} finally {
		// On the happy path the signal never fires, so the listener must come
		// down with the rest of the wiring or it outlives the run.
		linked.signal.removeEventListener("abort", stopAgent);
		linked.dispose();
	}

	const messages = agent.state.messages;
	// Accounting and the report come from what *this* errand produced; the
	// transcript handed back is the child's whole context. Membership rather than
	// an index, because a mid-run compaction rewrites the prefix: `slice` would
	// read a summary as seeded history and a retained turn as new work, and the
	// numbers a follow-up reported would include the errand before it.
	const seededMessages = new Set<AgentMessage>(seeded);
	const produced = messages.filter((message) => !seededMessages.has(message));
	const lastAssistant = [...produced].reverse().find((message) => message.role === "assistant");
	const accounting = {
		turns: produced.filter((message) => message.role === "assistant").length,
		// Compaction requests are billed but leave no message behind, so they ride
		// the extras channel `sumUsage` takes for exactly this.
		usage: sumUsage(produced, compactionUsage),
	};

	// pi resolves `prompt` — rather than rejecting — when a run ends aborted, so
	// the killed-run case is settled here rather than in the catch above.
	if (linked.signal.aborted) {
		// Whatever the child had already written is the point of salvaging: a
		// long sweep stopped one step from the end holds most of its findings.
		// The strict "a tool-call message is not a report" rule is relaxed for
		// exactly this case — there is no final report to prefer over prefatory
		// text, so the alternative to imperfect text is no text at all. The
		// `incomplete` flag is what stops the parent reading it as the answer.
		const salvaged = extractAssistantText(lastAssistant);
		if (!salvaged) {
			throw new SubagentRunError("Subagent aborted", messages);
		}
		return { text: salvaged, ...accounting, messages, incomplete: true };
	}

	// A message that requested tools has no report in it — even when it also
	// carries prefatory text ("Let me search for that…"), which is exactly the
	// wrong thing to hand the parent as a deliverable.
	const reportReady = lastAssistant !== undefined && lastAssistant.stopReason !== "toolUse";
	const text = reportReady ? extractAssistantText(lastAssistant) : "";
	if (!text) {
		// A failing tool that ended the run is a failure; a child that swept the
		// vault, found nothing, and said so briefly is not. Conflating them
		// leaves the parent unable to tell "no matches" from "the run broke", so
		// only a recorded error raises here — the empty-but-clean run returns as
		// itself and the wait tool words it as "no report".
		// Scoped to this errand as well: an old failed tool result still sitting in
		// the seeded history would be reported as this run's cause of death.
		const failure = lastToolError(produced) ?? agent.state.errorMessage;
		if (failure) {
			throw new SubagentRunError(`Subagent failed: ${describeFailure(failure, lastAssistant, model, accounting.turns)}`, messages);
		}
		return { text: "", ...accounting, messages };
	}
	return { text, ...accounting, messages };
}
