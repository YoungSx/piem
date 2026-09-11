import { Notice, type App } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { VIEW_TYPE_PIEM_CHAT } from "../constants";
import { textResult, throwIfAborted } from "./toolResult";
import type { AskUserBroker } from "./askUserBroker";
import type { AskUserQuestion } from "./askUserQuestion";

/**
 * Tools through which the agent reaches the user directly, rather than the
 * vault: `notify` is a one-way broadcast, `ask_user` is a structured question.
 *
 * The pair exists because of one gap: the chat panel is not always on screen.
 * On mobile it is a drawer the user may have collapsed; on desktop the agent
 * can keep working while the user reads elsewhere. A message that lands only in
 * the transcript can go unseen for the whole run, and a question asked in prose
 * on a phone costs the user a keyboard round-trip to answer. These tools put
 * the agent's side of that exchange where the user actually is.
 *
 * `ask_user` no longer owns how it looks. It hands the question to an
 * {@link AskUserBroker} and waits; the broker puts it in the chat transcript, or
 * escalates to a dialog when the panel is not on screen. What stays here is the
 * one judgement that is the tool's own: whether there is anybody to ask at all.
 */

const NotifyParameters = Type.Object({
	message: Type.String({
		description: "Short text to show in a toast. One or two sentences; it disappears, so it is not a place for the answer itself.",
	}),
	timeout: Type.Optional(
		Type.Number({ description: "Milliseconds to keep the toast visible. Omit for Obsidian's default duration." }),
	),
});

const AskUserOptionSchema = Type.Object({
	label: Type.String({ description: "Short answer as the user would pick it from a list, e.g. 'Archive it'." }),
	description: Type.Optional(
		Type.String({
			description: "One sentence on what choosing this does. States the consequence, not a restatement of the label.",
		}),
	),
});

const AskUserQuestionSchema = Type.Object({
	question: Type.String({ description: "The full question, self-contained: the user sees it out of conversational context." }),
	header: Type.String({ description: "Very short label for the question, a few words at most, e.g. 'Where to file'." }),
	options: Type.Array(AskUserOptionSchema, {
		description: "Between 2 and 4 concrete answers. They must be real choices: different actions, not yes/no around one action you could just do.",
		minItems: 2,
		maxItems: 4,
	}),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Allow picking several options at once. Omit for single choice." }),
	),
});

const AskUserParameters = Type.Object({
	questions: Type.Array(AskUserQuestionSchema, {
		description:
			"1 to 4 questions. Ask everything you need in one call rather than spreading it across turns; every question blocks on the user.",
		minItems: 1,
		maxItems: 4,
	}),
});

export function createNotifyTool(app: App): AgentTool<typeof NotifyParameters> {
	return {
		name: "notify",
		label: "Notify",
		// `Notice` is queue-and-forget, so concurrent calls would not corrupt
		// anything — but they would stack toasts out of order, and a notification
		// is a user-visible side effect this file keeps one-at-a-time.
		executionMode: "sequential",
		description:
			"Show a short toast notification that stays visible no matter what the user is looking at. Use it for completion or failure the user may be away from the chat panel for — a long reorganization finished, a step needs their attention. Do not use it to deliver the answer, report every step, or ask anything: the answer and questions belong in the chat.",
		parameters: NotifyParameters,
		execute: async (_toolCallId, params, signal) => {
			throwIfAborted(signal);
			// `Notice` is fire-and-forget in Obsidian: it queues itself and hides
			// on its own timer. Nothing to await, so the result reports the fact of
			// display, not an outcome.
			new Notice(params.message, params.timeout);
			return textResult("Displayed a notification toast.", { notified: true });
		},
	};
}

export function createAskUserTool(app: App, broker: AskUserBroker, ownerId?: string): AgentTool<typeof AskUserParameters> {
	return {
		name: "ask_user",
		label: "Ask user",
		// One question at a time per agent: a second call in the same batch could
		// not make progress while the first is on screen, and the broker would
		// queue it behind the first anyway. The pin says so at the tool level so
		// pi never starts the second call in the first place.
		executionMode: "sequential",
		description:
			"Ask the user a structured choice question with clickable options, shown in the chat panel where they can still see their notes while answering, instead of guessing. Use it when a decision materially changes what you do next, the context does not settle it, and a wrong guess costs real work — which note to file into, which of two conflicting instructions to follow. Do not use it for information already in the conversation, to confirm something you could just do, or as a substitute for answering. Options are rendered as-is, so write them as the concrete choices; the user can always hand the decision back or type their own answer. Ask at most once per turn: ask everything you need in one call, then act on the answers.",
		parameters: AskUserParameters,
		execute: async (_toolCallId, params, signal) => {
			throwIfAborted(signal);

			/*
			 * A three-step ladder, and this is its first rung.
			 *
			 * No chat panel at all means the user is not using Piem right now — a
			 * background run finishing while they work elsewhere in the vault. There
			 * is nobody to ask, and neither surface is the right answer: a card would
			 * go into a transcript nothing is rendering, and a dialog thrown over
			 * whatever they are doing is the rudeness this tool was built to avoid.
			 * Refusing sends the question back to the model, which puts it in the
			 * transcript in prose, where it at least survives to be read later.
			 *
			 * The other two rungs are the broker's: a panel that is on screen gets the
			 * question in its stream, and a panel that exists but is collapsed or
			 * buried in a background tab gets the dialog.
			 */
			if (app.workspace.getLeavesOfType(VIEW_TYPE_PIEM_CHAT).length === 0) {
				throw new Error(
					"The chat panel is not open, so there is no one to show a question to. Ask your question in the chat instead and let the user reply there.",
				);
			}

			const answers = await broker.ask(params.questions as readonly AskUserQuestion[], signal, ownerId);
			if (answers === null) {
				return textResult(
					"The user handed the decision back without answering. Do not re-ask the same thing; make the most reasonable choice yourself and say that you did.",
					{ dismissed: true },
				);
			}

			const lines = answers.map((answer) => `${answer.header}: ${answer.selected.join(", ")}`);
			return textResult(`The user answered:\n${lines.join("\n")}`, { dismissed: false, answers });
		},
	};
}
