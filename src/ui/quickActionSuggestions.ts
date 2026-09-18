/**
 * The empty screen's built-in quick actions.
 *
 * These are the deterministic first moves a blank panel shows immediately —
 * before, and forever when, the model-generated row from
 * `src/agent/quickActionSuggestionRequest.ts` arrives. The model's answer
 * replaces them when it lands; they stay when it never does, because a first
 * screen with nothing to tap is the one placement where a suggestion row is
 * load-bearing rather than decorative.
 *
 * Free of React and DOM imports so the selection rules unit-test without a
 * renderer; `QuickActions.tsx` owns the markup.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Translator } from "../i18n";
import type { NoteFacts } from "../agent/noteFacts";

/** One suggested prompt. `id` keys the row; `label` names the chip; `prompt` is what a tap sends. */
export interface QuickAction {
	id: string;
	label: string;
	prompt: string;
}

/**
 * Whether the run that just settled ended on a failed reply.
 *
 * Walks back from the transcript tail for the same reason
 * `regenerableIndex` does: a run that used tools parks itself on a
 * `toolResult` between model calls, and the settled state this reads has to
 * find the reply behind whatever the run left last. The walk stops at the
 * first user turn — a reply behind one belongs to an earlier exchange, and
 * its failure was already offered its chip when that exchange settled.
 *
 * `error` only, never `aborted`: a stop is the user's own hand, and the panel
 * does not offer to undo it. The verdict stays the reader's, not the
 * panel's, for configuration failures too — the chip sends an ordinary
 * message, so retrying a provider that is refusing is a choice the user
 * makes with full sight of the banner, not one the wording of an error
 * message makes for them.
 */
export function lastReplyFailed(messages: readonly AgentMessage[]): boolean {
	for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
		const message = messages[cursor];
		if (message?.role === "assistant") {
			return message.stopReason === "error";
		}
		if (message?.role === "user") {
			return false;
		}
	}
	return false;
}

/**
 * How many chips the empty screen offers. The empty row wraps instead of
 * scrolling, so three is where it stops being a scannable shortcut and starts
 * being a menu; it is also `parseSuggestedActions`' default cap, which is what
 * the settings page's test probe counts.
 */
export const MAX_QUICK_ACTIONS = 3;

/**
 * How many chips the post-reply row offers. That row scrolls horizontally
 * instead of wrapping, so six read as a palette to swipe through rather than a
 * menu to unpack; the ceiling travels into the model's instruction (`{count}`)
 * and the parse's slice, so the row, the prompt, and the parse agree.
 */
export const MAX_REPLY_QUICK_ACTIONS = 6;

/**
 * The one chip offered when a reply died mid-run.
 *
 * Its prompt is a real, visible "Continue" message — deliberately not a hidden
 * `agent.continue()`: the half-finished reply stays on the transcript and the
 * model picks up from it the same way it would from any user nudge, which is
 * also why this needs none of the tail surgery a `continue()` demands. The
 * label and the prompt are separate copy leaves because every other chip keeps
 * them separate too; the preset gets to read "Continue" on the button while
 * sending the fuller sentence.
 *
 * One chip, not a row: the failure already says what happened (the reply
 * cutoff pill and the banner), so the only thing left to offer is the way
 * forward, and padding it with canned suggestions would bury that.
 */
export function continueAfterFailureQuickAction(t: Translator): QuickAction[] {
	return [
		{ id: "continueAfterFailure", label: t.t("quickActions.continueAfterFailure.label"), prompt: t.t("quickActions.continueAfterFailure.prompt") },
	];
}

/**
 * The empty screen's first moves, shaped by what is open.
 *
 * When an active note is in context, the note facts (daily note, empty draft,
 * or orphan note with 0 backlinks) tailor the immediate suggestions to the note's
 * specific role in the vault:
 * - Daily journal notes offer task extraction, daily planning, and review.
 * - Empty drafts offer structured outline generation, topic research, and brainstorming.
 * - Orphan notes offer link-graph analysis, finding unlinked mentions, and summarization.
 * - Populated connected notes offer summarization, review improvements, and brainstorming.
 *
 * Without an active note, the suggestions turn to the vault as a whole.
 *
 * The if-else priority order is a design decision:
 *   dailyNote/periodicNote > isEmpty > isOrphan > default
 * A newly created empty daily note gets daily-journal chips (not scaffold chips),
 * because its role as a journal entry is more specific than its state as a draft.
 * An empty ordinary note gets scaffold chips (not orphan chips), because outlining
 * a blank page is more useful than analyzing a graph position it cannot have yet.
 */
