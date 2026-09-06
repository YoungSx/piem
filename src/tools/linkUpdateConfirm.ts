import type { App } from "obsidian";

/**
 * The "Update links" confirmation that `FileManager.renameFile` can raise.
 *
 * With `alwaysUpdateLinks` off (the factory default, read from a decompiled
 * 1.13.7 `.asar`), a rename whose note has *pathed* backlinks pops a modal and
 * the returned promise does not settle until someone answers it. Nothing in the
 * public API exposes the modal, and an unanswered one blocks the file manager's
 * serial update queue — every later rename stalls before even moving its file.
 * Measured on real Obsidian 1.13.7 (see issue #302); the modal is not reachable
 * as an object, so the only detection surface is the DOM.
 *
 * This module is the guard around a rename: poll for the modal, and if it stays
 * unanswered past the grace window, dismiss it with Escape so the promise
 * settles as if "Do not update" had been picked. The caller reports what
 * actually happened; it never answers the modal on the user's behalf.
 */

/**
 * Structural, not textual: neither the title nor the button labels survive
 * localization, and `.mod-confirmation` is version-drifted (present on 1.13,
 * absent on 1.8.7, where the same modal is a bare `Modal` that hand-builds the
 * same button row). Obsidian's own `FileManager` builds this modal's button row
 * as `modal-button-container`, which is what the community e2e suites match on.
 */
const MODAL_SELECTOR = ".modal-container:has(.modal-button-container)";

/**
 * How long a detected modal is left for the user to answer before it is
 * dismissed. Covers "user is at the keyboard and mid-click"; anything longer
 * means they are not coming back for this modal, and every subsequent rename
 * is stuck behind it.
 */
export const MODAL_GRACE_MS = 10_000;

/** How often the DOM is checked for the modal while the rename is in flight. */
const POLL_INTERVAL_MS = 50;

/**
 * How the watched rename ended, as the caller should report it:
 *
 * - `none` — settled with no confirmation on screen: either there was nothing
 *   to update, or the vault's setting updated links without asking.
 * - `answered` — the confirmation appeared and someone answered it. Which
 *   answer was given is not visible to this module, so the caller must not
 *   claim a link state for this outcome.
 * - `dismissed` — the confirmation outlived its grace window and was closed
 *   with Escape: the file moved, links did not update.
 */
export type RenameOutcome = { modal: "none" } | { modal: "answered" } | { modal: "dismissed" };

/** Knobs for the modal watch. Production callers take the defaults. */
export interface ModalWatchOptions {
	/** Defaults to {@link MODAL_GRACE_MS}. */
	graceMs?: number;
	/** Defaults to the internal poll interval. */
	pollIntervalMs?: number;
}

/**
 * Runs `rename` under modal watch: the rename promise and the modal poll race,
 * and whichever settles first ends the watch. Dismissal fires only when the
 * modal has been visible for the whole grace window while the rename is still
 * pending — a rename that settles never reaches the dismissal branch, so the
 * guard cannot Escape a modal the user opened for an unrelated reason.
 */
export async function runGuardedRename(
	app: App,
	rename: () => Promise<void>,
	signal?: AbortSignal,
	options?: ModalWatchOptions,
): Promise<RenameOutcome> {
	let renameError: unknown;
	let renameDone = false;
	const renamePromise = rename().then(
		() => {
			renameDone = true;
		},
		(error: unknown) => {
			renameError = error;
			renameDone = true;
		},
	);

	const outcome = await watchForModal(
		app,
		signal,
		() => renameDone,
		options?.graceMs ?? MODAL_GRACE_MS,
		options?.pollIntervalMs ?? POLL_INTERVAL_MS,
	);

	if (renameError !== undefined) {
		// A promise rejection may be anything (`vault.rename` throws Errors, but
		// nothing guarantees it), and lint forbids rethrowing a non-Error bare —
		// or stringifying one. Keep the value intact as `cause`; it lands in the
		// stack where the error-reporting layer already reads it.
		throw renameError instanceof Error
			? renameError
			: new Error("The rename failed with a non-Error value.", { cause: renameError });
	}
	await renamePromise;
	return outcome;
}

