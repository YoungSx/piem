import { Modal, Notice, Setting, type App } from "obsidian";
import type { Translator } from "../../i18n";

/**
 * Confirmation before a settings row is removed — or, with {@link ConfirmDeleteOptions.kind},
 * before a reversible consequence lands, such as disconnecting an MCP server.
 *
 * Deleting a provider is not a local edit: every model bound to it loses its
 * base URL and credential, so the panel has to say how many go with it before
 * the click lands. A `Notice` afterwards would arrive too late to matter, and
 * these rows hold an API key the user may not have anywhere else — which is
 * why {@link ConfirmDeleteOptions.copySecret} exists.
 */

export interface ConfirmDeleteOptions {
	/** What is being removed, e.g. `Provider "My gateway"`. */
	subject: string;
	/** Consequences the user cannot see from the row itself. */
	consequences: readonly string[];
	/** Copy for the dialog's own chrome (title and buttons). */
	t: Translator;
	/**
	 * Defaults to `"delete"`. `"disable"` is the reversible counterpart: the
	 * title and button read 停用 instead of 删除, and the button drops its
	 * destructive tint — `setDestructive` marks an irreversible click, and a
	 * disable is undone by flipping the toggle back.
	 */
	kind?: "delete" | "disable";
	/**
	 * A secret that dies with this row, offered for copying before it does.
	 * Omitted when the row holds nothing worth saving.
	 */
	copySecret?: string;
	onConfirm(): void | Promise<void>;
	/**
	 * Called when the dialog closes without confirming — Cancel, Escape, or a
	 * click outside.
	 *
	 * A caller that moved something before asking needs this: the toggle that
	 * opened a disable dialog has already flipped, and only a dismissal tells it
	 * to flip back. Confirming reports through {@link onConfirm} alone, so a
	 * caller can wire both and have exactly one of them run.
	 */
	onDismiss?(): void;
}

export function openConfirmDelete(app: App, options: ConfirmDeleteOptions): void {
	new ConfirmDeleteModal(app, options).open();
}

class ConfirmDeleteModal extends Modal {
	private readonly options: ConfirmDeleteOptions;
	/** Set before `close()`, so `onClose` can tell an answer from a dismissal. */
	private confirmed = false;

	constructor(app: App, options: ConfirmDeleteOptions) {
		super(app);
		this.options = options;
	}

	onOpen(): void {
		const { t } = this.options;
		const kind = this.options.kind ?? "delete";
		this.setTitle(
			kind === "disable"
				? t.t("confirmDelete.disableTitle", { subject: this.options.subject })
				: t.t("confirmDelete.title", { subject: this.options.subject }),
		);
		for (const line of this.options.consequences) {
			this.contentEl.createEl("p", { text: line });
		}

		const copySecret = this.options.copySecret;
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText(t.t("confirmDelete.cancel")).onClick(() => this.close()))
			.addButton((button) => {
				if (copySecret === undefined) {
					return;
				}
				button.setButtonText(t.t("confirmDelete.copyKey")).onClick(() => {
					void navigator.clipboard.writeText(copySecret).then(() => {
						new Notice(t.t("confirmDelete.copied"));
					});
				});
			})
			.addButton((button) => {
				if (kind === "disable") {
					button.setButtonText(t.t("confirmDelete.disable"));
				} else {
					// `setDestructive` is Obsidian's destructive styling, which is what
					// tells this button apart from the Cancel beside it at a glance.
					// (It replaced `setWarning`, deprecated in 1.13.)
					button.setButtonText(t.t("confirmDelete.delete")).setDestructive();
				}
				button.onClick(() => {
					this.confirmed = true;
					this.close();
					void this.options.onConfirm();
				});
			});
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.confirmed) {
			this.options.onDismiss?.();
		}
	}
}
