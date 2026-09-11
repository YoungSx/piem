/**
 * The model-generated side of the quick-action row.
 *
 * The rule-based suggestions in `src/ui/quickActionSuggestions.ts` still own
 * the empty screen as their immediate, always-available default; this module is
 * the request that replaces them once the model answers, and the sole source of
 * the post-reply row — where a suggestion is a nicety, so a failed request
 * shows nothing rather than falling back to canned chips.
 *
 * One non-streaming request per placement, sent through the same `StreamFn`
 * seam the agent's turns use, with tools and reasoning switched off: a
 * suggestion is a paragraph of JSON, not a task for the tool loop. Parsing is
 * deliberately lenient — providers wrap JSON in prose or fences, and a row that
 * half-survives is worth showing sliced down rather than discarded.
 *
 * The empty placements quote the caller's probed workspace facts — the model
 * would otherwise be guessing at a vault it has never seen; the reply placement
 * quotes the reply instead, which is both its subject and its context.
 *
 * The prompt copy is authored once in English, in this module — model-facing
 * strings are not user interface, so they carry no i18n burden; the output
 * language is named inside the instruction itself.
 *
 * Free of React and DOM imports so the prompt, the parse, and the failure
 * contract unit-test without a renderer or a network.
 */

import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, UserMessage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { MAX_QUICK_ACTIONS, MAX_REPLY_QUICK_ACTIONS, type QuickAction } from "../ui/quickActionSuggestions";
import type { Language } from "../i18n";
import { EMPTY_WORKSPACE_CONTEXT, hasWorkspaceFacts, renderWorkspaceLines, type WorkspaceContext } from "./workspaceContext";

/** Where the suggestions are headed; the placement decides the prompt's framing. */
export type SuggestionScope = "empty" | "reply";

/**
 * The chip ceiling each placement asks the model for and slices the answer to.
 * The mapping lives here rather than in the ui module because the cap is the
 * request's business — and the ui module cannot import from the agent module
 * without closing a cycle.
 *
 * This caps the model's array, not the row: the row is a `QuickAction[]` the
 * UI composes, and other contributors (the failure Continue chip today) may
 * appear beside or instead of these — so nothing downstream may read the cap
 * as "the row is full" or the request as "the row's only source".
 */
const CAPS: Record<SuggestionScope, number> = { empty: MAX_QUICK_ACTIONS, reply: MAX_REPLY_QUICK_ACTIONS };

/**
 * Ceiling on the reply text quoted back to the model. A suggestion prompt
 * should not cost what the original reply cost; anything past this is cut-off
 * context, not conversation the model needs verbatim.
 */
const REPLY_SAMPLE_LIMIT = 4_000;

/**
 * A JSON array of three short objects needs nowhere near a full reply. The
 * reply placement's larger cap does — labels, prompts, and JSON syntax add
 * up, and a request that stops mid-array fails the parse and takes the whole
 * row with it, so the ceiling moves with the cap rather than pinching the row.
 */
const SUGGESTION_MAX_TOKENS = 512;
const SUGGESTION_MAX_TOKENS_REPLY = 1_024;

/**
 * The request shape every suggestion travels with, exported so the settings
 * page's test probe can send exactly what a real suggestion sends.
 *
 * No `reasoning` key: the pi-ai option type has no "off" level — absence is
 * off. Sharing the object rather than duplicating it is what keeps the probe
 * honest: a probe that fakes the shape would pass on configurations the real
 * request fails on.
 */
export const SUGGESTION_STREAM_OPTIONS: SimpleStreamOptions = {
	toolChoice: "none",
	maxTokens: SUGGESTION_MAX_TOKENS,
};

/** The instruction is authored in English; the output language is named in words the model reads. */
const LANGUAGE_NAMES: Record<Language, string> = { en: "English", "zh-cn": "简体中文" };

/**
 * The instruction half of the request, authored once in English — the output
 * language is named inside it, so the instruction itself is not translated and
 * no i18n table carries model-facing copy. Structured the way the prompt
 * guides all ask: a one-line role, the output contract with a worked example,
 * and the quality rules that keep the row worth its tap.
 */
