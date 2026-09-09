import type { LogItem } from "@earendil-works/pi-agent-core";
import type { Entry } from "../../node_modules/@earendil-works/pi-agent-core/dist/harness/session/types.js";
import { parseHeader } from "../../node_modules/@earendil-works/pi-agent-core/dist/harness/session/jsonl/codec.js";
import { encodeMutation, parseMutationLine, scanDiskLines } from "./sessionMutationLine";

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
	/** Facts differ even when no conversation entry was appended. */
	factsChanged?: boolean;
	/** The disk lacks local facts, so even a transcript superset needs a write. */
	localFactsChanged?: boolean;
}

interface Side {
	headerLine: string | null;
	headerId: string | undefined;
	/** The main-lane transcript, oldest first — what the user reads as the conversation. */
	branch: Entry[];
	entriesById: Map<string, Entry>;
	/** The side's last `name` fact, or null when it never named the session. */
	nameFact: { name?: string } | null;
	/** Last label per target id. */
	labels: Map<string, string | undefined>;
}

/**
 * One pass over a side's lines, lenient like `scanDiskLines`: the same codec
 * that guards pi's loader reads each line here, so unparseable lines — a torn
 * tail, a header, anything pi itself would refuse — are skipped, not failed.
 * A side this module builds from is exactly what pi would load from it.
 *
 * The branch walk starts at the main lane's leaf and follows `parentId` home.
 * A file whose entries are all lane-less (the repair net's own output) leaves
 * the leaf at its bootstrap null, so the walk falls back to the last entry —
 * for a linear file that is the same transcript.
 */
