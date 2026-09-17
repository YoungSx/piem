import type { Entry } from "@earendil-works/pi-agent-core";

/** What the fs remembered about the last write it made to a path. */
interface FileFingerprint {
	mtimeMs: number;
	size: number;
}

const VALID_ENTRY_TYPES = new Set(["message", "custom", "compaction", "branch_summary", "model_change", "thinking_level_change"]);
const VALID_RECORD_TYPES = new Set(["usage", "operation_started", "operation_finished"]);

export type SessionMutationLine =
	| { kind: "entry"; seq?: number; lane?: string; entry: Entry & { seq: number; id: string; parentId: string | null } }
	| { kind: "record"; seq: number; record: { id: string; seq: number; lane: string; type: string; [key: string]: unknown } }
	| { kind: "lane"; seq: number; lane: string; leafId: string | null }
	| { kind: "fact"; seq: number; fact: "name"; name?: string }
	| { kind: "fact"; seq: number; fact: "label"; targetId: string; label?: string }
	| { kind: "usage"; seq: number; id: string; usage: unknown }
	| { kind: "value"; seq: number; op: "set" | "delete"; namespace: string; key: string; value?: unknown }
	| { kind: "list"; seq: number; op: "append" | "delete"; namespace: string; key: string; value?: unknown };

export function encodeMutation(mutation: Record<string, unknown>): string {
	if (mutation.kind === "entry" && mutation.entry && typeof mutation.entry === "object") {
		const entry = mutation.entry as Record<string, unknown>;
		const lane = mutation.lane;
		const full = {
			kind: "entry",
			seq: entry.seq,
			...(lane !== undefined ? { lane } : {}),
			...entry,
		};
		return `${JSON.stringify(full)}\n`;
	}
	return `${JSON.stringify(mutation)}\n`;
}

export function parseMutationFromObject(parsed: Record<string, unknown>): SessionMutationLine | null {
	if (parsed.kind === "header") {
		return null;
	}
	const seq = parsed.seq;
	if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
		return null;
	}

	switch (parsed.kind) {
		case "entry": {
			const entryObj = (typeof parsed.entry === "object" && parsed.entry !== null ? parsed.entry : parsed) as Record<string, unknown>;
			if (typeof entryObj.id !== "string" || !entryObj.id) return null;
			if (typeof entryObj.type !== "string" || !VALID_ENTRY_TYPES.has(entryObj.type)) return null;
			const { lane: _l, kind: _k, ...cleanEntryObj } = entryObj;
			const entry: Entry & { seq: number; id: string; parentId: string | null } = {
				...cleanEntryObj,
				id: entryObj.id,
				seq,
				parentId: (typeof entryObj.parentId === "string" ? entryObj.parentId : null),
			} as unknown as Entry & { seq: number; id: string; parentId: string | null };
			return {
				kind: "entry",
				lane: typeof parsed.lane === "string" ? parsed.lane : undefined,
				entry,
			};
		}
		case "record": {
			const recObj = (typeof parsed.record === "object" && parsed.record !== null ? parsed.record : parsed) as Record<string, unknown>;
			if (typeof recObj.id !== "string" || !recObj.id) return null;
			if (typeof recObj.lane !== "string") return null;
			if (typeof recObj.type !== "string" || !VALID_RECORD_TYPES.has(recObj.type)) return null;
			return {
				kind: "record",
				seq,
				record: { ...recObj, id: recObj.id, lane: recObj.lane, type: recObj.type, seq },
			};
		}
		case "lane":
			if (typeof parsed.lane !== "string") return null;
			return {
				kind: "lane",
				seq,
				lane: parsed.lane,
				leafId: typeof parsed.leafId === "string" ? parsed.leafId : null,
			};
		case "fact":
			if (parsed.fact === "name") {
				return { kind: "fact", seq, fact: "name", name: typeof parsed.name === "string" ? parsed.name : undefined };
			}
			if (parsed.fact === "label" && typeof parsed.targetId === "string") {
				return { kind: "fact", seq, fact: "label", targetId: parsed.targetId, label: typeof parsed.label === "string" ? parsed.label : undefined };
			}
			return null;
		case "usage":
			if (typeof parsed.id !== "string") return null;
			return { kind: "usage", seq, id: parsed.id, usage: parsed.usage };
		case "value":
			if (typeof parsed.namespace !== "string" || typeof parsed.key !== "string") return null;
			if (parsed.op !== "set" && parsed.op !== "delete") return null;
			return { kind: "value", seq, op: parsed.op, namespace: parsed.namespace, key: parsed.key, value: parsed.value };
		case "list":
			if (typeof parsed.namespace !== "string" || typeof parsed.key !== "string") return null;
			if (parsed.op !== "append" && parsed.op !== "delete") return null;
			return { kind: "list", seq, op: parsed.op, namespace: parsed.namespace, key: parsed.key, value: parsed.value };
		default:
			return null;
	}
}

