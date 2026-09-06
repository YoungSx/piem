import { App, Modal, Notice, Setting } from "obsidian";
import type { DropdownComponent, TextComponent } from "obsidian";
import type { ConnectionTestResult } from "../../connectionTest";
import {
	DEFAULT_WIRE_PROTOCOL,
	WIRE_PROTOCOLS,
	emptyProviderConfig,
	wireProtocolLabel,
	type ProviderConfig,
	type WireProtocol,
} from "../../modelConfig";
import {
	CUSTOM_PRESET_ID,
	PROVIDER_PRESETS,
	applyProviderPreset,
	findProviderPreset,
	matchProviderPreset,
	providerPresetLabel,
} from "../../net/providerPresets";
import type { Translator } from "../../i18n";
import { type SecretStorageState } from "./secretStorageCopy";
import { addSecretKeyField } from "./secretField";
import { attachTestButton } from "./testResult";
import { createModalStatus, DiscardGuard, submitOnEnter, type ModalStatus } from "./modalGuards";

export interface ProviderModalOptions {
	app: App;
	/** Existing row to edit; omitted to add a new one. */
	provider?: ProviderConfig;
	/** Where keys actually land on this device, for honest field copy. */
	secretStorage: SecretStorageState;
	/**
	 * Resolves a keychain id to its plaintext, so a pick can fill the draft's
	 * in-memory key the moment it is made.
	 */
	readSecret(id: string): string;
	/** Copy for every label, description, and button in this form. */
	t: Translator;
	/** Runs a live request against the draft. */
	test(draft: ProviderConfig): Promise<ConnectionTestResult>;
	/** Persists the finished row. Called only on a valid submit. */
	onSubmit(provider: ProviderConfig): Promise<void>;
}

/**
 * Add/edit form for one {@link ProviderConfig}.
 *
 * A modal rather than inline rows for a specific reason: the old panel rebuilt
 * its whole container whenever a keystroke changed the active configuration,
 * which stole focus mid-typing. Editing inside a modal keeps the draft in local
 * state and writes once on save, so no keystroke can trigger a re-render of the
 * field being typed into.
 */
export class ProviderModal extends Modal {
	private readonly draft: ProviderConfig;
	private readonly isNew: boolean;
	private readonly options: ProviderModalOptions;
	/** The draft as it stood at open, serialized — the baseline the dirty check compares against. */
	private readonly originalDraft: string;
	private readonly guard: DiscardGuard;
	private status: ModalStatus | null = null;
	/**
	 * Which preset row the dropdown shows.
	 *
	 * Derived from the draft at open and after any edit to a field it keys on, but
	 * held rather than recomputed at render time, because "Custom" has to be a
	 * position the user can stay in. A purely derived selection would snap back to
	 * whatever preset the URL still matches the moment they chose Custom.
	 */
	private presetChoice: string;
	/**
	 * The three components a preset writes into, kept so choosing one updates what
	 * is on screen and not just the draft behind it.
	 */
	private presetDropdown: DropdownComponent | undefined;
	private nameText: TextComponent | undefined;
	private baseUrlText: TextComponent | undefined;
	private protocolDropdown: DropdownComponent | undefined;
	/**
	 * The rows those three components live in, hidden while a preset is selected.
	 *
	 * A preset owns its endpoint, so there is nothing to decide in these rows: an
	 * edited OpenRouter URL is not OpenRouter. Showing them anyway would ask the
	 * user to read and skip three fields to reach the one thing only they have,
	 * which is the key. Custom brings them back, still holding whatever the preset
	 * left there, so taking the endpoint over by hand costs one dropdown change.
	 */
	private readonly customOnlyRows: HTMLElement[] = [];

