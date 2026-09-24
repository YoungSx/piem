import { describe, expect, it } from "bun:test";
import { compileJsonSchema } from "./json-schema";

const OBJECT_SCHEMA = {
	type: "object",
	properties: { n: { type: "number" }, s: { type: "string" } },
	required: ["n"],
};

describe("compileJsonSchema", () => {
	it("accepts an object-rooted schema and checks values against it", () => {
		const result = compileJsonSchema(OBJECT_SCHEMA);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.compiled.check({ n: 1 })).toBe(true);
		expect(result.compiled.check({ n: 1, s: "x" })).toBe(true);
		// Missing required field, and wrong type, both report rather than throw.
		expect(result.compiled.check({})).not.toBe(true);
		expect(result.compiled.check({ n: "not a number" })).not.toBe(true);
	});

	it("rejects a non-object root — the answer contract must be fillable", () => {
		expect(compileJsonSchema({ type: "string" }).ok).toBe(false);
		expect(compileJsonSchema([]).ok).toBe(false);
		expect(compileJsonSchema(null).ok).toBe(false);
	});

	it("names the failing path in JavaScript dot form", () => {
		const result = compileJsonSchema(OBJECT_SCHEMA);
		if (!result.ok) throw new Error("expected ok");
		const verdict = result.compiled.check({ n: "x" });
		expect(typeof verdict).toBe("string");
		expect(verdict).toContain("$.n");
	});
});
