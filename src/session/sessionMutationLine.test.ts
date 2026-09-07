import { describe, expect, it } from "bun:test";
import { parseMutationLine, repairMutationLine, scanDiskLines, stripTrailingNewline } from "./sessionMutationLine";

/** A valid message entry as pi's encoder emits it — flattened, lane-chained, seq 1. */
function entryLine(overrides: Partial<{ seq: number; id: string; parentId: string | null; lane: string; timestamp: number }> = {}): string {
	const full = {
		kind: "entry",
		seq: overrides.seq ?? 1,
		...(overrides.lane === undefined ? {} : { lane: overrides.lane }),
		id: overrides.id ?? "e1",
		type: "message",
		parentId: overrides.parentId === undefined ? null : overrides.parentId,
		timestamp: overrides.timestamp ?? 1000,
		message: { role: "user", content: [{ type: "text", text: "hi" }] },
	};
	return `${JSON.stringify(full)}\n`;
}

const emptyDisk = scanDiskLines([]);

describe("parseMutationLine", () => {
	it("accepts each mutation kind as pi's codec encodes it", () => {
		expect(parseMutationLine(entryLine())?.kind).toBe("entry");
		expect(parseMutationLine(`${JSON.stringify({ kind: "record", seq: 2, id: "r1", lane: "main", type: "usage", timestamp: 1000 })}\n`)?.kind).toBe("record");
		expect(parseMutationLine(`${JSON.stringify({ kind: "lane", seq: 3, lane: "main", leafId: "e1" })}\n`)?.kind).toBe("lane");
		expect(parseMutationLine(`${JSON.stringify({ kind: "fact", seq: 4, fact: "name", name: "Chat" })}\n`)?.kind).toBe("fact");
	});

	it("rejects the header, a bare newline, and garbage", () => {
		expect(parseMutationLine(`{"kind":"header","version":4,"id":"s","createdAt":"t","cwd":""}`)).toBeNull();
		expect(parseMutationLine("")).toBeNull();
		expect(parseMutationLine("{not json")).toBeNull();
		expect(parseMutationLine(`{"kind":"entry","seq":0,`)).toBeNull();
	});

	it("rejects bad seq and unknown types", () => {
		expect(parseMutationLine(entryLine({ seq: 0 }))).toBeNull();
		expect(parseMutationLine(entryLine({ seq: 1.5 }))).toBeNull();
		expect(parseMutationLine(`${JSON.stringify({ kind: "entry", seq: 1, id: "e", type: "bogus", parentId: null, timestamp: 1 })}\n`)).toBeNull();
		expect(parseMutationLine(`${JSON.stringify({ kind: "record", seq: 1, id: "r", lane: "main", type: "bogus" })}\n`)).toBeNull();
	});
});

describe("scanDiskLines", () => {
	it("bootstraps main at null, like a fresh pi state", () => {
		const disk = scanDiskLines([]);
		expect(disk.maxSeq).toBe(0);
		expect(disk.laneLeaves.get("main")).toBeNull();
		expect(disk.lastEntryId).toBeNull();
	});

	it("walks lanes exactly as applyMutation moves them", () => {
		const disk = scanDiskLines([entryLine({ seq: 1, id: "a", lane: "main" }), entryLine({ seq: 2, id: "b", lane: "main" })]);
		expect(disk.laneLeaves.get("main")).toBe("b");
		expect(disk.lastEntryId).toBe("b");

		// A lane mutation can rewind the leaf; a lane-less entry moves nothing.
		const rewound = scanDiskLines([
			...[entryLine({ seq: 1, id: "a", lane: "main" }), entryLine({ seq: 2, id: "b", lane: "main" })],
			`${JSON.stringify({ kind: "lane", seq: 3, lane: "main", leafId: "a" })}\n`,
			entryLine({ seq: 4, id: "c" }),
		]);
		expect(rewound.laneLeaves.get("main")).toBe("a");
		expect(rewound.lastEntryId).toBe("c");
	});

	it("skips unparseable lines instead of failing", () => {
		const disk = scanDiskLines(["{torn", entryLine({ seq: 1, id: "a", lane: "main" })]);
		expect(disk.maxSeq).toBe(1);
		expect(disk.usedIds.has("a")).toBe(true);
	});
});

