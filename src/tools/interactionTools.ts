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

			const answers = await broker.ask(params.questions, signal, ownerId);
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

const PresentUIParameters = Type.Object({
	code: Type.String({
		description:
			"JavaScript code executing with (container, obsidian, app, commit). Use native Obsidian UI components (Setting, etc.) to present interactive controls. Call commit(data) when user finishes or clicks an action button.",
	}),
	title: Type.Optional(
		Type.String({
			description: "Optional short header/title for the interactive card.",
		}),
	),
});

function isDOMNode(value: unknown): value is { tagName?: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"nodeType" in value &&
		typeof value.nodeType === "number"
	);
}

export function sanitizePayload(value: unknown, ancestors = new Set<object>()): unknown {
	if (value === null || typeof value !== "object") {
		if (typeof value === "function" || typeof value === "symbol") {
			return undefined;
		}
		if (typeof value === "bigint") {
			return value.toString();
		}
		return value;
	}
	if (ancestors.has(value)) {
		return "[Circular]";
	}
	if (isDOMNode(value)) {
		const tagName = typeof value.tagName === "string" ? value.tagName.toLowerCase() : "node";
		return `[Element <${tagName}>]`;
	}

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((item) => sanitizePayload(item, ancestors));
		}
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			const sanitized = sanitizePayload(v, ancestors);
			if (sanitized !== undefined) {
				result[k] = sanitized;
			}
		}
		return result;
	} finally {
		ancestors.delete(value);
	}
}

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
			"Present an interactive native Obsidian UI block directly inside the chat transcript. You write JavaScript code executing in a sandboxed host context with (container, obsidian, app, commit). container is the root HTMLElement for your component; obsidian provides native Obsidian primitives (Setting, Notice, etc.); app is the Obsidian App instance; commit(data) settles this tool call with your user response payload (e.g. form values or { action: string, ... }). Blocks until the user interacts and calls commit, or is cancelled.",
		parameters: PresentUIParameters,
		execute: async (_toolCallId, params, signal) => {
			throwIfAborted(signal);

			if (app.workspace.getLeavesOfType(VIEW_TYPE_PIEM_CHAT).length === 0) {
				throw new Error(
					"The chat panel is not open, so there is no one to show an interactive UI to. Present your UI or information in the chat instead.",
				);
			}

			const rawPayload = await broker.present(
				{ code: params.code, title: params.title },
				signal,
				ownerId,
			);

			if (!rawPayload || typeof rawPayload !== "object") {
				return textResult(
					"The user dismissed or cancelled the interactive UI block.",
					{ dismissed: true, title: params.title },
				);
			}

			const payload = (sanitizePayload(rawPayload) as Record<string, unknown>) ?? {};
			const action = typeof payload.action === "string" ? payload.action : undefined;
			const summary = action
				? `User submitted action "${action}"`
				: "User submitted interactive UI response";

			let formattedJson = "";
			try {
				formattedJson = JSON.stringify(payload, null, 2);
			} catch {
				formattedJson = "{unserializable payload}";
			}

			return textResult(
				`${summary}:\n${formattedJson}`,
				{ dismissed: false, data: payload, action, title: params.title },
			);
		},
	};
}