/**
 * Parses one JSONL mutation line, or `null` for anything a repair must not
 * rewrite: the header line, a torn tail, or a bare `"\n"`.
 */
export function parseMutationLine(line: string): SessionMutationLine | null {
	if (line === "" || line === "\n") {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return null;
	}
	if (Array.isArray(parsed)) {
		if (parsed.length === 0) return null;
		const entryItem = (parsed as unknown[]).find((item): item is Record<string, unknown> => typeof item === "object" && item !== null && (item as Record<string, unknown>).kind === "entry");
		const primary = entryItem ?? (parsed[0] as Record<string, unknown>);
		if (typeof primary !== "object" || primary === null) return null;
		return parseMutationFromObject(primary);
	}
	return parseMutationFromObject(parsed as Record<string, unknown>);
}

/**
 * What one pass over a log's lines establishes for repair decisions.
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
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const items = Array.isArray(parsed) ? parsed : [parsed];
		for (const item of items) {
			if (typeof item !== "object" || item === null) continue;
			const mutation = parseMutationFromObject(item as Record<string, unknown>);
			if (!mutation) continue;
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
				case "value":
					if (mutation.namespace === "pi.branch.tip") {
						snapshot.laneLeaves.set(mutation.key, typeof mutation.value === "string" ? mutation.value : null);
					}
					break;
				case "usage":
					snapshot.usedIds.add(mutation.id);
					break;
				case "list":
					break;
			}
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
 */
function mutationSeq(mutation: SessionMutationLine): number {
	return mutation.kind === "entry" ? mutation.entry.seq : mutation.kind === "record" ? mutation.record.seq : mutation.seq;
}

