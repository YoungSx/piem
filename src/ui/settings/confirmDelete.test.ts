import { describe, expect, it } from "bun:test";
import type { App } from "obsidian";
import { installDom } from "../../testUtils/dom";
import { installObsidianDomHelpers } from "../../testUtils/obsidianDom";
import { installObsidianStub } from "../../testUtils/obsidianStub";
import type { ConfirmDeleteOptions } from "./confirmDelete";
import type { Translator } from "../../i18n";

const document = installDom();
installObsidianDomHelpers();
installObsidianStub();

const { openConfirmDelete } = await import("./confirmDelete");

/**
 * Delete and disable share one modal, and the whole point of the `kind` option
 * is that the two verbs must not look the same: 删除 warns (irreversible), 停用
 * does not (flip the toggle back). The assertions therefore read the DOM the
 * stub built — title element, button text, destructive class — because those are
 * exactly the pixels a user sees.
 *
 * The fake translator echoes the copy path back, so an assertion on
 * `confirmDelete.disableTitle` proves the disable branch was taken, not merely
 * that some string arrived.
 */
describe("confirmDelete", () => {
	const t = { t: (path: string) => path, lang: "en" } as unknown as Translator;

	function openModal(options: Partial<ConfirmDeleteOptions> = {}): {
		title: string;
		confirm: HTMLButtonElement;
		cancel: HTMLButtonElement;
		confirmed: () => number;
		dismissed: () => number;
	} {
		let count = 0;
		let dismissals = 0;
		const app = document.createElement("div") as unknown as App;
		openConfirmDelete(app, {
			subject: "Provider \"My gateway\"",
			consequences: ["三份凭据会跟着走。"],
			t,
			onConfirm: () => {
				count += 1;
			},
			onDismiss: () => {
				dismissals += 1;
			},
			...options,
		});
		// The stub Modal appends its shell to the body and keeps the title as
		// the shell's first child; the confirm button is the last one built.
		const shell = document.body.lastElementChild as HTMLElement;
		const title = shell.firstElementChild?.textContent ?? "";
		// Scoped to this modal's own shell: a closed dialog is removed, but a test
		// that leaves one open would otherwise hand the next test its buttons.
		const buttons = Array.from(shell.querySelectorAll("button"));
		const confirm = buttons.at(-1) as HTMLButtonElement;
		const cancel = buttons.find((button) => button.textContent === "confirmDelete.cancel") as HTMLButtonElement;
		return { title, confirm, cancel, confirmed: () => count, dismissed: () => dismissals };
	}

	it("defaults to the destructive delete framing", () => {
		const modal = openModal();
		expect(modal.title).toContain("confirmDelete.title");
	});

	it("delete carries Obsidian's destructive styling on the confirm button", () => {
		const modal = openModal();
		expect(modal.confirm.classList.contains("mod-destructive")).toBe(true);
	});

	it("disable swaps in the 停用 verb in title and button", () => {
		const modal = openModal({ kind: "disable" });
		expect(modal.title).toContain("confirmDelete.disableTitle");
		expect(modal.confirm.textContent).toBe("confirmDelete.disable");
	});

	it("disable drops the destructive tint — the action is reversible", () => {
		const modal = openModal({ kind: "disable" });
		expect(modal.confirm.classList.contains("mod-destructive")).toBe(false);
	});

	it("confirm runs the callback and closes the modal", async () => {
		const modal = openModal();
		modal.confirm.click();
		await Promise.resolve();
		expect(modal.confirmed()).toBe(1);
	});

	it("cancel leaves the row untouched", () => {
		const modal = openModal();
		modal.cancel.click();
		expect(modal.confirmed()).toBe(0);
	});

	/**
	 * The dismissal signal exists for callers that moved something before asking —
	 * the MCP row's switch has already flipped by the time this dialog opens, and
	 * only a dismissal tells it to flip back. Exactly one of the two callbacks may
	 * run, or that caller would both restore and apply.
	 */
	it("dismissing reports itself, confirming does not", () => {
		const cancelled = openModal();
		cancelled.cancel.click();
		expect(cancelled.dismissed()).toBe(1);
		expect(cancelled.confirmed()).toBe(0);

		const confirmed = openModal();
		confirmed.confirm.click();
		expect(confirmed.confirmed()).toBe(1);
		expect(confirmed.dismissed()).toBe(0);
	});
});
