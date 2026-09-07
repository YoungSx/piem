/**
 * The one place that reads Obsidian for the facts injected into a request.
 *
 * Everything here is a thin read: no filtering worth testing, no ordering, no
 * caps. Those live in {@link ./workspaceContext} as pure functions over the
 * {@link WorkspaceReadout} this produces, so the rules that decide what the model
 * is told can be tested without an Obsidian runtime, and this file stays small
 * enough that reading it is the same as verifying it.
 *
 * Nothing here catches. Every call is an in-memory read off caches Obsidian keeps
 * warm — no disk, no network — so a throw means the app handed over something
 * structurally unexpected, and the caller ({@link ./ObsidianAgentService}) is
 * where the logger and the degrade-to-nothing decision live. Swallowing here
 * would turn a real breakage into a silently emptier prompt.
 */

import { apiVersion, getLanguage, MarkdownView, Platform, TFolder, type App } from "obsidian";
import { collectBacklinks, toLinkReferences } from "../vault/links";
import { MAX_SELECTION_CHARS, type FrozenRunContext, type InjectedSelection } from "./contextInjection";
import type { ContextRef } from "./contextRefs";
import type { EnvironmentFacts } from "./environmentPrompt";
import { buildLinkContext, type LinkContext } from "./linkContext";
import { buildNoteOutline, hasOutlineFacts, type NoteOutline } from "./noteOutline";
import { buildWorkspaceContext, type FolderEntry, type WorkspaceContext, type WorkspaceReadout } from "./workspaceContext";

/**
 * Reads the facts that cannot change while a conversation is open.
 *
 * `apiVersion` and `getLanguage` are module-level exports rather than methods on
 * `App`, which is why this takes the app only for the vault name. The plugin's
 * `minAppVersion` is 1.13.0 and `getLanguage` landed in 1.8.7, so no capability
 * probe is needed.
 */
export function probeEnvironment(app: App): EnvironmentFacts {
	return {
		vaultName: app.vault.getName(),
		appVersion: apiVersion,
		language: getLanguage(),
		platform: {
			isMacOS: Platform.isMacOS,
			isWin: Platform.isWin,
			isLinux: Platform.isLinux,
			isIosApp: Platform.isIosApp,
			isAndroidApp: Platform.isAndroidApp,
			isPhone: Platform.isPhone,
			isTablet: Platform.isTablet,
		},
	};
}

/**
 * Reads the workspace around the active note.
 *
 * `getLastOpenFiles` needs both filters and neither is optional:
 *
 * - **Existence.** Measured against a real vault: Obsidian never prunes a
 *   deleted file from that list. Injecting it unfiltered puts paths in front of
 *   the model that `read` will fail on, and it has no way to tell which.
 * - **Markdown.** The same list holds canvases and any other file type the user
 *   opened, and the note tools cannot act on those — the same reason
 *   `resolveWorkingNotePath` filters the active file down to `.md`.
 *
 * The open-tab read goes through `instanceof MarkdownView` to reach `view.file`,
 * matching how `messageActions` walks leaves. `leaf.getViewState().state.file`
 * carries the same path but as an untyped `Record` value, and one unchecked cast
 * is a worse trade than one `instanceof`.
 *
 * That read needs the same existence filter as `getLastOpenFiles`: for the whole
 * synchronous window of a vault `"delete"` event the leaves still hold the
 * deleted file's `TFile` (measured on a real runtime), so an unfiltered pass
 * would name a tab whose path the note tools cannot open.
 */
function readWorkspace(app: App, activePath: string | null): WorkspaceReadout {
	const openPaths: string[] = [];
	for (const leaf of app.workspace.getLeavesOfType("markdown")) {
		const view = leaf.view;
		if (view instanceof MarkdownView && view.file && app.vault.getFileByPath(view.file.path) !== null) {
			openPaths.push(view.file.path);
		}
	}

	const recentPaths = app.workspace.getLastOpenFiles().filter((path) => {
		const file = app.vault.getFileByPath(path);
		return file !== null && file.extension === "md";
	});

	let folderPath: string | null = null;
	let folderEntries: readonly FolderEntry[] = [];
	// `getFileByPath` returns `null` for a folder or a missing path, so reaching
	// `.parent` here needs no type guard of its own.
	const parent = activePath === null ? null : app.vault.getFileByPath(activePath)?.parent;
	if (parent) {
		folderPath = parent.path;
		folderEntries = parent.children.map((child) => ({ path: child.path, isFolder: child instanceof TFolder }));
	}

	return { folderPath, folderEntries, openPaths, recentPaths };
}

/**
 * Reads and shapes the workspace facts for one request.
 *
 * Takes the same `refs` the block will name, so exclusion and the active note's
 * folder are derived from one list rather than two reads that could disagree.
 */
