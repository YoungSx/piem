import type { CacheRetention } from "@earendil-works/pi-ai";
import type { App, ExtraButtonComponent } from "obsidian";
import type { CompactionConfig } from "../../agent/compactionSettings";
import type { PromptQueueStrategy } from "../../agent/queueStrategy";
import type { SkillLoadReport } from "../../agent/skillLoader";
import type { LogLevelSetting } from "../../logging/logLevel";
import type { McpServerConfig } from "../../mcp/mcpConfig";
import type { McpServerState } from "../../mcp/mcpManager";
import type { ModelConfig, ProviderConfig } from "../../modelConfig";
import type { NetworkTransport } from "../../net/obsidianFetch";
import type { TraceExpandSetting } from "../../ui/traceExpand";
import type { FetchedSkill, FetchedSource, UpdatePlan } from "../../skills/skillImport";
import type { SkillInventory } from "../../skills/skillManager";
import type { LanguageSetting, Translator } from "../../i18n";
import type { SendShortcut } from "../keyboard";
import type { SecretStorageState } from "./secretStorageCopy";

/**
 * What the settings tab needs from the plugin, and what it stores.
 *
 * Kept out of `settings.ts` on purpose: that module owns the schema, migration,
 * and the pure resolvers the agent reads on every turn, and none of it should
 * have to be loaded through a `PluginSettingTab` to be tested. The tab passes an
 * implementation of {@link SettingsPanelHost} in, rather than the plugin itself,
 * so the row builders depend on the handful of things they actually use instead
 * of the whole plugin surface — which is also what lets every one of them be
 * tested against a plain object.
 */

/** What the panel needs from the plugin to read and write configuration. */
export interface SettingsPanelHost {
	app: App;
	/** Live settings object. Mutated in place, then persisted via {@link save}. */
	settings: SettingsPanelSettings;
	/** Persists the current settings and refreshes the agent's configuration. */
	save(): Promise<void>;
	/**
	 * Rebuilds the tab from fresh definitions.
	 *
	 * The declarative replacement for "empty a container and render into it
	 * again": adding a provider changes which rows exist, and `update()` re-runs
	 * `getSettingDefinitions()` so the framework rebuilds from the new list. That
	 * is also what makes a list's search query survive the change — the framework
	 * owns the query and reapplies it after each render, which the old
	 * hand-rolled filter had to reconstruct by reading it back out of the DOM.
	 *
	 * For a change that only flips whether a row is visible or enabled, this is
	 * heavier than needed; those go through the framework's own predicate
	 * re-evaluation instead.
	 */
	refresh(): void;
	/** Whether this device can encrypt secrets at rest. */
	secretStorage: SecretStorageState;
	/**
	 * Resolves a keychain id to its plaintext, for the modals' pickers.
	 *
	 * Always available: the panel runs even on the `manual` tier, where the
	 * resolver answers `""` and the picker is never shown anyway.
	 */
	readSecret(id: string): string;
	/** Names whatever requests currently target, for the status line. */
	describeTarget(): string;
	/** Copy for the whole panel, resolved from {@link SettingsPanelSettings.language}. */
	t: Translator;
	/**
	 * The active model's context window, which the compaction group clamps its
	 * token fields against. A function because the active model changes while the
	 * panel is open.
	 */
	contextWindow(): number;
	/**
	 * Chats currently stored, for the Sessions tab's effect line.
	 *
	 * Asynchronous because the count lives on disk: the directory has to be listed
	 * and every log parsed. The row renders without it and fills the line in when
	 * it arrives, rather than blocking the tab on a directory scan.
	 */
	countStoredSessions(): Promise<number>;
	/**
	 * The builtin provider/model pair this build no longer carries, when a vault is
	 * still configured with one. Undefined in every case where nothing was
	 * substituted.
	 */
	missingBuiltinModel(): { provider: string; modelId: string } | undefined;
	/**
	 * The folder chat logs are being written to right now.
	 *
	 * Read from the live session manager rather than from settings: a vault
	 * upgraded from an earlier release has no stored folder and is still using the
	 * plugin-internal one, and the row has to name where the logs actually are.
	 */
	activeSessionDir(): string;
	/** Opens the log viewer panel; the Logs tab's shortcut into it. */
	openLogView(): void;
	/**
	 * Chats left in the folder earlier releases used, and where that folder is.
	 *
	 * Zero when there are none, which is the case for every vault installed after
	 * the move — the notice then renders nothing at all.
	 */
	countLegacySessions(): Promise<{ count: number; dir: string }>;
	/**
	 * Plugin metadata shown on the General tab.
	 *
	 * A narrow field rather than the plugin itself: this interface declares only
	 * what the panel reads, and one version string is all that section needs.
	 */
	manifest: { version: string };
	/** Vault skill operations for the Skills tab. */
	skills: SkillsHost;
	/** MCP server operations for the Extensions tab. */
	mcp: McpHost;
}

