import { normalizeVaultPath } from "../vault/path";

export const MEMORY_ROOT = "Piem/memory";
export const MEMORY_PATH = `${MEMORY_ROOT}/MEMORY.md`;
export const MEMORY_HISTORY_ROOT = `${MEMORY_ROOT}/history`;
export const MEMORY_MAX_BYTES = 64 * 1024;

export type MemoryEdit =
	| { type: "append"; text: string }
	| { type: "replace"; oldText: string; newText: string }
	| { type: "remove"; oldText: string };

/** User-editable Markdown, with no migration or metadata parser to strand old files. */
export function memoryPath(input = MEMORY_PATH): string {
	const path = normalizeVaultPath(input);
	if (!path.startsWith(`${MEMORY_ROOT}/`) || !path.endsWith(".md") || path.startsWith(`${MEMORY_HISTORY_ROOT}/`)) {
		throw new Error(`Use a Markdown file inside ${MEMORY_ROOT}/, outside history/.`);
	}
	return path;
}

/** Apply the whole batch in memory before any file is written. */
export function applyMemoryEdits(content: string, edits: readonly MemoryEdit[]): string {
	if (edits.length === 0 || edits.length > 50) throw new Error("Pass between 1 and 50 memory changes.");
	let next = content;
	for (const edit of edits) {
		if (edit.type === "append") {
			const text = edit.text.trim();
			if (!text) throw new Error("A memory entry must contain text.");
			// Match a whole block, not a substring of another fact. Retrying the
			// same append is harmless, including after a lost tool response.
			if (`\n${next}\n`.includes(`\n${text}\n`)) continue;
			next = `${next}${next && !next.endsWith("\n") ? "\n" : ""}${text}\n`;
			continue;
		}
		if (edit.type === "replace" && edit.oldText === "" && next === "") {
			next = edit.newText;
			continue;
		}
		if (!edit.oldText) throw new Error("oldText may be empty only when replacing an empty memory file.");
		const at = next.indexOf(edit.oldText);
		if (at < 0 || next.indexOf(edit.oldText, at + 1) >= 0) {
			throw new Error("oldText must match exactly once. Read the current memory and retry with a unique passage.");
		}
		const replacement = edit.type === "remove" ? "" : edit.newText;
		next = next.slice(0, at) + replacement + next.slice(at + edit.oldText.length);
	}
	const bytes = new TextEncoder().encode(next).byteLength;
	// Existing oversized notes remain readable and can be shortened. Never
	// silently truncate a fact or discard old entries to make room.
	if (bytes > MEMORY_MAX_BYTES && bytes > new TextEncoder().encode(content).byteLength) {
		throw new Error(`Memory files may grow to ${MEMORY_MAX_BYTES} bytes. Shorten this file or move detail to another memory note.`);
	}
	return next;
}
