import { MarkdownView, type App, type Editor } from "obsidian";

/** Match the requested path, even when chat focus or another note has moved on. */
export function resolveNoteEditor(app: App, path: string): Editor | null {
	const active = app.workspace.activeEditor;
	if (active?.editor && active.file?.path === path) return active.editor;
	const recent = app.workspace.getMostRecentLeaf?.()?.view;
	if (recent instanceof MarkdownView && recent.file?.path === path && recent.editor) return recent.editor;
	for (const leaf of app.workspace.getLeavesOfType?.("markdown") ?? []) {
		const view = leaf.view;
		if (view instanceof MarkdownView && view.file?.path === path && view.editor) return view.editor;
	}
	return null;
}

export function resolveWorkingEditor(app: App): Editor | null {
	const file = app.workspace.getActiveFile();
	return file?.extension === "md" ? resolveNoteEditor(app, file.path) : null;
}
