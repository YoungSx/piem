import type { CopyPath } from "../../i18n";
import type { EnCopy } from "../../i18n/en";

/**
 * Display metadata for the built-in Pi extensions the Extensions tab lets a
 * reader turn off, one row each.
 *
 * The `id`s mirror {@link ../../extensions/communityHost}'s static list — that
 * list is the source of truth for what actually loads, and this table only
 * decides what a reader sees and can toggle. Two members of that list are
 * deliberately absent: `pi-otel` is governed by the `shareDiagnostics` switch
 * (a second toggle would fight `disableOtel`), and the bookmark engine is a
 * separate host behind the `/bookmark` feature, not a community extension.
 *
 * Names and descriptions live in i18n rather than here: `communityHost` holds
 * only bare `id`s, and the upstream packages carry no localized display copy.
 * The `catalogCoversCommunityHost` test pins this table against that list so a
 * newly bundled extension cannot ship unlisted.
 */
export interface CommunityExtensionRow {
	/** Stable id, identical to the one in `communityHost`'s static list. */
	id: string;
	/** i18n leaf for the row title. */
	nameKey: CopyPath<EnCopy>;
	/** i18n leaf for the one-line description. */
	descKey: CopyPath<EnCopy>;
}

/** Tools first, then composer/input, then background and passive. */
export const COMMUNITY_EXTENSION_CATALOG: readonly CommunityExtensionRow[] = [
	{ id: "pi-web-search", nameKey: "extensions.catalog.webSearchName", descKey: "extensions.catalog.webSearchDesc" },
	{ id: "pi-model-switch", nameKey: "extensions.catalog.modelSwitchName", descKey: "extensions.catalog.modelSwitchDesc" },
	{ id: "pi-context", nameKey: "extensions.catalog.contextName", descKey: "extensions.catalog.contextDesc" },
	{ id: "@geminixiang/pi-agent-team", nameKey: "extensions.catalog.agentTeamName", descKey: "extensions.catalog.agentTeamDesc" },
	{ id: "pi-clarify", nameKey: "extensions.catalog.clarifyName", descKey: "extensions.catalog.clarifyDesc" },
	{ id: "pi-invisible-continue", nameKey: "extensions.catalog.continueName", descKey: "extensions.catalog.continueDesc" },
	{ id: "@juicesharp/rpiv-todo", nameKey: "extensions.catalog.todoName", descKey: "extensions.catalog.todoDesc" },
	{ id: "pi-assistant-provenance", nameKey: "extensions.catalog.provenanceName", descKey: "extensions.catalog.provenanceDesc" },
];
