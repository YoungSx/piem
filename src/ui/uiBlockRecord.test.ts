import { describe, expect, it } from "bun:test";
import { uiBlockOutcome } from "./uiBlockRecord";

describe("uiBlockOutcome", () => {
	it("returns null for non-objects or nullish values", () => {
		expect(uiBlockOutcome(null)).toBeNull();
		expect(uiBlockOutcome(undefined)).toBeNull();
		expect(uiBlockOutcome("string")).toBeNull();
		expect(uiBlockOutcome(123)).toBeNull();
	});

	it("carries the id a delivered view is looked up by", () => {
		expect(uiBlockOutcome({ uiId: "ui-3", live: true, title: "Dashboard" })).toEqual({
			id: "ui-3",
			title: "Dashboard",
			undelivered: false,
		});
	});

	it("reads a view that never opened as undelivered", () => {
		expect(uiBlockOutcome({ uiId: "ui-4", live: false, title: "Form" })).toEqual({
			id: "ui-4",
			title: "Form",
			undelivered: true,
		});
	});

	it("treats a missing live flag as undelivered rather than guessing", () => {
		// A details object written by a build between the two shapes, or edited by
		// hand. Claiming a view is live when nothing says so would make the row ask
		// the broker for an instance that cannot exist.
		expect(uiBlockOutcome({ uiId: "ui-5" })).toEqual({
			id: "ui-5",
			title: undefined,
			undelivered: true,
		});
	});

	it("keeps a title only when it is a string", () => {
		expect(uiBlockOutcome({ uiId: "ui-6", live: true, title: 42 })).toEqual({
			id: "ui-6",
			title: undefined,
			undelivered: false,
		});
	});

	describe("results from before the lifecycle split", () => {
		/*
		 * These have no `uiId`, and their views cannot be live: the build that wrote
		 * them destroyed the view to produce the result. So they read as a closed
		 * view with nothing to look up, and their payload is deliberately dropped —
		 * it was the user's answer to a question the transcript already shows the
		 * agent acting on.
		 */
		it("reads a committed legacy result as a closed view", () => {
			expect(
				uiBlockOutcome({
					dismissed: false,
					title: "Config Form",
					action: "apply",
					data: { port: 3000 },
				}),
			).toEqual({ title: "Config Form", undelivered: false });
		});

		it("reads a dismissed legacy result as never opened", () => {
			expect(uiBlockOutcome({ dismissed: true, title: "Custom Title" })).toEqual({
				title: "Custom Title",
				undelivered: true,
			});
		});

		it("never reports a legacy result as having an id", () => {
			const outcome = uiBlockOutcome({ dismissed: false, data: { key: "val" } });
			expect(outcome?.id).toBeUndefined();
		});
	});
});
