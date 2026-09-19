/**
 * The key-entry control shared by the provider and MCP-server forms.
 *
 * The two forms used to grow their own password rows, which worked until the
 * keychain arrived and gave them a second, better answer. Where the device can
 * read Obsidian's keychain (`delegated` tiers), the primary control is
 * Obsidian's own {@link SecretComponent} picker — the user picks a named entry,
 * the plugin stores its id, and no key ever reaches this form. The typed field
 * survives as a collapsed fallback for the key that genuinely cannot live in
 * the keychain. On the `manual` tier there is no keychain to delegate to, so
 * the typed field stays the primary control, exactly as before.
 *
 * Everything here is display-only: the callbacks carry the state changes, and
 * the form's draft stays the single owner of what will be saved.
 */

import { SecretComponent, Setting, type App } from "obsidian";
import type { Translator } from "../../i18n";
import { createCollapsibleSection } from "./collapsibleSection";
import {
	describeApiKeyField,
	describeSecretPortability,
	describeSecretStorage,
	type SecretStorageState,
} from "./secretStorageCopy";

/**
 * Obsidian's settings tab that lists keychain entries.
 *
 * Not in the public d.ts — it arrived with the keychain feature and is reached
 * by id like every other core tab. The call is guarded, so a build where the
 * id or the method is missing degrades to opening the settings root.
 */
const KEYCHAIN_TAB_ID = "keychain";

export interface SecretKeyFieldOptions {
	app: App;
	/** What this device offers. Drives which control is rendered. */
	tier: SecretStorageState;
	/** Copy resolver, shared with every other row in this form. */
	t: Translator;
	/**
	 * Resolves a picked id to its plaintext.
	 *
	 * The picker hands out ids, but the in-memory settings hold plaintext, so
	 * the form must resolve the pick immediately to keep the two in step.
	 */
	readSecret(id: string): string;
	/** Row title, from the caller's own namespace ("API key", "Bearer token"). */
	title: string;
	/**
	 * Overrides the row's computed description. The default copy is about the
	 * device's keychain; a caller whose form is about a specific credential —
	 * the bundled server's quota note — replaces it wholesale.
	 */
	desc?: string;
	/** Placeholder for the typed field. */
	placeholder: string;
	/** What the key is sent to, for the plaintext-field copy. */
	target: string;
	/** The plaintext currently in effect; the typed field's starting value. */
	inlineKey: string;
	/** The id currently bound, or `""` when the key is typed inline. */
	secretRef: string;
	/**
	 * A keychain entry was picked, or the binding cleared with `""`.
	 *
	 * `plaintext` is the resolved value of the new binding — `""` for a cleared
	 * one. The caller is responsible for the mutual exclusion: picking a
	 * binding retires the typed key, typing a key retires the binding.
	 */
	onRefChange(ref: string, plaintext: string): void;
	/** The typed field changed. The caller clears its binding in response. */
	onInlineChange(value: string): void;
}

/**
 * Adds the key row for this device's tier, plus the collapsed typed fallback
 * when the keychain is in charge.
 */
export function addSecretKeyField(containerEl: HTMLElement, options: SecretKeyFieldOptions): void {
	const { t, tier } = options;
	// The class is probed at runtime, not merely typed. `minAppVersion` is 1.13.0,
	// which is above SecretComponent's 1.11.1, so the class is present on every
	// supported host and this can no longer be a version fallback. It is kept as
	// a shape guard: the typed field is the control that degrades correctly if the
	// secret store's shape ever drifts, and that is cheaper than discovering the
	// drift as a blank row where the API key belongs.
	if (tier === "manual" || typeof SecretComponent !== "function") {
		addTypedKeyField(containerEl, options, { desc: options.desc ?? describeApiKeyField(tier, options.target, t) });
		return;
	}

	addKeychainKeyField(containerEl, options);
}

/**
 * The keychain row: Obsidian's picker for the binding, plus a button that
 * jumps to Obsidian's own keychain page — creating and naming entries is that
 * page's job, and the picker can only choose among what already exists.
 */
