import { describe, expect, it } from "bun:test";
import { groupByOwner, snapshotsForOwner, type SubagentSnapshot } from "./inspectorModel";

/**
 * The grouping half of the inspector's data model.
 *
 * Split from the extension's integration tests for the same reason
 * `inspectorCopy.test.ts` is split from the renderer: these are decisions about
 * ordering and membership, and they can be stated directly instead of through a
 * registry that has to spawn real children to produce two owners.
 */

function snapshot(id: string, ownerId: string, spawnedAt: number): SubagentSnapshot {
	return {
		id,
		role: "general",
		task: `task for ${id}`,
		depth: 1,
		ownerId,
		modelId: "test-model",
		thinkingLevel: "off",
		status: "done",
		spawnedAt,
		durationMs: 0,
		messages: [],
	};
}

describe("inspector grouping by conversation", () => {
	it("narrows to the runs one conversation ordered", () => {
		const all = [snapshot("s1", "chat-a", 1), snapshot("s2", "chat-b", 2), snapshot("s3", "chat-a", 3)];

		expect(snapshotsForOwner(all, "chat-a").map((s) => s.id)).toEqual(["s1", "s3"]);
		expect(snapshotsForOwner(all, "chat-b").map((s) => s.id)).toEqual(["s2"]);
		// A conversation that never delegated gets nothing, not everything — the
		// distinction the entry icon's "no icon at all" state rests on.
		expect(snapshotsForOwner(all, "chat-c")).toEqual([]);
	});

	it("lifts the focused conversation to the front and leaves the rest in first-delegation order", () => {
		const all = [snapshot("s1", "chat-a", 1), snapshot("s2", "chat-b", 2), snapshot("s3", "chat-c", 3), snapshot("s4", "chat-b", 4)];

		const groups = groupByOwner(all, "chat-b");
		expect(groups.map((group) => group.ownerId)).toEqual(["chat-b", "chat-a", "chat-c"]);
		// Runs stay oldest-first inside a group: the panel is a record read
		// forward, and the grouping must not reorder what it groups.
		expect(groups[0]!.snapshots.map((s) => s.id)).toEqual(["s2", "s4"]);
	});

	it("keeps first-delegation order when the focused conversation already leads, or delegated nothing", () => {
		const all = [snapshot("s1", "chat-a", 1), snapshot("s2", "chat-b", 2)];

		expect(groupByOwner(all, "chat-a").map((group) => group.ownerId)).toEqual(["chat-a", "chat-b"]);
		// The focused chat has no group of its own, so there is nothing to lift and
		// nothing to invent: an empty section for it would claim it is waiting on
		// something.
		expect(groupByOwner(all, "chat-c").map((group) => group.ownerId)).toEqual(["chat-a", "chat-b"]);
		expect(groupByOwner(all, undefined).map((group) => group.ownerId)).toEqual(["chat-a", "chat-b"]);
	});

	it("has no groups when nothing was delegated anywhere", () => {
		expect(groupByOwner([], "chat-a")).toEqual([]);
	});
});
