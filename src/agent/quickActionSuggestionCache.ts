/**
 * The empty screen's per-note suggestion cache.
 *
 * The empty-screen chips cost a billed request every time a blank panel opens,
 * and the answer for a given note barely changes between visits. This cache
 * lets the panel show the previous answer instantly (stale) while a fresh
 * request revalidates it — the stale-while-revalidate contract issue #200
 * asks for: cached chips first, a live answer replaces them when one arrives,
 * and the cache stands in when the request cannot.
 *
 * Keyed by the tuple the suggestion prompt is actually built from — the model
 * that produces the answer, the language, the note path, and the workspace
 * facts the prompt quotes — so a switch from note A to note B reads its own
 * entry, a language flip does not resurrect chips worded in the old tongue,
 * choosing a lighter suggestion model does not serve the previous model's
 * answer as if it were fresh, and a different set of open tabs does not serve
 * chips written for a room the user has left. Not persisted to disk: the cache
 * survives a panel close and reopen but dies with a plugin reload, which is
 * the right trade for chips that are decoration — the built-in row has always
 * covered the cold start.
 *
 * Free of React and Obsidian imports so the eviction and key rules unit-test
 * without a renderer or a vault.
 */

import type { QuickAction } from "../ui/quickActionSuggestions";
import type { WorkspaceContext } from "./workspaceContext";

/** The inputs a suggestion answer depends on; all of them key the entry. */
export interface SuggestionCacheKey {
	/** The panel's render language — chips come back worded in it. */
	language: string;
	/** The active note's vault path, or null for the vault-wide row. */
	notePath: string | null;
	/** Identity of the model that produced the answer — see `suggestionModelKey`. */
	modelKey: string;
	/** The workspace facts the prompt quotes, already flattened by {@link workspaceKeyPart}. */
	workspace: string;
}

/**
 * Flattens the workspace facts into the cache key's part.
 *
 * The prompt is built from the rendered lines, so the key has to move whenever
 * any of them would: the folder and its entries, the other open tabs, the
 * recently opened notes. Every field is already sorted upstream, so joining the
 * parts with a separator paths cannot contain is deterministic.
 */
export function workspaceKeyPart(workspace: WorkspaceContext): string {
	const folder = workspace.folder;
	const folderPart = folder === null ? "" : `${folder.path ?? ""}|${folder.entries.join("|")}|${folder.totalEntries}`;
	return [folderPart, ...workspace.openTabs, ...workspace.recentFiles].join("|");
}

/** How many notes keep an entry. Blanks across a vault outgrow memory fast. */
const MAX_ENTRIES = 32;

/** Builds the map key from a cache key's parts. */
function cacheKeyString(key: SuggestionCacheKey): string {
	return [key.modelKey, key.language, key.notePath ?? "", key.workspace].join("\0");
}

/**
 * A tiny insertion-ordered LRU: reads refresh recency, writes beyond the cap
 * evict the least recently used, and a rewrite of an existing key renews its
 * place without growing the map. `get` returns the array the caller stored —
 * callers treat chips as immutable, so no defensive copy is needed.
 */
export class QuickActionSuggestionCache {
	private readonly entries = new Map<string, QuickAction[]>();

	/** The cached chips, or undefined when this key has never been answered. */
	get(key: SuggestionCacheKey): QuickAction[] | undefined {
		const id = cacheKeyString(key);
		const actions = this.entries.get(id);
		if (actions === undefined) {
			return undefined;
		}
		// Read refreshes recency: delete-and-set moves the entry to the tail,
		// which is Map's insertion order standing in for an LRU list.
		this.entries.delete(id);
		this.entries.set(id, actions);
		return actions;
	}

	/** Stores an answer, evicting the oldest entry when the cap is already full. */
	set(key: SuggestionCacheKey, actions: QuickAction[]): void {
		const id = cacheKeyString(key);
		// Renewing an existing key must not grow the map past the cap.
		this.entries.delete(id);
		this.entries.set(id, actions);
		if (this.entries.size > MAX_ENTRIES) {
			// The first key in insertion order is the least recently used.
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) {
				this.entries.delete(oldest);
			}
		}
	}

	/** Drops every entry — the tests' reset between scenarios. */
	clear(): void {
		this.entries.clear();
	}
}
