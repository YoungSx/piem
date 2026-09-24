import type { SettingDefinitionItem, SettingDefinitionPage } from "obsidian";
import { chatDefinitions } from "./chatDefinitions";
import { extensionsDefinitions } from "./extensionsDefinitions";
import { generalDefinitions } from "./generalDefinitions";
import { modelsDefinitions } from "./modelsDefinitions";
import type { SettingsPanelHost } from "./panelHost";
import { SettingsPanelState } from "./panelState";

/**
 * The settings tab, as declarative definitions.
 *
 * `getSettingDefinitions()` replaced `display()` in 1.13.0, and the reason to
 * adopt it is not the deprecation: definitions are what Obsidian indexes for its
 * settings search, so anything drawn from `display()` cannot be found by a user
 * typing the name of the setting they want. `display()` is bypassed entirely once
 * this returns a non-empty array, which is why the switch is one step rather than
 * something that can run half-migrated.
 *
 * Each of the four groups is a {@link SettingDefinitionPage}: a navigable entry
 * whose rows are declared inline. That replaces the tab strip this plugin drew
 * for itself before the API existed — the strip existed because the panel had
 * outgrown one scroll and because one group had to be able to re-render without
 * destroying the controls in another, and the framework's navigation answers both
 * without a custom `role="tablist"` to keep accessible.
 *
 * Rows that need imperative behaviour keep it through `render`, which is what
 * that field is for: blur-committed text fields that coerce what was typed, the
 * MCP toggle's optimistic-then-reconciled verdict, the icon actions on a mutable
 * row. `SettingDefinitionRender` still carries `name`, `desc`, and `aliases`, so
 * those rows are searchable exactly like the fully declarative ones — the escape
 * hatch costs nothing in findability.
 *
 * Called on every `update()` and once at registration for indexing, so the page
 * bodies must stay cheap to build: reads that cost something run beside the build
 * and rebuild when they land, rather than blocking a search that never opens the
 * page.
 */

/** One page's title, its optional landing-entry annotations, and the rows behind it. */
interface PageDefinition {
	title(host: SettingsPanelHost): string;
	/**
	 * A static one-liner shown under the entry name on the landing page. Text only:
	 * the framework has no function form for `desc`, so this is resolved once at
	 * build and must not read anything the index pass should stay clear of.
	 */
	desc?: (host: SettingsPanelHost) => string;
	/**
	 * The current value surfaced on the entry, so the reader sees it without opening
	 * the page. Wired as a function so building the definitions — which also runs
	 * once purely to index for search — reads no live state, the same reason the
	 * rows defer their live reads into render callbacks.
	 */
	displayValue?: (host: SettingsPanelHost) => string;
	/**
	 * A warning marker on the entry when the page holds something needing
	 * attention. A function for the same reason as {@link displayValue}.
	 */
	status?: (host: SettingsPanelHost) => "warning" | null;
	/**
	 * The rows. Takes the tab's state as well as the host so a page whose content
	 * costs a disk read can hold the last answer across rebuilds; pages that need
	 * nothing of the sort simply ignore it.
	 */
	items(host: SettingsPanelHost, state: SettingsPanelState): SettingDefinitionItem[];
}

const PAGES: readonly PageDefinition[] = [
	// The model that answers rides onto the entry as its value; a warning marks the
	// one case that silently misleads — the vault still points at a builtin this
	// build dropped, and a stand-in is answering in its place.
	{
		title: (host) => host.t.t("settings.tabModels"),
		displayValue: (host) => host.describeTarget(),
		status: (host) => (host.missingBuiltinModel() ? "warning" : null),
		items: modelsDefinitions,
	},
	// Behaviour on top, storage underneath, separated by a section heading: both
	// halves answer questions about the same thing — the conversation — and two or
	// three rows cannot carry a page of their own.
	{
		title: (host) => host.t.t("settings.tabChat"),
		desc: (host) => host.t.t("settings.tabChatDesc"),
		items: chatDefinitions,
	},
	{
		title: (host) => host.t.t("settings.tabExtensions"),
		desc: (host) => host.t.t("settings.tabExtensionsDesc"),
		items: extensionsDefinitions,
	},
	// Controls first, prose last: language, shortcuts, logs, then the About
	// material. Each held one or two rows and no page of their own; a reader
	// reaching for any of them is doing the same thing — adjusting the plugin
	// rather than configuring it. The build version rides onto the entry as its value.
	{
		title: (host) => host.t.t("settings.tabGeneral"),
		displayValue: (host) => host.manifest.version,
		items: generalDefinitions,
	},
];

/**
 * The panel as definitions: one navigable page per group.
 *
 * A plain function of the host rather than a method on the tab, so it can be
 * tested without constructing a `PluginSettingTab` — the same reason the row
 * builders live outside `settings.ts`.
 */
export function buildSettingDefinitions(host: SettingsPanelHost, state: SettingsPanelState): SettingDefinitionItem[] {
	return PAGES.map((page) => {
		const entry: SettingDefinitionPage = {
			type: "page",
			name: page.title(host),
			items: page.items(host, state),
		};
		// `desc` has no function form, so it resolves now — a translation lookup that
		// probes nothing. `displayValue`/`status` are wired as closures so this build,
		// which also runs once purely to index for search, reads no live state; the
		// framework re-invokes them on every `update()` to refresh the entry.
		if (page.desc) entry.desc = page.desc(host);
		const displayValue = page.displayValue;
		if (displayValue) entry.displayValue = () => displayValue(host);
		const status = page.status;
		if (status) entry.status = () => status(host);
		return entry;
	});
}