const SUGGESTION_INSTRUCTION = `You are generating one-tap follow-up prompts for a chat assistant.

Reply with ONLY a JSON array of at most {count} objects, each {"label": string, "prompt": string}. Each label is 2-4 words shown on a button; each prompt is the full message the button sends, under 25 words. Do not use markdown, code fences, or any text outside the array. Write both fields in {language}.

Example (the shape, not the content — yours must fit the material below):
[{"label": "Compare notes", "prompt": "Compare the weekly review note with last month's and list what changed."}]

The suggestions must each do a different thing, name concrete material from the material below rather than speaking in general, and never ask what the material already answers.`;

/**
 * The empty screen's framing lines, joined with the workspace block into the
 * tagged material that rides above the instruction. One prompt per shape of
 * subject the empty screen can have: an open note, a probed workspace, or
 * nothing at all.
 */
const EMPTY_WITH_NOTE = `The conversation is empty. The user has the note "{path}" open as context.`;
const EMPTY_NO_NOTE = `The conversation is empty and no note is open; the suggestions should be about the user's vault in general.`;
const EMPTY_NO_NOTE_WORKSPACE = `The conversation is empty and no note is open; the suggestions should be grounded in the user's workspace below.`;
const WORKSPACE_INTRO = `The user's workspace:`;

/** The reply placement's framing line; the quoted reply is its material. */
const REPLY_INTRO = `Base the suggestions on this assistant reply:`;

/** What a suggestion request returns: parsed chips, plus the usage the parse must not swallow. */
export interface SuggestionResult {
	/** Null when nothing usable came back; the caller decides what absence shows. */
	actions: QuickAction[] | null;
	/** The billed usage, recorded even when the parse failed — the request still cost money. */
	usage: AssistantMessage["usage"] | undefined;
}

/**
 * Builds the one user message a suggestion request sends.
 *
 * The placement framing rides in the same message as the contract: one request,
 * one prompt, no system prompt to keep warm in a cache a side-channel will
 * never hit twice with the same prefix.
 *
 * The material goes up top in XML tags and the instruction lands at the
 * bottom — the order the prompt guides prescribe for longform data, and the
 * tags that keep note names and reply text (which users author) from reading
 * as instructions. Inside `<subject>`, every line between the framing and the
 * workspace is either a framing line, a workspace fact, or user-authored
 * bytes; the instruction cannot be reached by any of them.
 *
 * The empty placements quote the workspace facts the caller probed (folder
 * siblings, other open tabs, recently opened notes) so the chips are grounded
 * in what the user is actually surrounded by, not guessing at the vault; the
 * reply placement omits them — its subject is the reply itself, and workspace
 * noise there would only dilute it.
 */
export function buildSuggestionPrompt(scope: SuggestionScope, subject: string | null, language: Language, workspace?: WorkspaceContext): string {
	const materials: string[] = [];
	if (scope === "empty") {
		// No probed workspace means an empty one: the guard reads a real context either way.
		const quoted = workspace ?? EMPTY_WORKSPACE_CONTEXT;
		const workspaceQuoted = hasWorkspaceFacts(quoted);
		if (subject) {
			materials.push(EMPTY_WITH_NOTE.replace("{path}", subject));
		} else {
			materials.push(workspaceQuoted ? EMPTY_NO_NOTE_WORKSPACE : EMPTY_NO_NOTE);
		}
		if (workspaceQuoted) {
			materials.push([WORKSPACE_INTRO, ...renderWorkspaceLines(quoted)].join("\n"));
		}
	} else {
		materials.push(REPLY_INTRO);
		materials.push(String(subject ?? ""));
	}
	return `<subject>\n${materials.join("\n\n")}\n</subject>\n\n${SUGGESTION_INSTRUCTION.replace("{count}", String(CAPS[scope])).replace("{language}", LANGUAGE_NAMES[language])}`;
}

/**
 * The text of the last assistant reply, for the follow-up prompt to quote.
 *
 * Returns null when the transcript's newest assistant message carries no text —
 * a tool-only turn gives the suggestion prompt nothing to stand on, and a
 * follow-up row quoting an empty reply would be worse than no row.
 */
