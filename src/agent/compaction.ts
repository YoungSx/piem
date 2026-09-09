import {
	compact,
	createCompactionSummaryMessage,
	estimateContextTokens,
	prepareCompaction,
	shouldCompact,
	type AgentMessage,
	type CompactResult,
	type Entry,
	type MessageEntry,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models, RetryPolicy } from "@earendil-works/pi-ai";
import { DEFAULT_COMPACTION_SETTINGS, type CompactionSettings } from "./compactionSettings";
import { retainSkillContext } from "./skillContext";

export { DEFAULT_COMPACTION_SETTINGS, type CompactionSettings, type CompactResult };

/**
 * Retry budget for the summarization request.
 *
 * Compaction is the one request the user never asked for: it fires on the way
 * to sending a prompt, and when it fails the prompt goes out against a context
 * that is already known not to fit. A single 429 or dropped connection
 * therefore costs the whole turn, which makes this the request most worth
 * retrying and the one where a few seconds of backoff are least noticeable.
 *
 * pi's own loop (`retryAssistantCall`, reached through `compact`) classifies
 * which failures are transient and leaves deterministic ones — bad key, quota
 * exhausted — to fail fast, so a bounded budget here cannot turn a
 * misconfiguration into a long stall.
 */
export const DEFAULT_COMPACTION_RETRY: RetryPolicy = {
	enabled: true,
	maxRetries: 2,
	baseDelayMs: 1_000,
};

/**
 * A tidying attempt as the transcript sees it.
 *
 * The panel draws one row for the whole lifecycle — running, then either the
 * summary it produced or the failure it hit — the way a tool call and its result
 * share one row. That row needs two things the {@link CompactionOutcome} cannot
 * carry: where in the transcript the attempt happened, and a failure that has no
 * message of its own to hang on.
 *
 * `anchor` is the transcript length when the attempt started, so the row stays
 * at the point in time it belongs to instead of floating to the tail as the run
 * appends past it. A success needs no event at all: pi's summary message *is*
 * the record, and {@link toCompactedMessages} puts it where the cut happened.
 */
export interface CompactionEvent {
	state: "running" | "failed";
	anchor: number;
	/** Why it failed, verbatim from the provider. Absent while running. */
	error?: string;
}

/** Outcome of a compaction attempt. */
export type CompactionOutcome =
	| { status: "skipped" }
	| { status: "compacted"; messages: AgentMessage[]; result: CompactResult }
	| { status: "failed"; message: string };

export interface CompactionRequest {
	messages: AgentMessage[];
	model: Model<Api>;
	models: Models;
	thinkingLevel: ThinkingLevel;
	/** Result of the previous compaction, so summaries are updated instead of rebuilt. */
	previous?: CompactResult;
	/**
	 * Resolved compaction configuration. Optional so the tests that only
	 * exercise the wrapper's plumbing need not build one; every production
	 * caller passes the same resolved settings the context meter reads.
	 */
	settings?: CompactionSettings;
	signal?: AbortSignal;
	/** Retry budget for the summarization request; {@link DEFAULT_COMPACTION_RETRY} when unset. */
	retry?: RetryPolicy;
	/**
	 * Summarize even when the context still fits, for the manual "compact now"
	 * command. The cut point and retention budget stay pi's own — forcing only
	 * skips the threshold check, it never re-summarizes more than
	 * `keepRecentTokens` leaves behind.
	 */
	force?: boolean;
}

/**
 * Whether pi would compact this context right now.
 *
 * Exported so a caller that must announce a compaction *before* launching it —
 * the between-turns hook raises `isCompacting`, which the composer renders —
 * asks the same question {@link compactIfNeeded} asks itself. Asking a
 * different one would flash the compaction banner at turn boundaries that then
 * skip.
 */
export function needsCompaction(
	messages: AgentMessage[],
	model: Model<Api>,
	settings: CompactionSettings = DEFAULT_COMPACTION_SETTINGS,
): boolean {
	return shouldCompact(estimateContextTokens(messages).tokens, model.contextWindow, settings);
}

/**
 * Summarizes older history when the context is close to the model's window.
 *
 * pi owns every decision here — when to compact ({@link shouldCompact}), where
 * to cut ({@link prepareCompaction}), and how to summarize ({@link compact}).
 * This wrapper projects messages into the harness `Entry` shape and restores
 * already-loaded skill instructions in the retained tail before persistence.
 */