function addKeychainKeyField(containerEl: HTMLElement, options: SecretKeyFieldOptions): void {
	const { t, tier } = options;
	// Capability copy, not state copy: what this device does with a bound key,
	// and the sync warning a bound key earns. The picker itself shows which
	// entry is selected, so the row does not need to restate it.
	const setting = new Setting(containerEl)
		.setName(options.title)
		.setDesc(options.desc ?? joinSentences(describeSecretStorage(tier, t), describeSecretPortability(tier, t)))
		.addComponent((el) =>
			new SecretComponent(options.app, el)
				.setValue(options.secretRef)
				.onChange((id) => {
					// Resolve immediately: the draft's plaintext has to match the
					// binding or the in-memory invariant breaks the moment the
					// form saves.
					options.onRefChange(id, id === "" ? "" : options.readSecret(id));
					// A pick that resolves to nothing is a dangling binding made
					// just now; the picker shows the selection, so silence here
					// would read as success.
					if (id !== "" && options.readSecret(id) === "") {
						// The dangling warning outranks a caller's desc override: a binding
						// that resolves to nothing is a live problem, the quota note is not.
						setting.setDesc(joinSentences(describeSecretStorage(tier, t), describeSecretPortability(tier, t), t.t("secretStorage.danglingRef")));
					}
				}),
		);

	if (canOpenKeychainSettings(options.app)) {
		setting.addExtraButton((button) => {
			button.setIcon("key-round").setTooltip(t.t("secretStorage.openKeychain")).onClick(() => openKeychainSettings(options.app));
		});
	}

	// The typed fallback: a disclosure group, because on a keychain device it
	// is the road not taken and must not compete with the picker for attention.
	const fallback = createCollapsibleSection(containerEl, {
		label: t.t("secretStorage.manualGroup"),
		description: t.t("secretStorage.manualGroupHint"),
	});
	addTypedKeyField(fallback, options, {
		// The group's own hint already says where a typed key lands; the field
		// adds the one thing the hint does not — that this key is sent anywhere
		// at all, and how to limit the blast radius.
		desc: t.t("secretStorage.manualKeyFieldPlain", { target: options.target }),
	});
}

/**
 * The typed field. Shared by the `manual` tier (where it is the primary
 * control) and the keychain tiers' collapsed fallback.
 */
function addTypedKeyField(containerEl: HTMLElement, options: SecretKeyFieldOptions, copy: { desc: string }): void {
	new Setting(containerEl)
		.setName(options.title)
		.setDesc(copy.desc)
		.addText((text) => {
			text.inputEl.type = "password";
			text.setPlaceholder(options.placeholder);
			text.setValue(options.inlineKey);
			text.onChange((value) => options.onInlineChange(value));
		});
}


/**
 * Whether the settings host can be navigated to a tab by id.
 *
 * The same structural probe the plugin-settings shortcut uses: `app.setting`
 * is undocumented surface, so its shape is tested rather than assumed.
 */
function canOpenKeychainSettings(app: App): boolean {
	const host = (app as { setting?: { open?: unknown; openTabById?: unknown } }).setting;
	return typeof host?.open === "function" && typeof host?.openTabById === "function";
}

/** Opens the settings root, then the keychain tab, if the host knows it. */
function openKeychainSettings(app: App): void {
	if (!canOpenKeychainSettings(app)) {
		return;
	}
	// `open()` first, so an unknown tab id costs nothing worse than the root:
	// a build that has not shipped the keychain page must not turn the button
	// into an unhandled throw.
	try {
		(app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting.openTabById(KEYCHAIN_TAB_ID);
	} catch {
		// The settings root is already open. That is the graceful floor.
	}
}

/** Joins the sentence fragments a description is built from, skipping blanks. */
function joinSentences(...parts: string[]): string {
	return parts.filter((part) => part !== "").join(" ");
}