export function probeWorkspaceContext(app: App, refs: readonly ContextRef[]): WorkspaceContext {
	const activePath = refs.find((ref) => ref.kind === "active")?.path ?? null;
	return buildWorkspaceContext(refs, readWorkspace(app, activePath));
}

/**
 * Reads the active note's place in the link graph.
 *
 * No wait for the metadata index, unlike `get_note_links`: this runs on the
 * request path, where blocking is not an option. An unindexed vault therefore
 * reports no links, and the degradation is safe in the direction that matters —
 * a missing line makes the model reach for the tool, which does wait, while a
 * line claiming zero backlinks would be a conclusion it acts on.
 *
 * `unresolvedLinks` is keyed by the *written* link text rather than a path, which
 * is why it needs no file lookup and why the renderer keeps the brackets.
 */
export function probeLinkContext(app: App, refs: readonly ContextRef[]): LinkContext {
	const activePath = refs.find((ref) => ref.kind === "active")?.path ?? null;
	const file = activePath === null ? null : app.vault.getFileByPath(activePath);
	if (!file || activePath === null) {
		return buildLinkContext({ backlinks: [], brokenLinks: [] });
	}
	return buildLinkContext({
		backlinks: collectBacklinks(app, file),
		brokenLinks: toLinkReferences(app.metadataCache.unresolvedLinks[activePath]),
	});
}

/**
 * Reads a skeleton for each pinned note.
 *
 * Pinned notes only. The active note's full body is already in the block, so an
 * outline of it would be a second copy of the same headings. A note with neither
 * headings nor frontmatter is dropped rather than reported as empty — the pin's
 * path line already said it exists.
 */
export function probeOutlines(app: App, refs: readonly ContextRef[]): NoteOutline[] {
	const outlines: NoteOutline[] = [];
	for (const ref of refs) {
		if (ref.kind !== "pinned") {
			continue;
		}
		const file = app.vault.getFileByPath(ref.path);
		const cache = file === null ? null : app.metadataCache.getFileCache(file);
		if (!cache) {
			continue;
		}
		const outline = buildNoteOutline({
			path: ref.path,
			headings: (cache.headings ?? []).map((heading) => ({ level: heading.level, text: heading.heading })),
			frontmatter: cache.frontmatter ?? null,
		});
		if (hasOutlineFacts(outline)) {
			outlines.push(outline);
		}
	}
	return outlines;
}

/**
 * The runtime shape of `workspace.activeEditor`, which carries a `file` that
 * `obsidian.d.ts` does not declare on `MarkdownFileInfo`.
 *
 * Measured against a real vault: the property is there, and it is the only way
 * to tell which note a selection came from. Typed locally rather than cast at the
 * use site, the same way `vault/links` handles `getBacklinksForFile`; a build that
 * drops it fails the guard below and reports no selection.
 */
interface ActiveEditorWithFile {
	file?: { path?: string } | null;
}

/**
 * Reads what the user has selected in the active note.
 *
 * `workspace.activeEditor` rather than `getActiveViewOfType(MarkdownView)`, for
 * the reason `resolveWorkingNotePath` avoids the latter: clicking into the chat
 * composer makes the chat leaf active, and the focused-view read returns null at
 * exactly the moment someone types "rewrite the part I selected".
 *
 * The path guard is not defensive padding. `activeEditor` reports the most
 * recently active editor, which after a navigation can still be the note the user
 * *left*; without the check, a selection made in one note would be attributed to
 * another. Measured: opening a canvas leaves `activeEditor` null entirely, so the
 * optional chain is load-bearing too.
 */
export function probeSelection(app: App, refs: readonly ContextRef[]): InjectedSelection | null {
	const activePath = refs.find((ref) => ref.kind === "active")?.path ?? null;
	if (activePath === null) {
		return null;
	}
	const active = app.workspace.activeEditor;
	if (!active?.editor || (active as ActiveEditorWithFile).file?.path !== activePath) {
		return null;
	}
	const text = active.editor.getSelection();
	if (text === "") {
		return null;
	}
	return { path: activePath, text: text.length <= MAX_SELECTION_CHARS ? text : null, length: text.length };
}

/**
 * Everything one run freezes, read in one pass.
 *
 * One entry point because all four readings are derived from the same ref list,
 * and one caller means one place where a structural surprise degrades — the
 * service wraps this, since that is where the logger lives.
 */
export function probeRunContext(app: App, refs: readonly ContextRef[]): Omit<FrozenRunContext, "refs"> {
	return {
		workspace: probeWorkspaceContext(app, refs),
		links: probeLinkContext(app, refs),
		outlines: probeOutlines(app, refs),
		selection: probeSelection(app, refs),
	};
}
