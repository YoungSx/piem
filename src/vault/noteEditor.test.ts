import { describe, expect, it } from "bun:test";
import type { App, WorkspaceLeaf } from "obsidian";
import { installObsidianStub } from "../testUtils/obsidianStub";

installObsidianStub();
const { MarkdownView } = await import("obsidian");
const { resolveNoteEditor } = await import("./noteEditor");
const { createActiveNoteTool } = await import("../tools/noteTools");

function appWithBuffers() {
	const a = { path: "A.md", extension: "md" };
	const b = { path: "B.md", extension: "md" };
	const editorA = { getValue: () => "UNSAVED A", getSelection: () => "selected A" };
	const editorB = { getValue: () => "UNSAVED B", getSelection: () => "selected B" };
	const leafA = { view: Object.assign(new MarkdownView({} as WorkspaceLeaf), { file: a, editor: editorA }) };
	const leafB = { view: Object.assign(new MarkdownView({} as WorkspaceLeaf), { file: b, editor: editorB }) };
	const workspace = { activeEditor: { file: b, editor: editorB }, getActiveFile: () => b,
		getActiveViewOfType: () => null, getMostRecentLeaf: () => leafB, getLeavesOfType: () => [leafA, leafB] };
	const app = { workspace, vault: { cachedRead: async () => "SAVED TEXT" } } as unknown as App;
	return { app, workspace, editorA, editorB };
}

describe("note editor context", () => {
	it("reads the frozen path rather than the different note that now has focus", () => {
		const { app } = appWithBuffers();
		expect(resolveNoteEditor(app, "A.md")?.getValue()).toBe("UNSAVED A");
		expect(resolveNoteEditor(app, "B.md")?.getValue()).toBe("UNSAVED B");
		expect(resolveNoteEditor(app, "Missing.md")).toBeNull();
	});

	it("get_active_note retains the working editor's unsaved body and selection after chat takes focus", async () => {
		const { app } = appWithBuffers();
		const result = await createActiveNoteTool(app).execute("read", { includeContent: true, includeSelection: true });
		const text = JSON.stringify(result.content);
		expect(text).toContain("B.md");
		expect(text).toContain("UNSAVED B");
		expect(text).toContain("selected B");
		expect(text).not.toContain("SAVED TEXT");
	});

	it("uses the vault copy when the working note has no open editor", async () => {
		const { app } = appWithBuffers();
		Object.assign(app.workspace, { activeEditor: null, getMostRecentLeaf: () => null, getLeavesOfType: () => [] });
		const result = await createActiveNoteTool(app).execute("read", { includeContent: true });
		expect(JSON.stringify(result.content)).toContain("SAVED TEXT");
	});
});