export function lastAssistantText(messages: readonly { role: string; content?: unknown }[]): string | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		const text = message.content
			.filter(
				(content): content is { type: "text"; text: string } =>
					typeof content === "object" && content !== null && (content as { type?: unknown }).type === "text",
			)
			.map((content) => content.text)
			.join("\n")
			.trim();
		if (!text) {
			continue;
		}
		return text.length > REPLY_SAMPLE_LIMIT ? `${text.slice(0, REPLY_SAMPLE_LIMIT)}\n…` : text;
	}
	return null;
}

/**
 * Reads the chips out of whatever the model answered with.
 *
 * Lenient by design: fences are stripped, the first `[` to the last `]` is the
 * candidate JSON, and entries missing a label or a prompt are dropped rather
 * than rejecting the row. An empty result is the caller's signal to show
 * nothing.
 */
export function parseSuggestedActions(text: string, cap: number = MAX_QUICK_ACTIONS): QuickAction[] {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start === -1 || end <= start) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	const actions: QuickAction[] = [];
	for (const entry of parsed.slice(0, cap)) {
		if (typeof entry !== "object" || entry === null) {
			continue;
		}
		const label = typeof (entry as Record<string, unknown>).label === "string" ? ((entry as Record<string, unknown>).label as string).trim() : "";
		const prompt = typeof (entry as Record<string, unknown>).prompt === "string" ? ((entry as Record<string, unknown>).prompt as string).trim() : "";
		if (!label || !prompt) {
			continue;
		}
		// Ids are positional: the row keys off them and the row is rebuilt whole
		// whenever the actions change, so stability across requests buys nothing.
		actions.push({ id: `suggested-${actions.length}`, label, prompt });
	}
	return actions;
}

/**
 * The plain text of an assistant reply, joined across its text blocks.
 *
 * Shared by the request path (where the text is parsed into chips) and the
 * settings page's test probe (which judges the same text), so both read the
 * answer the same way — a probe that joined blocks differently would disagree
 * with the feature about whether a model produced usable output.
 */
export function assistantMessageText(message: AssistantMessage): string {
	return message.content
		.filter((content): content is Extract<typeof content, { type: "text" }> => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

/**
 * One suggestion request, end to end.
 *
 * `streamSimple` is injected rather than reached for, so the caller keeps its
 * transport, key, and test seam — the same `StreamFn` the agent's turns run on.
 * Tools and reasoning are both off: the request wants a paragraph of JSON and
 * nothing else, and paying for deliberation on a nicety inverts the feature.
 *
 * Never throws. Every failure — transport error, aborted stop, unparseable
 * answer, empty parse — resolves to the same shape with `actions: null`, so the
 * callers' contract ("nothing to show") is one branch, not a try/catch each.
 */
export async function fetchQuickActionSuggestions(options: {
	streamSimple: StreamFn;
	model: Model<Api>;
	scope: SuggestionScope;
	subject: string | null;
	language: Language;
	/** The probed workspace facts; quoted by the empty placements, ignored by reply. */
	workspace?: WorkspaceContext;
	signal?: AbortSignal;
	apiKey?: string;
}): Promise<SuggestionResult> {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: buildSuggestionPrompt(options.scope, options.subject, options.language, options.workspace),
				timestamp: Date.now(),
			} satisfies UserMessage,
		],
	};
	const streamOptions: SimpleStreamOptions = {
		...SUGGESTION_STREAM_OPTIONS,
		// The shared shape stays untouched for the settings probe (which only
		// ever sends the empty placement); the reply placement widens its own
		// output budget to fit its six chips.
		maxTokens: options.scope === "reply" ? SUGGESTION_MAX_TOKENS_REPLY : SUGGESTION_MAX_TOKENS,
		...(options.apiKey !== undefined && { apiKey: options.apiKey }),
		...(options.signal && { signal: options.signal }),
	};
	let message: AssistantMessage;
	try {
		// StreamFn is allowed to hand back the stream or a promise for it.
		const stream = await options.streamSimple(options.model, context, streamOptions);
		message = await stream.result();
	} catch {
		return { actions: null, usage: undefined };
	}
	if (options.signal?.aborted || message.stopReason === "error" || message.stopReason === "aborted") {
		return { actions: null, usage: message.usage };
	}
	const actions = parseSuggestedActions(assistantMessageText(message), CAPS[options.scope]);
	return { actions: actions.length > 0 ? actions : null, usage: message.usage };
}
