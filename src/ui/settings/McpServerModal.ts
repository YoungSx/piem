import { Modal, Notice, Setting, type App } from "obsidian";
import { generateMcpServerId, type McpServerConfig } from "../../mcp/mcpConfig";
import type { Translator } from "../../i18n";
import { type SecretStorageState } from "./secretStorageCopy";
import { addSecretKeyField } from "./secretField";
import { attachTestButton } from "./testResult";
import { createModalStatus, DiscardGuard, submitOnEnter, type ModalStatus } from "./modalGuards";

export interface McpServerModalOptions {
	app: App;
	/** Existing row to edit; omitted to add a new one. */
	server?: McpServerConfig;
	/** Where tokens actually land on this device, for honest field copy. */
	secretStorage: SecretStorageState;
	/** Resolves a picked keychain id to its plaintext, as in the provider form. */
	readSecret(id: string): string;
	/** Copy for every label, description, and button in this form. */
	t: Translator;
	/**
	 * Probes a draft configuration live. Resolves to the tool count the draft
	 * serves, or throws — the test row renders the throw as a failed verdict.
	 */
	test(draft: McpServerConfig): Promise<number>;
	/** Persists the finished row. Called only on a valid submit. */
	onSubmit(server: McpServerConfig): Promise<void>;
}

/**
 * Add/edit form for one {@link McpServerConfig}.
 *
 * The same modal-not-inline reasoning as {@link ProviderModal}: a modal keeps
 * the draft in local state and writes once on save, so no keystroke can
 * re-render the field being typed into.
 *
 * The token field accepts the saved token as its starting value. Unlike the
 * provider form there is no "unchanged" sentinel to model — the in-memory
 * settings object holds plaintext, so echoing it back into a password field is
 * safe here. A keychain-bound row is not echoed verbatim, though: the binding
 * resolves again at open, against the keychain as it stands now.
 */
export class McpServerModal extends Modal {
	private draft: McpServerConfig;
	private readonly isNew: boolean;
	private readonly options: McpServerModalOptions;
	/** The draft as it stood at open, serialized — the baseline the dirty check compares against. */
	private readonly originalDraft: string;
	private readonly guard: DiscardGuard;
	private status: ModalStatus | null = null;

