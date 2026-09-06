import { scanDiskLines } from "./sessionMutationLine";

/**
 * Union merge of two device-local views of one chat log.
 *
 * The vault sync plugin arbitrates whole files last-writer-wins, so when a
 * foreign version lands on disk the previous local version survives only in
 * pi's memory. This is the recovery: both sides are line arrays of the same
 * JSONL shape, and the merge unions their transcripts — the shared history is
 * a common prefix of entry ids, the two tails are interleaved by timestamp,
 * and the whole thing is re-linearized onto the main lane.
 *
 * What it deliberately does not do: preserve cross-device branch shape
 * (linearization is the settled rule), keep record mutations (operation
 * ledgers are bookkeeping; the merged file starts with zero open operations,
 * which is exactly what recovery wants), or reconcile two independent
 * compactions (a compacted context forked beyond repair is quarantined, not
 * merged).
 *
 * Strings in, strings out — the golden tests read like file contents, and the
 * caller writes the output with the same `.tmp` → rename ritual pi's own
 * torn-tail repair uses.
 */

export type MergeConflict =
	/** The foreign file's first line is not a readable header. */
	| { kind: "unreadable-foreign" }
	/** The foreign file is a different session than the one the caller expected. */
	| { kind: "session-id"; foreignId?: string }
	/** One entry id exists on both sides with different content. */
	| { kind: "duplicate-entry"; id: string }
	/** Both sides compacted past the common prefix — the contexts forked irreconcilably. */
	| { kind: "compaction-both" };

export interface MergeResult {
	/** Re-serialized file lines (foreign header first), or null when conflicts block the merge. */
	merged: string[] | null;
	conflicts: MergeConflict[];
	/**
	 * Entries each side contributed beyond the common prefix. A side with zero
	 * tail means the other side already holds the full union — the caller can
	 * skip the write entirely and only rebuild in memory.
	 */
	localTail: number;
	foreignTail: number;
}

interface SideEntry {
	id: string;
	timestamp: number;
	parentId: string | null;
	/** The full flat mutation value — payload fields included, re-emitted verbatim. */
	value: Record<string, unknown>;
}

interface Side {
	headerLine: string | null;
	headerId: string | undefined;
	/** The main-lane transcript, oldest first — what the user reads as the conversation. */
	branch: SideEntry[];
	entriesById: Map<string, SideEntry>;
	/** The side's last `name` fact, or null when it never named the session. */
	nameFact: { name?: string } | null;
	/** Last label per target id. */
	labels: Map<string, string | undefined>;
}

/**
 * One pass over a side's lines, lenient like `scanDiskLines`: unparseable
 * lines are skipped, not failed — pi only ever writes valid mutations, so a
 * failure means a torn tail or a header, both of which the scan already
 * handles.
 *
 * The branch walk starts at the main lane's leaf and follows `parentId` home.
 * A file whose entries are all lane-less (the repair net's own output) leaves
 * the leaf at its bootstrap null, so the walk falls back to the last entry —
 * for a linear file that is the same transcript.
 */
function parseSide(lines: string[]): Side {
	const side: Side = {
		headerLine: null,
		headerId: undefined,
		branch: [],
		entriesById: new Map(),
		nameFact: null,
		labels: new Map(),
	};
	for (const line of lines) {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			continue;
		}
		const record = value as Record<string, unknown>;
		if (side.headerLine === null && record.kind === "header") {
			side.headerLine = line;
			side.headerId = typeof record.id === "string" ? record.id : undefined;
			continue;
		}
		if (record.kind === "entry" && typeof record.id === "string") {
			const entry: SideEntry = {
				id: record.id,
				timestamp: typeof record.timestamp === "number" ? record.timestamp : 0,
				parentId: typeof record.parentId === "string" ? record.parentId : null,
				value: record,
			};
			if (!side.entriesById.has(entry.id)) {
				side.entriesById.set(entry.id, entry);
			}
			continue;
		}
		if (record.kind === "fact" && record.fact === "name") {
			side.nameFact = { name: typeof record.name === "string" ? record.name : undefined };
			continue;
		}
		if (record.kind === "fact" && record.fact === "label" && typeof record.targetId === "string") {
			side.labels.set(record.targetId, typeof record.label === "string" ? record.label : undefined);
		}
	}
	const disk = scanDiskLines(lines);
	const leaf = disk.laneLeaves.get("main") ?? disk.lastEntryId;
	const walked: string[] = [];
	const visited = new Set<string>();
	for (let id = leaf; id !== null && id !== undefined && !visited.has(id) && side.entriesById.has(id); id = side.entriesById.get(id)!.parentId) {
		visited.add(id);
		walked.push(id);
	}
	side.branch = walked.reverse().map((id) => side.entriesById.get(id)!);
	return side;
}

/**
 * Content identity of an entry, independent of where it sat in its own file:
 * `seq` is positional and renumbered, `lane` is rewritten to main, everything
 * else — parent, timestamp, payload — is the entry itself. Keys are sorted so
 * the same object serialized by different code paths compares equal.
 */
