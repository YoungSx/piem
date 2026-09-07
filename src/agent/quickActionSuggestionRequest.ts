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
 * Free of React and DOM imports so the prompt, the parse, and the failure
 * contract unit-test without a renderer or a network.
 */

import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, UserMessage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { MAX_QUICK_ACTIONS, type QuickAction } from "../ui/quickActionSuggestions";
import type { Language, Translator } from "../i18n";
import { EMPTY_WORKSPACE_CONTEXT, hasWorkspaceFacts, renderWorkspaceLines, type WorkspaceContext } from "./workspaceContext";

/** Where the suggestions are headed; the placement decides the prompt's framing. */
export type SuggestionScope = "empty" | "reply";

/**
 * Ceiling on the reply text quoted back to the model. A suggestion prompt
 * should not cost what the original reply cost; anything past this is cut-off
 * context, not conversation the model needs verbatim.
 */
const REPLY_SAMPLE_LIMIT = 4_000;

/** A JSON array of three short objects needs nowhere near a full reply. */
const SUGGESTION_MAX_TOKENS = 512;

/** The instruction is authored in English; the output language is named in words the model reads. */
const LANGUAGE_NAMES: Record<Language, string> = { en: "English", "zh-cn": "简体中文" };

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
 * The empty placements quote the workspace facts the caller probed (folder
 * siblings, other open tabs, recently opened notes) so the chips are grounded
 * in what the user is actually surrounded by, not guessing at the vault; the
 * reply placement omits them — its subject is the reply itself, and workspace
 * noise there would only dilute it.
 */
export function buildSuggestionPrompt(scope: SuggestionScope, subject: string | null, language: Language, t: Translator, workspace?: WorkspaceContext): string {
	const lines = [t.t("quickActions.suggest.instruction", { language: LANGUAGE_NAMES[language] })];
	if (scope === "empty") {
		// No probed workspace means an empty one: the guard reads a real context either way.
		const quoted = workspace ?? EMPTY_WORKSPACE_CONTEXT;
		const workspaceQuoted = hasWorkspaceFacts(quoted);
		if (subject) {
			lines.push(t.t("quickActions.suggest.emptyWithNote", { path: subject }));
		} else {
			lines.push(t.t(workspaceQuoted ? "quickActions.suggest.emptyNoNoteWorkspace" : "quickActions.suggest.emptyNoNote"));
		}
		if (workspaceQuoted) {
			lines.push([t.t("quickActions.suggest.workspaceIntro"), ...renderWorkspaceLines(quoted)].join("\n"));
		}
	} else {
		lines.push(t.t("quickActions.suggest.reply", { reply: subject ?? "" }));
	}
	return lines.join("\n\n");
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
export function parseSuggestedActions(text: string): QuickAction[] {
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
	for (const entry of parsed.slice(0, MAX_QUICK_ACTIONS)) {
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
	t: Translator;
	/** The probed workspace facts; quoted by the empty placements, ignored by reply. */
	workspace?: WorkspaceContext;
	signal?: AbortSignal;
	apiKey?: string;
}): Promise<SuggestionResult> {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: buildSuggestionPrompt(options.scope, options.subject, options.language, options.t, options.workspace),
				timestamp: Date.now(),
			} satisfies UserMessage,
		],
	};
	const streamOptions: SimpleStreamOptions = {
		// No `reasoning` key: the pi-ai option type has no "off" level — absence is off.
		toolChoice: "none",
		maxTokens: SUGGESTION_MAX_TOKENS,
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
	const text = message.content
		.filter((content): content is Extract<typeof content, { type: "text" }> => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	const actions = parseSuggestedActions(text);
	return { actions: actions.length > 0 ? actions : null, usage: message.usage };
}
