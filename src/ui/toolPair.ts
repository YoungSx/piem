import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { ASK_USER_TOOL } from "./askUserRecord";
import { PRESENT_UI_TOOL } from "./uiBlockRecord";

/**
 * Pairing a tool call with the result that answered it, so one invocation is one
 * row.
 *
 * The transcript used to draw two. `pi` delivers a call as a block inside an
 * assistant message and its result as a message of its own, and the renderer
 * followed that shape one row per message — so every tool the agent used printed
 * its name twice, once under a wrench that reports no status and once under a
 * tick that repeats the name to tell you the status. The reader scanning for what
 * the agent did counted every action twice, on a phone at two rows apiece, and
 * the two halves of the one thing they wanted to know — which note, and did it
 * work — sat in different rows, each with its own truncation.
 *
 * None of which the data required: `ToolCall.id` and `ToolResultMessage.toolCallId`
 * are the same string. This module reads that correspondence into a plan the
 * renderer can consult per row, on the model of `traceFold.ts`: computed once at
 * the top of `MessageList`, passed down, and each row asks it whether to draw
 * itself, draw itself plus a partner, or stand down.
 *
 * Free of React and DOM imports so the rules can be unit-tested without a
 * renderer.
 */

/**
 * Which call each result belongs to, both ways round.
 *
 * Two indexes rather than one because the renderer asks two questions from two
 * places: a call row asks "is my result in yet", and a result row asks "has my
 * call already spoken for me". Deriving the second from the first at render time
 * would mean a scan per result row.
 */
export interface ToolPairPlan {
	/** `message:block` of a call → the result that answered it. */
	readonly resultFor: ReadonlyMap<string, ToolResultMessage>;
	/** Message indices of results a call has already drawn. */
	readonly claimed: ReadonlySet<number>;
}

/** The plan for a transcript with nothing to pair; also what `traceFold` falls back to. */
export const EMPTY_TOOL_PAIR_PLAN: ToolPairPlan = { resultFor: new Map(), claimed: new Set() };

/**
 * Pairs every call in the transcript with its result.
 *
 * One pass to index the results by call id, one to walk the calls in order. The
 * indexing pass comes first because a result always follows its call in the
 * transcript but not always immediately — a turn may issue three calls and then
 * report three results — so a single forward pass would have to hold unmatched
 * calls anyway.
 *
 * A call id is claimed exactly once. Two calls sharing an id (a session file
 * replayed from a build that generated them differently, a provider that reuses
 * ids across turns) leave the second one unpaired rather than showing the first
 * one's result twice: an unpaired call still says what it did, while a wrong
 * result says something that never happened.
 *
 * `ask_user` never pairs. Its call row is suppressed and its result renders as a
 * receipt of the reader's own decision, so a pairing would delete the receipt and
 * fold a human answer back into machine traffic.
 */
export function planToolPairs(messages: readonly AgentMessage[]): ToolPairPlan {
	const resultsById = new Map<string, { result: ToolResultMessage; index: number }>();
	for (const [index, message] of messages.entries()) {
		if (message.role !== "toolResult" || message.toolName === ASK_USER_TOOL || message.toolName === PRESENT_UI_TOOL) {
			continue;
		}
		if (!message.toolCallId || resultsById.has(message.toolCallId)) {
			// No id to pair on, or a second result for one call: leave it to draw
			// itself, which is what it did before this module existed.
			continue;
		}
		resultsById.set(message.toolCallId, { result: message, index });
	}
	if (resultsById.size === 0) {
		return EMPTY_TOOL_PAIR_PLAN;
	}

	const resultFor = new Map<string, ToolResultMessage>();
	const claimed = new Set<number>();
	for (const [messageIndex, message] of messages.entries()) {
		if (message.role !== "assistant") {
			continue;
		}
		for (const [blockIndex, block] of message.content.entries()) {
			if (block.type !== "toolCall" || block.name === ASK_USER_TOOL || block.name === PRESENT_UI_TOOL) {
				continue;
			}
			const match = resultsById.get(block.id);
			if (!match) {
				continue;
			}
			resultsById.delete(block.id);
			resultFor.set(pairKey(messageIndex, blockIndex), match.result);
			claimed.add(match.index);
		}
	}
	return { resultFor, claimed };
}

/** The result a call row should draw with, or `null` while the tool is still out. */
export function pairedResult(plan: ToolPairPlan, message: number, block: number): ToolResultMessage | null {
	return plan.resultFor.get(pairKey(message, block)) ?? null;
}

/**
 * Whether a result message has already been drawn by its call.
 *
 * The one question a result row asks. False for every orphan — a result whose
 * call was compacted away, a session file from before ids were recorded, an
 * `ask_user` receipt — and an orphan draws exactly as it always has.
 */
export function resultIsPaired(plan: ToolPairPlan, message: number): boolean {
	return plan.claimed.has(message);
}

function pairKey(message: number, block: number): string {
	return `${message}:${block}`;
}
