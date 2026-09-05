import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { Translator } from "../i18n";
import { ASK_USER_TOOL } from "./askUserRecord";
import { categorizeTool, type ToolCategory } from "./toolCatalog";
import { EMPTY_TOOL_PAIR_PLAN, pairedResult, resultIsPaired, type ToolPairPlan } from "./toolPair";
import type { TraceExpandSetting } from "./traceExpand";

/**
 * Folding a run of consecutive tool traffic into one transcript row.
 *
 * A turn that reads six notes writes twelve rows into the transcript — a call
 * row and a result row per tool — and the model's actual prose ends up as a
 * paragraph adrift in machine traffic. The rows are each already one line and
 * already closed; the problem is their *number*, which no per-row treatment can
 * fix.
 *
 * So a run of them becomes a single row that says what the run did, with the
 * original rows inside it: nothing is lost, and the reader who wants the detail
 * is one click away from exactly what they saw before. The summary counts by
 * category rather than reporting a total, because "used 6 tools" answers a
 * question nobody has; "changed a note and read 5 notes" is the shape of the
 * turn.
 *
 * Two things stay out of every fold, for the same reason: a row the reader must
 * not have to open to see. An `ask_user` call is a decision *they* made, and an
 * errored result leads with the failure message. Both break the run rather than
 * being swallowed by it, so a fold's contents are always things that worked and
 * things the agent chose on its own.
 *
 * Only the all-collapsed expand mode folds. The other two modes exist to *open*
 * machine traffic, and hiding it one layer deeper would answer the opposite of
 * what they were chosen for.
 *
 * Free of React and DOM imports so the rules can be unit-tested without a
 * renderer; `MessageList.tsx` owns the markup, on the model of `traceExpand.ts`
 * and `traceSummary.ts`.
 */

/**
 * The order categories are named in, most consequential first.
 *
 * Fixed rather than sorted by count: a reader skimming a folded run wants to
 * meet a vault change before a search, and a line whose word order shifts with
 * the counts is a line that reads differently every turn.
 *
 * The categories themselves, and which tool falls in which, live in
 * `toolCatalog.ts` beside that tool's name and glyph — this is only the order
 * they are spoken in, which is the fold line's own business.
 */
export const TRACE_FOLD_CATEGORIES: readonly ToolCategory[] = ["write", "web", "subagent", "read", "search", "other"];

/**
 * Where a foldable row sits in the transcript.
 *
 * A tool call is a content block inside an assistant message; a tool result is
 * a message of its own, which is what `block: null` says. The pair is what lets
 * a run cross the boundary between them — the common case, since a call and its
 * result are never in the same message.
 */
export interface TraceRowRef {
	/** Index into the transcript's message array. */
	message: number;
	/** Index into an assistant message's `content`; `null` for a whole-message row. */
	block: number | null;
}

/** One row a fold swallowed, carrying what the fold's body needs to draw it. */
export type TraceFoldRow =
	| { ref: TraceRowRef; kind: "call"; call: ToolCall }
	| { ref: TraceRowRef; kind: "result"; result: ToolResultMessage };

/** One category's share of a folded run. */
export interface TraceFoldTally {
	category: ToolCategory;
	count: number;
}

/** A run of tool traffic the transcript draws as one row. */
export interface TraceFoldGroup {
	/** The rows it swallowed, in transcript order. */
	rows: readonly TraceFoldRow[];
	/** Call counts per category, in {@link TRACE_FOLD_CATEGORIES} order. */
	tallies: readonly TraceFoldTally[];
}

/**
 * What a folded row does when the renderer reaches it.
 *
 * The group draws at the position of its first row — inside the assistant
 * message for a call, in the result's own slot for a result — so the summary
 * lands exactly where the traffic it replaced began, whichever kind of row that
 * was. Every other member draws nothing.
 */
export interface TraceFoldSlot {
	group: TraceFoldGroup;
	/** True for the run's first row, the one that draws the summary. */
	head: boolean;
}

/** Every folded row in a transcript, addressable by position. */
export interface TraceFoldPlan {
	slots: ReadonlyMap<string, TraceFoldSlot>;
}

/** What a transcript with nothing to fold looks like; also the answer for the other two modes. */
export const EMPTY_TRACE_FOLD_PLAN: TraceFoldPlan = { slots: new Map() };

/** The plan's verdict for one row, or `null` when the row renders as it always has. */
export function traceFoldSlot(plan: TraceFoldPlan, message: number, block: number | null): TraceFoldSlot | null {
	return plan.slots.get(rowKey(message, block)) ?? null;
}

