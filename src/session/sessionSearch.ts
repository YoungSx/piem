import type { Entry, JsonlSessionMetadata, ScanningSessionSearchHit } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** A pi entry hit with the stable vault path needed by the picker. */
export interface StoredSessionSearchHit extends ScanningSessionSearchHit {
	readonly path: string;
	readonly entryType: Entry["type"];
}

/** One picker row, folded from all matching entries in a session. */
export interface SessionSearchResult {
	readonly sessionId: string;
	readonly path: string;
	readonly entryId: string;
	readonly entryType: Entry["type"];
	readonly timestamp: number;
	readonly snippet: string;
	readonly matchCount: number;
}

const SNIPPET_LENGTH = 180;

function textParts(message: AgentMessage): string[] {
	if (!("content" in message)) return [];
	if (typeof message.content === "string") return [message.content];
	return message.content
		.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
		.map((part) => part.text);
}

/** Projects searchable, human-readable content without indexing tool payloads or images. */
export function projectSessionEntryText(_metadata: JsonlSessionMetadata, entry: Entry, label?: string): string {
	let text = "";
	if (entry.type === "message") text = textParts(entry.message).join("\n");
	else if (entry.type === "compaction" || entry.type === "branch_summary") text = entry.summary;
	else if (entry.type === "custom" && typeof entry.data === "string") text = entry.data;
	return [text.trim(), label?.trim()].filter(Boolean).join(" ");
}

/** Returns a short excerpt around the first case-insensitive match. */
export function makeSnippet(text: string, query: string, maxLength = SNIPPET_LENGTH): string {
	const clean = text.trim();
	if (clean.length <= maxLength) return clean;
	const needle = query.trim().toLocaleLowerCase();
	const index = needle ? clean.toLocaleLowerCase().indexOf(needle) : 0;
	const center = index < 0 ? 0 : index;
	const start = Math.max(0, Math.min(center - Math.floor(maxLength / 3), clean.length - maxLength));
	const end = Math.min(clean.length, start + maxLength);
	return `${start > 0 ? "…" : ""}${clean.slice(start, end).trim()}${end < clean.length ? "…" : ""}`;
}

/** Folds pi's per-entry hits into one stable result per session. */
export function aggregateSessionSearchHits(
	hits: Iterable<StoredSessionSearchHit>,
	query: string,
	maxResults = 50,
): SessionSearchResult[] {
	const folded = new Map<string, SessionSearchResult>();
	for (const hit of hits) {
		const existing = folded.get(hit.sessionId);
		if (existing) {
			folded.set(hit.sessionId, { ...existing, matchCount: existing.matchCount + 1 });
			continue;
		}
		folded.set(hit.sessionId, { ...hit, snippet: makeSnippet(hit.snippet, query), matchCount: 1 });
		if (folded.size >= maxResults) break;
	}
	return [...folded.values()];
}