export function repairMutationLine(line: string, disk: DiskSnapshot): RepairedLine {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return { action: "kept", line, seq: 0 };
	}

	if (Array.isArray(raw)) {
		if (raw.length === 0) {
			return { action: "kept", line, seq: 0 };
		}
		const entryIndex = (raw as unknown[]).findIndex((item) => typeof item === "object" && item !== null && (item as Record<string, unknown>).kind === "entry");
		if (entryIndex !== -1) {
			const entryObj = raw[entryIndex] as Record<string, unknown>;
			const id = entryObj.id as string;
			if (disk.usedIds.has(id)) {
				return { action: "dropped" };
			}
			const leaf = disk.laneLeaves.get("main") ?? null;
			const firstItem = raw[0] as Record<string, unknown>;
			const firstSeq = typeof firstItem?.seq === "number" ? firstItem.seq : (entryObj.seq as number);
			const continues = firstSeq === disk.maxSeq + 1 && (entryObj.parentId ?? null) === leaf;
			const lastItem = raw[raw.length - 1] as Record<string, unknown>;
			const lastSeq = (typeof lastItem?.seq === "number" ? lastItem.seq : entryObj.seq) as number;
			if (continues) {
				return { action: "kept", line, seq: lastSeq };
			}
			let nextSeq = disk.maxSeq;
			for (let i = 0; i < raw.length; i++) {
				const item = raw[i] as Record<string, unknown>;
				item.seq = ++nextSeq;
				if (i === entryIndex) {
					item.parentId = leaf;
				}
				if (item.kind === "value" && item.namespace === "pi.branch.tip") {
					item.value = id;
				}
			}
			return { action: "repaired", line: `${JSON.stringify(raw)}\n`, seq: nextSeq };
		}

		for (const item of raw) {
			if (typeof item !== "object" || item === null) continue;
			const itemObj = item as Record<string, unknown>;
			if (itemObj.kind === "value") {
				if (itemObj.namespace === "pi.branch.tip" && typeof itemObj.value === "string" && itemObj.value !== null && !disk.entryIds.has(itemObj.value)) {
					return { action: "dropped" };
				}
				if (itemObj.namespace === "pi.entry.label" && typeof itemObj.key === "string" && !disk.entryIds.has(itemObj.key)) {
					return { action: "dropped" };
				}
			} else if (itemObj.kind === "record") {
				if ((typeof itemObj.lane === "string" && !disk.laneLeaves.has(itemObj.lane)) || (typeof itemObj.id === "string" && disk.usedIds.has(itemObj.id))) {
					return { action: "dropped" };
				}
			} else if (itemObj.kind === "usage") {
				if (typeof itemObj.id === "string" && disk.usedIds.has(itemObj.id)) {
					return { action: "dropped" };
				}
			} else if (itemObj.kind === "lane") {
				if (itemObj.leafId !== null && typeof itemObj.leafId === "string" && !disk.entryIds.has(itemObj.leafId)) {
					return { action: "dropped" };
				}
			} else if (itemObj.kind === "fact") {
				if (itemObj.fact === "label" && typeof itemObj.targetId === "string" && !disk.entryIds.has(itemObj.targetId)) {
					return { action: "dropped" };
				}
			}
		}

		const firstItem = raw[0] as Record<string, unknown>;
		const firstSeq = typeof firstItem?.seq === "number" ? firstItem.seq : 0;
		const lastItem = raw[raw.length - 1] as Record<string, unknown>;
		const lastSeq = typeof lastItem?.seq === "number" ? lastItem.seq : firstSeq;
		const continues = firstSeq === disk.maxSeq + 1;
		if (continues) {
			return { action: "kept", line, seq: lastSeq };
		}
		let nextSeq = disk.maxSeq;
		for (let i = 0; i < raw.length; i++) {
			const item = raw[i] as Record<string, unknown>;
			item.seq = ++nextSeq;
		}
		return { action: "repaired", line: `${JSON.stringify(raw)}\n`, seq: nextSeq };
	}

	const mutation = parseMutationLine(line);
	if (!mutation) {
		return { action: "kept", line, seq: 0 };
	}
	const seq = disk.maxSeq + 1;
	const continues = mutationSeq(mutation) === seq;
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
		case "value":
			if (mutation.namespace === "pi.branch.tip" && mutation.value !== null && typeof mutation.value === "string" && !disk.entryIds.has(mutation.value)) {
				return { action: "dropped" };
			}
			if (mutation.namespace === "pi.entry.label" && !disk.entryIds.has(mutation.key)) {
				return { action: "dropped" };
			}
			return verdict(null);
		case "usage":
			return verdict(disk.usedIds.has(mutation.id) ? { action: "dropped" } : null);
		case "list":
			return verdict(null);
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
			let rawParsed: unknown;
			try {
				rawParsed = JSON.parse(bare);
			} catch {
				return { line: content };
			}
			if (typeof rawParsed !== "object" || rawParsed === null) {
				return { line: content };
			}
			if (Array.isArray(rawParsed) && rawParsed.length === 0) {
				return { line: content };
			}
			if ((rawParsed as Record<string, unknown>).kind === "header") {
				return { line: content };
			}

			const items = Array.isArray(rawParsed) ? rawParsed : [rawParsed];
			const firstItem = items[0] as Record<string, unknown>;
			const lastItem = items[items.length - 1] as Record<string, unknown>;
			const firstSeq = typeof firstItem?.seq === "number" ? firstItem.seq : undefined;
			const lastSeq = typeof lastItem?.seq === "number" ? lastItem.seq : firstSeq;

			if (firstSeq === undefined || lastSeq === undefined) {
				return { line: content };
			}

			// The fast path: disk is exactly where we left it AND pi's seq continues
			// from the last seq we wrote. No read needed.
			if (same && track.lastSeq !== undefined && firstSeq === track.lastSeq + 1) {
				return { line: content, appendedSeq: lastSeq };
			}

			// Everything else — first append this process (a sync landing between
			// load and here is invisible to a baseline we never wrote), a foreign
			// writer, or a seq that stopped continuing — is settled by one disk
			// read and a verify-or-repair pass.
			const disk = scanDiskLines(observed === null ? [] : (await io.read()).split("\n"));
			const repaired = repairMutationLine(bare, disk);
			const mutation = parseMutationLine(bare);
			const eventKind: SessionMutationLine["kind"] = mutation?.kind ?? "value";
			if (repaired.action === "dropped") {
				this.onDrift?.({ path, action: "dropped", kind: eventKind });
				// Nothing was written, but the read did verify the disk's tail —
				// remembering it keeps the fast path honest for the next append.
				return { line: null, appendedSeq: disk.maxSeq };
			}
			if (repaired.action === "repaired") {
				this.onDrift?.({ path, action: "repaired", kind: eventKind, seq: repaired.seq });
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
