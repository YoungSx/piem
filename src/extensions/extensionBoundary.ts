import { convertToLlm, createBranchSummaryMessage, createCompactionSummaryMessage, estimateContextTokens, type AgentMessage, type Entry } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { BoundaryContextPreview, SessionBoundaryDraft, SessionEntry } from "@earendil-works/pi-coding-agent";

export interface BoundarySnapshot {
	entries: Entry[];
	messages: AgentMessage[];
	messageOrigins: (string | null)[];
	pendingMessages: AgentMessage[];
}

export interface PreparedBoundary {
	context: BoundaryContextPreview;
	messages: AgentMessage[];
	messageOrigins: (string | null)[];
	/** Core entries use reserved IDs, shared by preview and durable append. */
	entries: Entry[];
}

/** Project supported boundary drafts without mutating the live transcript or storage. */
export function prepareExtensionBoundary(snapshot: BoundarySnapshot, drafts: SessionBoundaryDraft[], ids: string[], now = Date.now()): PreparedBoundary {
	let messages = snapshot.messages.slice();
	let messageOrigins = snapshot.messageOrigins.slice();
	const entries: Entry[] = [];
	const sourceEntries = snapshot.entries.slice();
	for (const [index, draft] of drafts.entries()) {
		const id = ids[index];
		if (!id) throw new Error("Boundary draft is missing its reserved entry ID.");
		const base = { id, parentId: sourceEntries.at(-1)?.id ?? null, seq: (sourceEntries.at(-1)?.seq ?? 0) + 1, timestamp: now };
		let entry: Entry;
		switch (draft.type) {
			case "custom":
				entry = wireEntry({ ...base, type: "custom", customType: draft.customType, data: draft.data });
				break;
			case "custom_message": {
				const message: AgentMessage = { role: "custom", customType: draft.customType, content: structuredClone(draft.content), display: draft.display, details: draft.details, timestamp: now };
				entry = wireEntry({ ...base, type: "message", message });
				messages.push(message);
				messageOrigins.push(id);
				break;
			}
			case "compaction": {
				const start = draft.firstKeptEntryId === null ? sourceEntries.length : sourceEntries.findIndex(entry => entry.id === draft.firstKeptEntryId);
				if (start < 0) throw new Error("Compaction must retain an entry on the active branch.");
				const liveMessages = new Map<string, AgentMessage>();
				messages.forEach((message, index) => { const origin = messageOrigins[index]; if (origin) liveMessages.set(origin, message); });
				const retainedTail: AgentMessage[] = [];
				const retainedMessageOrigins: string[] = [];
				for (const source of sourceEntries.slice(start)) {
					// The boundary names raw entries, including state-only ones. An
					// older compaction contributes no summary or virtual retained tail.
					if (source.type === "compaction" || source.type === "custom") continue;
					const message = liveMessages.get(source.id) ?? (source.type === "message" ? source.message
						: source.summary ? createBranchSummaryMessage(source.summary, source.fromId, source.timestamp) : undefined);
					if (!message || message.role === "system") continue;
					retainedTail.push(message);
					retainedMessageOrigins.push(source.id);
				}
				const tokensBefore = estimateContextTokens(messages).tokens;
				const system = getCurrentSystemMessage(convertToLlm(messages));
				entry = wireEntry({ ...base, type: "compaction", summary: draft.summary, tokensBefore, retainedTail, retainedMessageOrigins, firstKeptEntryId: draft.firstKeptEntryId, fromHook: true, details: draft.details, usage: draft.usage, systemMessage: system });
				messages = [...(system ? [system] : []), createCompactionSummaryMessage(draft.summary, tokensBefore, now), ...retainedTail];
				messageOrigins = [...(system ? [null] : []), id, ...retainedMessageOrigins];
				break;
			}
			case "context_edit":
				throw new Error("context_edit is unavailable: Piem's Vault session format does not support append-only context edits.");
		}
		entries.push(entry);
		sourceEntries.push(entry);
	}
	const llmMessages = convertToLlm(messages);
	const finalRole = llmMessages.at(-1)?.role;
	const latestCompaction = sourceEntries.findLastIndex(entry => entry.type === "compaction");
	const retainedIds = new Set(messageOrigins.filter(id => id !== null));
	const latest = sourceEntries[latestCompaction];
	const firstKeptEntryId = latest && "firstKeptEntryId" in latest ? latest.firstKeptEntryId : undefined;
	const retainedStart = typeof firstKeptEntryId === "string" ? sourceEntries.findIndex(entry => entry.id === firstKeptEntryId)
		: firstKeptEntryId === undefined ? sourceEntries.findIndex(entry => retainedIds.has(entry.id)) : latestCompaction;
	const contextSources = latestCompaction < 0 ? sourceEntries : [
		sourceEntries[latestCompaction]!,
		...sourceEntries.slice(retainedStart < 0 ? latestCompaction : retainedStart, latestCompaction).filter(entry => entry.type !== "message" || entry.message.role !== "system"),
		...sourceEntries.slice(latestCompaction + 1),
	];
	const messagesByOrigin = new Map<string, AgentMessage[]>();
	messages.forEach((message, index) => {
		const origin = messageOrigins[index] ?? (message.role === "system" && latestCompaction >= 0 ? sourceEntries[latestCompaction]!.id : null);
		if (!origin) return;
		const projected = messagesByOrigin.get(origin) ?? [];
		projected.push(message);
		messagesByOrigin.set(origin, projected);
	});
	const context: BoundaryContextPreview = {
		contextEntries: contextSources.map(sourceEntry => ({
			sourceEntry: extensionEntry(sourceEntry),
			messages: messagesByOrigin.get(sourceEntry.id) ?? [],
		})),
		contextMessages: messages,
		llmMessages,
		pendingMessages: snapshot.pendingMessages.slice(),
		canContinue: (llmMessages.some(message => message.role !== "system") && finalRole !== "assistant") || snapshot.pendingMessages.length > 0,
	};
	return { context, messages, messageOrigins, entries };
}

function wireEntry(value: unknown): Entry {
	// Match the session's JSON wire boundary, rejecting cycles and bigint.
	return JSON.parse(JSON.stringify(value)) as Entry;
}

function extensionEntry(entry: Entry): SessionEntry {
	const timestamp = new Date(entry.timestamp).toISOString();
	if (entry.type === "message" && entry.message.role === "custom") {
		return { type: "custom_message", id: entry.id, parentId: entry.parentId, timestamp, customType: entry.message.customType, content: entry.message.content, display: entry.message.display, details: entry.message.details };
	}
	if (entry.type === "compaction") {
		const firstKeptEntryId = "firstKeptEntryId" in entry && typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : "";
		return { ...entry, timestamp, firstKeptEntryId };
	}
	if (entry.type === "branch_summary") return { ...entry, timestamp, fromId: entry.fromId ?? "" };
	return { ...entry, timestamp };
}
