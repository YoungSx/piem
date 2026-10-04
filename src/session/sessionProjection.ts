import { buildSessionProjection, type SessionEntry } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import type { Entry } from "./sessionTypes";

/** Adapt UUID provenance and UI-only message roles around Pi's original context projection. */
export function projectSession(entries: Entry[]) {
	const origins = new Map<string, string | null>();
	for (const entry of entries) {
		origins.set(entry.id, entry.type === "message" ? entry.id : null);
		if (entry.type === "compaction") entry.retainedTail.forEach((_, index) => {
			origins.set(`${entry.id}/retained/${index}`, entry.retainedMessageOrigins?.[index] ?? null);
		});
	}
	const projection = buildSessionProjection(nativeEntries(entries));
	const parts = projection.entries.flatMap(entry => entry.messages
		.filter(message => message.role !== "assistant" || !["error", "aborted", "deferred"].includes(message.stopReason))
		.map(message => ({ message, origin: origins.get(entry.sourceEntry.id) ?? null })));
	return { messages: parts.map(part => part.message), messageOrigins: parts.map(part => part.origin) };
}

/** Old retained-tail payloads become Pi entry references; the caller supplies a native branch scan. */
export function nativeEntries(entries: Entry[]): SessionEntry[] {
	const result: SessionEntry[] = [];
	let parentId: string | null = null;
	for (const entry of entries) {
		const timestamp = new Date(entry.timestamp).toISOString();
		if (entry.type === "compaction") {
			const tail = entry.retainedTail.map((message, index): SessionEntry => {
				const id = `${entry.id}/retained/${index}`;
				const item: SessionEntry = { type: "message", id, parentId, timestamp, message };
				parentId = id;
				return item;
			});
			result.push(...tail, { ...entry, parentId, timestamp, firstKeptEntryId: tail[0]?.id ?? entry.id });
		} else if (entry.type === "branch_summary") result.push({ ...entry, parentId, timestamp, fromId: entry.fromId ?? "" });
		else result.push({ ...entry, parentId, timestamp });
		parentId = entry.id;
	}
	return result;
}
