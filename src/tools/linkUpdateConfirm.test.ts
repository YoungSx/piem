/**
 * The modal guard around `FileManager.renameFile`, exercised against a fixture
 * modal in the test DOM.
 *
 * The guard's only detection surface is structural — a `.modal-container`
 * holding a `.modal-button-container` — so the fixture is exactly that
 * structure and nothing more: a title or button labels would invite the
 * production code into text it must not read. Dismissal is exercised the
 * production way: the fixture listens for the Escape the guard dispatches and
 * closes the modal in response, which is what Obsidian's own modal does, so
 * the rename settles *because of* the dismissal rather than alongside it.
 *
 * Timing knobs come from `ModalWatchOptions` — injectability the production
 * caller declines and tests spend, the same arrangement `metadataWait` uses.
 */

import { describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { installDom, mountLinkUpdateModal } from "../testUtils/dom";
import type { App } from "obsidian";
import { runGuardedRename } from "./linkUpdateConfirm";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("runGuardedRename", () => {
	it("reports none when the rename settles with no confirmation on screen", async () => {
		installDom();

		const outcome = await runGuardedRename(stubApp(), () => sleep(10), undefined, { pollIntervalMs: 5 });

		expect(outcome).toEqual({ modal: "none" });
	});

	it("reports answered when the confirmation appeared and the rename settled anyway", async () => {
		const doc = installDom();
		const modal = mountLinkUpdateModal(doc);
		const escape = recordEscape(doc);

		const outcome = await runGuardedRename(
			stubApp(),
			// The user answered: the modal goes away and the rename proceeds.
			async () => {
				await sleep(30);
				modal.remove();
			},
			undefined,
			{ graceMs: 200, pollIntervalMs: 5 },
		);

		expect(outcome).toEqual({ modal: "answered" });
		expect(escape()).toEqual([]);
	});

	it("dismisses the confirmation with Escape once it outlives the grace window", async () => {
		const doc = installDom();
		const modal = mountLinkUpdateModal(doc);
		const escape = recordEscape(doc);
		// Obsidian's modal closes on Escape and the rename promise settles with
		// "Do not update"; the fixture replays exactly that coupling so the
		// guard exits through the production path, not a test shortcut.
		const settle = () => {
			modal.remove();
		};
		doc.addEventListener("keydown", onEscape);
		function onEscape(event: KeyboardEvent): void {
			if (event.key === "Escape") {
				doc.removeEventListener("keydown", onEscape);
				settle();
			}
		}

		const outcome = await runGuardedRename(
			stubApp(),
			() => new Promise<void>((resolve) => setTimeout(resolve, 100)),
			undefined,
			{ graceMs: 40, pollIntervalMs: 5 },
		);

		expect(outcome).toEqual({ modal: "dismissed" });
		expect(escape()).toContain("Escape");
		// The fixture's own cleanup proves the dismissal actually closed it.
		expect(modal.isConnected).toBe(false);
		doc.removeEventListener("keydown", onEscape);
	});

	it("restarts the grace window after a gap, so only a continuously visible confirmation is dismissed", async () => {
		const doc = installDom();
		const modal = mountLinkUpdateModal(doc);
		const escape = recordEscape(doc);
		// Up for 30ms, answered and gone, up again for 30ms — each continuous
		// stretch is far under the 80ms grace, so no dismissal may fire even
		// though the total time the guard runs is longer than the grace.
		setTimeout(() => modal.remove(), 30);
		setTimeout(() => doc.body.appendChild(modal), 60);
		setTimeout(() => modal.remove(), 120);

		const outcome = await runGuardedRename(
			stubApp(),
			() => new Promise<void>((resolve) => setTimeout(resolve, 150)),
			undefined,
			{ graceMs: 80, pollIntervalMs: 5 },
		);

		expect(outcome).toEqual({ modal: "answered" });
		expect(escape()).toEqual([]);
	});

	it("rejects with the rename's own error", async () => {
		installDom();

		const error = await runGuardedRename(stubApp(), () => Promise.reject(new Error("vault locked")), undefined, {
			pollIntervalMs: 5,
		}).then(
			() => null,
			asError,
		);

		expect(error?.message).toBe("vault locked");
	});

	it("rejects when the signal aborts while the rename is pending", async () => {
		installDom();
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);

		const error = await runGuardedRename(stubApp(), () => sleep(150), controller.signal, { pollIntervalMs: 5 }).then(
			() => null,
			asError,
		);

		// The rename promise is not abortable, so the guard exits on the abort
		// without waiting for it — the rename keeps running underneath.
		expect(error?.message).toBe("Operation aborted");
	});

	it("rejects immediately on an already-aborted signal", async () => {
		installDom();
		const controller = new AbortController();
		controller.abort();

		const error = await runGuardedRename(stubApp(), () => sleep(10), controller.signal, { pollIntervalMs: 5 }).then(
			() => null,
			asError,
		);

		expect(error?.message).toBe("Operation aborted");
	});

	it("watches the workspace's own document, so a popout window's confirmation is seen", async () => {
		// The default document stays clean: if the watch consulted it anyway,
		// the fixture modal would be invisible and the outcome would be `none`.
		installDom();
		const popout = new Window();
		const modal = mountLinkUpdateModal(popout.document as unknown as Document);
		const app = { workspace: { containerEl: { ownerDocument: popout.document } } } as unknown as App;

		const outcome = await runGuardedRename(
			app,
			async () => {
				await sleep(30);
				modal.remove();
			},
			undefined,
			{ graceMs: 200, pollIntervalMs: 5 },
		);

		expect(outcome).toEqual({ modal: "answered" });
	});
});

/**
 * An app with no workspace at all: the guard must take its `document`
 * fallback, which `installDom` provides. The workspace-routed path is pinned
 * separately by the popout test.
 */
function stubApp(): App {
	return {} as unknown as App;
}

/**
 * Records Escape keydowns on `doc` so tests can assert what the guard
 * dispatched — and, just as importantly, what it did not.
 */
function recordEscape(doc: Document): () => string[] {
	const keys: string[] = [];
	doc.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			keys.push(event.key);
		}
	});
	return () => keys;
}

function asError(reason: unknown): Error | null {
	return reason instanceof Error ? reason : null;
}
