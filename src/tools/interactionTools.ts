import { Notice, type App } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { VIEW_TYPE_PIEM_CHAT } from "../constants";
import { textResult, throwIfAborted } from "./toolResult";
import type { AskUserBroker } from "./askUserBroker";
import type { UIBlockBroker } from "./uiBlockBroker";

/**
 * Tools through which the agent reaches the user directly, rather than the
 * vault: `notify` is a one-way broadcast, `ask_user` is a structured question,
 * and `present_ui` is an interactive native Obsidian UI block.
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
		executionMode: "sequential",
		description:
			"Show a short toast notification that stays visible no matter what the user is looking at. Use it for completion or failure the user may be away from the chat panel for — a long reorganization finished, a step needs their attention. Do not use it to deliver the answer, report every step, or ask anything: the answer and questions belong in the chat.",
		parameters: NotifyParameters,
		execute: async (_toolCallId, params, signal) => {
			throwIfAborted(signal);
			new Notice(params.message, params.timeout);
			return textResult("Displayed a notification toast.", { notified: true });
		},
	};
}

export function createAskUserTool(app: App, broker: AskUserBroker, ownerId?: string): AgentTool<typeof AskUserParameters> {
	return {
		name: "ask_user",
		label: "Ask user",
		executionMode: "sequential",
		description:
			"Ask the user a structured choice question with clickable options, shown in the chat panel where they can still see their notes while answering, instead of guessing. Use it when a decision materially changes what you do next, the context does not settle it, and a wrong guess costs real work — which note to file into, which of two conflicting instructions to follow. Do not use it for information already in the conversation, to confirm something you could just do, or as a substitute for answering. Options are rendered as-is, so write them as the concrete choices; the user can always hand the decision back or type their own answer. Ask at most once per turn: ask everything you need in one call, then act on the answers.",
		parameters: AskUserParameters,
		execute: async (_toolCallId, params, signal) => {
			throwIfAborted(signal);

			if (app.workspace.getLeavesOfType(VIEW_TYPE_PIEM_CHAT).length === 0) {
				throw new Error(
					"The chat panel is not open, so there is no one to show a question to. Ask your question in the chat instead and let the user reply there.",
				);
			}

			const startTime = performance.now();
			const answers = await broker.ask(params.questions, signal, ownerId);
			const userWaitMs = Math.round(performance.now() - startTime);
			if (answers === null) {
				return textResult(
					"The user handed the decision back without answering. Do not re-ask the same thing; make the most reasonable choice yourself and say that you did.",
					{ dismissed: true, interactive: true, userWaitMs },
				);
			}

			const lines = answers.map((answer) => `${answer.header}: ${answer.selected.join(", ")}`);
			return textResult(`The user answered:\n${lines.join("\n")}`, { dismissed: false, answers, interactive: true, userWaitMs });
		},
	};
}

const PresentUIParameters = Type.Object({
	code: Type.String({
		description:
			"JavaScript executing with (container, obsidian, app, ui). Build native Obsidian controls (Setting, etc.) into container. The two ways back to the agent: ui.sendMessage(data) starts a new turn — use it for a decision the agent must act on (a submitted form, 'approve'); ui.update(state) only records state for the agent's next turn and does not interrupt it — use it for local changes like a filter or an expanded row. ui.close() removes the view, and a one-shot form should call it after ui.sendMessage so it does not sit there inviting a second submission. ui.state is whatever you last passed to ui.update, and is null on first mount — read it defensively (ui.state?.filter ?? \"all\") and restore from it, because the code runs again whenever the view remounts (the panel is reopened, the session is switched). Return a function to clean up timers or listeners. If this code throws, the view does not open and you get the error back.",
	}),
	title: Type.Optional(
		Type.String({
			description: "Optional short header/title for the interactive card.",
		}),
	),
});

export function createPresentUITool(
	app: App,
	broker: UIBlockBroker,
	ownerId?: string,
): AgentTool<typeof PresentUIParameters> {
	return {
		name: "present_ui",
		label: "Present UI",
		executionMode: "sequential",
		description:
			"Put an interactive native Obsidian view into the chat transcript — a form to fill in, or a panel to work with over time. You write JavaScript running in a sandboxed host context with (container, obsidian, app, ui): container is the root HTMLElement, obsidian provides the native primitives (Setting, Notice, etc.), app is the Obsidian App. This returns as soon as the view is on screen, which ends your turn — do not say you are waiting and do not keep calling tools. The view stays live after you stop. When the user does something your code reports with ui.sendMessage(data), that arrives as a new turn and you continue then; anything they do that your code reports with ui.update(state) is waiting for you in the next turn's context without interrupting you. Use this instead of ask_user when the choice needs real controls rather than 2-4 options; use ask_user when you need the answer before you can take your next step in this turn.",
		parameters: PresentUIParameters,
		execute: async (_toolCallId, params, signal) => {
			throwIfAborted(signal);

			if (app.workspace.getLeavesOfType(VIEW_TYPE_PIEM_CHAT).length === 0) {
				throw new Error(
					"The chat panel is not open, so there is no one to show an interactive UI to. Present your UI or information in the chat instead.",
				);
			}

			const startTime = performance.now();
			const delivery = await broker.present(
				{ code: params.code, title: params.title },
				signal,
				ownerId,
			);
			const mountMs = Math.round(performance.now() - startTime);

			if (!delivery.delivered) {
				return textResult(
					"The interactive UI was closed before it finished opening, so the user never saw it. Do not present it again unless they ask; carry on in the chat.",
					{ uiId: delivery.id, live: false, title: params.title, interactive: true, mountMs },
				);
			}

			return textResult(
				`The interactive UI is open in the chat and stays open. Your turn ends here: if the user does something that needs you, it will arrive as a new message${
					params.title ? ` from "${params.title}"` : ""
				}.`,
				{ uiId: delivery.id, live: true, title: params.title, interactive: true, mountMs },
			);
		},
	};
}