export async function compactIfNeeded(request: CompactionRequest): Promise<CompactionOutcome> {
	const settings = request.settings ?? DEFAULT_COMPACTION_SETTINGS;
	if (!request.force && !needsCompaction(request.messages, request.model, settings)) {
		return { status: "skipped" };
	}

	const prepared = prepareCompaction(toHarnessEntries(request.messages, request.previous), settings);
	if (!prepared.ok) {
		return { status: "failed", message: prepared.error.message };
	}
	// `undefined` is a success meaning "nothing left to compact", not an error.
	if (!prepared.value) {
		return { status: "skipped" };
	}

	// `compact` returns a Result for its own validation failures, but a provider
	// error propagates as a thrown exception, so both paths need handling.
	let compacted;
	try {
		compacted = await compact(
			prepared.value,
			request.models,
			request.model,
			undefined,
			request.signal,
			request.thinkingLevel,
			request.retry ?? DEFAULT_COMPACTION_RETRY,
		);
	} catch (error) {
		return { status: "failed", message: error instanceof Error ? error.message : String(error) };
	}
	if (!compacted.ok) {
		return { status: "failed", message: compacted.error.message };
	}

	const result = { ...compacted.value, retainedTail: retainSkillContext(request.messages, compacted.value.retainedTail) };
	return {
		status: "compacted",
		messages: toCompactedMessages(result),
		result,
	};
}

/**
 * Builds the message list that replaces the transcript after compaction.
 *
 * The summary must be a `compactionSummary` message so pi's `convertToLlm`
 * renders it into the request. The agent's default converter drops that role
 * silently, which is why {@link ObsidianAgentService} passes pi's converter in.
 */
export function toCompactedMessages(result: CompactResult): AgentMessage[] {
	return [createCompactionSummaryMessage(result.summary, result.tokensBefore, Date.now()), ...result.retainedTail];
}

/**
 * Projects plugin messages into throwaway harness entries.
 *
 * pi's compaction functions read only `type`, `message`, and a previous
 * compaction's summary/retainedTail, so ids and sequence numbers exist purely
 * to satisfy the shape — they are never compared or sorted. Passing the prior
 * result as a real compaction entry is what lets pi update the existing summary
 * rather than re-summarizing its own output.
 */
function toHarnessEntries(messages: AgentMessage[], previous?: CompactResult): Entry[] {
	if (!previous) {
		return messages.map((message, index) => toMessageEntry(message, index));
	}

	const compaction: Entry = {
		type: "compaction",
		id: "compaction-0",
		seq: 0,
		parentId: null,
		timestamp: Date.now(),
		summary: previous.summary,
		tokensBefore: previous.tokensBefore,
		retainedTail: previous.retainedTail,
		...(previous.details === undefined ? {} : { details: previous.details }),
		...(previous.usage === undefined ? {} : { usage: previous.usage }),
	};
	const remaining = dropRetainedPrefix(messages, previous.retainedTail);
	return [compaction, ...remaining.map((message, index) => toMessageEntry(message, index, compaction.id))];
}

/**
 * Drops the prefix the compaction entry already carries.
 *
 * A compacted transcript *is* `[summary, ...retainedTail]`, and pi
 * re-materializes the tail from the entry itself (`prepareCompaction`, its
 * `virtualRetainedEntries`). Listing those messages again as entries made pi
 * see each of them twice, so the next compaction's own `retainedTail` — and the
 * JSONL line {@link ObsidianSessionManager.appendCompaction} writes from it —
 * came back with every message duplicated.
 *
 * Matched by identity rather than by length: `prepareCompaction` pushes
 * `entry.message` into the tail, so a live tail holds the very objects the
 * transcript holds, and a reloaded one shares the parsed array. Identity also
 * stops a transcript a retry has truncated from losing real messages to a
 * count that no longer describes it.
 */
function dropRetainedPrefix(messages: AgentMessage[], retainedTail: AgentMessage[]): AgentMessage[] {
	const afterSummary = messages[0]?.role === "compactionSummary" ? messages.slice(1) : messages;
	let matched = 0;
	while (matched < retainedTail.length && afterSummary[matched] === retainedTail[matched]) {
		matched += 1;
	}
	return afterSummary.slice(matched);
}

function toMessageEntry(message: AgentMessage, index: number, parentId: string | null = null): MessageEntry {
	return {
		type: "message",
		id: `message-${index}`,
		seq: index + 1,
		parentId: index === 0 ? parentId : `message-${index - 1}`,
		timestamp: message.timestamp,
		message,
	};
}
