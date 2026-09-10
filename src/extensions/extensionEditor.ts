import type { ExtensionUIAdapter } from "./extensionUI";

/** Capture the native composer once; a late rewrite never replaces newer words. */
export function captureExtensionEditor(getUI: () => ExtensionUIAdapter | undefined) {
	const editor = getUI();
	if (!editor) throw new Error("Open this conversation's composer before rewriting a draft.");
	const original = editor.getEditorText();
	return {
		read: () => original,
		replace: (text: string): void => {
			if (getUI() !== editor || editor.getEditorText() !== original) {
				throw new Error(`The draft changed while rewriting. Your draft was kept.\n\n${text}`);
			}
			editor.setEditorText(text);
		},
	};
}
