import { describe, expect, it } from "bun:test";
import type { DataAdapter } from "obsidian";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { ObsidianSessionFileSystem } from "./ObsidianSessionFileSystem";
import { scanDiskLines } from "./sessionMutationLine";
import { mergeSessions } from "./sessionMerge";

const SESSIONS_ROOT = "Piem/chats";
const CWD = "piem";

/** A flat header line, as pi's codec emits it — createdAt is epoch ms, not ISO. */
function header(id: string): string {
	return `${JSON.stringify({ kind: "header", version: 4, id, createdAt: 1767225600000, cwd: CWD })}\n`;
}

/**
 * One flat, main-lane message entry with deterministic ids and timestamps.
 * `seq` must be positive for the line to parse (the merge renumbers anyway);
 * each caller chains its own 1..n.
 */
let seqCounter = 0;
function entryLine(id: string, parentId: string | null, timestamp: number, overrides: Record<string, unknown> = {}): string {
	return `${JSON.stringify({
		kind: "entry", seq: (seqCounter = seqCounter % 100 + 1), lane: "main", id, type: "message", parentId, timestamp,
		message: { role: "user", content: [{ type: "text", text: `msg ${id}` }] },
		...overrides,
	})}\n`;
}

function factName(seq: number, name: string): string {
	return `${JSON.stringify({ kind: "fact", seq, fact: "name", name })}\n`;
}

/** Chain a list of ids: each entry's parent is the previous one. */
function chain(ids: string[], baseTimestamp: number, parentId: string | null = null): string[] {
	const lines: string[] = [];
	let parent = parentId;
	let timestamp = baseTimestamp;
	for (const id of ids) {
		lines.push(entryLine(id, parent, timestamp));
		parent = id;
		timestamp += 10;
	}
	return lines;
}

function entryIds(lines: string[]): string[] {
	return lines.flatMap((line) => {
		const value = JSON.parse(line) as { kind?: string; id?: string };
		return value.kind === "entry" && typeof value.id === "string" ? [value.id] : [];
	});
}

