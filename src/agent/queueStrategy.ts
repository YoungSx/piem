/**
 * When a message typed mid-reply is allowed to reach the model.
 *
 * A send during a running reply is not refused — it waits. The only question is
 * *how long*, and there are two honest answers, because a run is two nested
 * things: one provider request (the model speaks, its tools run) and the whole
 * answer (as many of those as the model needs to finish).
 *
 * - `afterRun` waits for the whole answer. The reply the reader is watching
 *   completes, tools and all, and the queue departs as the next question. This
 *   is the default: it is the only timing that never changes what the reply
 *   already promised to do, and a reader who queued "also check B" meant it as
 *   a follow-up far more often than as a correction.
 * - `afterTurn` waits for the current provider request instead — the message
 *   lands at the next turn boundary, after this turn's tools finish and before
 *   the model speaks again. Sooner, and it can still change the course of a
 *   long tool loop, which is exactly why it is not the default: a reply halfway
 *   through a plan gets a new instruction mid-plan.
 *
 * Neither is an interrupt. A queued message that cannot wait at all is the
 * chip's own steer action, which cuts the reply short — see
 * `ObsidianAgentService.steerQueuedPrompt`.
 *
 * Free of React, DOM and pi imports so the rules and the wording can be
 * unit-tested on their own, on the model of `ui/traceExpand.ts`.
 */

/** The two waiting rules the settings panel offers. */
export type PromptQueueStrategy = "afterRun" | "afterTurn";

/**
 * What a vault that has never stored the field gets.
 *
 * The whole answer, not the next turn: a reply cut into mid-plan by a message
 * meant as a follow-up is the failure mode a default has to avoid, and the
 * reader who wants the other timing is by definition someone who has thought
 * about it.
 */
export const DEFAULT_PROMPT_QUEUE_STRATEGY: PromptQueueStrategy = "afterRun";

/** Whether `value` names a rule this build implements, for the settings parse and the dropdown write. */
export function isPromptQueueStrategy(value: unknown): value is PromptQueueStrategy {
	return value === "afterRun" || value === "afterTurn";
}
