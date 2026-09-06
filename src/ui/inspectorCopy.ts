import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { formatCost, formatTokens } from "../agent/usage";
import type { SubagentSnapshot } from "../subagent/inspectorModel";
import type { Translator } from "../i18n";
import { summarizeToolPayload } from "./traceSummary";

/**
 * Copy and shaping rules for the subagent inspector.
 *
 * Free of React and DOM imports so every wording decision below can be
 * unit-tested without a renderer; `SubagentInspector.tsx` owns the markup. Same
 * split as `headerCopy.ts` and `traceSummary.ts`, and for the same reason: the
 * hard part here is what to say about a run that was cut short, not how to lay
 * it out.
 *
 * Every prose function takes the {@link Translator} rather than reaching for a
 * table itself, so the language stays the caller's decision and both languages
 * can be asserted through one entry point.
 */

/** Longest a transcript step's text may run in the process record before it is clipped. */
const MAX_STEP_LENGTH = 160;

/** The status word, which is also the only channel a colour-blind reader has. */
export function statusText(status: SubagentSnapshot["status"], t: Translator): string {
	return t.t(`subagents.status.${status}`);
}

/**
 * Elapsed time, at one significant unit.
 *
 * Seconds under a minute, minutes under an hour, hours above — a subagent run
 * is a thing you glance at, and "3m" answers "is this stuck?" as well as
 * "3m 12.4s" does while surviving a 300px sidebar. Sub-second runs floor to
 * "0s" rather than printing milliseconds, which would be the only unit here
 * nobody has an intuition for.
 */
