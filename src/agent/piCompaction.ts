import type { Context, JsonValue } from "@earendil-works/chord";
import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Api, type Model, type Models, type RetryCallbacks, type RetryPolicy } from "@earendil-works/pi-ai";
import { ok, err, type Result } from "@earendil-works/pi-durable/env";
import * as native from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import { buildSessionProjection, type SessionEntry } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import type { CompactResult, Entry } from "../session/sessionTypes";

export { DEFAULT_COMPACTION_SETTINGS, calculateContextTokens, estimateContextTokens, shouldCompact, type CompactionSettings } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
export type CompactionPreparation = NonNullable<ReturnType<typeof native.prepareCompaction>> & { retainedTail: AgentMessage[] };
type Failure = { code: string; message: string };

/** Convert Piem's retained-tail snapshots to Pi's current entry-reference projection. */
export function nativeEntries(entries: Entry[]): SessionEntry[] {
	const result: SessionEntry[] = [];
	for (const entry of entries) {
		const timestamp = new Date(entry.timestamp).toISOString();
		if (entry.type === "compaction") {
			let parentId = entry.parentId;
			const tail = entry.retainedTail.map((message, index): SessionEntry => {
				const id = `${entry.id}/retained/${index}`;
				const item: SessionEntry = { type: "message", id, parentId, timestamp, message };
				parentId = id;
				return item;
			});
			result.push(...tail, { ...entry, parentId, timestamp, firstKeptEntryId: tail[0]?.id ?? entry.id });
		} else if (entry.type === "branch_summary") result.push({ ...entry, timestamp, fromId: entry.fromId ?? "" });
		else result.push({ ...entry, timestamp });
	}
	return result;
}

export function prepareCompaction(entries: Entry[], settings: native.CompactionSettings): Result<CompactionPreparation | undefined, Failure> {
	try {
		const source = nativeEntries(entries);
		const prepared = native.prepareCompaction(source, settings);
		if (!prepared) return ok(undefined);
		const projected = buildSessionProjection(source).entries;
		const start = projected.findIndex(entry => entry.sourceEntry.id === prepared.firstKeptEntryId);
		return ok({ ...prepared, retainedTail: projected.slice(start).flatMap(entry => entry.messages) });
	} catch (error) { return err(failure(error)); }
}

/** Original summarizers own retries; the host retains its configured auth and transport. */
export function summaryStream(models: Models): StreamFn {
	return async (model, context, options) => {
		const message = await models.completeSimple(model, context, options);
		const stream = createAssistantMessageEventStream();
		stream.end(message);
		return stream;
	};
}

export async function compact(preparation: CompactionPreparation, models: Models, model: Model<Api>, instructions: string | undefined, thinking: ThinkingLevel | undefined, retry: RetryPolicy | undefined, callbacks: RetryCallbacks | undefined, context: Context): Promise<Result<CompactResult, Failure>> {
	try {
		const result = await native.compact(preparation, model, undefined, undefined, instructions, context.abortSignal, thinking, summaryStream(models), undefined, retry, callbacks);
		return ok({ ...result, details: result.details as JsonValue | undefined, retainedTail: preparation.retainedTail });
	} catch (error) { return err(failure(error, context)); }
}

export function failure(error: unknown, context?: Context): Failure {
	return { code: context?.abortSignal?.aborted || (error instanceof Error && error.name === "AbortError") ? "aborted" : "summarization_failed", message: error instanceof Error ? error.message : String(error) };
}
