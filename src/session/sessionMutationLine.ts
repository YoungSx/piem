import type { SessionMutation } from "../../node_modules/@earendil-works/pi-agent-core/dist/harness/session/state.js";
import { encodeMutation, parseMutation } from "../../node_modules/@earendil-works/pi-agent-core/dist/harness/session/jsonl/codec.js";

/** What the fs remembered about the last write it made to a path. */
interface FileFingerprint {
	mtimeMs: number;
	size: number;
}

export { encodeMutation };

/**
 * The mutation wire format pi's JSONL codec writes — one JSON object per line,
 * entry fields flattened to the top level next to `kind`.
 *
 * The parser itself is pi's own codec, reached the same way `src/vault/editDiff.ts`
 * reaches the edit engine: the `exports` map stops at the root, `./node` and
 * `./session/testing`, so `parseMutation` is not reachable from any package
 * specifier — but the module is already in the bundle (pi's storage imports
 * it), so delegating costs zero bytes and hands us validation that can never
 * drift from what `SessionState` accepts. If a future pi release exports the
 * codec from the root, delete the relative specifier here and import it
 * normally.
 *
 * This module adds one thing the codec does not do: a *lenient* verdict. The
 * codec throws a typed error for every invalid line; {@link parseMutationLine}
 * collapses all of those (plus the header line, which the codec's sibling
 * `parseHeader` owns) to `null` — the signal the repair net and the merge use
 * to mean "pass through untouched", which for a header or a torn tail is
 * exactly the right treatment.
 */

/**
 * The mutation shape pi's codec returns, with the flattened wire fields of an
 * entry kept where the repair net reads them: the codec folds an entry's `seq`
 * *into* `entry`, so an entry's top-level seq is `mutation.entry.seq`.
 */
export type SessionMutationLine = SessionMutation;

/**
 * Parses one JSONL mutation line, or `null` for anything a repair must not
 * rewrite: the header line, a torn tail, or a bare `"\n"` (pi's unterminated-
 * tail repair appends exactly that through {@link appendFile}).
 *
 * Validation mirrors pi's codec field-for-field. A line that fails here is
 * passed through untouched — pi only ever encodes valid mutations, so a
 * failure means the content was never a mutation to begin with.
 */
export function parseMutationLine(line: string): SessionMutationLine | null {
	if (line === "") {
		return null;
	}
	const result = parseMutation(line);
	return result.ok ? result.value : null;
}

/**
 * What one pass over a log's lines establishes for repair decisions.
 *
 * `maxSeq` is the load invariant's other half: every appended mutation must
 * carry `maxSeq + 1` or the file dies as `invalid` on next load. The rest are
 * the reference targets pi's `applyMutation` resolves — an entry's `parentId`,
 * a lane's `leafId`, a label's `targetId` must exist, a record's `lane` must
 * name a lane the file actually declares, and an entry or record id must never
 * repeat.
 *
 * `laneLeaves` starts as pi's fresh state does — `main` at `null` — and moves
 * exactly the way `applyMutation` moves it: an entry carrying a lane advances
 * that lane's leaf; a `lane` mutation sets it outright (and may introduce a
 * new lane); a lane-less entry moves nothing. This is what lets the repair
 * net tell a *valid* lane-chained entry from one that would brick the file.
 */
export interface DiskSnapshot {
	maxSeq: number;
	usedIds: Set<string>;
	entryIds: Set<string>;
	laneLeaves: Map<string, string | null>;
	/** The id of the final entry-kind line, or null when the log holds no entry. */
	lastEntryId: string | null;
}

/**
 * One pass over a log's lines, lenient by design: unparseable lines (a torn
 * tail pi has not repaired yet, a header) are skipped rather than failing the
 * scan, because the snapshot only feeds decisions about lines pi is *about to*
 * append — and those come from pi's own encoder, not from this file.
 */
export function scanDiskLines(lines: string[]): DiskSnapshot {
	const snapshot: DiskSnapshot = {
		maxSeq: 0,
		usedIds: new Set(),
		entryIds: new Set(),
		laneLeaves: new Map([["main", null]]),
		lastEntryId: null,
	};
	for (const line of lines) {
		const mutation = parseMutationLine(line);
		if (!mutation) {
			continue;
		}
		if (mutationSeq(mutation) > snapshot.maxSeq) {
			snapshot.maxSeq = mutationSeq(mutation);
		}
		switch (mutation.kind) {
			case "entry":
				snapshot.usedIds.add(mutation.entry.id);
				snapshot.entryIds.add(mutation.entry.id);
				snapshot.lastEntryId = mutation.entry.id;
				if (mutation.lane !== undefined && snapshot.laneLeaves.has(mutation.lane)) {
					snapshot.laneLeaves.set(mutation.lane, mutation.entry.id);
				}
				break;
			case "record":
				snapshot.usedIds.add(mutation.record.id);
				break;
			case "lane":
				snapshot.laneLeaves.set(mutation.lane, mutation.leafId);
				break;
		}
	}
	return snapshot;
}