function parseSide(lines: string[]): Side {
	let hasMainPointer = false;
	const side: Side = {
		headerLine: null,
		headerId: undefined,
		branch: [],
		entriesById: new Map(),
		nameFact: null,
		labels: new Map(),
	};
	for (const line of lines) {
		if (side.headerLine === null) {
			// The first readable header line wins; the codec also rejects headers of
			// a version pi itself would refuse, so an unreadable one is just skipped.
			const header = parseHeader(line);
			if (header.ok) {
				side.headerLine = line;
				side.headerId = header.value.id;
				continue;
			}
		}
		const mutation = parseMutationLine(line);
		if (!mutation) {
			continue;
		}
		switch (mutation.kind) {
			case "entry": {
				const entry = mutation.entry;
				if (!side.entriesById.has(entry.id)) {
					side.entriesById.set(entry.id, entry);
				}
				break;
			}
			case "fact":
				if (mutation.fact === "name") {
					side.nameFact = { name: mutation.name };
				} else {
					side.labels.set(mutation.targetId, mutation.label);
				}
				break;
			case "lane":
				if (mutation.lane === "main") hasMainPointer = true;
				break;
		}
	}
	const disk = scanDiskLines(lines);
	const leaf = hasMainPointer ? disk.laneLeaves.get("main") : disk.laneLeaves.get("main") ?? disk.lastEntryId;
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
 * Content identity of an entry, independent of where it sat in its own file.
 * Two fields are deliberately stripped, both because the merge re-derives them:
 * `seq` is positional and renumbered, and `parentId` is structural — every
 * emitted entry is re-chained to its predecessor, so where an entry hung in
 * its own file never reaches the output. Tolerating the chain position is not
 * leniency, it is what lets the repair net's own rewrites fold back in: an
 * append written across a foreign landing arrives with its parent corrected to
 * the disk's leaf, and the memory's stale chain position must not turn that
 * into a conflict. Everything left — timestamp, payload — is the entry itself.
 *
 * Plain `JSON.stringify` suffices for identity: pi's codec is the only
 * producer of these lines and serializes keys in a fixed order, and the repair
 * net's rewrites only mutate values in place, so equal content always
 * stringifies equal. A future producer with a different key order degrades
 * safely — to a quarantine, never to a silently accepted divergent entry.
 */
function contentKey(entry: Entry): string {
	const { seq: _seq, parentId: _parentId, ...content } = entry;
	return JSON.stringify(content);
}

/**
 * Merges the local in-memory view into the foreign on-disk file.
 *
 * `sessionId` is the id the caller believes both files carry — normally the
 * active session's metadata id. The output header is the foreign file's own,
 * verbatim: it is the session every other device already knows.
 */
export function mergeSessions(localLines: string[], foreignLines: string[], sessionId: string): MergeResult {
	// The shared shape of the two refused-at-the-header outcomes.
	const refused = (conflicts: MergeConflict[]): MergeResult => ({ merged: null, conflicts, localTail: 0, foreignTail: 0 });
	const foreign = parseSide(foreignLines);
	if (foreign.headerLine === null) {
		return refused([{ kind: "unreadable-foreign" }]);
	}
	if (foreign.headerId !== sessionId) {
		return refused([{ kind: "session-id", foreignId: foreign.headerId }]);
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
	let prefixLength = 0;
	while (
		prefixLength < local.branch.length &&
		prefixLength < foreign.branch.length &&
		local.branch[prefixLength]!.id === foreign.branch[prefixLength]!.id
	) {
		prefixLength += 1;
	}
	const prefix = local.branch.slice(0, prefixLength);
	const localTail = local.branch.slice(prefixLength);
	const foreignTail = foreign.branch.slice(prefixLength);

	// Both sides compacted past the shared history: each summary describes a
	// context the other never saw, and stitching them would fabricate a
	// conversation nobody had. Quarantine, not merge.
	if (localTail.some((entry) => entry.type === "compaction") && foreignTail.some((entry) => entry.type === "compaction")) {
		conflicts.push({ kind: "compaction-both" });
	}
	if (conflicts.length > 0) {
		return { merged: null, conflicts, localTail: localTail.length, foreignTail: foreignTail.length };
	}

	// An id on both tails with identical content is one entry seen twice — the
	// foreign copy wins, the local one folds away. Tails are short (a session's
	// entries past the shared history), so the linear scan beats a set.
	const localOnly = localTail.filter((entry) => !foreignTail.some((foreignEntry) => foreignEntry.id === entry.id));

	const lines: string[] = [];
	// The emitted contract is one newline per line, and the header obeys it too:
	// sides may arrive with bare lines (a `split("\n")` view) or with their
	// terminators kept (a hand-built fixture), so the header — the one line
	// passed through byte-for-byte — is terminated here rather than trusted.
	const headerLine = foreign.headerLine.endsWith("\n") ? foreign.headerLine : `${foreign.headerLine}\n`;
	lines.push(headerLine);
	const emittedIds = new Set<string>();
	let seq = 0;
	let previousId: string | null = null;
	// The two tails interleave by timestamp — a stable sort does it: local first
	// in the concat wins ties, and each tail's chain order survives (ES2019+
	// sorts are stable), so the comparison order is identical to a hand-rolled
	// merge of two sorted sequences.
	for (const entry of [...prefix, ...[...localOnly, ...foreignTail].sort((a, b) => a.timestamp - b.timestamp)]) {
		seq += 1;
		emittedIds.add(entry.id);
		// Every entry rides the main lane chained to its predecessor, so the
		// replayed leaf lands on the final entry — the lane shape pi itself
		// writes for a linear session, with no terminal lane mutation needed.
		// Emission is pi's own encoder: each line keeps its trailing newline,
		// and joined, the output is the byte-exact file content pi's loader
		// expects.
		lines.push(encodeMutation({ kind: "entry", lane: "main", entry: { ...entry, seq, parentId: previousId } }));
		previousId = entry.id;
	}

	// The rename race has no in-band timestamps to arbitrate it; the foreign
	// name wins because that is the state the sync event just delivered. A
	// label survives only when its target entry did.
	const nameFact = foreign.nameFact ?? local.nameFact;
	if (nameFact !== null) {
		seq += 1;
		lines.push(encodeMutation({ kind: "fact", seq, fact: "name", name: nameFact.name }));
	}
	const labels = new Map([...local.labels, ...foreign.labels]);
	for (const [targetId, label] of labels) {
		if (!emittedIds.has(targetId)) {
			continue;
		}
		seq += 1;
		lines.push(encodeMutation({ kind: "fact", seq, fact: "label", targetId, label }));
	}

	const factsChanged = JSON.stringify(nameFact) !== JSON.stringify(local.nameFact)
		|| [...labels].some(([id, label]) => local.labels.get(id) !== label || !local.labels.has(id));
	if (localOnly.length === 0) {
		// Disk already contains the transcript. Keep its branches and operation records
		// byte-for-byte; adding a label must not linearize an unchanged conversation.
		const preserved = foreignLines.filter(line => line.trim()).map(line => line.endsWith("\n") ? line : `${line}\n`);
		let nextSeq = scanDiskLines(foreignLines).maxSeq;
		let localFactsChanged = false;
		if (foreign.nameFact === null && local.nameFact !== null) {
			preserved.push(encodeMutation({ kind: "fact", seq: ++nextSeq, fact: "name", name: local.nameFact.name }));
			localFactsChanged = true;
		}
		for (const [targetId, label] of local.labels) {
			if (!foreign.labels.has(targetId) && foreign.entriesById.has(targetId)) {
				preserved.push(encodeMutation({ kind: "fact", seq: ++nextSeq, fact: "label", targetId, label }));
				localFactsChanged = true;
			}
		}
		return { merged: preserved, conflicts: [], localTail: 0, foreignTail: foreignTail.length, factsChanged, localFactsChanged };
	}
	return { merged: lines, conflicts: [], localTail: localOnly.length, foreignTail: foreignTail.length, factsChanged };
}

/**
 * Flattens pi's in-memory log back into the JSONL wire shape the merge — and
 * the file on disk — speak. `getLog` returns entries nested under `entry`, the
 * opposite of what the wire carries, so this re-flattens through pi's own
 * encoder. Final lane pointers restore the branch heads: getLog's entry items
 * omit their original lane, so treating every append as main alone would undo a
 * rewind when the reconciler next reads an otherwise unchanged file.
 *
 * No header line: `getLog` never returns one, and {@link mergeSessions} only
 * reads the foreign side's header — the local side is tolerated headerless.
 */
export function serializeLogLines(items: LogItem[], lanes: ReadonlyArray<{ lane: string; leafId: string | null }> = []): string[] {
	const lines: string[] = [];
	for (const item of items) {
		if (item.kind === "entry") {
			lines.push(encodeMutation({ kind: "entry", lane: "main", entry: item.entry }));
		} else if (item.kind === "fact") {
			lines.push(encodeMutation(item));
		}
	}
	let seq = items.at(-1)?.seq ?? 0;
	for (const pointer of lanes) {
		lines.push(encodeMutation({ kind: "lane", seq: ++seq, ...pointer }));
	}
	return lines;
}
