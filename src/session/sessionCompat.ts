import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Entry } from "./sessionTypes";
import { createBranchSummaryMessage, createCompactionSummaryMessage } from "../agent/piMessages";
export { BACKGROUND_CONTEXT, type Context };

export function buildContextEntries(pathEntries: readonly Entry[]): Entry[] {
	let compaction: Entry | undefined;
	let compactionIndex = -1;
	for (let index = pathEntries.length - 1; index >= 0; index--) {
		const entry = pathEntries[index];
		if (entry?.type === "compaction") {
			compaction = entry;
			compactionIndex = index;
			break;
		}
	}
	return compaction === undefined ? [...pathEntries] : [compaction, ...pathEntries.slice(compactionIndex + 1)];
}

function isContextMessage(message: AgentMessage): boolean {
	return (
		message.role !== "assistant" ||
		(message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "deferred")
	);
}

export function sessionEntryToContextMessages(entry: Entry): AgentMessage[] {
	switch (entry.type) {
		case "message":
			return isContextMessage(entry.message) ? [entry.message] : [];
		case "compaction":
			return [
				createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
				...entry.retainedTail.filter(isContextMessage),
			];
		case "branch_summary":
			return entry.summary ? [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)] : [];
		case "custom":
		default:
			return [];
	}
}

export async function buildSessionContext(
	pathEntries: readonly Entry[],
	options?: { entryProjectors?: Readonly<Record<string, (entry: Entry, context: Context) => Promise<AgentMessage[] | undefined>>> },
	context: Context = BACKGROUND_CONTEXT,
): Promise<AgentMessage[]> {
	options ??= {};
	const entries = buildContextEntries(pathEntries);
	const messages: AgentMessage[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom") {
			messages.push(...sessionEntryToContextMessages(entry));
			continue;
		}
		const projector = options.entryProjectors?.[entry.customType];
		if (projector !== undefined) {
			messages.push(...((await projector(entry, context)) ?? []));
		}
	}
	return messages;
}