/**
 * What the repair net decided to do with a line pi asked to append while the
 * disk had moved under it.
 */
export type RepairedLine = {
	/** The rewritten line, ready to append (with its trailing newline). */
	action: "repaired";
	line: string;
	seq: number;
} | {
	/** The line survives as-is — the disk agreed with pi's view. */
	action: "kept";
	line: string;
	seq: number;
} | {
	/** The line cannot be made loadable against this disk; it is skipped. */
	action: "dropped";
};

/**
 * Rewrites one incoming mutation line so it stays loadable against `disk`.
 *
 * The rules are the minimal edit that satisfies `SessionState.applyMutation` —
 * verify first, repair only what actually violates:
 *
 * - seq is the one invariant every kind shares: renumbered to `maxSeq + 1`
 *   when it does not already continue the disk. A line that needs nothing but
 *   that (or nothing at all) comes back as-is.
 * - an entry whose lane exists on disk must chain to that lane's leaf; when it
 *   doesn't, the parent is corrected to the leaf — the shape pi itself would
 *   have written. A lane that does *not* exist on disk (a foreign file that
 *   never declared it) falls back to pi's lane-less escape hatch: the field is
 *   dropped and the entry hangs off the disk's last entry. A dangling parentId
 *   on a lane-less entry is corrected the same way.
 * - an entry or record id already used on disk is dropped — a rewrite could
 *   only paper over a genuine duplicate.
 * - a record survives only if its lane exists on disk; a `lane` mutation only
 *   if its `leafId` is null or on disk; a label fact only if its target is.
 *   Anything else is dropped rather than appended, because a dangling
 *   reference would brick the whole file at next load — and every dropped
 *   line is recoverable bookkeeping (run ledgers, lane moves), not chat
 *   content.
 */
/** An entry or record carries its seq inside; a lane or fact carries it on top. */
function mutationSeq(mutation: SessionMutationLine): number {
	return mutation.kind === "entry" ? mutation.entry.seq : mutation.kind === "record" ? mutation.record.seq : mutation.seq;
}

export function repairMutationLine(line: string, disk: DiskSnapshot): RepairedLine {
	const mutation = parseMutationLine(line);
	if (!mutation) {
		return { action: "kept", line, seq: 0 };
	}
	const seq = disk.maxSeq + 1;
	const continues = mutationSeq(mutation) === seq;
	// The four kinds share one exit: a verdict of dropped, a rewrite whose patch
	// (if any) repairs the specific violation found, or the seq-only continue.
	// `verdict` returns the drop/rewrite result; the caller falls through to the
	// shared kept-or-renumbered tail.
	const verdict = (repaired: RepairedLine | null): RepairedLine => repaired ?? (continues ? { action: "kept", line, seq: mutationSeq(mutation) } : rewrite(line, { seq }));
	switch (mutation.kind) {
		case "entry": {
			if (disk.usedIds.has(mutation.entry.id)) {
				return { action: "dropped" };
			}
			if (mutation.lane !== undefined) {
				const leaf = disk.laneLeaves.get(mutation.lane);
				if (leaf === undefined) {
					return rewrite(line, { seq, parentId: disk.lastEntryId, dropLane: true });
				}
				if (mutation.entry.parentId !== leaf) {
					return rewrite(line, { seq, parentId: leaf ?? null });
				}
			} else if (mutation.entry.parentId !== null && !disk.entryIds.has(mutation.entry.parentId)) {
				return rewrite(line, { seq, parentId: disk.lastEntryId });
			}
			return verdict(null);
		}
		case "record":
			return verdict(
				!disk.laneLeaves.has(mutation.record.lane) || disk.usedIds.has(mutation.record.id) ? { action: "dropped" } : null,
			);
		case "lane":
			return verdict(mutation.leafId !== null && !disk.entryIds.has(mutation.leafId) ? { action: "dropped" } : null);
		case "fact":
			return verdict(mutation.fact === "label" && !disk.entryIds.has(mutation.targetId) ? { action: "dropped" } : null);
	}
}

/** Rewrites a line's seq (and, when given, its parent and lane) in place. */
function rewrite(
	line: string,
	patch: { seq: number; parentId?: string | null; dropLane?: boolean },
): RepairedLine {
	const rewritten = JSON.parse(line) as Record<string, unknown>;
	rewritten.seq = patch.seq;
	if (patch.parentId !== undefined) {
		rewritten.parentId = patch.parentId;
	}
	if (patch.dropLane) {
		delete rewritten.lane;
	}
	return { action: "repaired", line: `${JSON.stringify(rewritten)}\n`, seq: patch.seq };
}

/**
 * Strips the single trailing newline pi's encoder adds, so the bare JSON can
 * be parsed and re-encoded. Returns the empty string for a bare `"\n"` append.
 */