	constructor(options: ProviderModalOptions) {
		super(options.app);
		this.options = options;
		this.isNew = options.provider === undefined;
		this.draft = options.provider ? { ...options.provider } : emptyProviderConfig();
		// An edited row reports the preset it came from, so the form never claims a
		// hand-typed gateway is one of ours — or hides that a saved row is Anthropic.
		this.presetChoice = matchProviderPreset(this.draft)?.id ?? CUSTOM_PRESET_ID;
		this.originalDraft = JSON.stringify(normalizeProviderDraft(this.draft));
		this.guard = new DiscardGuard(() => {
			this.status?.showError(options.t.t("discard.warning"));
		});
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("piem-settings-modal");
		const { t } = this.options;
		this.setTitle(t.t(this.isNew ? "providerModal.addTitle" : "providerModal.editTitle"));

		// First, because it writes the three rows below it. A native <select> cannot
		// carry the vendor marks the rest of the panel uses, so each option names its
		// host instead — which is the part that distinguishes a vendor's several
		// services anyway.
		new Setting(contentEl)
			.setName(t.t("providerModal.preset"))
			.setDesc(t.t("providerModal.presetDesc"))
			.addDropdown((dropdown) => {
				dropdown.addOption(CUSTOM_PRESET_ID, t.t("providerModal.presetCustom"));
				for (const preset of PROVIDER_PRESETS) {
					dropdown.addOption(preset.id, providerPresetLabel(preset));
				}
				dropdown.setValue(this.presetChoice);
				dropdown.onChange((value) => this.choosePreset(value));
				this.presetDropdown = dropdown;
			});

		// The three rows a preset owns. Collected so the preset row can hide them:
		// see `customOnlyRows`.
		const nameRow = new Setting(contentEl)
			.setName(t.t("providerModal.name"))
			.setDesc(t.t("providerModal.nameDesc"))
			.addText((text) => {
				text.setPlaceholder(t.t("providerModal.namePlaceholder"));
				text.setValue(this.draft.name);
				text.onChange((value) => {
					this.draft.name = value;
					this.onEdit();
				});
				submitOnEnter(text.inputEl, () => void this.submit());
				this.nameText = text;
			});

		const baseUrlRow = new Setting(contentEl)
			.setName(t.t("providerModal.baseUrl"))
			.setDesc(t.t("providerModal.baseUrlDesc"))
			.addText((text) => {
				text.setPlaceholder(t.t("providerModal.baseUrlPlaceholder"));
				text.setValue(this.draft.baseUrl);
				text.onChange((value) => {
					this.draft.baseUrl = value;
					this.syncPresetChoice();
					this.onEdit();
					this.testRow?.reset();
				});
				submitOnEnter(text.inputEl, () => void this.submit());
				this.baseUrlText = text;
			});

		const protocolRow = new Setting(contentEl)
			.setName(t.t("providerModal.protocol"))
			.setDesc(t.t("providerModal.protocolDesc"))
			.addDropdown((dropdown) => {
				for (const protocol of WIRE_PROTOCOLS) {
					dropdown.addOption(protocol, wireProtocolLabel(protocol, t));
				}
				dropdown.setValue(this.draft.protocol ?? DEFAULT_WIRE_PROTOCOL);
				dropdown.onChange((value) => {
					this.draft.protocol = value as WireProtocol;
					this.syncPresetChoice();
					this.onEdit();
					this.testRow?.reset();
				});
				this.protocolDropdown = dropdown;
			});

		this.customOnlyRows.length = 0;
		this.customOnlyRows.push(nameRow.settingEl, baseUrlRow.settingEl, protocolRow.settingEl);
		this.syncCustomRows();

		// The key row changes shape with the tier: a keychain picker where the
		// device can delegate, the typed field where it cannot (or collapsed
		// beneath the picker, as the road not taken). See secretField.ts.
		addSecretKeyField(contentEl, {
			app: this.app,
			tier: this.options.secretStorage,
			t,
			readSecret: (id) => this.options.readSecret(id),
			title: t.t("providerModal.apiKey"),
			placeholder: t.t("providerModal.apiKeyPlaceholder"),
			target: t.t("secretStorage.providerTarget"),
			inlineKey: this.draft.apiKey,
			secretRef: this.draft.secretRef,
			onRefChange: (ref, plaintext) => {
				this.draft.secretRef = ref;
				this.draft.apiKey = plaintext;
				this.onEdit();
				this.testRow?.reset();
			},
			onInlineChange: (value) => {
				// Typing retires the binding: one slot, one owner at a time.
				this.draft.secretRef = "";
				this.draft.apiKey = value;
				this.onEdit();
				this.testRow?.reset();
			},
		});

		// Placed before the save row so a failing verdict is read before
		// committing. The check needs no model id of its own: the caller probes with
		// one of this provider's own models when the user has configured one, and
		// otherwise asks the endpoint which models it serves.
		const testSetting = new Setting(contentEl)
			.setName(t.t("providerModal.connection"))
			.setDesc(t.t("providerModal.connectionDesc"));
		this.testRow = attachTestButton(testSetting, t, async () => {
			const problem = validateProviderDraft(this.draft, t);
			if (problem) {
				return { ok: false, detail: problem };
			}
			return this.options.test(this.normalizedDraft());
		});

		// Between the last field and the buttons: a failing verdict is read on the
		// way to save, and it stays until the next edit instead of expiring.
		this.status = createModalStatus(contentEl);

		// Sticks to the modal's bottom edge so the save row stays reachable however
		// far the body has scrolled.
		new Setting(contentEl)
			.setClass("piem-settings-modal-footer")
			.addButton((button) => {
				button.setButtonText(t.t("providerModal.cancel"));
				// Cancel is an explicit discard, so it earns its close.
				button.onClick(() => {
					this.guard.allowClose();
					this.close();
				});
			})
			.addButton((button) => {
				button.setButtonText(t.t(this.isNew ? "providerModal.add" : "providerModal.save"));
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

	/**
	 * Applies a dropdown choice.
	 *
	 * Picking a preset writes the three fields it owns and hides their rows: the
	 * form collapses to the preset, the key, and the test. `setValue` does not fire
	 * `onChange` in Obsidian's components, so the draft is updated here rather than
	 * left to a callback that will not run — and there is no loop back into
	 * {@link syncPresetChoice}.
	 *
	 * Picking Custom reveals the rows and changes nothing else. Clearing them would
	 * be a destructive answer to a navigational click, and it would defeat the
	 * point: Custom exists so somebody can take a preset's endpoint over by hand,
	 * which needs the values still there to edit.
	 */
	private choosePreset(id: string): void {
		this.presetChoice = id;
		this.syncCustomRows();
		const preset = findProviderPreset(id);
		if (!preset) {
			return;
		}
		const applied = applyProviderPreset(this.draft, preset);
		this.draft.name = applied.name;
		this.draft.baseUrl = applied.baseUrl;
		this.draft.protocol = applied.protocol;
		this.nameText?.setValue(this.draft.name);
		this.baseUrlText?.setValue(this.draft.baseUrl);
		this.protocolDropdown?.setValue(this.draft.protocol);
		this.onEdit();
		this.testRow?.reset();
	}

	/**
	 * Shows the three preset-owned rows only while Custom is selected.
	 *
	 * A class rather than an inline style, so the one rule lives in `styles.css`
	 * with everything else that decides what this modal looks like.
	 */
	private syncCustomRows(): void {
		const isCustom = this.presetChoice === CUSTOM_PRESET_ID;
		for (const row of this.customOnlyRows) {
			row.toggleClass("piem-settings-modal-row-hidden", !isCustom);
		}
	}

	/**
	 * Re-reads the selection after an edit to a field the match keys on.
	 *
	 * Typing one character into a preset's URL makes it a different endpoint, and
	 * the dropdown has to stop claiming otherwise. The reverse also holds: typing
	 * a preset's URL by hand selects it, which is the honest answer rather than a
	 * coincidence to hide. The name is not consulted — renaming a row does not
	 * change where it points.
	 */
	private syncPresetChoice(): void {
		const id = matchProviderPreset(this.draft)?.id ?? CUSTOM_PRESET_ID;
		if (id === this.presetChoice) {
			return;
		}
		this.presetChoice = id;
		this.presetDropdown?.setValue(id);
		this.syncCustomRows();
	}

	/** One fresh edit clears the old verdict — it no longer describes this draft. */
	private onEdit(): void {
		this.guard.edited();
		this.status?.clear();
	}

	/** True when the draft no longer matches what the form opened with. */
	private isDirty(): boolean {
		return JSON.stringify(normalizeProviderDraft(this.draft)) !== this.originalDraft;
	}

	/** The draft as it would be persisted, with incidental whitespace removed. */
	private normalizedDraft(): ProviderConfig {
		return normalizeProviderDraft(this.draft);
	}

	private async submit(): Promise<void> {
		const { t } = this.options;
		const problem = validateProviderDraft(this.draft, t);
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
			const message = t.t("providerModal.couldNotSave", { message: cause instanceof Error ? cause.message : String(cause) });
			this.status?.showError(message);
			new Notice(message);
		}
	}
}

/** The draft as it would be persisted, with incidental whitespace removed. */
function normalizeProviderDraft(draft: ProviderConfig): ProviderConfig {
	return {
		...draft,
		name: draft.name.trim(),
		baseUrl: draft.baseUrl.trim(),
		apiKey: draft.apiKey.trim(),
	};
}

/**
 * Validates a draft before it can be saved, returning a message or undefined.
 *
 * Kept exported and free of DOM access so the rules are unit-testable: this is
 * the panel's only guard against saving a row that cannot ever serve a request.
 */
export function validateProviderDraft(draft: ProviderConfig, t: Translator): string | undefined {
	const baseUrl = draft.baseUrl.trim();
	if (!baseUrl) {
		return t.t("providerModal.baseUrlRequired");
	}
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		return t.t("providerModal.baseUrlInvalid");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return t.t("providerModal.baseUrlScheme");
	}
	return undefined;
}