/**
 * How many calls a run needs before folding it is a win.
 *
 * Two. A single call's own row already says more than any summary could — the
 * tool it used *and* the path it touched — so folding one would trade
 * information for a click. It also keeps the common one-shot turn ("read this
 * note, answer") looking exactly as it does today.
 */
const MIN_FOLDED_CALLS = 2;

/** What the planner needs to know beyond the transcript itself. */
export interface TraceFoldOptions {
	/** The reader's expand mode; only `collapsed` folds. */
	mode: TraceExpandSetting;
	/** Whether raw tool ids and payloads are on show, which makes `ask_user` calls visible. */
	showAgentDetails: boolean;
	/**
	 * Which result answered which call, so a call whose result failed can break the
	 * run the same way the failure itself does.
	 *
	 * A failed result has always interrupted a fold — a row the reader must not have
	 * to open to see cannot be folded away. That was enough while the two halves of
	 * an invocation were two rows: the result broke the run and drew itself. Now that
	 * the call draws the result (see `toolPair.ts`), a run that swallowed the call
	 * would swallow the failure with it, and the one row the fold rules exist to keep
	 * out would be the one row inside it that mattered.
	 */
	pairs?: ToolPairPlan;
}

/**
 * Which runs of tool traffic to fold, and where each one draws.
 *
 * One pass over the transcript, accumulating a run and flushing it whenever
 * something visible that is not a foldable tool row interrupts it: prose, a
 * thought, a harness line, a question, a failure, the user's own turn. The run
 * that survives to the end of the transcript is flushed too — a turn cut off
 * mid-tools folds like any other.
 */
export function planTraceFolds(messages: readonly AgentMessage[], options: TraceFoldOptions): TraceFoldPlan {
	if (options.mode !== "collapsed") {
		return EMPTY_TRACE_FOLD_PLAN;
	}
	const slots = new Map<string, TraceFoldSlot>();
	let run: TraceFoldRow[] = [];
	let calls = 0;

	const flush = (): void => {
		if (calls >= MIN_FOLDED_CALLS) {
			const group: TraceFoldGroup = { rows: run, tallies: tallyCalls(run) };
			run.forEach((row, index) => slots.set(rowKey(row.ref.message, row.ref.block), { group, head: index === 0 }));
		}
		run = [];
		calls = 0;
	};

	messages.forEach((message, index) => {
		if (message.role === "assistant") {
			message.content.forEach((block, blockIndex) => {
				if (!blockIsVisible(block, options.showAgentDetails)) {
					// Transparent: neither folded nor a break. A suppressed `ask_user`
					// call and the empty text block a provider can open before its
					// first token would each otherwise split a run around something
					// the reader cannot see.
					return;
				}
				/*
				 * Anything else visible interrupts the run: prose, a thought, and the
				 * question row agent details bring back. A visible `ask_user` call has
				 * reached here rather than the guard above, and it must break the run
				 * rather than join it — the payload that mode exists to show is the
				 * whole reason the row is on screen.
				 *
				 * A call still running does *not* break it any more. It used to: the
				 * live row was the transcript's only sign that the turn was working in
				 * that spot, and a fold would have replaced a spinner with a settled
				 * count. Two things changed. The exemption could only ever cover one
				 * call — it was addressed at the last block of the streaming message,
				 * so a turn that issued eight left seven of them folded and silent —
				 * and a fold that holds a running call now breathes, which is one
				 * animation for however many calls are behind it instead of a row each.
				 */
				if (
					block.type !== "toolCall" ||
					block.name === ASK_USER_TOOL ||
					pairedResult(options.pairs ?? EMPTY_TOOL_PAIR_PLAN, index, blockIndex)?.isError
				) {
					flush();
					return;
				}
				run.push({ ref: { message: index, block: blockIndex }, kind: "call", call: block });
				calls += 1;
			});
			return;
		}
		if (message.role === "toolResult") {
			/*
			 * Transparent, like a suppressed `ask_user` call: its own call row draws it
			 * (see `toolPair.ts`), so it is not a row here to fold or to break a run
			 * with. Left in the run it would be counted as a row the fold swallowed and
			 * could become the run's *head* — the position the summary draws at — which
			 * is a position nothing occupies, so the whole run would vanish.
			 */
			if (resultIsPaired(options.pairs ?? EMPTY_TOOL_PAIR_PLAN, index)) {
				return;
			}
			if (message.isError || message.toolName === ASK_USER_TOOL) {
				flush();
				return;
			}
			run.push({ ref: { message: index, block: null }, kind: "result", result: message });
			return;
		}
		flush();
	});
	flush();
	return { slots };
}

