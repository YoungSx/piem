import { describe, expect, it } from "bun:test";
import { asPayloadObject, sanitizePayload } from "./uiBlockPayload";

describe("sanitizePayload", () => {
	it("passes primitives through untouched", () => {
		expect(sanitizePayload("text")).toBe("text");
		expect(sanitizePayload(42)).toBe(42);
		expect(sanitizePayload(true)).toBe(true);
		expect(sanitizePayload(null)).toBeNull();
	});

	it("drops functions and symbols, which are never state", () => {
		expect(
			sanitizePayload({ keep: 1, onClick: () => undefined, tag: Symbol("x") }),
		).toEqual({ keep: 1 });
	});

	it("renders a bigint as its decimal string so JSON can carry it", () => {
		expect(sanitizePayload({ bytes: 9007199254740993n })).toEqual({ bytes: "9007199254740993" });
	});

	it("names a DOM node by its tag instead of walking it", () => {
		expect(sanitizePayload({ element: { nodeType: 1, tagName: "BUTTON" } })).toEqual({
			element: "[Element <button>]",
		});
	});

	it("falls back to a generic label for a node with no tag name", () => {
		expect(sanitizePayload({ node: { nodeType: 3 } })).toEqual({ node: "[Element <node>]" });
	});

	it("breaks a cycle rather than recursing forever", () => {
		const circular: Record<string, unknown> = { key: "value" };
		circular.self = circular;

		expect(sanitizePayload(circular)).toEqual({ key: "value", self: "[Circular]" });
	});

	it("breaks a cycle reached through an array", () => {
		const parent: Record<string, unknown> = { name: "parent" };
		parent.children = [{ parent }];

		expect(sanitizePayload(parent)).toEqual({
			name: "parent",
			children: [{ parent: "[Circular]" }],
		});
	});

	it("preserves a shared reference that is not a cycle", () => {
		/*
		 * The distinction this guards: a DAG is not a cycle. Tracking every object
		 * ever seen rather than the current path would render the second and later
		 * appearances of a shared options object as `[Circular]` and silently lose
		 * real data — a plausible implementation that is wrong.
		 */
		const shared = { enabled: true, count: 42 };

		expect(sanitizePayload({ defaults: shared, current: shared, items: [shared, shared] })).toEqual({
			defaults: { enabled: true, count: 42 },
			current: { enabled: true, count: 42 },
			items: [
				{ enabled: true, count: 42 },
				{ enabled: true, count: 42 },
			],
		});
	});
});

describe("asPayloadObject", () => {
	it("keeps a plain object as itself, sanitized", () => {
		expect(asPayloadObject({ action: "save", onDone: () => undefined })).toEqual({ action: "save" });
	});

	it("wraps a non-object so every channel stores the same shape", () => {
		expect(asPayloadObject("approve")).toEqual({ value: "approve" });
		expect(asPayloadObject(7)).toEqual({ value: 7 });
		expect(asPayloadObject([1, 2])).toEqual({ value: [1, 2] });
	});

	it("reads a bare call as an affirmative rather than an empty payload", () => {
		// `ui.sendMessage()` with no argument is a button that means "yes, do it".
		expect(asPayloadObject(undefined)).toEqual({ value: true });
		expect(asPayloadObject(null)).toEqual({ value: true });
	});
});
