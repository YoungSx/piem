import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import { ok, err, type Result } from "@earendil-works/pi-durable/env";
import * as native from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/branch-summarization.js";
import type { SessionEntry, ReadonlySessionManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { nativeEntries, summaryStream, failure } from "./piCompaction";
import type { Entry, BranchSummaryResult } from "../session/sessionTypes";
import type { PiemSession } from "../session/PiemSession";

export async function collectEntriesForBranchSummary(_branch: unknown, session: PiemSession, oldTipId: string | null, targetId: string, context: Context) {
	const entries = await session.findEntries({}, context);
	const original = new Map(entries.map(entry => [entry.id, entry]));
	const converted = new Map(nativeEntries(entries).map(entry => [entry.id, entry]));
	const reader: Pick<ReadonlySessionManager, "getBranch" | "getEntry"> = {
		getEntry: id => converted.get(id),
		getBranch: (id = oldTipId ?? undefined) => {
			const branch: SessionEntry[] = [];
			const seen = new Set<string>();
			while (id) {
				if (seen.has(id)) throw new Error("Conversation branch contains a cycle");
				seen.add(id);
				const entry = converted.get(id);
				if (!entry) break;
				branch.unshift(entry);
				id = entry.parentId ?? undefined;
			}
			return branch;
		},
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
