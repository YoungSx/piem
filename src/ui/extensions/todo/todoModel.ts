/**
 * TODO overlay adapter — the one Pi extension piem renders specially.
 *
 * Policy: piem bridges Pi extensions generically and renders whatever text they
 * emit. This module is the single, deliberate exception. It reads the
 * `@juicesharp/rpiv-todo` overlay's emitted text to (a) drive a progress badge on
 * the context-row entry icon and (b) let the feed hide the overlay while it is
 * collapsed, instead of leaving the "… to expand" ghost line the extension prints.
 *
 * We parse the rendered text, not the extension's internal state, and we do NOT
 * pin its version — so every reading here degrades safely: `readTodoModel`
 * returns null on any shape it does not recognize, and the caller falls back to
 * the generic renderer (today's behavior). The only locale-invariant signals it
 * leans on are the digits in the "(done/total)" heading, the active/idle dot
 * (● / ○), and the per-task status glyphs (○ ◐ ✓). The localized "{key} to
 * expand" hint prose is never matched.
 */
import type { NativeComponentNode } from "../../../extensions/compat/componentTree";
import { plainText } from "../../../extensions/compat/textMetrics";

/** The widget key rpiv-todo mounts its overlay under (see its todo-overlay.ts). */
export const TODO_WIDGET_KEY = "rpiv-todos";

export interface TodoModel {
	/** Completed task count — the left half of the overlay's "(done/total)". */
	readonly completed: number;
	/** Total visible tasks — the right half. */
	readonly total: number;
	/** Something is pending or in progress (heading shows ●); all done shows ○. */
	readonly active: boolean;
	/** The overlay is collapsed to its heading — nothing worth a card in the feed. */
	readonly collapsed: boolean;
}

// The active dot the heading wears while work remains; ○ once everything is done.
const ACTIVE_DOT = "●"; // ●
// Per-task status glyphs the overlay prints (rpiv-todo view/format.ts): ○ pending,
// ◐ in_progress, ✓ completed. Locale-invariant, unlike the collapsed hint's prose,
// so a body row is told from the hint by the glyph alone.
const TASK_GLYPH = /^[○◐✓]/; // ○ ◐ ✓
// The "├─ " / "└─ " tree prefix before every body row.
const TREE_PREFIX = /^[├└][─\s]*/; // ├ └ ─
// The "+N more (…)" overflow summary row the overlay appends when rows are hidden.
const OVERFLOW_ROW = /^\+/;

function flattenText(node: NativeComponentNode | undefined): string {
	if (!node) return "";
	if (node.kind === "text") return node.text;
	if (node.kind === "container") return node.children.map(flattenText).join("\n");
	return "";
}

/**
 * Read the overlay's structured meaning out of its rendered text, or null when the
 * text is not the shape we know (→ the caller renders it generically). Pure: no
 * React, no DOM — this is where every fragile assumption about the extension's
 * output is quarantined.
 */
export function readTodoModel(node: NativeComponentNode | undefined): TodoModel | null {
	const lines = flattenText(node)
		.split("\n")
		.map((line) => plainText(line).trim())
		.filter((line) => line.length > 0);
	if (lines.length === 0) return null;

	const heading = lines[0]!;
	const count = heading.match(/(\d+)\s*\/\s*(\d+)/);
	if (!count) return null;

	const body = lines.slice(1);
	const bodyContent = (line: string): string => line.replace(TREE_PREFIX, "");
	const hasTaskRow = body.some((line) => TASK_GLYPH.test(bodyContent(line)));
	const hasOverflowRow = body.some((line) => OVERFLOW_ROW.test(bodyContent(line)));
	// Collapsed = the heading plus only its "… to expand" hint. Recognized only
	// negatively (the hint is localized prose, so it is never matched directly):
	// a body that is neither a task row nor a "+N more" overflow, in ≤1 line, is
	// the hint. ≥2 body rows are always real content, so glyph recognition is
	// leaned on for the single-row case alone — a glyph drift can never hide a
	// real list, at worst it boxes a collapsed hint. Any positively-recognized
	// content (task or overflow) keeps it expanded rather than hidden.
	const collapsed = body.length <= 1 && !hasTaskRow && !hasOverflowRow;

	return {
		completed: Number(count[1]),
		total: Number(count[2]),
		active: heading.includes(ACTIVE_DOT),
		collapsed,
	};
}
