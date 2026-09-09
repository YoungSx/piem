import type { App, TFile } from "obsidian";
import { makeSnippet } from "../session/sessionSearch";
import { throwIfAborted } from "../tools/toolResult";
import { MEMORY_HISTORY_ROOT, MEMORY_MAX_BYTES, MEMORY_PATH, MEMORY_ROOT, memoryPath } from "./memoryEdits";

export interface MemoryReadOptions {
	path?: string;
	query?: string;
	/** File offset for the next page of a keyword search. */
	offset?: number;
}

export interface MemoryDocument {
	path: string;
	text: string;
	truncated: boolean;
}

export interface MemoryReadResult {
	documents: MemoryDocument[];
	unreadable: string[];
	nextOffset: number | null;
	scanned: number;
}

const SEARCH_PAGE_SIZE = 20;
const DOCUMENT_CHARS = 8000;

/** Bounded, on-demand reads. No index, listener, timer, or model call. */
export async function readMemory(app: App, options: MemoryReadOptions, signal?: AbortSignal): Promise<MemoryReadResult> {
	throwIfAborted(signal);
	const query = options.query?.trim();
	if (options.query !== undefined && !query) throw new Error("Use a non-empty query, or omit it to recall current memory.");
	const offset = options.offset ?? 0;
	if (!Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && !query)) {
		throw new Error("offset must be a non-negative integer used with a query.");
	}
	const result: MemoryReadResult = { documents: [], unreadable: [], nextOffset: null, scanned: 0 };
	let files: TFile[];
	if (options.path) {
		const path = memoryPath(options.path);
		const file = app.vault.getFileByPath(path);
		if (!file && app.vault.getAbstractFileByPath(path)) throw new Error(`Memory path is a folder: ${path}`);
		files = file ? [file] : [];
	} else {
		const folder = app.vault.getFolderByPath(MEMORY_ROOT);
		if (!folder) {
			if (app.vault.getAbstractFileByPath(MEMORY_ROOT)) throw new Error(`${MEMORY_ROOT} must be a folder.`);
			return result;
		}
		files = app.vault.getMarkdownFiles()
			.filter((file) => file.path.startsWith(`${MEMORY_ROOT}/`) && !file.path.startsWith(`${MEMORY_HISTORY_ROOT}/`))
			.sort((a, b) => Number(b.path === MEMORY_PATH) - Number(a.path === MEMORY_PATH) || b.stat.mtime - a.stat.mtime || b.path.localeCompare(a.path));
		if (!query) {
			// Reading recent logs even before MEMORY.md exists closes the cold-start
			// gap. Topic files remain reachable through links and keyword search.
			const core = files.filter((file) => file.path === MEMORY_PATH);
			const daily = files.filter((file) => /^Piem\/memory\/\d{4}-\d{2}-\d{2}\.md$/.test(file.path))
				.sort((a, b) => b.path.localeCompare(a.path)).slice(0, 3);
			files = [...core, ...daily];
		}
	}
	const page = query ? files.slice(offset, offset + SEARCH_PAGE_SIZE) : files;
	if (query && offset + page.length < files.length) result.nextOffset = offset + page.length;
	for (const file of page) {
		throwIfAborted(signal);
		result.scanned += 1;
		// Vault.read cannot be stopped halfway through a file. Check the indexed
		// size first; normal read remains available for oversized legacy notes.
		if (file.stat.size > MEMORY_MAX_BYTES) {
			result.unreadable.push(file.path);
			continue;
		}
		let text: string;
		try {
			text = await app.vault.read(file);
		} catch {
			result.unreadable.push(file.path);
			continue;
		}
		throwIfAborted(signal);
		if (new TextEncoder().encode(text).byteLength > MEMORY_MAX_BYTES) {
			result.unreadable.push(file.path);
			continue;
		}
		if (query && !text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
		const visible = query ? makeSnippet(text, query, 600) : text.slice(0, DOCUMENT_CHARS);
		result.documents.push({ path: file.path, text: visible, truncated: visible !== text });
	}
	throwIfAborted(signal);
	return result;
}