function contentKey(entry: SideEntry): string {
	const { seq: _seq, lane: _lane, ...content } = entry.value;
	return canonicalJson(content);
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (typeof value === "object" && value !== null) {
		const keys = Object.keys(value as Record<string, unknown>).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** Interleaves two chain-ordered tails by timestamp; each tail keeps its own order, local wins ties. */
function interleave(local: SideEntry[], foreign: SideEntry[]): SideEntry[] {
	const out: SideEntry[] = [];
	let i = 0;
	let j = 0;
	while (i < local.length && j < foreign.length) {
		const takeLocal = local[i]!.timestamp <= foreign[j]!.timestamp;
		out.push(takeLocal ? local[i++]! : foreign[j++]!);
	}
	while (i < local.length) {
		out.push(local[i++]!);
	}
	while (j < foreign.length) {
		out.push(foreign[j++]!);
	}
	return out;
}

/**
 * Merges the local in-memory view into the foreign on-disk file.
 *
 * `sessionId` is the id the caller believes both files carry — normally the
 * active session's metadata id. The output header is the foreign file's own,
 * verbatim: it is the session every other device already knows.
 */
export function mergeSessions(localLines: string[], foreignLines: string[], sessionId: string): MergeResult {
	const foreign = parseSide(foreignLines);
	if (foreign.headerLine === null) {
		return { merged: null, conflicts: [{ kind: "unreadable-foreign" }], localTail: 0, foreignTail: 0 };
	}
	if (foreign.headerId !== sessionId) {
		return { merged: null, conflicts: [{ kind: "session-id", foreignId: foreign.headerId }], localTail: 0, foreignTail: 0 };
	}
	const local = parseSide(localLines);

	// A shared id with divergent content means the two devices disagree about
	// what that entry is — no silent winner is safe, so the whole merge yields
	// to quarantine. (pi's per-append uuids make this practically unreachable;
	// it guards the pathological sync, not the everyday one.)
	const conflicts: MergeConflict[] = [];
	for (const [id, localEntry] of local.entriesById) {
		const foreignEntry = foreign.entriesById.get(id);
		if (foreignEntry !== undefined && contentKey(localEntry) !== contentKey(foreignEntry)) {
			conflicts.push({ kind: "duplicate-entry", id });
		}
	}

	// The shared history is the longest common prefix of the two transcripts.
	const localIds = local.branch.map((entry) => entry.id);
	const foreignIds = foreign.branch.map((entry) => entry.id);
	let prefixLength = 0;
	while (
		prefixLength < localIds.length &&
		prefixLength < foreignIds.length &&
		localIds[prefixLength] === foreignIds[prefixLength]
	) {
		prefixLength += 1;
	}
	const prefix = local.branch.slice(0, prefixLength);
	const localTail = local.branch.slice(prefixLength);
	const foreignTail = foreign.branch.slice(prefixLength);

	// Both sides compacted past the shared history: each summary describes a
	// context the other never saw, and stitching them would fabricate a
	// conversation nobody had. Quarantine, not merge.
	if (localTail.some((entry) => entry.value.type === "compaction") && foreignTail.some((entry) => entry.value.type === "compaction")) {
		conflicts.push({ kind: "compaction-both" });
	}
	if (conflicts.length > 0) {
		return { merged: null, conflicts, localTail: localTail.length, foreignTail: foreignTail.length };
	}

	// An id on both tails with identical content is one entry seen twice — the
	// foreign copy wins, the local one folds away.
	const foreignTailIds = new Set(foreignTail.map((entry) => entry.id));
	const localOnly = localTail.filter((entry) => !foreignTailIds.has(entry.id));

	const lines: string[] = [foreign.headerLine];
	const emittedIds = new Set<string>();
	let seq = 0;
	let previousId: string | null = null;
	for (const entry of [...prefix, ...interleave(localOnly, foreignTail)]) {
		seq += 1;
		emittedIds.add(entry.id);
		// Every entry rides the main lane chained to its predecessor, so the
		// replayed leaf lands on the final entry — the lane shape pi itself
		// writes for a linear session, with no terminal lane mutation needed.
		// Each line keeps its own trailing newline: joined, the output is the
		// byte-exact file content pi's loader expects.
		lines.push(`${JSON.stringify({ ...entry.value, kind: "entry", seq, lane: "main", parentId: previousId })}\n`);
		previousId = entry.id;
	}

	// The rename race has no in-band timestamps to arbitrate it; the foreign
	// name wins because that is the state the sync event just delivered. A
	// label survives only when its target entry did.
	const nameFact = foreign.nameFact ?? local.nameFact;
	if (nameFact !== null) {
		seq += 1;
		lines.push(`${JSON.stringify({ kind: "fact", seq, fact: "name", ...(nameFact.name === undefined ? {} : { name: nameFact.name }) })}\n`);
	}
	const labels = new Map([...local.labels, ...foreign.labels]);
	for (const [targetId, label] of labels) {
		if (!emittedIds.has(targetId)) {
			continue;
		}
		seq += 1;
		lines.push(`${JSON.stringify({ kind: "fact", seq, fact: "label", targetId, ...(label === undefined ? {} : { label }) })}\n`);
	}

	return { merged: lines, conflicts: [], localTail: localOnly.length, foreignTail: foreignTail.length };
}
