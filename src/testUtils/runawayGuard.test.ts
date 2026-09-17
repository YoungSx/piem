import { describe, it, expect } from "bun:test";
import { withRunawayGuard, createBoundedCollector } from "./runawayGuard";

describe("withRunawayGuard", () => {
	it("allows invocations within the limit", () => {
		const fn = (x: number) => x * 2;
		const guarded = withRunawayGuard(fn, { maxCalls: 3 });

		expect(guarded(1)).toBe(2);
		expect(guarded(2)).toBe(4);
		expect(guarded(3)).toBe(6);
	});

	it("throws when invocations exceed the limit", () => {
		let count = 0;
		const fn = () => { count++; };
		const guarded = withRunawayGuard(fn, { maxCalls: 2, label: "testMock" });

		guarded();
		guarded();
		expect(() => guarded()).toThrow("[RunawayGuard] testMock exceeded maximum invocation limit (2)");
		expect(count).toBe(2);
	});

	it("defaults to 50 maxCalls", () => {
		const fn = () => 1;
		const guarded = withRunawayGuard(fn);

		for (let i = 0; i < 50; i++) {
			guarded();
		}
		expect(() => guarded()).toThrow("[RunawayGuard] mock function exceeded maximum invocation limit (50)");
	});
});

describe("createBoundedCollector", () => {
	it("collects items up to maxItems", () => {
		const collector = createBoundedCollector<number>(3);
		collector.push(1, 2);
		expect(collector.items).toEqual([1, 2]);
		expect(collector.totalPushed()).toBe(2);

		collector.push(3, 4, 5);
		expect(collector.items).toEqual([1, 2, 3]);
		expect(collector.totalPushed()).toBe(5);
	});
});