/**
 * What the MCP section of the Extensions tab needs from the plugin.
 *
 * Config itself lives in {@link SettingsPanelSettings.mcpServers} and is saved
 * like any other setting; this carries only the live half the settings object
 * cannot know — the connection states of the running manager, and a probe that
 * tests a draft without touching those connections.
 */
export interface McpHost {
	/** Per-server status after the most recent connect attempt, in config order. */
	states(): McpServerState[];
	/**
	 * Probes one candidate configuration; resolves to the tool count it serves.
	 * Throws on failure — the test row renders the throw as a failed verdict.
	 */
	test(server: McpServerConfig): Promise<number>;
	/**
	 * Runs a connect pass, which skips the servers already mounted and retries
	 * only the failed ones. Resolves after every attempt has settled; the caller
	 * then re-reads {@link states} for the fresh verdicts. This repairs the
	 * connection cache alone — a live conversation sees new tools at its next
	 * agent rebuild point, not here.
	 */
	reconnect(): Promise<void>;
}

/**
 * What the Skills tab needs from the plugin: vault skill operations.
 *
 * Implemented over {@link SkillManager} plus the agent's reload path. Every
 * mutation here lands in the vault as files — not through
 * {@link SettingsPanelHost.save} — so the host carries the one call that tells
 * the running agent its prompt changed.
 */
export interface SkillsHost {
	/** Lists the skills installed under the vault's skills folder. */
	list(): Promise<SkillInventory>;
	/** Fetches a pasted URL for preview, writing nothing. */
	fetchSource(url: string): Promise<FetchedSource>;
	/** Writes one previewed skill into the vault. */
	install(source: FetchedSource, skill: FetchedSkill): Promise<void>;
	/** Checks upstream and applies a clean update; returns the plan either way. */
	update(dirName: string): Promise<UpdatePlan>;
	/** Deletes a skill directory, provenance sidecar included. */
	remove(dirName: string): Promise<void>;
	/**
	 * Re-reads skill files into the running agent after a change on disk, and
	 * makes {@link lastSkillLoad} current.
	 *
	 * Awaited before every render of this tab, not only after a mutation: the
	 * report below describes the agent's load, so the panel must have caused one
	 * to exist. A settings tab opened before any chat would otherwise render the
	 * empty report the service starts with.
	 */
	refreshAgent(): Promise<void>;
	/**
	 * Warnings from the agent's most recent skill load, split by layer.
	 *
	 * Read rather than loaded, which is the whole point: an earlier revision had
	 * the panel walk the folders itself, so the tab presented as *the* place skill
	 * problems are reported could describe a read the agent never performed. Two
	 * loads a moment apart disagree whenever a network folder reattaches between
	 * them — the panel says clean, and the prompt was built without those skills.
	 *
	 * Synchronous because it is a field read; {@link refreshAgent} is what makes
	 * it current, and it resolves only once the load has finished.
	 */
	lastSkillLoad(): SkillLoadReport;
	/**
	 * Whether user-level skills can be read on this device.
	 *
	 * Desktop only: the node filesystem they live in does not exist on mobile,
	 * and a section promising skills that can never load is noise.
	 */
	userSkillsAvailable: boolean;
}

/** The slice of settings this panel reads and writes. */
export interface SettingsPanelSettings {
	activeModelId?: string;
	providers: ProviderConfig[];
	models: ModelConfig[];
	networkTransport: NetworkTransport;
	cacheRetention: CacheRetention;
	showAgentDetails: boolean;
	traceExpand: TraceExpandSetting;
	promptQueueStrategy: PromptQueueStrategy;
	sendShortcut: SendShortcut;
	language: LanguageSetting;
	compaction?: CompactionConfig;
	sessionRetention: number;
	sessionDir: string;
	userSkillsDir: string;
	mcpServers: McpServerConfig[];
	logLevel: LogLevelSetting;
}

/**
 * One icon button in a row's control slot, labelled the same way for eyes and
 * screen readers: the tooltip is a visual title, so the accessible name has to
 * be set separately or the button reads as blank to assistive technology.
 */
export function rowAction(button: ExtraButtonComponent, icon: string, label: string): void {
	button.setIcon(icon);
	button.setTooltip(label);
	button.extraSettingsEl.setAttribute("aria-label", label);
}