	constructor(options: McpServerModalOptions) {
		super(options.app);
		this.options = options;
		this.isNew = options.server === undefined;
		// A new draft carries its real id from the start: the panel upserts by id,
		// so add and edit share one submit path and a reopened form keeps its row.
		this.draft = options.server ? { ...options.server } : { id: generateMcpServerId(), name: "", url: "", token: "", secretRef: "", enabled: true };
		// A binding resolves at open, not at plugin load: the settings object
		// holds the plaintext as it was read then, and a keychain entry rotated
		// since would leave this form probing — and saving — the stale snapshot.
		// Re-picking the entry already healed it; resolving here makes that the
		// default instead of a trick. A dangling entry resolves to `""`, which is
		// the honest value — it is what the probe would send. Runs before the
		// dirty baseline, so the resolution is never an edit the user must discard.
		if (this.draft.secretRef !== "") {
			this.draft.token = this.options.readSecret(this.draft.secretRef);
		}
		this.originalDraft = JSON.stringify(normalizeServerDraft(this.draft));
		this.guard = new DiscardGuard(() => {
			this.status?.showError(options.t.t("discard.warning"));
		});
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("piem-settings-modal");
		const { t } = this.options;
		this.setTitle(t.t(this.isNew ? "mcp.addTitle" : "mcp.editTitle"));

		new Setting(contentEl)
			.setName(t.t("mcp.name"))
			.addText((text) => {
				text.setPlaceholder(t.t("mcp.namePlaceholder"));
				text.setValue(this.draft.name);
				text.onChange((value) => {
					this.draft.name = value;
					this.onEdit();
					this.testRow?.reset();
				});
				submitOnEnter(text.inputEl, () => void this.submit());
			});

		new Setting(contentEl)
			.setName(t.t("mcp.urlName"))
			.setDesc(t.t("mcp.urlDesc"))
			.addText((text) => {
				text.setPlaceholder(t.t("mcp.urlPlaceholder"));
				text.setValue(this.draft.url);
				text.onChange((value) => {
					this.draft.url = value;
					this.onEdit();
					this.testRow?.reset();
				});
				submitOnEnter(text.inputEl, () => void this.submit());
			});

		// Same tier-driven shape as the provider form's key row: picker where the
		// device delegates, typed field where it cannot (see secretField.ts).
		addSecretKeyField(contentEl, {
			app: this.app,
			tier: this.options.secretStorage,
			t,
			readSecret: (id) => this.options.readSecret(id),
			title: t.t("mcp.tokenName"),
			placeholder: "",
			target: t.t("mcp.tokenTarget"),
			inlineKey: this.draft.token,
			secretRef: this.draft.secretRef,
			onRefChange: (ref, plaintext) => {
				this.draft.secretRef = ref;
				this.draft.token = plaintext;
				this.onEdit();
				this.testRow?.reset();
			},
			onInlineChange: (value) => {
				// Typing retires the binding: one slot, one owner at a time.
				this.draft.secretRef = "";
				this.draft.token = value;
				this.onEdit();
				this.testRow?.reset();
			},
		});

		// Placed before the save row so a failing verdict is read before
		// committing. The probe builds a throwaway client against the draft, so
		// it never touches the cached connections of the saved rows.
		const testSetting = new Setting(contentEl)
			.setName(t.t("mcp.testTitle"));
		this.testRow = attachTestButton(testSetting, t, async () => {
			const problem = validateDraft(this.draft, t);
			if (problem) {
				return { ok: false, detail: problem };
			}
			const count = await this.options.test(this.normalizedDraft());
			return { ok: true, detail: t.t("mcp.testOk", { tools: count }) };
		});

		// Between the last field and the buttons: a failing verdict is read on the
		// way to save, and it stays until the next edit instead of expiring.
		this.status = createModalStatus(contentEl);

		// Sticks to the modal's bottom edge so the save row stays reachable however
		// far the body has scrolled.
		new Setting(contentEl)
			.setClass("piem-settings-modal-footer")
			.addButton((button) => {
				button.setButtonText(t.t("mcp.cancelButton"));
				// Cancel is an explicit discard, so it earns its close.
				button.onClick(() => {
					this.guard.allowClose();
					this.close();
				});
			})
			.addButton((button) => {
				button.setButtonText(t.t(this.isNew ? "mcp.addButton" : "mcp.saveButton"));
				button.setCta();
				button.onClick(() => void this.submit());
			});
	}

	/**
	 * A stray Esc must not silently throw away a half-filled form: the first
	 * press warns and stays, the second — or a clean draft — closes.
	 */
	close(): void {
		if (this.guard.shouldClose(this.isDirty())) {
			super.close();
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private testRow: ReturnType<typeof attachTestButton> | undefined;

	/** One fresh edit clears the old verdict — it no longer describes this draft. */
	private onEdit(): void {
		this.guard.edited();
		this.status?.clear();
	}

	/** True when the draft no longer matches what the form opened with. */
	private isDirty(): boolean {
		return JSON.stringify(normalizeServerDraft(this.draft)) !== this.originalDraft;
	}

	/** The draft as it would be persisted, with incidental whitespace removed. */
	private normalizedDraft(): McpServerConfig {
		return normalizeServerDraft(this.draft);
	}

	private async submit(): Promise<void> {
		const { t } = this.options;
		const problem = validateDraft(this.draft, t);
		if (problem) {
			// Inline first, so the problem survives being read; the Notice is the
			// redundant shout for a user whose eyes were elsewhere.
			this.status?.showError(problem);
			new Notice(problem);
			return;
		}
		this.status?.clear();
		try {
			await this.options.onSubmit(this.normalizedDraft());
			this.guard.allowClose();
			this.close();
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			this.status?.showError(message);
			new Notice(message);
		}
	}
}

/** The draft as it would be persisted, with incidental whitespace removed. */
function normalizeServerDraft(draft: McpServerConfig): McpServerConfig {
	return { ...draft, name: draft.name.trim(), url: draft.url.trim() };
}

/** The two fields the form cannot do anything sensible without. */
function validateDraft(draft: McpServerConfig, t: Translator): string | undefined {
	if (draft.name.trim() === "") {
		return t.t("mcp.nameRequired");
	}
	if (!/^https?:\/\//i.test(draft.url.trim())) {
		return t.t("mcp.urlRequired");
	}
	return undefined;
}
