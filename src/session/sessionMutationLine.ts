import { DiskSentinel, type FileFingerprint } from "./DiskSentinel";

/**
 * The mutation wire format pi's JSONL codec writes — one JSON object per line,
 * entry fields flattened to the top level next to `kind`.
 *
 * Not imported from pi: the package's `exports` map stops at the root, `./node`
 * and `./session/testing`, and `parseMutation`/`encodeMutation` are not
 * reachable from any of them. This parser mirrors only what the repair net and
 * the merge need to *decide* — the validation strength of pi's own codec, so
 * anything this module accepts is guaranteed loadable by `SessionState`.
 */

const ENTRY_TYPES = new Set([
	"message",
	"model_change",
	"thinking_level_change",
	"active_tools_change",
	"compaction",
	"branch_summary",
	"custom",
]);

const RECORD_TYPES = new Set([
	"operation_started",
	"abort_requested",
	"operation_finished",
	"step_attempt",
	"tool_started",
	"queue_enqueued",
	"queue_cancelled",
	"write_deferred",
	"usage",
]);

const MUTATION_KINDS = new Set(["entry", "record", "lane", "fact"]);

/** The four mutation kinds, with the flattened wire shape of an entry kept raw. */
export type SessionMutationLine = {
	kind: "entry";
	seq: number;
	lane?: string;
	entry: { id: string; type: string; parentId: string | null; timestamp: number };
} | {
	kind: "record";
	seq: number;
	record: { id: string; lane: string; type: string };
} | {
	kind: "lane";
	seq: number;
	lane: string;
	leafId: string | null;
} | {
	kind: "fact";
	seq: number;
	fact: "name";
	name?: string;
} | {
	kind: "fact";
	seq: number;
	fact: "label";
	targetId: string;
	label?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isSeq(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

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
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isObject(value) || !isSeq(value.seq) || !MUTATION_KINDS.has(value.kind as string)) {
		return null;
	}
	const seq = value.seq;
	switch (value.kind) {
		case "entry": {
			if (value.lane !== undefined && !isString(value.lane)) {
				return null;
			}
			const { id, type, parentId, timestamp } = value;
			if (!isString(id) || !isString(type) || !ENTRY_TYPES.has(type)) {
				return null;
			}
			if (parentId !== null && !isString(parentId)) {
				return null;
			}
			if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp < 0) {
				return null;
			}
			if (type === "custom" && !isString(value.customType)) {
				return null;
			}
			return {
				kind: "entry",
				seq,
				...(value.lane === undefined ? {} : { lane: value.lane }),
				entry: { id, type, parentId, timestamp },
			};
		}
		case "record": {
			const { id, lane, type } = value;
			if (!isString(id) || !isString(lane) || !isString(type) || !RECORD_TYPES.has(type)) {
				return null;
			}
			return { kind: "record", seq, record: { id, lane, type } };
		}
		case "lane": {
			if (!isString(value.lane) || (value.leafId !== null && !isString(value.leafId))) {
				return null;
			}
			return { kind: "lane", seq, lane: value.lane, leafId: value.leafId };
		}
		case "fact": {
			if (value.fact === "name") {
				if (value.name !== undefined && !isString(value.name)) {
					return null;
				}
				return { kind: "fact", seq, fact: "name", name: value.name };
			}
			if (value.fact === "label") {
				if (!isString(value.targetId) || (value.label !== undefined && !isString(value.label))) {
					return null;
				}
				return { kind: "fact", seq, fact: "label", targetId: value.targetId, label: value.label };
			}
			return null;
		}
		default:
			return null;
	}
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
		if (mutation.seq > snapshot.maxSeq) {
			snapshot.maxSeq = mutation.seq;
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
export function repairMutationLine(line: string, disk: DiskSnapshot): RepairedLine {
	const mutation = parseMutationLine(line);
	if (!mutation) {
		return { action: "kept", line, seq: 0 };
	}
	const seq = disk.maxSeq + 1;
	const continues = mutation.seq === seq;
	switch (mutation.kind) {
		case "entry": {
			if (disk.usedIds.has(mutation.entry.id)) {
				return { action: "dropped" };
			}
			if (mutation.lane !== undefined) {
				const leaf = disk.laneLeaves.get(mutation.lane);
				if (leaf === undefined) {
					return reparent(line, { seq, parentId: disk.lastEntryId, dropLane: true });
				}
				if (mutation.entry.parentId !== leaf) {
					return reparent(line, { seq, parentId: leaf ?? null });
				}
			} else if (mutation.entry.parentId !== null && !disk.entryIds.has(mutation.entry.parentId)) {
				return reparent(line, { seq, parentId: disk.lastEntryId });
			}
			return continues ? { action: "kept", line, seq: mutation.seq } : renumber(line, seq);
		}
		case "record": {
			if (!disk.laneLeaves.has(mutation.record.lane) || disk.usedIds.has(mutation.record.id)) {
				return { action: "dropped" };
			}
			return continues ? { action: "kept", line, seq: mutation.seq } : renumber(line, seq);
		}
		case "lane": {
			if (mutation.leafId !== null && !disk.entryIds.has(mutation.leafId)) {
				return { action: "dropped" };
			}
			return continues ? { action: "kept", line, seq: mutation.seq } : renumber(line, seq);
		}
		case "fact": {
			if (mutation.fact === "label" && !disk.entryIds.has(mutation.targetId)) {
				return { action: "dropped" };
			}
			return continues ? { action: "kept", line, seq: mutation.seq } : renumber(line, seq);
		}
	}
}

function renumber(line: string, seq: number): RepairedLine {
	const rewritten = JSON.parse(line) as Record<string, unknown>;
	rewritten.seq = seq;
	return { action: "repaired", line: `${JSON.stringify(rewritten)}\n`, seq };
}

function reparent(
	line: string,
	options: { seq: number; parentId: string | null; dropLane?: boolean },
): RepairedLine {
	const rewritten = JSON.parse(line) as Record<string, unknown>;
	rewritten.seq = options.seq;
	rewritten.parentId = options.parentId;
	if (options.dropLane) {
		delete rewritten.lane;
	}
	return { action: "repaired", line: `${JSON.stringify(rewritten)}\n`, seq: options.seq };
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
	private readonly sentinel = new DiskSentinel();
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
			const fingerprint: FileFingerprint | null = observed ? { mtimeMs: observed.mtime, size: observed.size } : null;
			const track = this.tracks.get(path);
			const status = this.sentinel.check(path, fingerprint ?? { mtimeMs: 0, size: -1 });
			const mutation = parseMutationLine(stripTrailingNewline(content));

			// Not a mutation line (header write, bare "\n"): nothing to verify.
			if (!mutation) {
				return { line: content };
			}

			// The fast path: disk is exactly where we left it AND pi's seq continues
			// from the last seq we wrote. No read needed.
			if (status === "same" && track?.lastSeq !== undefined && mutation.seq === track.lastSeq + 1) {
				return { line: content, appendedSeq: mutation.seq };
			}

			// Everything else — first append this process (a sync landing between
			// load and here is invisible to a baseline we never wrote), a foreign
			// writer, or a seq that stopped continuing — is settled by one disk
			// read and a verify-or-repair pass.
			const disk = scanDiskLines(fingerprint === null ? [] : (await io.read()).split("\n"));
			const repaired = repairMutationLine(stripTrailingNewline(content), disk);
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
				this.sentinel.forget(path);
				this.tracks.delete(path);
				return;
			}
			const fingerprint = { mtimeMs: observed.mtime, size: observed.size };
			this.sentinel.remember(path, fingerprint);
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
		this.sentinel.forget(path);
		this.tracks.delete(path);
	}
}
