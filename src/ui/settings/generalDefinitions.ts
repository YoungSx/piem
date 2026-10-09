import { Platform, type Setting, type SettingDefinitionItem, type SettingGroupItem } from "obsidian";
import { LANGUAGES, getT } from "../../i18n";
import { LOG_LEVEL_SETTINGS } from "../../logging/logLevel";
import { aboutLinks, describeVersion } from "./aboutCopy";
import { describeSecretPortability, describeSecretStorage } from "./secretStorageCopy";
import type { SettingsPanelHost } from "./panelHost";

/**
 * The General tab as declarative definitions.
 *
 * Migrated first among the four because every row here is a single field with no
 * dependants: a language, a chord, a log threshold, and prose. That makes it the
 * honest test of whether the declarative form can carry this panel's copy and
 * grouping without the rows losing anything — and each row that moves becomes
 * individually findable in Obsidian's settings search, which the imperative
 * version could not offer at all.
 *
 * Order is unchanged from the imperative tab: controls first, prose last.
 */

/** Language names, each written in the language it names. */
function languageOptions(host: SettingsPanelHost): Record<string, string> {
	const options: Record<string, string> = { auto: host.t.t("language.auto") };
	for (const language of LANGUAGES) {
		// Each entry is labelled by its own translator, not the active one: a reader
		// looking for their language recognizes its endonym, not its English name.
		options[language] = getT(language).t(`language.${language}`);
	}
	return options;
}

/** Log thresholds, sharing the viewer's own filter words. */
function logLevelOptions(host: SettingsPanelHost): Record<string, string> {
	const options: Record<string, string> = {};
	for (const level of LOG_LEVEL_SETTINGS) {
		options[level] = host.t.t(`logView.filter.${level}`);
	}
	return options;
}

/**
 * The send-shortcut row's description, annotated on a phone.
 *
 * The note is folded into `desc` rather than rendered as a separate effect line:
 * a declarative row has one description slot, and the sentence belongs to the
 * control's explanation anyway. Hiding the row on mobile was never an option —
 * the stored value still describes the keyboard it was chosen on, and a mobile
 * reader has to be able to see, let alone change, what their desktop does.
 */
function sendShortcutDesc(host: SettingsPanelHost): string {
	const base = host.t.t("settings.sendShortcutDesc");
	return Platform.isMobile ? `${base} ${host.t.t("settings.sendShortcutMobileNote")}` : base;
}

/**
 * The About material: version, links, and what leaves the vault.
 *
 * Each link is its own row with a real `<a>` in the control slot, which is why
 * these stay `render` rather than becoming `action` buttons: Obsidian routes
 * external hrefs to the system browser on both platforms, and a real link keeps
 * middle-click, copy-address, and open-in-background — affordances a synthetic
 * button removes.
 */
function aboutItems(host: SettingsPanelHost): SettingGroupItem[] {
	const { t } = host;
	const items: SettingGroupItem[] = [
		{ name: "Piem", desc: describeVersion(host.manifest.version, t) },
		...aboutLinks(t).map((link) => ({
			name: link.name,
			desc: link.description,
			render: (setting: Setting) => {
				setting.controlEl.createEl("a", {
					text: link.label,
					href: link.href,
					cls: "piem-settings-link",
					// The target opens in a new context and must not receive a handle
					// back to the app window.
					attr: { target: "_blank", rel: "noopener noreferrer" },
				});
			},
		})),
		{ name: t.t("settings.whatLeavesVault"), desc: t.t("settings.whatLeavesVaultDesc") },
		// The one consequence of the chat folder living in the vault that a reader
		// would otherwise meet by surprise: whatever syncs or backs up the vault now
		// carries the conversations too, and those contain note text the tools read.
		{ name: t.t("settings.chatLogsInVault"), searchable: false },
		{ name: t.t("settings.apiKeysHeading"), desc: describeSecretStorage(host.secretStorage, t) },
	];

	// Empty on the plaintext tier, where keys do travel with the vault; a blank row
	// would read as a rendering fault, so it is conditional rather than always
	// present with empty copy.
	const portability = describeSecretPortability(host.secretStorage, t);
	if (portability) {
		items.push({ name: portability, searchable: false });
	}
	items.push({ name: t.t("settings.restrictedKeyHint"), searchable: false });
	return items;
}

/** The General tab's rows, in the order they read. */
export function generalDefinitions(host: SettingsPanelHost): SettingDefinitionItem[] {
	const { t } = host;
	return [
		{
			name: t.t("settings.languageHeading"),
			desc: t.t("settings.languageDesc"),
			control: { type: "dropdown", key: "language", options: languageOptions(host) },
		},
		{
			type: "group",
			heading: t.t("settings.shortcutsHeading"),
			items: [
				{
					name: t.t("settings.sendShortcut"),
					desc: sendShortcutDesc(host),
					control: {
						type: "dropdown",
						key: "sendShortcut",
						options: {
							enter: t.t("settings.sendShortcutEnter"),
							modEnter: t.t("settings.sendShortcutModEnter"),
						},
					},
				},
			],
		},
		{
			type: "group",
			heading: t.t("settings.logsHeading"),
			items: [
				{
					name: t.t("settings.logLevelHeading"),
					desc: t.t("settings.logLevelDesc"),
					control: { type: "dropdown", key: "logLevel", options: logLevelOptions(host) },
				},
				{
					name: t.t("extensions.shareDiagnostics"),
					desc: t.t("extensions.shareDiagnosticsDesc"),
					control: { type: "toggle", key: "shareDiagnostics", defaultValue: true },
				},
				{
					// Named rather than a bare button, so assistive technology announcing
					// it out of context still says what it opens.
					name: t.t("settings.logViewerName"),
					desc: t.t("settings.logViewerDesc"),
					action: () => host.openLogView(),
				},
			],
		},
		{ type: "group", heading: "Piem", items: aboutItems(host) },
	];
}
