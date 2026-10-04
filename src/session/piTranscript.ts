import { configure, UserEntry, AssistantEntry, SystemEntry, ToolResultEntry, type EntryRecord, type ConversationId, type EntryId, type Tx } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { convertToLlm, createBranchSummaryMessage, createCompactionSummaryMessage } from "../agent/piMessages";
import type { Entry } from "./sessionTypes";

/** UUID/timestamp metadata belongs to Piem; ancestry, model content and configuration belong to Pi. */
export async function appendTranscript(tx: Tx, conversationId: ConversationId, entry: Entry) {
	if (entry.type === "model_change") await configure(tx, conversationId, { model: { provider: entry.provider, modelId: entry.modelId } });
	if (entry.type === "thinking_level_change") await configure(tx, conversationId, { thinkingLevel: entry.thinkingLevel });
	const messages = entry.type === "message" ? [entry.message]
		: entry.type === "compaction" ? [createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp), ...entry.retainedTail]
			: entry.type === "branch_summary" && entry.summary ? [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)] : [];
	const kinds: Record<string, string> = { user: UserEntry.kind, assistant: AssistantEntry.kind, system: SystemEntry.kind, toolResult: ToolResultEntry.kind };
	const nativeKind = entry.type === "message" ? kinds[entry.message.role] : undefined;
	const data = entry.type === "message" && nativeKind ? (({ message: _message, ...metadata }) => metadata)(entry) : entry;
	return tx.appendEntry(conversationId, {
		kind: nativeKind ?? "piem.transcript", data: data as unknown as JsonValue,
		...(messages.length ? { model: convertToLlm(messages) } : {}),
		...(entry.type === "compaction" ? { head: "self" as const } : {}),
	});
}

/** Pi's scan follows fork ancestry and enforces its entry cutoffs. */
export async function scanTranscript(tx: Tx, conversationId: ConversationId, bounds: { minEntryId?: EntryId; maxEntryId?: EntryId } = {}): Promise<Entry[]> {
	const entries: Entry[] = [];
	let cursor;
	do {
		const page = await tx.scanEntries({ conversationId, ...bounds }, 512, cursor);
		for (const entry of page.items) entries.push(transcriptEntry(entry));
		cursor = page.next;
	} while (cursor);
	return entries.reverse();
}

/** Standard message bodies live once, in Pi's model field. */
export function transcriptEntry(record: EntryRecord): Entry {
	const data = record.data as unknown as Entry | Omit<Extract<Entry, { type: "message" }>, "message">;
	return data.type === "message" && !("message" in data)
		? { ...data, message: record.model![0]! } : data;
}