export function formatDuration(durationMs: number): string {
	const seconds = Math.max(0, Math.floor(durationMs / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	return `${Math.floor(minutes / 60)}h${minutes % 60 > 0 ? `${minutes % 60}m` : ""}`;
}

/**
 * The one-line summary under a row's title: how long, and when it started.
 *
 * A running child gets the same shape as a settled one on purpose. "ran for 2m"
 * of a live run is true — it *has* run for two minutes — and the status word
 * beside it already says the run is not over, so a second tense here would only
 * repeat it.
 */
export function timingLine(snapshot: SubagentSnapshot, t: Translator): string {
	return t.t("subagents.ranFor", { duration: formatDuration(snapshot.durationMs) });
}

/**
 * Why a run's report is not the whole answer, in one sentence, or null.
 *
 * Two separate facts can be true at once — the report is partial, and something
 * ordered the kill — and they answer different questions ("can I trust this?"
 * versus "whose decision was that?"). Joined into one paragraph rather than
 * shown as two badges because a reader hitting a partial report reads a
 * sentence, not a legend.
 */
export function incompleteNote(snapshot: SubagentSnapshot, t: Translator): string | null {
	const parts: string[] = [];
	if (snapshot.incomplete) {
		parts.push(t.t("subagents.incompletePartial"));
	}
	if (snapshot.killedBy === "parent") {
		parts.push(t.t("subagents.killedByParent"));
	} else if (snapshot.killedBy === "teardown") {
		parts.push(t.t("subagents.killedByTeardown"));
	} else if (snapshot.killedBy === "tool") {
		parts.push(t.t("subagents.killedByTool"));
	} else if (snapshot.killedBy === "user") {
		parts.push(t.t("subagents.killedByUser"));
	}
	return parts.length > 0 ? parts.join(" ") : null;
}

/** One `label: value` pair in the setup block. */
export interface ConfigItem {
	label: string;
	value: string;
	/**
	 * Whether the value is a machine identifier rather than prose.
	 *
	 * A model id (`deepseek-v4-pro`) wants monospace and a role name ("scout")
	 * does not; the renderer cannot tell which it was handed, so the decision is
	 * made here where the fields are known. Same reasoning as
	 * {@link isToolIdentifier} in `traceSummary.ts`.
	 */
	isIdentifier?: boolean;
}

/** The setup block: what this run actually ran as, after resolution and clamping. */
export function configItems(snapshot: SubagentSnapshot, t: Translator): ConfigItem[] {
	return [
		{ label: t.t("subagents.configRole"), value: snapshot.role },
		{ label: t.t("subagents.configModel"), value: snapshot.modelId, isIdentifier: true },
		{ label: t.t("subagents.configThinking"), value: snapshot.thinkingLevel, isIdentifier: true },
		{ label: t.t("subagents.configDepth"), value: t.t("subagents.depthValue", { depth: snapshot.depth }) },
	];
}

/**
 * Turns, tokens and spend, or an empty list.
 *
 * Empty is the honest answer twice over: a run still going has no totals yet,
 * and a failed run never produced any. Both cases the renderer handles by
 * showing nothing rather than a row of zeros, which would read as a measurement.
 *
 * Cost is dropped when the tier is off, matching the context popover: how much
 * it cost is a different question from what it did, and only one of them belongs
 * to a reader who has not asked for agent internals.
 */
export function usageItems(snapshot: SubagentSnapshot, showAgentDetails: boolean, t: Translator): string[] {
	const items: string[] = [];
	if (snapshot.turns !== undefined) {
		items.push(t.t("subagents.usageTurns", { count: snapshot.turns }));
	}
	if (snapshot.usage && snapshot.usage.requests > 0) {
		items.push(t.t("subagents.usageTokens", { tokens: formatTokens(snapshot.usage.tokens) }));
		if (showAgentDetails) {
			items.push(t.t("subagents.usageCost", { cost: formatCost(snapshot.usage.cost) }));
		}
	}
	return items;
}

/**
 * The report, or the reason there is none.
 *
 * `kind` exists so the renderer can set a real report as Markdown and a
 * substitute sentence as prose: running the stand-in through the Markdown
 * pipeline would be a lie about where the words came from.
 */
export function reportBody(snapshot: SubagentSnapshot, t: Translator): { kind: "report" | "note"; text: string } {
	if (snapshot.report && snapshot.report.trim()) {
		return { kind: "report", text: snapshot.report };
	}
	if (snapshot.status === "running") {
		return { kind: "note", text: t.t("subagents.reportPending") };
	}
	if (snapshot.status === "failed") {
		return { kind: "note", text: t.t("subagents.reportNone") };
	}
	// Settled, no error, and nothing written: the empty-clean return in the
	// runner. Same words as a pending run would be wrong — it is not coming —
	// so this reuses the failure wording, which is what actually happened to
	// the report.
	return { kind: "note", text: t.t("subagents.reportNone") };
}

/** One row of the process record. */
export interface ProcessStep {
	/** What this step was: "Reply", "Ran grep", "grep failed". */
	label: string;
	/** The step's text, clipped; empty when the step carries none. */
	text: string;
	/** Whether {@link text} was cut. */
	clipped: boolean;
	/** A failed tool result, which the row marks. */
	isError?: boolean;
}

/**
 * Flattens a settled child's transcript into rows a reader can scan.
 *
 * Not the chat transcript renderer. That one is built for a conversation the
 * user is part of — avatars, reply actions, streaming carets, Markdown per
 * block — and none of it applies to a record of what somebody else's process
 * did. What a monitor needs is the sequence and the shape of each step, which
 * is one line each.
 *
 * Thinking blocks are included. They are the one thing that explains a
 * surprising tool call, and the run is over: there is no live token stream to
 * flood, and nothing here can be replied to.
 */
export function processSteps(messages: readonly AgentMessage[], t: Translator): ProcessStep[] {
	const steps: ProcessStep[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			steps.push(step(t.t("subagents.line.user"), userText(message.content)));
			continue;
		}
		if (message.role === "assistant") {
			for (const content of message.content) {
				if (content.type === "text") {
					steps.push(step(t.t("subagents.line.assistant"), content.text));
				} else if (content.type === "thinking") {
					steps.push(step(t.t("subagents.line.thinking"), content.thinking));
				} else if (content.type === "toolCall") {
					// The argument, the same rule the transcript's collapsed rows use: a
					// path answers "which note?", a pattern answers "searching for what?".
					// The call keeps its own row (the result holds the next one), so a
					// reader gets what → what came back in two lines rather than one.
					steps.push(step(t.t("subagents.line.toolCall", { tool: content.name }), summarizeToolPayload(content.arguments)));
				}
			}
			continue;
		}
		if (message.role === "toolResult") {
			const label = message.isError
				? t.t("subagents.line.toolError", { tool: message.toolName })
				: t.t("subagents.line.toolResult", { tool: message.toolName });
			steps.push({ ...step(label, textOf(message.content)), isError: message.isError });
		}
		// Every other role is harness bookkeeping (compaction summaries, bash
		// executions) that a child does not produce; skipped rather than shown as
		// an unnamed row.
	}
	return steps;
}

function step(label: string, text: string): ProcessStep {
	const trimmed = text.trim();
	const clipped = trimmed.length > MAX_STEP_LENGTH;
	return { label, text: clipped ? `${trimmed.slice(0, MAX_STEP_LENGTH)}` : trimmed, clipped };
}

/** A user message's content is either a plain string or a block list. */
function userText(content: string | readonly (TextContent | ImageContent)[]): string {
	return typeof content === "string" ? content : textOf(content);
}

/**
 * First text block's text, or empty for content that is all images.
 *
 * Narrowed on the discriminant rather than cast: `ImageContent` carries no
 * `text`, and a cast here would compile while handing the caller `undefined` on
 * an image-only step — which reads as "this step said nothing" instead of
 * "this step was a picture".
 */
function textOf(content: readonly (TextContent | ImageContent)[]): string {
	for (const block of content) {
		if (block.type === "text") {
			return block.text;
		}
	}
	return "";
}