describe("repairMutationLine", () => {
	it("keeps a line that already satisfies every invariant", () => {
		const disk = scanDiskLines([entryLine({ seq: 1, id: "a", lane: "main" })]);
		const next = repairMutationLine(entryLine({ seq: 2, id: "b", parentId: "a", lane: "main" }), disk);
		expect(next).toEqual({ action: "kept", line: entryLine({ seq: 2, id: "b", parentId: "a", lane: "main" }), seq: 2 });
	});

	it("renumbers a valid line whose seq stopped continuing", () => {
		const disk = scanDiskLines([entryLine({ seq: 1, id: "a", lane: "main" }), entryLine({ seq: 2, id: "b", parentId: "a", lane: "main" })]);
		const repaired = repairMutationLine(entryLine({ seq: 2, id: "c", parentId: "b", lane: "main" }), disk);
		expect(repaired.action).toBe("repaired");
		expect(repaired.action === "repaired" && repaired.seq).toBe(3);
		const parsed = JSON.parse(repaired.action === "repaired" ? repaired.line : "{}");
		expect(parsed.seq).toBe(3);
		expect(parsed.lane).toBe("main");
		expect(parsed.parentId).toBe("b");
	});

	it("repairs a lane-chained entry to the disk's lane leaf", () => {
		// Foreign disk advanced main to "b"; pi still thinks "a" is the leaf.
		const disk = scanDiskLines([entryLine({ seq: 1, id: "a", lane: "main" }), entryLine({ seq: 2, id: "b", parentId: "a", lane: "main" })]);
		const repaired = repairMutationLine(entryLine({ seq: 2, id: "c", parentId: "a", lane: "main" }), disk);
		expect(repaired.action).toBe("repaired");
		const parsed = JSON.parse(repaired.action === "repaired" ? repaired.line : "{}");
		expect(parsed.parentId).toBe("b");
		expect(parsed.seq).toBe(3);
	});

	it("drops a foreign lane field, reparenting to the last entry", () => {
		// Foreign file's entries are lane-less. "main" exists on every disk (pi
		// bootstraps it), so only an undeclared lane name forces the fallback.
		const disk = scanDiskLines([entryLine({ seq: 1, id: "f1" }), entryLine({ seq: 2, id: "f2", parentId: "f1" })]);
		const repaired = repairMutationLine(entryLine({ seq: 2, id: "c", lane: "side" }), disk);
		expect(repaired.action).toBe("repaired");
		const parsed = JSON.parse(repaired.action === "repaired" ? repaired.line : "{}");
		expect(parsed.lane).toBeUndefined();
		expect(parsed.parentId).toBe("f2");
	});

	it("drops an entry whose id the disk already used", () => {
		const disk = scanDiskLines([entryLine({ seq: 1, id: "a", lane: "main" })]);
		expect(repairMutationLine(entryLine({ seq: 2, id: "a", parentId: "a", lane: "main" }), disk).action).toBe("dropped");
	});

	it("drops a record whose lane the disk lacks", () => {
		const disk = scanDiskLines([entryLine({ seq: 1, id: "a" })]);
		const record = `${JSON.stringify({ kind: "record", seq: 2, id: "r1", lane: "main", type: "usage", timestamp: 1000 })}\n`;
		// main exists on any disk (bootstrap), so flip to an undeclared lane.
		const foreign = scanDiskLines([entryLine({ seq: 1, id: "a" }), `${JSON.stringify({ kind: "lane", seq: 2, lane: "side", leafId: null })}\n`]);
		expect(repairMutationLine(record, disk).action).toBe("kept");
		expect(repairMutationLine(`${JSON.stringify({ kind: "record", seq: 3, id: "r2", lane: "side", type: "usage", timestamp: 1000 })}\n`, foreign).action).toBe("kept");
		expect(repairMutationLine(`${JSON.stringify({ kind: "record", seq: 3, id: "r2", lane: "ghost", type: "usage", timestamp: 1000 })}\n`, foreign).action).toBe("dropped");
	});

	it("drops a lane mutation pointing at an entry the disk lacks", () => {
		const disk = scanDiskLines([entryLine({ seq: 1, id: "a" })]);
		expect(repairMutationLine(`${JSON.stringify({ kind: "lane", seq: 2, lane: "main", leafId: "ghost" })}\n`, disk).action).toBe("dropped");
		expect(repairMutationLine(`${JSON.stringify({ kind: "lane", seq: 2, lane: "main", leafId: null })}\n`, disk).action).toBe("kept");
	});

	it("drops a label fact whose target the disk lacks, keeps name facts", () => {
		const disk = scanDiskLines([entryLine({ seq: 1, id: "a" })]);
		expect(repairMutationLine(`${JSON.stringify({ kind: "fact", seq: 2, fact: "label", targetId: "ghost", label: "x" })}\n`, disk).action).toBe("dropped");
		expect(repairMutationLine(`${JSON.stringify({ kind: "fact", seq: 2, fact: "label", targetId: "a", label: "x" })}\n`, disk).action).toBe("kept");
		expect(repairMutationLine(`${JSON.stringify({ kind: "fact", seq: 2, fact: "name", name: "N" })}\n`, disk).action).toBe("kept");
	});

	it("passes non-mutation content through untouched", () => {
		const header = `{"kind":"header","version":4,"id":"s","createdAt":"t","cwd":""}\n`;
		expect(repairMutationLine(header, emptyDisk)).toEqual({ action: "kept", line: header, seq: 0 });
		expect(repairMutationLine("", emptyDisk)).toEqual({ action: "kept", line: "", seq: 0 });
	});
});

describe("stripTrailingNewline", () => {
	it("strips exactly one trailing newline", () => {
		expect(stripTrailingNewline("a\n")).toBe("a");
		expect(stripTrailingNewline("a")).toBe("a");
	});
});
