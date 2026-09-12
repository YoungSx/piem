/**
 * Puts the notes the user is working with — and what surrounds them — in front of
 * the model on every turn.
 *
 * The panel could always *answer* "which note am I looking at" — `get_active_note`
 * reports it — but nothing ever volunteered it, so "rewrite this note" made the
 * model ask which one, or guess from earlier context. This closes that gap by
 * appending a small block to the request, without touching the transcript.
 *
 * Wired as pi's `transformContext` (`AgentOptions.transformContext`), which pi
 * documents for exactly this ("Injecting context from external sources"). Three
 * properties make it the right seam rather than rewriting the system prompt or
 * pushing a real message:
 *
 * - **Nothing is persisted.** pi calls this on a copy of the transcript and
 *   feeds the result straight to `convertToLlm`; the return value never reaches
 *   `agent.state.messages`. So the block stays out of the session log, out of the
 *   chat panel, and out of the next turn's history. A synthetic user message
 *   would be written to the `.jsonl` and then re-sent forever.
 * - **Prompt caching survives.** Anthropic caching is prefix-based, and the
 *   breakpoints sit on the system block, the last tool, and the last user
 *   message. Appending here makes the block *become* the last user message, so
 *   the breakpoint moves with it and the conversation history behind it stays
 *   cached. Editing the system prompt instead sits at the front of the prefix
 *   and invalidates the tool definitions plus the entire history every turn.
 * - **Every turn is covered for free.** pi applies this per LLM request, not per
 *   `prompt()` call, so multi-turn tool loops re-inject without any bookkeeping
 *   about when to refresh. The service supplies a frozen per-prompt ref list, so
 *   navigation during a tool loop cannot silently retarget the user's request.
 *
 * The block must be byte-identical between turns whenever the reported facts have
 * not changed. Anything volatile in it makes the block itself miss the cache for
 * no benefit, which is why a cursor position, a scroll offset and a word count
 * are permanently out: they move on every keystroke and the model can act on
 * none of them. The active note's *content* is the opposite case — re-read every
 * turn, but its bytes only move when the note does, which is exactly when a fresh
 * read is the point. The `mtime` is emitted as a fixed ISO string off the file
 * stat, stable until the file changes, so it costs a cache byte only when it is
 * news.
 *
 * The selection sits on the near side of that line despite moving often. It is
 * absent entirely until the user selects something, it is frozen for the run
 * ({@link FrozenRunContext}) rather than re-read per turn, and when present it is
 * the single strongest statement of what the request is about — "translate this"
 * is unanswerable without it. A selection *offset* would have been the volatile
 * half with none of the value, so only the text and its length are reported.
 *
 * The date is the one fact here that moves on its own, and it earns the
 * exception: it changes once a day, at the tail of the prefix, and without it
 * "today's note" is a guess. It deliberately does *not* live in the system
 * prompt, where it would be assembled once per session and then quietly lie
 * through midnight. Facts that genuinely cannot change mid-session — the vault,
 * the device, the interface language — do live there; see
 * {@link ./environmentPrompt}.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextRef } from "./contextRefs";
import { EMPTY_LINK_CONTEXT, renderLinkLines, type LinkContext } from "./linkContext";
import { renderOutlineLines, type NoteOutline } from "./noteOutline";
import { EMPTY_WORKSPACE_CONTEXT, renderWorkspaceLines, type WorkspaceContext } from "./workspaceContext";

/**
 * Timestamp stamped on the injected message.
 *
 * A real clock reading would make the message differ every turn. pi's providers
 * do not send `timestamp` to the API, so this is invisible to the model either
 * way — a fixed value just keeps the object deterministic for tests and for
 * anyone diffing two requests. Zero rather than a plausible date so nobody
 * mistakes it for a real event time.
 */
const INJECTED_TIMESTAMP = 0;

/**
 * How much of the active note's text rides along on every turn.
 *
 * Roughly 5k tokens at the usual ~4 characters-per-token ratio: enough for the
 * working notes people actually edit in the panel, small enough that a
 * megabyte-sized clipboard dump in the vault cannot bill a fortune per turn.
 * Pinned notes never get content — they were named deliberately and stay one
 * `read` tool call away — so this bounds the worst case to one document.
 */
export const MAX_ACTIVE_NOTE_CHARS = 20_000;

/**
 * How much selected text rides along.
 *
 * A selection is a pointer — "this paragraph", "these three bullets" — and at
 * that size it is the strongest statement of intent the block can carry. Past
 * roughly a thousand tokens it stops being a pointer and becomes a second copy
 * of the note, whose full text is already here. Over the budget the block
 * reports the size and names the tool that can page it, the same trade a pinned
 * note makes with its body.
 */
export const MAX_SELECTION_CHARS = 4_000;

/**
 * Weekday names for the date line.
 *
 * A fixed table rather than `toLocaleDateString`: the block's bytes must depend
 * only on the facts, and a locale-derived name would make the same Saturday
 * render differently on two machines — or change under the user's feet when they
 * switch Obsidian's language.
 */
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/**
 * The active note's current text, read from its open editor or the vault.
 *
 * The service supplies the raw payload; this module decides how much of it the
 * model sees. `modifiedAt` is the file stat's `mtime` in epoch milliseconds;
 * it is null for an editor buffer, whose unsaved text has no file timestamp.
 */
