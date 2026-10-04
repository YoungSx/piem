import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import { ok, err, type Result } from "@earendil-works/pi-durable/env";
import * as native from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/branch-summarization.js";
import type { SessionEntry, ReadonlySessionManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { nativeEntries } from "../session/sessionProjection";
import { summaryStream, failure } from "./piCompaction";
import type { Entry, BranchSummaryResult } from "../session/sessionTypes";
import type { PiemSession } from "../session/PiemSession";

export async function collectEntriesForBranchSummary(_branch: unknown, session: PiemSession, oldTipId: string | null, targetId: string, context: Context) {
	if (!oldTipId) return { entries: [], commonAncestorId: null };
	const branches = new Map<string, SessionEntry[]>();
	const original = new Map<string, Entry>();
	for (const id of new Set([oldTipId, targetId])) {
		const entries = await session.view().findEntries({ fromId: id }, context);
		for (const entry of entries) original.set(entry.id, entry);
		branches.set(id, nativeEntries(entries));
	}
	const converted = new Map([...branches.values()].flat().map(entry => [entry.id, entry]));
	const reader: Pick<ReadonlySessionManager, "getBranch" | "getEntry"> = {
		getEntry: id => converted.get(id),
		getBranch: (id = oldTipId) => branches.get(id) ?? [],
	};
	// The audited collector reads exactly getBranch/getEntry. Its public type
	// names the full CLI reader, whose other capabilities this snapshot lacks.
	const result = native.collectEntriesForBranchSummary(reader as ReadonlySessionManager, oldTipId, targetId);
	return { entries: result.entries.flatMap(entry => original.has(entry.id) ? [original.get(entry.id)!] : []), commonAncestorId: result.commonAncestorId };
}

export async function generateBranchSummary(entries: Entry[], options: Omit<native.GenerateBranchSummaryOptions, "signal"> & { models: Models }, context: Context): Promise<Result<BranchSummaryResult, { code: string; message: string }>> {
	try {
		const result = await native.generateBranchSummary(nativeEntries(entries), { ...options, signal: context.abortSignal ?? new AbortController().signal, streamFn: summaryStream(options.models) });
		if (result.aborted) return err({ code: "aborted", message: result.error ?? "Branch summary aborted" });
		if (result.error) return err({ code: "summarization_failed", message: result.error });
		return ok<BranchSummaryResult, { code: string; message: string }>({ ...result, summary: result.summary ?? "", details: { readFiles: result.readFiles ?? [], modifiedFiles: result.modifiedFiles ?? [] } });
	} catch (error) { return err(failure(error, context)); }
}