/**
 * Polls for the modal until the rename settles or the modal has been up past
 * its grace window (dismiss it). There is deliberately no watch ceiling: the
 * caller cannot return before the rename promise settles anyway, so the only
 * honest exits are "the rename finished" and "we dismissed the blocker" — and
 * a slow but unblocked rename never produces the modal, so polling it has no
 * false positives to bound. `isDone` is read on every tick so the poll stops
 * the moment the rename resolves.
 */
async function watchForModal(
	app: App,
	signal: AbortSignal | undefined,
	isDone: () => boolean,
	graceMs: number,
	pollIntervalMs: number,
): Promise<RenameOutcome> {
	let modalSeen = false;
	let modalSince: number | null = null;
	while (!isDone()) {
		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}
		if (findLinkUpdateModal(app) !== null) {
			modalSeen = true;
			if (modalSince === null) {
				modalSince = Date.now();
			} else if (Date.now() - modalSince >= graceMs) {
				dismissModal(app);
				return { modal: "dismissed" };
			}
		} else {
			// The modal can be answered and then reopened by the next rename in
			// the file manager's queue, so only a continuously visible modal
			// counts toward the grace window; any gap restarts it.
			modalSince = null;
		}
		await delay(pollIntervalMs, signal);
	}
	// The rename settled on its own. A confirmation seen at all along the way
	// was answered — possibly in the instant the promise resolved, with the DOM
	// not yet repainted.
	return { modal: modalSeen ? "answered" : "none" };
}

/**
 * Finds the modal among the currently open ones. `activeDocument` rather than a
 * bare `document`: a popout workspace keeps a second window alive, and
 * `document` alone would watch only whichever one is active.
 */
function findLinkUpdateModal(app: App): Element | null {
	const doc = activeDocument(app);
	return doc ? doc.querySelector(MODAL_SELECTOR) : null;
}

function activeDocument(app: App): Document | null {
	const workspace = (app as { workspace?: { containerEl?: { ownerDocument?: Document } } }).workspace;
	// Probe for the member the poll actually needs, not for `workspace` itself:
	// stub apps without a workspace must take the `document` fallback, and a
	// present-but-shapeless workspace must not throw inside the poll.
	const containerEl = workspace?.containerEl;
	if (containerEl?.ownerDocument) {
		return containerEl.ownerDocument;
	}
	return typeof document !== "undefined" ? document : null;
}

/**
 * Closes the modal the way a user pressing Escape would — the measured effect
 * is "Do not update": the rename promise settles with links untouched. A
 * KeyboardEvent on the document is what reaches it; the modal object itself is
 * unreachable from the DOM (`containerEl` carries no back-reference). Obsidian
 * closes the topmost modal on Escape, and the link-update modal is topmost by
 * having just appeared.
 */
function dismissModal(app: App): void {
	const doc = activeDocument(app);
	if (!doc) {
		return;
	}
	const eventInit: KeyboardEventInit = { key: "Escape", bubbles: true, cancelable: true };
	doc.activeElement?.dispatchEvent(new KeyboardEvent("keydown", eventInit));
	doc.dispatchEvent(new KeyboardEvent("keydown", eventInit));
	doc.activeElement?.dispatchEvent(new KeyboardEvent("keyup", eventInit));
	doc.dispatchEvent(new KeyboardEvent("keyup", eventInit));
}

/**
 * `window.`-prefixed on purpose (`obsidianmd/prefer-window-timers`): a popout
 * window's timers belong to its realm, and the bare globals resolve to the
 * main window's, which can be throttled in the background.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = window.setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				window.clearTimeout(timer);
				reject(new Error("Operation aborted"));
			},
			{ once: true },
		);
	});
}
