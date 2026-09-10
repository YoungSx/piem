import type { Session } from "@earendil-works/pi-agent-core";
import type { ContextNavigation } from "../extensions/contextSession";

/** One reusable pointer, not a new lane for every handoff. */
export const CONTEXT_STAGING_LANE = "piem-context";

/**
 * Prepare a summary off the selected branch, then publish it with one lane move.
 * The caller holds the captured chat's operation lock until this settles and
 * invalidates assertCurrent when that chat stops, unloads, or changes Session.
 *
 * Pi commits each mutation separately. Failed staging leaves the old branch
 * selected and keeps any staged entries in the log. A final move already being
 * saved may still commit after cancellation; do not issue a compensating write
 * from an expired owner. Rebuild the runtime from the authoritative Session.
 */
export async function navigateExtensionSummary(
	session: Session,
	request: ContextNavigation,
	assertCurrent: () => void,
): Promise<void> {
	assertCurrent();
	if (request.lane === CONTEXT_STAGING_LANE) throw new Error("The context staging lane cannot be selected for navigation.");
	if (!Number.isInteger(request.checkpointSeq) || request.checkpointSeq < 0) throw new Error("Invalid context checkpoint sequence.");
	const lanes = await session.getLanes();
	assertCurrent();
	if (!lanes.some(pointer => pointer.lane === request.lane && pointer.leafId === request.expectedLeafId)) {
		throw new Error("Conversation changed before context navigation.");
	}
	// Reading at most two log items also detects a checkpoint ahead of this
	// Session, without copying the complete transcript a second time.
	const tail = await session.getLog({ afterSeq: Math.max(0, request.checkpointSeq - 1), limit: 2 });
	assertCurrent();
	if ((tail.at(-1)?.seq ?? 0) !== request.checkpointSeq) {
		throw new Error("Conversation changed before context navigation.");
	}
	if (lanes.some(pointer => pointer.lane === CONTEXT_STAGING_LANE)) {
		await session.moveLane(CONTEXT_STAGING_LANE, request.targetId);
	} else {
		await session.createLane(CONTEXT_STAGING_LANE, request.targetId);
	}
	assertCurrent();
	const summary = await session.appendEntry({
		type: "branch_summary", id: request.summaryEntryId, fromId: request.fromId, summary: request.summary,
	}, CONTEXT_STAGING_LANE);
	assertCurrent();
	// Reject an intervening writer even if it changed a label or another lane,
	// so the saved summary still describes the history it was prepared from.
	if (summary.seq !== request.checkpointSeq + 2) throw new Error("Conversation changed while saving the context summary.");
	const currentLeaf = await session.view(request.lane).getLeafId();
	assertCurrent();
	const newer = await session.getLog({ afterSeq: summary.seq, limit: 1 });
	assertCurrent();
	if (currentLeaf !== request.expectedLeafId || newer.length) {
		throw new Error("Conversation changed while saving the context summary.");
	}
	await session.moveLane(request.lane, request.summaryEntryId);
	assertCurrent();
}
