import { TFile, TFolder, type App } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { normalizeVaultPath } from "../vault/path";
import { collectPathedBacklinkSources } from "../vault/links";
import { hasFileManager, trashOrDelete } from "../vault/trash";
import { runGuardedRename, type RenameOutcome } from "./linkUpdateConfirm";
import { vaultPathParameter } from "./parameters";
import { ensureParentFolders } from "./vaultFiles";
import { textResult, throwIfAborted } from "./toolResult";

/**
 * Reorganizing tools: move/rename and trash.
 *
 * Deliberately not routed through {@link VaultExecutionEnv}. That env satisfies
 * pi's `FileSystem` contract, whose rename is specified to *replace* an existing
 * destination — which is why `VaultExecutionEnv.renameFile` trashes the occupant
 * first and then calls `vault.rename`. Both halves are wrong for a user-facing
 * tool: silently trashing a note the model guessed the path of is exactly the
 * accident recoverability is meant to cover, and `vault.rename` leaves every
 * inbound link dangling (`obsidian.d.ts` on `Vault.rename` says to use
 * `FileManager.renameFile` instead). What is reused from the env is its
 * *guards*, not its plumbing: {@link normalizeVaultPath}, same as `linkTools`.
 */

/**
 * `from`/`to` rather than `path`/`to`: symmetric names for a two-path operation
 * make swapped arguments far less likely, and there is no single "the path" for
 * the model to anchor `path` to.
 */
const MoveNoteParameters = Type.Object({
	from: vaultPathParameter("Note or folder to move. Must exist."),
	to: vaultPathParameter("Destination. Must be free."),
});

const TrashNoteParameters = Type.Object({
	path: vaultPathParameter("Note or folder to trash."),
	recursive: Type.Optional(
		Type.Boolean({
			// Names the refusal, not just the flag: a model reading this as an
			// optimization will omit it and spend a turn on the error.
			description: "Required to trash a non-empty folder.",
		}),
	),
});

