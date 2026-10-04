import { describe, expect, it } from "bun:test";
import { DEFAULT_MAX_BYTES } from "./piTruncate";
import { sliceTextByLines, truncateToolOutput } from "./truncate";

describe("sliceTextByLines", () => {
	it("returns a one-indexed line slice", () => {
		const slice = sliceTextByLines("one\ntwo\nthree", { offset: 2, limit: 1 });
		expect(slice).toMatchObject({ text: "two", startLine: 2, endLine: 2, totalLines: 3, truncated: true });
	});

	it("reports the whole file as untruncated", () => {
		expect(sliceTextByLines("one\ntwo")).toMatchObject({ text: "one\ntwo", totalLines: 2, truncated: false });
	});
});

describe("truncateToolOutput", () => {
	it("leaves output within the budget untouched", () => {
		expect(truncateToolOutput("short note")).toBe("short note");
	});

	it("cuts on whole lines and reports the byte budget", () => {
		const output = truncateToolOutput("keep\n" + "x".repeat(80), 10);
		expect(output).toStartWith("keep");
		expect(output).toContain("[Output truncated at");
	});

	it("budgets by UTF-8 bytes, not characters, so CJK notes are capped", () => {
		// 40k CJK characters is ~120k bytes: a character-based cap would let this
		// through and ship triple the intended payload to the provider.
		const cjk = "中".repeat(40_000);
		const output = truncateToolOutput(cjk);

		expect(output).toContain("[Output truncated at");
		expect(new TextEncoder().encode(output).length).toBeLessThan(DEFAULT_MAX_BYTES + 200);
	});

	it("still returns content when the whole file is one oversized line", () => {
		// pi's truncateHead yields empty content in this case; an empty tool result
		// would be worse than a partial one.
		const output = truncateToolOutput("x".repeat(80_000));

		expect(output).toStartWith("xxx");
		expect(output).toContain("[Output truncated at");
	});
});