export function emptyScreenQuickActions(hasActiveNote: boolean, t: Translator, noteFacts?: NoteFacts | null): QuickAction[] {
	if (hasActiveNote) {
		if (noteFacts?.isDailyNote || noteFacts?.isPeriodicNote) {
			return [
				{ id: "todayTasks", label: t.t("quickActions.empty.todayTasks.label"), prompt: t.t("quickActions.empty.todayTasks.prompt") },
				{ id: "planDay", label: t.t("quickActions.empty.planDay.label"), prompt: t.t("quickActions.empty.planDay.prompt") },
				{ id: "reviewDay", label: t.t("quickActions.empty.reviewDay.label"), prompt: t.t("quickActions.empty.reviewDay.prompt") },
			];
		}
		if (noteFacts?.isEmpty) {
			return [
				{ id: "scaffoldOutline", label: t.t("quickActions.empty.scaffoldOutline.label"), prompt: t.t("quickActions.empty.scaffoldOutline.prompt") },
				{ id: "researchTopic", label: t.t("quickActions.empty.researchTopic.label"), prompt: t.t("quickActions.empty.researchTopic.prompt") },
				{ id: "brainstorm", label: t.t("quickActions.empty.brainstorm.label"), prompt: t.t("quickActions.empty.brainstorm.prompt") },
			];
		}
		if (noteFacts?.isOrphan) {
			return [
				{ id: "linkGraph", label: t.t("quickActions.empty.linkGraph.label"), prompt: t.t("quickActions.empty.linkGraph.prompt") },
				{ id: "findMentions", label: t.t("quickActions.empty.findMentions.label"), prompt: t.t("quickActions.empty.findMentions.prompt") },
				{ id: "summarizeNote", label: t.t("quickActions.empty.summarizeNote.label"), prompt: t.t("quickActions.empty.summarizeNote.prompt") },
			];
		}
		return [
			{ id: "summarizeNote", label: t.t("quickActions.empty.summarizeNote.label"), prompt: t.t("quickActions.empty.summarizeNote.prompt") },
			{ id: "improveNote", label: t.t("quickActions.empty.improveNote.label"), prompt: t.t("quickActions.empty.improveNote.prompt") },
			{ id: "brainstorm", label: t.t("quickActions.empty.brainstorm.label"), prompt: t.t("quickActions.empty.brainstorm.prompt") },
		];
	}
	return [
		{ id: "draftNote", label: t.t("quickActions.empty.draftNote.label"), prompt: t.t("quickActions.empty.draftNote.prompt") },
		{ id: "mapVault", label: t.t("quickActions.empty.mapVault.label"), prompt: t.t("quickActions.empty.mapVault.prompt") },
		{ id: "capabilities", label: t.t("quickActions.empty.capabilities.label"), prompt: t.t("quickActions.empty.capabilities.prompt") },
	];
}

/**
 * Quick action to distill the settled conversation into a reusable skill.
 *
 * Exported but not yet wired into the post-reply fallback row: the model
 * instruction in {@link REPLY_SUGGESTION_INSTRUCTION} handles the distill
 * suggestion dynamically. This static chip is the deterministic stand-in
 * for when the post-reply row gains a built-in fallback alongside the
 * model-generated suggestions.
 *
 * TODO: wire into MessageList's `followUpActions` as a fallback when the
 * model's reply suggestions are empty and the conversation shows a
 * multi-step procedure worth distilling.
 */
export function distillSkillQuickAction(t: Translator): QuickAction {
	return {
		id: "distillSkill",
		label: t.t("quickActions.reply.distillSkill.label"),
		prompt: t.t("quickActions.reply.distillSkill.prompt"),
	};
}

