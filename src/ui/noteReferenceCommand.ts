import { Notice, type Editor } from "obsidian";
import { buildNoteReference } from "./noteReference";
import { MAX_REFERENCE_EXCERPT, type ContextReference } from "../agent/contextReference";
import type { Translator } from "../i18n";

/**
 * Collects the reference for the editor the user is acting on and hands it to
 * `deliver`, which opens the chat panel and prefills the composer.
 *
 * Returns false when there is nothing to reference (no file, or no selection
 * when one is required), so callers can fall back or warn.
 */
export function requestNoteReference(
	editor: Editor,
	filePath: string | null | undefined,
	options: { selectionOnly: boolean; deliver: (text: string, truncated: boolean) => void },
): boolean {
	if (!filePath) {
		return false;
	}
	const rawSelection = options.selectionOnly ? editor.getSelection() : "";
	const selection = rawSelection.trim();
	if (options.selectionOnly && !selection) {
		return false;
	}

	const { startLine, endLine } = selectionRange(editor, selection);
	const reference = buildNoteReference({ path: filePath, selection: rawSelection, startLine, endLine });
	options.deliver(reference.text, reference.truncated);
	return true;
}

function selectionRange(editor: Editor, trimmedSelection: string): { startLine?: number; endLine?: number } {
	if (!trimmedSelection || editor.listSelections().length !== 1) {
		// Multi-cursor selections have no single meaningful line range.
		return {};
	}
	const anchor = editor.getCursor("anchor");
	const head = editor.getCursor("head");
	const forward = anchor.line < head.line || (anchor.line === head.line && anchor.ch <= head.ch);
	const first = forward ? anchor : head;
	const last = forward ? head : anchor;
	return { startLine: first.line + 1, endLine: last.line + 1 };
}

/** Warns once per action when a quoted selection had to be clipped. */
export function warnIfTruncated(truncated: boolean, t: Translator): void {
	if (truncated) {
		// Sentence case is enforced by eslint-plugin-obsidianmd for UI text.
		new Notice(t.t("noteReference.truncated"));
	}
}

/** Snapshot the selection at the user's action; later navigation cannot change it. */
export function collectNoteReference(editor: Editor, path: string | null | undefined, selectionOnly: boolean): ContextReference | null {
	if (!path) return null;
	if (!selectionOnly) return { kind: "file", path };
	const text = editor.getSelection();
	if (!text.trim()) return null;
	const chars = Array.from(text);
	return { kind: "selection", path, text: chars.slice(0, MAX_REFERENCE_EXCERPT).join(""),
		...selectionRange(editor, text), ...(chars.length > MAX_REFERENCE_EXCERPT ? { truncated: true } : {}),
	};
}
