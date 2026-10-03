import { expect, it } from "bun:test";
import { CODEMODE_STORE_ENTRY_TYPE, readCodemodeStore } from "./store";

it("replays only the selected branch in order, including overwrites and deletions", () => {
	const write = (set: Record<string, unknown>, deleted: string[] = []) => ({ type: "custom", customType: CODEMODE_STORE_ENTRY_TYPE, data: { set, delete: deleted } });
	const shared = write({ n: 1, removed: true });
	const branchA = [shared, write({ n: 2 }, ["removed"])];
	const branchB = [shared, write({ n: 3 })];
	expect(readCodemodeStore(branchA)).toEqual({ n: 2 });
	expect(readCodemodeStore(branchB)).toEqual({ n: 3, removed: true });
	expect(readCodemodeStore([write({ n: 1 }), { type: "custom", customType: CODEMODE_STORE_ENTRY_TYPE, data: null }])).toEqual({ n: 1 });
});