describe("mergeSessions", () => {
	// The two sides always build from the same shared prefix; the scenarios
	// diverge in what each device appended after it.
	const SHARED = chain(["s1", "s2", "s3"], 1000);

	it("unions two divergent tails in timestamp order and renumbers seq 1..n", () => {
		const local = [header("sess"), ...SHARED, ...chain(["l4", "l5"], 1100, "s3")];
		const foreign = [header("sess"), ...SHARED, ...chain(["f6", "f7"], 1050, "s3")];

		const result = mergeSessions(local, foreign, "sess");

		expect(result.conflicts).toEqual([]);
		expect(result.merged).not.toBeNull();
		const merged = result.merged!;
		expect(merged[0]).toBe(foreign[0]);
		expect(entryIds(merged)).toEqual(["s1", "s2", "s3", "f6", "f7", "l4", "l5"]);
		// seqs are 1..n in emitted order, parents form one chain on main.
		const parsed = merged.slice(1).map((line) => JSON.parse(line) as { seq: number; lane: string; parentId: string | null; id: string });
		expect(parsed.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
		expect(parsed.every((m) => m.lane === "main")).toBe(true);
		expect(parsed.map((m) => m.parentId)).toEqual([null, "s1", "s2", "s3", "f6", "f7", "l4"]);
		// The leaf chain from the merged file's own snapshot ends on the final entry.
		expect(scanDiskLines(merged).laneLeaves.get("main")).toBe("l5");
		expect(result.localTail).toBe(2);
		expect(result.foreignTail).toBe(2);
	});

	it("keeps an entry present on both tails with identical content once", () => {
		const local = [header("sess"), ...SHARED, ...chain(["l4"], 1100, "s3")];
		// The foreign file already holds everything local has — same l4, same
		// content — plus one more entry after it: the foreign side is the superset.
		const foreign = [header("sess"), ...SHARED, ...chain(["l4", "f6"], 1100, "s3")];

		const result = mergeSessions(local, foreign, "sess");

		expect(result.conflicts).toEqual([]);
		expect(entryIds(result.merged!)).toEqual(["s1", "s2", "s3", "l4", "f6"]);
		expect(result.localTail).toBe(0);
		expect(result.foreignTail).toBe(1);
	});

	it("rejects a foreign file that is a different session", () => {
		const local = [header("sess"), ...SHARED];
		const foreign = [header("other"), ...SHARED];

		const result = mergeSessions(local, foreign, "sess");

		expect(result.merged).toBeNull();
		expect(result.conflicts).toEqual([{ kind: "session-id", foreignId: "other" }]);
	});

	it("rejects a foreign file without a readable header", () => {
		const result = mergeSessions([header("sess")], ["{torn"], "sess");

		expect(result.merged).toBeNull();
		expect(result.conflicts).toEqual([{ kind: "unreadable-foreign" }]);
	});

	it("flags a shared entry whose content diverged instead of picking a winner", () => {
		const local = [header("sess"), ...SHARED, ...chain(["l4"], 1100, "s3")];
		// s2 exists on both sides but its message text differs — the one thing a
		// union cannot paper over.
		const foreign = [header("sess"), entryLine("s1", null, 1000), entryLine("s2", "s1", 1010, { message: { role: "user", content: [{ type: "text", text: "corrupted" }] } })];

		const result = mergeSessions(local, foreign, "sess");

		expect(result.merged).toBeNull();
		expect(result.conflicts).toEqual([{ kind: "duplicate-entry", id: "s2" }]);
	});

	it("quarantines when both sides compacted past the shared prefix", () => {
		const local = [header("sess"), ...SHARED, entryLine("lc", "s3", 1200, { type: "compaction", summary: "local summary", retainedTail: [], tokensBefore: 10 })];
		const foreign = [header("sess"), ...SHARED, entryLine("fc", "s3", 1200, { type: "compaction", summary: "foreign summary", retainedTail: [], tokensBefore: 10 })];

		const result = mergeSessions(local, foreign, "sess");

		expect(result.merged).toBeNull();
		expect(result.conflicts).toEqual([{ kind: "compaction-both" }]);
	});

	it("merges when only one side compacted — the compacted side's summary rides along", () => {
		const local = [header("sess"), ...SHARED, ...chain(["l4"], 1100, "s3")];
		const foreign = [header("sess"), ...SHARED, entryLine("fc", "s3", 1150, { type: "compaction", summary: "foreign summary", retainedTail: [], tokensBefore: 10 })];

		const result = mergeSessions(local, foreign, "sess");

		expect(result.conflicts).toEqual([]);
		// The compaction is an entry like any other; what it means for context
		// reconstruction is pi's business on reload.
		expect(entryIds(result.merged!)).toEqual(["s1", "s2", "s3", "l4", "fc"]);
	});

	it("keeps the foreign name when both sides renamed", () => {
		const local = [header("sess"), ...SHARED, factName(5, "local name")];
		const foreign = [header("sess"), ...SHARED, factName(5, "foreign name")];

		const result = mergeSessions(local, foreign, "sess");

		const facts = result.merged!.map((line) => JSON.parse(line) as { fact?: string; name?: string }).filter((p) => p.fact === "name");
		expect(facts.map((f) => f.name)).toEqual(["foreign name"]);
	});

	it("keeps a local-only name fact", () => {
		const local = [header("sess"), ...SHARED, factName(5, "local name")];
		const foreign = [header("sess"), ...SHARED];

		const result = mergeSessions(local, foreign, "sess");

		const facts = result.merged!.map((line) => JSON.parse(line) as { fact?: string; name?: string }).filter((p) => p.fact === "name");
		expect(facts.map((f) => f.name)).toEqual(["local name"]);
	});

	it("drops label facts whose target entry vanished from the merge", () => {
		const labelLine = `${JSON.stringify({ kind: "fact", seq: 5, fact: "label", targetId: "l4", label: "kept" })}\n`;
		const labelGhost = `${JSON.stringify({ kind: "fact", seq: 6, fact: "label", targetId: "ghost", label: "dropped" })}\n`;
		const local = [header("sess"), ...SHARED, ...chain(["l4"], 1100, "s3"), labelLine, labelGhost];
		const foreign = [header("sess"), ...SHARED];

		const result = mergeSessions(local, foreign, "sess");

		const labels = result.merged!.map((line) => JSON.parse(line) as { fact?: string; targetId?: string; label?: string }).filter((p) => p.fact === "label");
		expect(labels.map((f) => [f.targetId, f.label])).toEqual([["l4", "kept"]]);
	});

	it("resolves equal timestamps with the local entry first (stable interleave)", () => {
		const local = [header("sess"), ...SHARED, ...chain(["l4"], 1200, "s3")];
		const foreign = [header("sess"), ...SHARED, ...chain(["f6"], 1200, "s3")];

		const result = mergeSessions(local, foreign, "sess");
		expect(entryIds(result.merged!)).toEqual(["s1", "s2", "s3", "l4", "f6"]);
	});

	it("skips the write when the foreign side already holds the full union", () => {
		const local = [header("sess"), ...SHARED];
		const foreign = [header("sess"), ...SHARED, ...chain(["f6", "f7"], 1100, "s3")];

		const result = mergeSessions(local, foreign, "sess");

		expect(result.conflicts).toEqual([]);
		expect(entryIds(result.merged!)).toEqual(["s1", "s2", "s3", "f6", "f7"]);
		expect(result.localTail).toBe(0);
		expect(result.foreignTail).toBe(2);
	});

	/**
	 * The gate the golden tests cannot replace: the merged output must load in
	 * pi's own state machine, not just satisfy this file's expectations.
	 */
	it("produces a file pi's JsonlSessionRepo loads and reads back", async () => {
		const adapter = new MemoryAdapter();
		const fs = new ObsidianSessionFileSystem(adapter as unknown as DataAdapter);
		const repo = new JsonlSessionRepo({ fs, sessionsRoot: SESSIONS_ROOT });

		const local = [header("sess-1"), ...SHARED, ...chain(["l4", "l5"], 1100, "s3")];
		const foreign = [header("sess-1"), ...SHARED, ...chain(["f6", "f7"], 1050, "s3")];
		const result = mergeSessions(local, foreign, "sess-1");
		expect(result.merged).not.toBeNull();

		// pi composes `<root>/--<cwd>--/<name>.jsonl` and refuses a session id
		// outside its charset, so the fixture must speak pi's own layout. The
		// adapter is driven raw here (a foreign writer), so the folder must be
		// registered by hand — only fs writes create parents on their way in.
		const path = `${SESSIONS_ROOT}/--${CWD}--/merged.jsonl`;
		await adapter.mkdir(SESSIONS_ROOT);
		await adapter.mkdir(`${SESSIONS_ROOT}/--${CWD}--`);
		await adapter.write(path, result.merged!.join(""));

		const listed = await repo.list();
		expect(listed).toHaveLength(1);
		const opened = await repo.open(listed[0]!);
		const entries = await opened.findEntriesOnBranch({ order: "oldestFirst" });
		expect(entries.filter((e) => e.type === "message")).toHaveLength(7);
	});
});