export function stripTrailingNewline(content: string): string {
	return content.endsWith("\n") ? content.slice(0, -1) : content;
}

/** What the fs remembered about the last write it made to a path. */
interface WriteTrack {
	fingerprint: FileFingerprint;
	/**
	 * The seq of the last mutation this fs wrote (or verified) on disk, so the
	 * fast path can prove `incoming.seq === diskLastSeq + 1` without a read.
	 * `undefined` after a whole-file write or rename, where the disk's seq is
	 * not inferable and the next append must read once.
	 */
	lastSeq?: number;
}

/** Observability hook: the fs reports every repair decision it made. */
export interface SessionDriftEvent {
	path: string;
	action: "repaired" | "dropped";
	kind: SessionMutationLine["kind"];
	/** The seq the line now carries on disk — absent when dropped. */
	seq?: number;
}

/**
 * Why the next append needs the repair net: the vault sync plugin arbitrates
 * whole files last-writer-wins, so between two of our appends a foreign file
 * version can land on disk. pi's in-memory sequence has no idea, and an
 * uncorrected append would carry a seq the file already used — `invalid` at
 * next load, the whole chat bricked.
 */
export class SessionLogRepairNet {
	private readonly tracks = new Map<string, WriteTrack>();

	constructor(private readonly onDrift?: (event: SessionDriftEvent) => void) {}

	/**
	 * Decides what to do with a line about to be appended to `path`, given the
	 * adapter's raw stat. Returns the line to append — possibly rewritten — or
	 * `null` to skip the append entirely.
	 *
	 * Any internal failure (a stat or read error) degrades to pass-through:
	 * this net is a safety net, and turning an appendable message into a
	 * failed send would be a worse outcome than the rare double-seq it guards
	 * against. The fingerprint refresh afterwards heals the bookkeeping.
	 */
	async prepare(
		path: string,
		content: string,
		io: { stat: () => Promise<{ mtime: number; size: number } | null>; read: () => Promise<string> },
	): Promise<{ line: string | null; appendedSeq?: number }> {
		try {
			const observed = await io.stat();
			const track = this.tracks.get(path);
			// The track's fingerprint is the sentinel: a track absent means we never
			// wrote this path, a match means the disk is exactly where we left it,
			// anything else is drift. The three outcomes share one fast-path exit;
			// only the match unlocks it, so a boolean is all the caller consumes.
			const same = track !== undefined && observed !== null && track.fingerprint.mtimeMs === observed.mtime && track.fingerprint.size === observed.size;
			const bare = stripTrailingNewline(content);
			const mutation = parseMutationLine(bare);

			// Not a mutation line (header write, bare "\n"): nothing to verify.
			if (!mutation) {
				return { line: content };
			}

			// The fast path: disk is exactly where we left it AND pi's seq continues
			// from the last seq we wrote. No read needed.
			if (same && track.lastSeq !== undefined && mutationSeq(mutation) === track.lastSeq + 1) {
				return { line: content, appendedSeq: mutationSeq(mutation) };
			}

			// Everything else — first append this process (a sync landing between
			// load and here is invisible to a baseline we never wrote), a foreign
			// writer, or a seq that stopped continuing — is settled by one disk
			// read and a verify-or-repair pass.
			const disk = scanDiskLines(observed === null ? [] : (await io.read()).split("\n"));
			const repaired = repairMutationLine(bare, disk);
			if (repaired.action === "dropped") {
				this.onDrift?.({ path, action: "dropped", kind: mutation.kind });
				// Nothing was written, but the read did verify the disk's tail —
				// remembering it keeps the fast path honest for the next append.
				return { line: null, appendedSeq: disk.maxSeq };
			}
			if (repaired.action === "repaired") {
				this.onDrift?.({ path, action: "repaired", kind: mutation.kind, seq: repaired.seq });
				return { line: repaired.line, appendedSeq: repaired.seq };
			}
			return { line: content, appendedSeq: repaired.seq };
		} catch {
			return { line: content };
		}
	}

	/**
	 * Records the post-write state: our own writes must never read as drift.
	 * `lastSeq` comes from the append decision; whole-file writes and renames
	 * pass none, forcing the next append to read the disk once.
	 */
	async refresh(
		path: string,
		stat: () => Promise<{ mtime: number; size: number } | null>,
		appendedSeq?: number,
	): Promise<void> {
		try {
			const observed = await stat();
			if (!observed) {
				this.tracks.delete(path);
				return;
			}
			const fingerprint = { mtimeMs: observed.mtime, size: observed.size };
			const previous = this.tracks.get(path);
			this.tracks.set(path, {
				fingerprint,
				lastSeq: appendedSeq === undefined ? previous?.lastSeq : appendedSeq,
			});
		} catch {
			// Bookkeeping must never break the write that preceded it.
		}
	}

	forget(path: string): void {
		this.tracks.delete(path);
	}
}