/**
 * Whether an assistant content block puts anything on screen.
 *
 * One predicate for two questions that have to agree: whether a block breaks a
 * run of tool traffic, and whether an assistant turn still has something to
 * draw once its folded rows are gone. Answering them separately is how a blank
 * text block ends up splitting a fold in two while also earning the turn an
 * empty card.
 *
 * The `ask_user` clause mirrors the render site: the question is drawn in full
 * at the tail and as a receipt afterwards, so its call row is suppressed unless
 * agent details are on to show the payload behind it.
 */
export function blockIsVisible(block: AssistantMessage["content"][number], showAgentDetails: boolean): boolean {
	if (block.type === "text") {
		return block.text.trim().length > 0;
	}
	if (block.type === "toolCall") {
		return showAgentDetails || block.name !== ASK_USER_TOOL;
	}
	return true;
}

/**
 * The one-line summary a folded run draws.
 *
 * Assembled from copy rather than concatenated prose: each category contributes
 * a mid-sentence phrase, and the two joiners are themselves copy, so a
 * translator owns the punctuation and the word order instead of inheriting
 * English's. The phrases are authored lower-case for that reason, and the
 * assembled line is put in sentence case here — the one place that knows which
 * phrase came first.
 */
export function describeTraceFold(tallies: readonly TraceFoldTally[], t: Translator): string {
	const phrases = tallies.map((tally) => phraseFor(tally, tallies.length > 1, t));
	return sentenceCase(joinPhrases(phrases, t));
}

/** A copy path, typed off the translator so this module needs no import from the tables. */
type CopyKey = Parameters<Translator["t"]>[0];

/**
 * The two forms each category needs, because the copy tables carry no plural rule.
 *
 * `other` has a third and fourth: alone it is "used 2 tools", but next to a
 * named category it has to be "used 2 *other* tools" or the reader is invited to
 * wonder whether the notes it just read were tools as well.
 */
const CATEGORY_KEYS: Readonly<Record<ToolCategory, { one: CopyKey; many: CopyKey }>> = {
	write: { one: "traceFold.writeOne", many: "traceFold.writeMany" },
	web: { one: "traceFold.webOne", many: "traceFold.webMany" },
	subagent: { one: "traceFold.subagentOne", many: "traceFold.subagentMany" },
	read: { one: "traceFold.readOne", many: "traceFold.readMany" },
	search: { one: "traceFold.searchOne", many: "traceFold.searchMany" },
	other: { one: "traceFold.otherOne", many: "traceFold.otherMany" },
};

const OTHER_ALONGSIDE_KEYS: { one: CopyKey; many: CopyKey } = {
	one: "traceFold.otherAlsoOne",
	many: "traceFold.otherAlsoMany",
};

function phraseFor(tally: TraceFoldTally, alongside: boolean, t: Translator): string {
	const keys = tally.category === "other" && alongside ? OTHER_ALONGSIDE_KEYS : CATEGORY_KEYS[tally.category];
	return t.t(tally.count === 1 ? keys.one : keys.many, { count: tally.count });
}

/**
 * Joins the phrases right to left, so the last pair gets the conjunction and
 * every earlier one gets the list separator.
 *
 * `reduceRight` with no seed starts on the final phrase, which is exactly the
 * accumulator this needs; the guard above it is for the empty list, where that
 * form throws.
 */
function joinPhrases(phrases: readonly string[], t: Translator): string {
	if (phrases.length === 0) {
		return "";
	}
	return phrases.reduceRight((tail, head, index) =>
		index === phrases.length - 2
			? t.t("traceFold.also", { first: head, second: tail })
			: t.t("traceFold.list", { first: head, rest: tail }),
	);
}

/** Upper-cases the first character only; a no-op on the Chinese table's phrases. */
function sentenceCase(text: string): string {
	return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
}

function tallyCalls(rows: readonly TraceFoldRow[]): TraceFoldTally[] {
	const counts = new Map<ToolCategory, number>();
	for (const row of rows) {
		if (row.kind !== "call") {
			continue;
		}
		const category = categorizeTool(row.call.name);
		counts.set(category, (counts.get(category) ?? 0) + 1);
	}
	return TRACE_FOLD_CATEGORIES.flatMap((category) => {
		const count = counts.get(category);
		return count ? [{ category, count }] : [];
	});
}

function rowKey(message: number, block: number | null): string {
	return `${message}:${block ?? "result"}`;
}
