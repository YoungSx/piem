import type { Context, JsonValue } from "@earendil-works/chord";
import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Api, type Model, type Models, type RetryCallbacks, type RetryPolicy } from "@earendil-works/pi-ai";
import { ok, err, type Result } from "@earendil-works/pi-durable/env";
import * as native from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import { buildSessionProjection } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { nativeEntries } from "../session/sessionProjection";
import type { CompactResult, Entry } from "../session/sessionTypes";

export { DEFAULT_COMPACTION_SETTINGS, calculateContextTokens, estimateContextTokens, shouldCompact, type CompactionSettings } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
export type CompactionPreparation = NonNullable<ReturnType<typeof native.prepareCompaction>> & { retainedTail: AgentMessage[] };
type Failure = { code: string; message: string };


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
