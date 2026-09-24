import { describe, expect, it } from "bun:test";
import { extractMeta, WorkflowMetaError } from "./meta";

describe("extractMeta", () => {
	it("pulls a pure-literal meta and strips only the export keyword", () => {
		const { meta, body } = extractMeta(
			'export const meta = { name: "n", description: "d", phases: [{ title: "P" }] };\nphase("P");',
		);
		expect(meta.name).toBe("n");
		expect(meta.description).toBe("d");
		expect(meta.phases).toEqual([{ title: "P" }]);
		// The body keeps every offset: `export` becomes six spaces, so `const meta`
		// still starts at the same column and stack lines stay aligned.
		expect(body).toContain("const meta =");
		expect(body).not.toContain("export");
		expect(body.indexOf("const meta =")).toBe(
			'export const meta ='.indexOf("const meta ="),
		);
		expect(body).toContain('phase("P");');
	});

	it("scans braces inside strings without ending early", () => {
		const { meta } = extractMeta(
			'export const meta = { name: "n", description: "a}b {c", phases: [{ title: "x}y" }] };',
		);
		expect(meta.description).toBe("a}b {c");
		expect(meta.phases?.[0]?.title).toBe("x}y");
	});

	it("rejects a missing meta declaration", () => {
		expect(() => extractMeta('const notMeta = 1;')).toThrow(WorkflowMetaError);
	});

	it("rejects an impure literal that reaches for a variable", () => {
		expect(() => extractMeta('export const meta = { name: SOME_VAR, description: "d" };')).toThrow(
			WorkflowMetaError,
		);
	});

	it("rejects template interpolation even when it would evaluate", () => {
		expect(() =>
			// eslint-disable-next-line no-template-curly-in-string
			extractMeta('export const meta = { name: `a${1 + 1}b`, description: "d" };'),
		).toThrow(/interpolation/);
	});

	it("rejects an unbalanced brace", () => {
		expect(() => extractMeta('export const meta = { name: "n", description: "d"')).toThrow(/never closed/);
	});

	it("requires name and description", () => {
		expect(() => extractMeta('export const meta = { description: "d" };')).toThrow(/name/);
		expect(() => extractMeta('export const meta = { name: "n" };')).toThrow(/description/);
	});
});