export interface InjectedNote {
	path: string;
	content: string;
	modifiedAt: number | null;
}

/**
 * What the user had selected when they sent the message.
 *
 * Frozen with the refs rather than re-read per turn, because it is *intent*, not
 * state: it records the passage the person meant when they typed "translate
 * this", and a mid-loop click that collapses the selection must not retarget the
 * request that is already running. The consequence is deliberate — after the
 * model edits the note, the selection text it was given may no longer appear in
 * the re-read body. That is the honest reading: the user selected the text as it
 * was before the edit.
 */
export interface InjectedSelection {
	/** The note the selection was read from, matched against the active ref. */
	path: string;
	/** The selected text, or `null` when it exceeded {@link MAX_SELECTION_CHARS}. */
	text: string | null;
	/** Character count of the whole selection, reported either way. */
	length: number;
}

/**
 * The half of a turn's context that is frozen for one user run.
 *
 * `refs` was already frozen so a mid-loop note switch could not retarget a write.
 * Everything derived from those refs has to freeze *with* them: the folder, the
 * link graph, the pinned notes' skeletons and the selection all answer questions
 * about the notes the ref list names, and a live reading paired with a frozen
 * list would eventually name one note as active and describe another's
 * surroundings — a block that contradicts itself.
 *
 * The active note's *body* is deliberately not in here. It is re-read every turn
 * so an `edit` the model just made is visible to its next turn, which is the one
 * place a live reading is more honest than a snapshot.
 */
export interface FrozenRunContext {
	refs: ContextRef[];
	workspace: WorkspaceContext;
	links: LinkContext;
	outlines: NoteOutline[];
	selection: InjectedSelection | null;
}

/**
 * What a failed probe degrades to.
 *
 * The refs still stand — they come from the panel's own state, not from Obsidian —
 * so a structural surprise costs the surroundings and not the note the user is
 * looking at.
 */
export const EMPTY_RUN_CONTEXT: Omit<FrozenRunContext, "refs"> = {
	workspace: EMPTY_WORKSPACE_CONTEXT,
	links: EMPTY_LINK_CONTEXT,
	outlines: [],
	selection: null,
};

/**
 * Everything one turn's block reports.
 *
 * An object rather than positional parameters. Four facts of four different
 * shapes read as four anonymous arguments at the call site, and the two optional
 * ones would have to be passed as `null` to reach the third — the exact shape
 * that makes a caller pass a workspace context where a note belonged.
 */
export interface InjectedContext {
	/** Notes named to the model, active note first. */
	refs: readonly ContextRef[];
	/** The active note's text, or `null` when the read failed. */
	note?: InjectedNote | null;
	/** What the user had selected, or `null` when nothing was. */
	selection?: InjectedSelection | null;
	/** The active note's place in the link graph. */
	links?: LinkContext;
	/** Skeletons for the pinned notes, matched to their refs by path. */
	outlines?: readonly NoteOutline[];
	/** Facts about the folder and tabs around the active note. */
	workspace?: WorkspaceContext;
	/** The current local date, or `null` to leave it out. */
	today?: Date | null;
}

/**
 * How much of a note fits the budget, and what got left out.
 *
 * Truncation happens on line boundaries: a block that ends mid-word reads as
 * corruption to a model, while a block that ends after a complete line reads as
 * a document that continues. Only a single line longer than the whole budget
 * falls to a character slice — a line that size is already a broken document,
 * and the budget must still hold.
 */
function sliceForBudget(content: string): { text: string; shownLines: number; totalLines: number; truncated: boolean } {
	const lines = content.split("\n");
	if (content.length <= MAX_ACTIVE_NOTE_CHARS) {
		return { text: content, shownLines: lines.length, totalLines: lines.length, truncated: false };
	}
	const kept: string[] = [];
	let used = 0;
	for (const line of lines) {
		const cost = line.length + (kept.length === 0 ? 0 : 1);
		if (used + cost > MAX_ACTIVE_NOTE_CHARS) {
			break;
		}
		kept.push(line);
		used += cost;
	}
	if (kept.length === 0) {
		const text = content.slice(0, MAX_ACTIVE_NOTE_CHARS);
		return { text, shownLines: text.split("\n").length, totalLines: lines.length, truncated: true };
	}
	return { text: kept.join("\n"), shownLines: kept.length, totalLines: lines.length, truncated: true };
}

/**
 * Renders the active note's content section, under its path line.
 *
 * A note containing `</context>` could close the wrapper early and smuggle the
 * rest past it; `<note-content>` bounds that blast radius to its own tag, the
 * same trade every tool that quotes file contents into a prompt accepts.
 */
