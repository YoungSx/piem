import type { App, EventRef } from "obsidian";

/**
 * Watches which note the user is working in.
 *
 * Nothing in the panel observed this before. `ChatApp` recomputes
 * `getActiveNotePath` on every render, but no render is *triggered* by a note
 * switch — the only external subscription there is the agent snapshot — so the
 * value was refreshed only when something unrelated happened to re-render. Good
 * enough for a link-resolution base, useless for anything that has to be correct
 * the moment focus moves.
 *
 * Returns the event refs instead of registering them, so the component that owns
 * the lifecycle stays in charge of teardown and this stays testable without an
 * `ItemView`.
 */
export function watchActiveNote(
	app: App,
	onChange: (path: string | null) => void,
	onRename?: (oldPath: string, newPath: string) => void,
	onDelete?: (path: string) => void,
): EventRef[] {
	const publish = (): void => {
		onChange(resolveWorkingNotePath(app));
	};

	const refs: EventRef[] = [
		app.workspace.on("active-leaf-change", publish),
		// `active-leaf-change` does not fire when a file is swapped inside a leaf
		// that already has focus, which `file-open` covers. Both run the same read,
		// and a repeated path is expected to be cheap for the consumer to ignore.
		app.workspace.on("file-open", publish),
	];
	if (onRename) {
		refs.push(app.vault.on("rename", (file, oldPath) => {
			onRename(oldPath, file.path);
			publish();
		}));
	}
	if (onDelete) {
		refs.push(app.vault.on("delete", (file) => {
			onDelete(file.path);
			publish();
		}));
	}
	return refs;
}

/**
 * The note the user is working in, or `null` when there isn't one.
 *
 * Deliberately not `getActiveViewOfType(MarkdownView)`, which reports the
 * *focused* view. Clicking into the chat composer makes the chat leaf active, so
 * that read returns null exactly when the user is typing "rewrite this note" —
 * the chip row would empty and no context would be sent, in the one moment the
 * feature exists for.
 *
 * `getActiveFile()` is documented to fall back to the most recently active file
 * when the current view is not a `FileView`, which is precisely the chat-panel
 * case. Filtered to Markdown so focusing a PDF or an image reports nothing
 * rather than a path the note tools cannot use.
 *
 * Measured on a real runtime: for the whole synchronous window of the vault
 * `"delete"` event, `getActiveFile()` still hands back the just-deleted file's
 * `TFile` — the vault index has dropped it, the workspace has not settled yet.
 * Re-checking the index is what turns that ghost into `null` instead of a path
 * the model would `read` into an ENOENT.
 */
export function resolveWorkingNotePath(app: App): string | null {
	const file = app.workspace.getActiveFile();
	if (!file || file.extension !== "md") {
		return null;
	}
	if (app.vault.getFileByPath(file.path) === null) {
		return null;
	}
	return file.path;
}