export function createMoveNoteTool(app: App): AgentTool<typeof MoveNoteParameters> {
	return {
		name: "move_note",
		label: "Move note",
		// Load-bearing since the agent's `toolExecution` moved to "parallel": a
		// hand-written tool never enters pi's file mutation queue (whose per-path
		// locks are keyed off env object identity and which only the native
		// read/write/edit tools consult), so without this flag nothing would
		// interlock a concurrent `move_note` and `write` on the same path. One
		// sequential tool is enough to serialize the whole batch.
		executionMode: "sequential",
		description:
			"Rename or move a note or folder to a new vault-relative path. Prefer this over writing the note at the new path and trashing the old one: this goes through Obsidian's file manager, so inbound [[wikilinks]] are updated across the vault, the note keeps its history, and no duplicate is left behind. Depending on the vault's link settings, Obsidian may show a link-update confirmation; the result reports whether it was answered, dismissed after going unanswered, or never shown, and lists notes still linking to the old path when links were left behind. Missing destination folders are created. Refuses when anything already exists at the destination, so choose a free path or trash the occupant first.",
		parameters: MoveNoteParameters,
		execute: async (_toolCallId, params, signal) => {
			throwIfAborted(signal);
			// Both paths are normalized: checking only `from` would let a move
			// *into* `.obsidian/plugins/piem/` through.
			const from = normalizeVaultPath(params.from);
			const to = normalizeVaultPath(params.to);
			if (!from) {
				throw new Error("Cannot move the vault root.");
			}
			if (!to) {
				throw new Error("Cannot move to the vault root.");
			}
			if (from === to) {
				// Reported as success rather than an error: the vault is already in
				// the requested state, and `moved: false` keeps that legible. `kind`
				// is null because nothing was looked up — the vault is untouched,
				// including when `from` does not exist.
				return textResult(`${from} is already at that path; nothing to move.`, {
					from,
					to,
					kind: null,
					moved: false,
					linksUpdated: false,
				});
			}

			// `instanceof` rather than a cast: `obsidianmd/no-tfile-tfolder-cast`
			// is an error, and a cast would also hide the not-found case, since
			// `getAbstractFileByPath` returns null for a missing path.
			const source = app.vault.getAbstractFileByPath(from);
			if (!(source instanceof TFile) && !(source instanceof TFolder)) {
				throw new Error(`File or folder not found: ${from}`);
			}
			if (source instanceof TFolder && to.startsWith(`${from}/`)) {
				// Moving a folder under itself ("Archive" into "Archive/2026")
				// would relocate the destination along with the source.
				throw new Error(`Cannot move folder ${from} inside itself.`);
			}
			const destination = app.vault.getAbstractFileByPath(to);
			if (destination instanceof TFile || destination instanceof TFolder) {
				throw new Error(
					`Cannot move to ${to} because a file or folder already exists there. Pick a different path, or trash the existing one first.`,
				);
			}

			// `FileManager.renameFile` does not create missing parents.
			await ensureParentFolders(app, to);
			// Last cancellation point before the vault changes. Nothing is checked
			// afterwards: reporting failure for work that already succeeded would
			// leave the model believing the note is still at `from`.
			throwIfAborted(signal);
			// Resolved to a value rather than branched on in place, for the same
			// reason `trashOrDelete` takes its vault handle up front: `App` declares
			// `fileManager` as non-optional, so the type guard narrows its negative
			// branch to `never` and an `else` could not reach `app.vault` at all.
			const { vault } = app;
			const fileManager = hasFileManager(app) ? app.fileManager : null;
			// Snapshot the pathed backlink sources *before* the rename: once it
			// settles, the index has re-resolved, and a read under the old path
			// returns whatever the reindex left behind — emptiness included. Taken
			// here, the list is exactly "notes whose links would dangle if the
			// update were skipped", which is what the skipped-update branches
			// report. Folders cannot carry links, so the empty list is literal.
			const priorBacklinks =
				source instanceof TFile ? collectPathedBacklinkSources(app, source, signal) : [];
			let outcome: RenameOutcome = { modal: "none" };
			if (fileManager) {
				// `renameFile` can park on Obsidian's "Update links" modal until
				// someone answers it; without the guard, one unanswered modal hangs
				// this tool forever and blocks every later rename behind the file
				// manager's serial queue. The guard never answers for the user —
				// it only stops the hang once the modal has clearly gone unclaimed.
				outcome = await runGuardedRename(app, () => fileManager.renameFile(source, to), signal);
			} else {
				// The eslint plugin ships `prefer-file-manager-trash-file` but no
				// rename counterpart, so nothing but this tool's own output warns that
				// inbound links are now stale.
				await vault.rename(source, to);
			}

			const kind = source instanceof TFolder ? "folder" : "file";
			const modalDismissed = outcome.modal === "dismissed";
			// Whether links followed is knowable only from the settled outcomes: an
			// answered confirmation may or may not have updated them, depending on
			// a choice that is invisible to this tool, and claiming either way
			// would teach the model a falsehood about the vault.
			const linksUpdated = linksUpdatedAfter(outcome, fileManager !== null);
			// The dangling list is only claimed where the links are known not to
			// have been updated; an answer the user gave may well have updated them.
			const backlinks = modalDismissed || fileManager === null ? priorBacklinks : [];
			return textResult(describeMove(from, to, kind, outcome, linksUpdated, backlinks), {
				from,
				to,
				kind,
				moved: true,
				linksUpdated,
				modalDismissed,
				unresolvedBacklinks: backlinks,
			});
		},
	};
}

/**
 * Whether inbound links were updated, as far as this tool can know:
 *
 * - No confirmation at all: the file manager updated them — or there was
 *   nothing to update — while the vault API never updates them.
 * - A dismissed confirmation is "Do not update" by another route.
 * - An answered confirmation is not visible here, so the honest answer is
 *   neither true nor false.
 */
function linksUpdatedAfter(outcome: RenameOutcome, viaFileManager: boolean): boolean | null {
	if (outcome.modal === "answered") {
		return null;
	}
	return outcome.modal === "none" && viaFileManager;
}

