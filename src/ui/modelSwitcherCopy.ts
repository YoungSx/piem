import type { ModelChoice } from "../settings";
import type { Translator } from "../i18n";

/**
 * Copy and label rules for the composer's model switcher.
 *
 * Free of React and DOM imports so the wording can be unit-tested without a
 * renderer; `ModelSwitcher.tsx` owns the markup and the Obsidian menu. Named
 * `…Copy` rather than matching the component's own name because a module
 * differing from it only by case is one Bun's resolver picks between by
 * extension, not by the spelling in the import.
 *
 * This is where the header's old model line ended up. That line sat above the
 * transcript and could only be read, never acted on: a user who wanted a
 * different model had to leave the panel, find **Settings → Piem**, and change a
 * dropdown two tabs in. Naming the model *on the control that changes it* costs
 * one row that the composer bar already had spare, and removes the header row
 * entirely.
 *
 * Two strings, for two audiences. The button face carries the model's own name
 * and nothing else, because it is read at a glance and a sidebar is narrow. The
 * accessible name and tooltip carry the endpoint too, since two providers
 * serving the same model are indistinguishable by name alone — and that is
 * exactly the pair a user switches between.
 */

/** What the switcher needs to know about the current target and its options. */
export interface ModelTarget {
	/** Configured models, in stored order. Empty when nothing is configured. */
	modelChoices: readonly ModelChoice[];
	/** Which choice is active, or undefined when the builtin fallback is in force. */
	activeModelId?: string;
	/**
	 * Resolved provider and model id of whatever requests actually go out on.
	 *
	 * Only read when no choice is active: for a configured model these hold the
	 * provider's uuid and the raw api id, neither of which is a name a person
	 * asked for. A live choice is described from its own fields instead.
	 */
	provider: string;
	modelId: string;
	/**
	 * Obsidian icon id of the mark for the active target, already resolved by
	 * the snapshot — the vendor's mark when one matches, else the neutral
	 * fallback (see `modelIconName`). Optional only so non-snapshot callers and
	 * fixtures need not set it; the live snapshot always does.
	 */
	modelIcon?: string;
	/**
	 * Wire id of the model the live agent is actually serving requests on, when
	 * the snapshot knows it. Equal to the settings-resolved {@link modelId}
	 * except while a mid-run switch (issue #252) waits for the run to land —
	 * that gap, not a flag, is what the title's "takes effect after this reply"
	 * note reports.
	 */
	runningModelId?: string;
}

/**
 * The name on the button face.
 *
 * The model alone, never the provider: this string is the one thing the switcher
 * always shows, and provider paths are long enough ("openrouter/anthropic/…")
 * that including them would leave the sidebar showing an ellipsis instead of a
 * model. The endpoint is one hover or one menu-open away.
 */
export function activeModelName(target: ModelTarget): string {
	// Not routed through the translator: both branches are ids the server chose,
	// which is the one kind of string a translation must not touch.
	return findActiveChoice(target)?.name ?? target.modelId;
}

/**
 * Accessible name and tooltip, e.g. "Switch model · Opus 5 · OpenRouter".
 *
 * The action leads. A control whose name is only its current value tells a
 * screen reader user what the panel is set to but not that they may change it,
 * which is the whole point of moving this out of the header — so the verb comes
 * first and the state follows it, the same shape {@link sendButtonTitle} uses for
 * Send and its chord.
 *
 * While a mid-run choice is waiting, the note that it lands after the reply
 * follows the state. The face already shows the new model — the intent — so the
 * note is the only place the timing is said.
 */
export function modelSwitcherTitle(target: ModelTarget, t: Translator): string {
	const title = t.t("modelSwitcher.buttonTitle", {
		action: t.t("modelSwitcher.switchModel"),
		model: describeTarget(target, t),
	});
	if (modelSwitchPending(target)) {
		return `${title} · ${t.t("chat.appliesAfterReply")}`;
	}
	return title;
}

/**
 * Whether a mid-run model choice is waiting to be applied.
 *
 * The gap between the two wire ids is the whole test: settings already name the
 * new model, the agent keeps the one it started on, and both are the same
 * namespace — what pi-ai dispatches on. Ids across namespaces would not compare
 * (a choice id is a config row, a wire id is an api string), which is why the
 * snapshot resolves both sides itself.
 */
function modelSwitchPending(target: ModelTarget): boolean {
	return target.runningModelId !== undefined && target.runningModelId !== target.modelId;
}

/**
 * One menu row.
 *
 * Provider included even when only one is configured. Suppressing it while it
 * happens to be unambiguous would change the row's shape the moment a second
 * provider is added, and the format matches the Models tab's own rows — a user
 * meets the same string where they created it and where they select it.
 *
 * No "active" suffix: the menu marks that with a check, and saying it twice
 * makes the checked row read as a different kind of entry.
 */
export function modelChoiceLabel(choice: ModelChoice, t: Translator): string {
	if (!choice.provider) {
		return choice.name;
	}
	return t.t("modelSwitcher.modelWithProvider", { model: choice.name, provider: choice.provider });
}

/** Turns pi's `very-high` enum into prose for the reasoning suffix. */
export function formatThinkingLevel(level: string): string {
	return level.replace(/-/g, " ").replace(/^./, (first: string) => first.toUpperCase());
}

/** The active choice, or undefined when the builtin fallback is serving requests. */
function findActiveChoice(target: ModelTarget): ModelChoice | undefined {
	return target.modelChoices.find((choice) => choice.id === target.activeModelId);
}

/**
 * Model plus endpoint.
 *
 * The reasoning level used to ride this tooltip in the agent-details tier, when
 * the header line had been the panel's only report of it; the thinking selector
 * beside this control now shows the level outright, and saying it twice would
 * make two adjacent controls describe the same state.
 */
function describeTarget(target: ModelTarget, t: Translator): string {
	const active = findActiveChoice(target);
	// The builtin pair is joined the way `describeModelTarget` joins it, so the
	// panel and the plugin's error messages name an unconfigured target alike.
	return active ? modelChoiceLabel(active, t) : `${target.provider}/${target.modelId}`;
}
