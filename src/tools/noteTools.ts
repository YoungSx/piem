import { MarkdownView, type App } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { formatTextSlice, sliceTextByLines } from "../vault/truncate";
import { textResult, throwIfAborted } from "./toolResult";
import { resolveNoteEditor } from "../vault/noteEditor";

const ActiveNoteParameters = Type.Object({
	includeContent: Type.Optional(Type.Boolean()),
	includeSelection: Type.Optional(Type.Boolean()),
});

export function createActiveNoteTool(app: App): AgentTool<typeof ActiveNoteParameters> {
	return {
		name: "get_active_note",
		label: "Get active note",
		// Pure read of the working note, its selection, and its latest body — it
		// never writes, so concurrent sibling calls are safe.
		executionMode: "parallel",
		// The active note's path arrives in the per-turn <context> block for the main
		// conversation, so the wording steers that caller away from a no-argument
		// call that only re-reads it. A subagent gets no such block, and the old
		// flat "it is already in your context" steered it away from the one tool
		// that could tell it — hence the conditional phrasing.
		description:
			"Read the active Markdown note's path, selected text, or body content. If a <context> block in this conversation already names the active note, do not call this only to learn the path.",
		parameters: ActiveNoteParameters,
		execute: async (_toolCallId, params, signal) => {
			throwIfAborted(signal);
			const view = app.workspace.getActiveViewOfType(MarkdownView);
			const file = view?.file ?? app.workspace.getActiveFile();
			if (!file || file.extension !== "md") {
				throw new Error("No active Markdown note.");
			}
			const editor = view?.editor ?? resolveNoteEditor(app, file.path);

			const lines = [`Active note: ${file.path}`];
			const selection = params.includeSelection ? editor?.getSelection() ?? "" : "";
			if (params.includeSelection) {
				lines.push("", "Selection:", selection || "(no selection)");
			}
			if (params.includeContent) {
				const content = editor ? editor.getValue() : await app.vault.cachedRead(file);
				lines.push("", "Content:", formatTextSlice(file.path, sliceTextByLines(content, { limit: 200 })));
			}

			return textResult(lines.join("\n"), { path: file.path, hasSelection: selection.length > 0 });
		},
	};
}