export function createTrashNoteTool(app: App): AgentTool<typeof TrashNoteParameters> {
	return {
		name: "trash_note",
		label: "Trash note",
		// See `move_note`: same reason — a hand-written tool that mutates the
		// vault outside pi's file mutation queue.
		executionMode: "sequential",
		// The name is half the safety story: `trash_note` states the recoverable
		// nature of the operation in the one field the model always reads, and
		// describes `fileManager.trashFile` more honestly than `delete_note` would.
		description:
			"Delete a note or folder by moving it to trash, where the user can restore it. Prefer this over leaving an obsolete note behind once its content has moved elsewhere. A folder that still has anything inside it requires recursive: true, so a subtree is never removed by accident. Use move_note instead when the note should survive at a different path: trashing and rewriting breaks every link pointing at it.",
		parameters: TrashNoteParameters,
		execute: async (_toolCallId, params, signal) => {
			throwIfAborted(signal);
			const path = normalizeVaultPath(params.path);
			if (!path) {
				// Load-bearing, not defensive: `normalizeVaultPath` maps both "" and
				// "." to "", and a real vault's `getAbstractFileByPath("")` returns
				// null — so without this an attempt to delete the entire vault would
				// come back as a misleading not-found. Mirrors the vault-root refusal
				// in `VaultExecutionEnv.remove`.
				throw new Error("Refusing to trash the vault root.");
			}

			const target = app.vault.getAbstractFileByPath(path);
			if (!(target instanceof TFile) && !(target instanceof TFolder)) {
				// No `force` escape hatch: a trash call that succeeds on a path the
				// model got wrong teaches it the note is gone when it is not.
				throw new Error(`File or folder not found: ${path}`);
			}
			if (target instanceof TFolder && target.children.length > 0 && params.recursive !== true) {
				throw new Error(`${path} is a folder and is not empty. Pass recursive: true to trash it and everything inside.`);
			}

			throwIfAborted(signal);
			const kind = target instanceof TFolder ? "folder" : "file";
			const { trashed } = await trashOrDelete(app, target, { force: params.recursive === true });
			return textResult(describeTrash(path, kind, trashed), { path, kind, trashed });
		},
	};
}

/**
 * The link-update sentences are hedged on purpose, and each names the cause it
 * observed rather than an intention:
 *
 * - The through-file-manager path cannot claim links were updated: the call
 *   settles "depending on the user's preferences" (`obsidian.d.ts`), so the
 *   only true unconditional claim is which API ran.
 * - A dismissed modal is called out in the first line — `summarizeToolResult`
 *   renders that line as the collapsed transcript row, and it is the one thing
 *   that changes the meaning of the move. The dangling list and the setting
 *   that prevents the modal follow, so the model can act (fix the links, or
 *   point the user at the setting) without this tool scripting what to say.
 */
function describeMove(from: string, to: string, kind: "file" | "folder", outcome: RenameOutcome, linksUpdated: boolean | null, backlinks: string[]): string {
	const subject = kind === "folder" ? `folder ${from}` : from;
	const scope = kind === "folder" ? ", with everything inside it" : "";
	const moved = `Moved ${subject} to ${to}${scope}`;
	if (outcome.modal === "dismissed") {
		const dangling = backlinks.length > 0 ? backlinks.join(", ") : "none found";
		return `${moved}. Obsidian asked whether to update inbound links and no one answered, so the confirmation was dismissed: inbound links were NOT updated. Notes still linking to the old path: ${dangling}. To stop this confirmation appearing, enable "Always update internal links" in Settings → Files and links.`;
	}
	if (outcome.modal === "answered") {
		// The answer itself decides whether links followed, and is invisible
		// here — claim neither direction.
		return `${moved}. Obsidian's link-update confirmation was answered; inbound links follow the answer that was given.`;
	}
	if (linksUpdated) {
		return `${moved}. Obsidian's file manager handled the move.`;
	}
	return `${moved} using the vault API directly, because Obsidian's file manager was unavailable. Inbound links were not updated and may now be broken.`;
}

/**
 * Never names where the trash is: `trashFile` honours the user's ".trash/ vs OS
 * trash" preference, so naming one would be wrong half the time. The fallback
 * branch is where recoverability ends, and it says so plainly.
 */
function describeTrash(path: string, kind: "file" | "folder", trashed: boolean): string {
	const subject = kind === "folder" ? `folder ${path}` : path;
	const scope = kind === "folder" ? ", with everything inside it" : "";
	if (trashed) {
		return `Moved ${subject} to trash${scope}. It can be restored from trash.`;
	}
	return `Permanently deleted ${subject}${scope}. Obsidian's file manager was unavailable, so this could not be sent to trash and cannot be undone.`;
}
