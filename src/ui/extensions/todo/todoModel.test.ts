import { describe, expect, it } from "bun:test";
import type { NativeComponentNode } from "../../../extensions/compat/componentTree";
import { readTodoModel } from "./todoModel";

/** A rpiv-todo overlay surface renders as a single text node; wrap given lines. */
function textNode(...lines: string[]): NativeComponentNode {
	return { kind: "text", text: lines.join("\n"), paddingX: 0, paddingY: 0 };
}

describe("readTodoModel", () => {
	it("reads count and idle dot from a settled, expanded overlay", () => {
		const model = readTodoModel(textNode("○ Todos (2/2)", "├─ ✓ wrote it", "└─ ✓ shipped it"));
		expect(model).toEqual({ completed: 2, total: 2, active: false, collapsed: false });
	});

	it("reads the active dot when work remains", () => {
		const model = readTodoModel(textNode("● Todos (1/3)", "├─ ✓ a", "├─ ◐ b", "└─ ○ c"));
		expect(model).toEqual({ completed: 1, total: 3, active: true, collapsed: false });
	});

	it("treats a single task row (└─ + glyph) as expanded, not collapsed", () => {
		const model = readTodoModel(textNode("● Todos (0/1)", "└─ ◐ the only task"));
		expect(model?.collapsed).toBe(false);
	});

	it("detects collapse from the hint line even while active", () => {
		// The └─ line is prose, not a task glyph → collapsed, regardless of the ● dot.
		const model = readTodoModel(textNode("● Todos (1/2)", "└─ ctrl+shift+t to expand"));
		expect(model).toEqual({ completed: 1, total: 2, active: true, collapsed: true });
	});

	it("detects collapse from the static 'collapsed' label", () => {
		const model = readTodoModel(textNode("○ Todos (3/3)", "└─ collapsed"));
		expect(model?.collapsed).toBe(true);
	});

	it("stays expanded past an overflow summary row", () => {
		const model = readTodoModel(textNode("● Todos (2/9)", "├─ ○ a", "└─ +7 more (2 completed, 5 pending)"));
		expect(model?.collapsed).toBe(false);
	});

	it("never hides a multi-row list, even if the glyphs are unrecognized", () => {
		// Two body rows → expanded by count alone, so a future glyph change cannot
		// swallow a real list.
		const model = readTodoModel(textNode("● Todos (0/2)", "├─ ? first", "└─ ? second"));
		expect(model?.collapsed).toBe(false);
	});

	it("flattens a container of text nodes", () => {
		const node: NativeComponentNode = {
			kind: "container",
			children: [textNode("● Todos (1/2)"), textNode("└─ ○ pending one")],
		};
		expect(readTodoModel(node)).toEqual({ completed: 1, total: 2, active: true, collapsed: false });
	});

	it("returns null for a shape with no (done/total) heading", () => {
		expect(readTodoModel(textNode("Something else entirely"))).toBeNull();
	});

	it("returns null for empty or absent content", () => {
		expect(readTodoModel(textNode(""))).toBeNull();
		expect(readTodoModel(undefined)).toBeNull();
	});
});