function renderNoteBody(note: InjectedNote): string[] {
	const lines: string[] = [];
	if (note.modifiedAt != null) {
		lines.push(`Last modified: ${new Date(note.modifiedAt).toISOString()}`);
	}
	if (note.content === "") {
		lines.push("The note is empty.");
		return lines;
	}
	const slice = sliceForBudget(note.content);
	const label = slice.truncated
		? `first ${slice.shownLines} of ${slice.totalLines} lines`
		: slice.totalLines === 1
			? "1 line"
			: `${slice.totalLines} lines`;
	lines.push(`Note content (${label}):`);
	lines.push("<note-content>", slice.text, "</note-content>");
	return lines;
}

/**
 * Renders the selection, under the active note's body.
 *
 * After the body rather than before it: the block is the last message in the
 * request, so its tail sits closest to where the model generates, and "this
 * passage, in that note" reads in the order it is written. The tag wrapper does
 * the same job `<note-content>` does — a selection containing `</context>` closes
 * only its own tag.
 *
 * Over budget the line stops quoting and starts pointing. It names the tool by
 * the argument that gets the text, because "read the selection" without that
 * argument returns the note instead and looks like the tool ignored the request.
 */
function renderSelection(selection: InjectedSelection): string[] {
	if (selection.text === null) {
		return [
			`The user has ${selection.length} characters selected in this note, which is more than fits here. Read it with get_active_note (includeSelection) if the request depends on the exact text.`,
		];
	}
	const unit = selection.length === 1 ? "character" : "characters";
	return [`Selected text (${selection.length} ${unit}):`, "<selection>", selection.text, "</selection>"];
}

/**
 * Renders the date line.
 *
 * Assembled from the local-time getters rather than `toISOString`, which formats
 * in UTC: for anyone east of Greenwich in the evening, or west of it in the
 * morning, the UTC date is a different day than the one on the user's wall. A
 * "today's note" resolved off that would be the wrong note, and the mistake
 * would be invisible for most of the day.
 */
function formatToday(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `Today: ${year}-${month}-${day} (${WEEKDAY_NAMES[date.getDay()]})`;
}

/**
 * The block's body, one line per fact, or `[]` when there is nothing to report.
 *
 * Order is deliberate and stable, and runs from nearest to furthest: the date,
 * then the active note (path, body, selection, link graph), then each pinned note
 * with its skeleton, then the workspace around them. Reordering would rewrite the
 * whole block for no new information, so the order is part of the cache contract,
 * not a formatting preference.
 *
 * Full vault paths for every note, never the shortened labels the chips display:
 * the path is what the model passes to `read` and `edit`, so a truncated one
 * would be worse than useless.
 *
 * Only the active note carries content ({@link InjectedNote}); a pinned note
 * stays a path line, and the model reads it with the `read` tool when it needs
 * to. When the active ref is absent — follow dismissed, non-Markdown leaf — or
 * the read failed and `note` is `null`, that entry degrades to the path-only
 * form, which is still strictly better than nothing.
 */
function renderContextLines(input: InjectedContext): string[] {
	const lines: string[] = [];
	if (input.today) {
		lines.push(formatToday(input.today));
	}
	for (const ref of input.refs) {
		if (ref.kind === "active") {
			lines.push(`Active note: ${ref.path}`);
			if (input.note && input.note.path === ref.path) {
				lines.push(...renderNoteBody(input.note));
			}
			if (input.selection && input.selection.path === ref.path) {
				lines.push(...renderSelection(input.selection));
			}
			// Link facts describe the active note, so they belong to its entry rather
			// than to the block: with follow dismissed there is no note for them to be
			// about, and the probe stops reading them.
			lines.push(...renderLinkLines(input.links ?? EMPTY_LINK_CONTEXT));
		} else {
			lines.push(`Pinned note: ${ref.path}`);
			const outline = input.outlines?.find((candidate) => candidate.path === ref.path);
			if (outline) {
				lines.push(...renderOutlineLines(outline));
			}
		}
	}
	lines.push(...renderWorkspaceLines(input.workspace ?? EMPTY_WORKSPACE_CONTEXT));
	return lines;
}

/**
 * Renders the block, or `""` when nothing is worth reporting.
 *
 * The tag wrapper marks the boundary between this and the user's own words, so a
 * note title that reads like an instruction cannot be mistaken for one.
 */
export function renderContextBlock(input: InjectedContext): string {
	const body = renderContextLines(input);
	if (body.length === 0) {
		return "";
	}
	return ["<context>", ...body, "</context>"].join("\n");
}

/**
 * Appends the context block to the messages bound for the model.
 *
 * Returns `messages` unchanged when there is nothing to report, which costs zero
 * tokens and, more importantly, avoids telling the model the negative fact that
 * nothing is open. That is a fact it has no use for, and stating it would make
 * the prompt churn every time the user clicked away from a note.
 *
 * This transient projection uses `role: "user"` directly. Pi also supports
 * `CustomMessage` and converts its content to a user message; its `details`
 * remain application metadata. No transcript entry is created by this projection.
 */
export function injectContext(messages: AgentMessage[], input: InjectedContext): AgentMessage[] {
	const content = renderContextBlock(input);
	if (content === "") {
		return messages;
	}
	return [...messages, { role: "user", content, timestamp: INJECTED_TIMESTAMP }];
}
