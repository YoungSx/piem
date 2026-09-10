import { prepareFuzzySearch, sortSearchResults, type SearchResult } from "obsidian";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import type { CommandEntry } from "./CommandMenu";

/** The existing slash commands are the base an extension wraps, without a filesystem or terminal dependency. */
export function createComposerAutocomplete(getCommands: () => readonly CommandEntry[]): AutocompleteProvider {
	return {
		triggerCharacters: ["/"],
		getSuggestions(lines, cursorLine, cursorCol, options) {
			if (options.signal.aborted || cursorLine !== 0 || lines.length !== 1) return Promise.resolve(null);
			const prefix = (lines[0] ?? "").slice(0, cursorCol);
			if (!prefix.startsWith("/") || /\s/.test(prefix)) return Promise.resolve(null);
			const query = prefix.slice(1);
			const commands = getCommands();
			const search = prepareFuzzySearch(query);
			const scored = commands
				.map((command) => ({ command, match: query ? search(command.name) : { score: 0, matches: [] } }))
				.filter((entry): entry is { command: CommandEntry; match: SearchResult } => entry.match !== null);
			if (query) sortSearchResults(scored);
			return Promise.resolve({ prefix, items: scored.map(({ command }) => ({
				value: command.invocation, label: `/${command.name}`, description: command.description,
			})) });
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const line = lines[cursorLine] ?? "";
			const start = Math.max(0, cursorCol - prefix.length);
			const value = prefix.startsWith("/") && start === 0 ? `/${item.value} ` : item.value;
			const updated = [...lines];
			updated[cursorLine] = line.slice(0, start) + value + line.slice(cursorCol);
			return { lines: updated, cursorLine, cursorCol: start + value.length };
		},
	};
}

export function editorPosition(text: string, offset: number): { lines: string[]; cursorLine: number; cursorCol: number } {
	const lines = text.split("\n");
	const before = text.slice(0, Math.max(0, Math.min(text.length, offset))).split("\n");
	return { lines, cursorLine: before.length - 1, cursorCol: before.at(-1)?.length ?? 0 };
}

export function editorOffset(lines: string[], cursorLine: number, cursorCol: number): number {
	const line = Math.max(0, Math.min(lines.length - 1, cursorLine));
	return lines.slice(0, line).reduce((length, value) => length + value.length + 1, 0)
		+ Math.max(0, Math.min(lines[line]?.length ?? 0, cursorCol));
}
