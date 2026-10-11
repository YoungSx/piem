import { describe, expect, it } from "bun:test";
import { uiBlockOutcome } from "./uiBlockRecord";

describe("uiBlockOutcome", () => {
	it("returns null for non-objects or nullish values", () => {
		expect(uiBlockOutcome(null)).toBeNull();
		expect(uiBlockOutcome(undefined)).toBeNull();
		expect(uiBlockOutcome("string")).toBeNull();
		expect(uiBlockOutcome(123)).toBeNull();
	});

	it("parses dismissed outcome", () => {
		const outcome = uiBlockOutcome({ dismissed: true, title: "Custom Title" });
		expect(outcome).toEqual({
			dismissed: true,
			title: "Custom Title",
			action: undefined,
		});
	});

	it("parses committed data and action", () => {
		const outcome = uiBlockOutcome({
			dismissed: false,
			title: "Config Form",
			action: "apply",
			data: { port: 3000, host: "localhost" },
		});
		expect(outcome).toEqual({
			dismissed: false,
			title: "Config Form",
			action: "apply",
			data: { port: 3000, host: "localhost" },
		});
	});

	it("handles data without action", () => {
		const outcome = uiBlockOutcome({
			dismissed: false,
			data: { key: "val" },
		});
		expect(outcome).toEqual({
			dismissed: false,
			data: { key: "val" },
			action: undefined,
			title: undefined,
		});
	});
});
