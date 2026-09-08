import { PluginSettingTab, type App, type SettingDefinitionItem } from "obsidian";
import { getBuiltinModels } from "./net/builtinCatalog";
import type { CacheRetention, Model } from "@earendil-works/pi-ai";
import type PiemPlugin from "./main";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER } from "./constants";
import type { SecretEnvironment, SecretStorageTier } from "./keychainEnv";
import type { NetworkTransport } from "./net/obsidianFetch";
import { DEFAULT_CACHE_RETENTION, readCacheRetention } from "./net/cacheRetention";
import {
	buildConfiguredModel,
	describeModelConfig,
	describeProviderConfig,
	normalizeProviderAndModelLists,
	type ModelConfig,
	type ProviderConfig,
} from "./modelConfig";
import { normalizeCompactionConfig, type CompactionConfig } from "./agent/compactionSettings";

import { normalizeRetryConfig, type RetryConfig } from "./net/retrySettings";
import { normalizeMcpServers, type McpServerConfig } from "./mcp/mcpConfig";
import { DEFAULT_SESSION_RETENTION, readRetentionLimit } from "./session/retention";
import { DEFAULT_SESSION_DIR, normalizeSessionDir } from "./session/sessionDir";
import { DEFAULT_LOG_LEVEL, readLogLevel, type LogLevelSetting } from "./logging/logLevel";
import { resolveSecretRefs } from "./settingsSecrets";
import type { SettingsPanelHost } from "./ui/settings/panelHost";
import { buildSettingDefinitions } from "./ui/settings/settingDefinitions";
import { SettingsPanelState } from "./ui/settings/panelState";
import { isControlKey, readControlValue, writeControlValue } from "./ui/settings/controlKeys";
import { getT, isLanguageSetting, resolveLanguage, type LanguageHost, type LanguageSetting, type Translator } from "./i18n";
import { DEFAULT_SEND_SHORTCUT, isSendShortcutSetting, type SendShortcut } from "./ui/keyboard";
import { DEFAULT_TRACE_EXPAND, isTraceExpandSetting, type TraceExpandSetting } from "./ui/traceExpand";
import {
	DEFAULT_PROMPT_QUEUE_STRATEGY,
	isPromptQueueStrategy,
	type PromptQueueStrategy,
} from "./agent/queueStrategy";
import { SkillManager } from "./skills/skillManager";
import { userSkillsSupported } from "./skills/userSkills";
import { normalizeUserSkillsDir } from "./skills/userSkillsDir";
import { VaultExecutionEnv } from "./vault/VaultExecutionEnv";
import { createObsidianRequestUrlFetch } from "./net/obsidianFetch";

export interface PiemSettings {
	/**
	 * The {@link ModelConfig} every request goes out on. Undefined means no
	 * configured model has been chosen, so the builtin provider/model pair
	 * below applies.
	 */
	activeModelId?: string;
	/**
	 * The {@link ModelConfig} the quick-action suggestion request goes out on.
	 * Undefined means the suggestion follows the active model — a suggestion is
	 * a 512-token side channel, and most readers want it on whatever is already
	 * picked rather than maintaining a second choice.
	 */
	suggestionModelId?: string;
	/** User-configured endpoints. Connection and credential only, no models. */
	providers: ProviderConfig[];
	/** Configured models, each bound to one entry in {@link providers}. */
	models: ModelConfig[];
	/** Builtin catalog provider, used when no configured model is active. */
	provider: string;
	/** Builtin catalog model id, used when no configured model is active. */
	modelId: string;
	networkTransport: NetworkTransport;
	/**
	 * How long providers are asked to keep the prompt cache alive.
	 *
	 * Always resolved rather than optional: an absent value would mean "follow
	 * pi", and pi's default is the five-minute cache tuned for a CLI loop, which
	 * is the thing {@link DEFAULT_CACHE_RETENTION} exists to override.
	 */
	cacheRetention: CacheRetention;
	/**
	 * Whether the chat panel exposes agent-internal metrics — token counts,
	 * spend, context-window occupancy and raw tool payloads.
	 *
	 * Off by default: an Obsidian user's vocabulary is notes and links, not
	 * context windows, and the panel's job is to keep that plumbing out of the
	 * way. Readers who do want the numbers turn it on once.
	 */
	showAgentDetails: boolean;
	/**
	 * How much of the transcript's machine traffic starts open — the default
	 * behind every thinking, tool-call, and tool-result row. Rows stay openable
	 * by hand either way; this is the state the reader meets, not a permission.
	 */
	traceExpand: TraceExpandSetting;
	/**
	 * Whether the mobile composer starts folded down to its top row.
	 *
	 * Persisted UI state rather than a preference: a phone that switched away
	 * from the panel usually had it unloaded, and without this the reader who
	 * folded the composer to read would unfold it again on every return. The
	 * fold is mobile-only — no toggle renders on desktop, so ChatComposer clamps
	 * the state off there. That clamp is what keeps a sync plugin harmless: a
	 * data.json copied from a phone must not strand a desktop panel in a fold it
	 * has no button to leave. Absent means expanded, so vaults written before
	 * the field existed get today's behaviour.
	 */
	mobileComposerCollapsed?: boolean;
	/**
	 * How long a message typed mid-reply waits before it reaches the model —
	 * the whole answer, or only the provider request in flight (issue #289).
	 * Neither is an interrupt; the chip's own steer action is.
	 */
	promptQueueStrategy: PromptQueueStrategy;
	/**
	 * Language the interface speaks. `"auto"` follows the host vault's language
	 * (resolved once per load); the concrete values override it.
	 */
	language: LanguageSetting;
	/**
	 * Which keypress sends the draft.
	 *
	 * Ctrl/Cmd+Enter sends under either value, so this only decides whether a bare
	 * Enter sends too — see {@link isSendShortcut}. Always present: there is no
	 * upstream default to defer to, and a chord the plugin picked has to be visible
	 * in the panel rather than implied by an empty field.
	 */
	sendShortcut: SendShortcut;
	/**
	 * When history gets summarized, and how much survives.
	 *
	 * Partial by design: an absent field follows pi's own default rather than
	 * freezing the value it had when the vault was created, so a pi upgrade that
	 * retunes compaction still reaches users who never opened the advanced group.
	 * Resolution and clamping live in {@link resolveCompactionSettings}.
	 */
	compaction?: CompactionConfig;
	/**
	 * When a transient failure earns another attempt, and how fast.
	 *
	 * Partial like compaction: an absent field follows the plugin's default
	 * rather than freezing a shipped value on vaults that never opened the
	 * advanced group. Resolution and clamping live in {@link resolveRetrySettings};
	 * unlike compaction, the range clamp lands in {@link normalizeRetryConfig}
	 * because the range is absolute rather than model-dependent.
	 */
	retry?: RetryConfig;
	/**
	 * How many chats are kept before the oldest are moved to trash.
	 *
	 * {@link UNLIMITED_SESSION_RETENTION} keeps every chat, which is the old
	 * behaviour. Always present — unlike compaction, there is no pi default to
	 * defer to, and a cap the plugin picked has to be visible in the panel rather
	 * than implied by an empty field.
	 */
	sessionRetention: number;
	/**
	 * Folder chat logs are written to, relative to the vault root.
	 *
	 * Always resolved: a vault written before this setting existed gets
	 * {@link DEFAULT_SESSION_DIR} too, so every install writes chat logs where the
	 * user can see them. The logs an earlier release left in the plugin folder are
	 * not moved; the Sessions tab names that folder so they can be recovered.
	 */
	sessionDir: string;
	/**
	 * One extra directory to load user-level skills from, or `""` for none.
	 *
	 * Additive, not a replacement: the two directories pi itself reads are not a
	 * choice anyone made here, and a user who has skills in both places wants
	 * both. It outranks them, because a directory the user named is a more
	 * deliberate statement than a default they inherited.
	 *
	 * Empty is the shipped value and a valid answer, so this is `""` rather than
	 * optional — an absent field and a cleared one mean the same thing, and one
	 * spelling keeps every reader from having to handle both.
	 */
	userSkillsDir: string;
	/**
	 * Names of skills turned off on the Skills tab, by name across all layers.
	 *
	 * A name, not a path or layer: the merge lets a vault skill override a
	 * builtin of the same name, and the user's intent in disabling either is
	 * "that name should not load", so the filter matches the merged output. An
	 * entry naming nothing currently installed is harmless — it disables
	 * nothing and is rewritten away only if the row is toggled again.
	 */
	disabledSkills: string[];
	/**
	 * Threshold below which log records are discarded.
	 *
	 * Read live by the logger through the settings closure, so a change on the
	 * Logs tab takes effect on the next record without reloading the plugin.
	 */
	logLevel: LogLevelSetting;
	/** Configured MCP servers; empty means no remote tools join the agent. */
	mcpServers: McpServerConfig[];
}

export const DEFAULT_SETTINGS: PiemSettings = {
	providers: [],
	models: [],
	provider: DEFAULT_PROVIDER,
	modelId: DEFAULT_MODEL_ID,
	networkTransport: "requestUrl",
	cacheRetention: DEFAULT_CACHE_RETENTION,
	showAgentDetails: false,
	traceExpand: DEFAULT_TRACE_EXPAND,
	promptQueueStrategy: DEFAULT_PROMPT_QUEUE_STRATEGY,
	language: "auto",
	sendShortcut: DEFAULT_SEND_SHORTCUT,
	sessionRetention: DEFAULT_SESSION_RETENTION,
	sessionDir: DEFAULT_SESSION_DIR,
	userSkillsDir: "",
	disabledSkills: [],
	logLevel: DEFAULT_LOG_LEVEL,
	mcpServers: [],
};

/**
 * Coerces persisted data into settings.
 */
export function normalizeSettings(data: Partial<PiemSettings> | null | undefined): PiemSettings {
	const provider = data?.provider || DEFAULT_PROVIDER;
	const modelId = data?.modelId || DEFAULT_MODEL_ID;
	// A stored `thinkingLevel` from before the field moved into the session file
	// is deliberately dropped, not migrated: the level now belongs to each
	// conversation, and a global leftover would claim authority over sessions
	// that already recorded their own.
	const networkTransport: NetworkTransport = data?.networkTransport === "fetch" ? "fetch" : "requestUrl";
	// A corrupted or unknown stored value degrades to "auto" rather than
	// throwing, matching how every other enum-typed setting is repaired.
	const rawLanguage = data?.language;
	const language: LanguageSetting = isLanguageSetting(rawLanguage) ? rawLanguage : "auto";

	const compaction = normalizeCompactionConfig(data?.compaction);
	const retry = normalizeRetryConfig(data?.retry);

	const { providers, models } = normalizeProviderAndModelLists(data?.providers, data?.models);
	let activeModelId = typeof data?.activeModelId === "string" ? data.activeModelId.trim() : "";

	// A dangling reference would resolve to nothing on every request, so it is
	// dropped in favour of the builtin fallback below.
	if (activeModelId && !models.some((model) => model.id === activeModelId)) {
		activeModelId = "";
	}
	let suggestionModelId = typeof data?.suggestionModelId === "string" ? data.suggestionModelId.trim() : "";

	// Same dangling rule as `activeModelId`: a reference to a deleted model would
	// resolve to nothing on every suggestion request, so it reverts to "follow
	// the active model" instead of pointing nowhere.
	if (suggestionModelId && !models.some((model) => model.id === suggestionModelId)) {
		suggestionModelId = "";
	}

	const settings: PiemSettings = {
		providers,
		models,
		provider,
		modelId,
		networkTransport,
		// Absent in vaults written before the setting existed. Those get the hour
		// rather than pi's five minutes, which is the point of the default — see
		// `DEFAULT_CACHE_RETENTION` for the arithmetic behind that choice.
		cacheRetention: readCacheRetention(data?.cacheRetention),
		// Absent in vaults written before the setting existed; those users get the
		// quiet default rather than inheriting the old always-verbose panel.
		showAgentDetails: data?.showAgentDetails === true,
		// Absent in vaults written before the setting existed; those keep the
		// collapsed transcript, which is what they were reading before the choice
		// was one to make.
		traceExpand: isTraceExpandSetting(data?.traceExpand) ? data.traceExpand : DEFAULT_TRACE_EXPAND,
		// Absent in vaults written before the setting existed; those get the whole
		// answer, which is the timing a mid-run send has had since the queue itself
		// only ever waited for `agent_end` (issue #289).
		promptQueueStrategy: isPromptQueueStrategy(data?.promptQueueStrategy)
			? data.promptQueueStrategy
			: DEFAULT_PROMPT_QUEUE_STRATEGY,
		language,
		// Absent in vaults written before the setting existed. Those users get bare
		// Enter, which adds a way to send rather than moving one: the Ctrl+Enter
		// chord they already know keeps working under it.
		sendShortcut: isSendShortcutSetting(data?.sendShortcut) ? data.sendShortcut : DEFAULT_SEND_SHORTCUT,
		// Absent in vaults written before the cap existed. Those vaults may already
		// hold more chats than it allows, and the first new chat trims them to it —
		// to trash, so nothing is lost outright.
		sessionRetention: readRetentionLimit(data?.sessionRetention),
		// Falls back to the vault-folder default, including on a vault written
		// before this setting existed: chat logs belong with the user's notes, where
		// they can be opened, searched, and backed up. Nothing is moved — chats in
		// the old plugin folder stay on disk, and the Sessions tab says where.
		sessionDir: normalizeSessionDir(data?.sessionDir) ?? DEFAULT_SESSION_DIR,
		// Normalised on the way in, so a hand-edited data.json cannot hand the
		// loader a relative path that would silently resolve against the home
		// directory. A value the validator cannot judge is kept rather than
		// dropped: on mobile there is no filesystem for the verdict to matter, and
		// clearing the field would lose the directory the user's desktop configured
		// — see `normalizeUserSkillsDir` for why that shapes its return.
		userSkillsDir: normalizeUserSkillsDir(data?.userSkillsDir) ?? "",
		// Non-strings and duplicates from a hand-edited data.json are dropped
		// rather than carried: the filter below reads this list on every skill
		// load, and a Set would forgive both — but the persisted file is the one
		// place the list should stay clean.
		disabledSkills: Array.from(
			new Set((Array.isArray(data?.disabledSkills) ? data.disabledSkills : []).filter((name): name is string => typeof name === "string")),
		),
		// A corrupted or unknown stored value degrades to the default rather than
		// throwing, matching how every other enum-typed setting is repaired.
		logLevel: readLogLevel(data?.logLevel),
		mcpServers: normalizeMcpServers(data?.mcpServers),
	};
	// Omitted rather than stored as `false`, so "absent" keeps meaning "expanded"
	// and a vault written before the field existed stays byte-identical on load.
	if (data?.mobileComposerCollapsed === true) {
		settings.mobileComposerCollapsed = true;
	}
	if (activeModelId) {
		settings.activeModelId = activeModelId;
	}
	// Same omitted-not-empty rule as `activeModelId`: "absent" is what the
	// follow-the-active-model default reads as, and an empty string stored
	// forever would disagree with a load/save round trip.
	if (suggestionModelId) {
		settings.suggestionModelId = suggestionModelId;
	}
	// Omitted rather than stored as `{}` so an untouched vault's data.json stays
	// as it was, and "unset" keeps meaning "follow pi".
	if (compaction) {
		settings.compaction = compaction;
	}
	if (retry) {
		settings.retry = retry;
	}
	return settings;
}

export function getProviderModels(provider: string): Model<string>[] {
	return getBuiltinModels(provider);
}

/**
 * The settings slice model resolution reads.
 *
 * Declared structurally rather than taken as {@link PiemSettings} because the
 * settings tab resolves models from its own narrower view of configuration —
 * the panel never holds the builtin pair or the rest of the stored shape, and
 * resolution needs none of them. A full {@link PiemSettings} satisfies it, so
 * every caller keeps working unchanged.
 */
export interface ModelResolutionSource {
	providers: readonly ProviderConfig[];
	models: readonly ModelConfig[];
	activeModelId?: string;
	/** The suggestion side channel's explicit pick; see {@link getSuggestionConfiguration}. */
	suggestionModelId?: string;
}

/** The active {@link ModelConfig}, or undefined when a builtin model is selected. */
export function getActiveModelConfig(source: ModelResolutionSource): ModelConfig | undefined {
	if (!source.activeModelId) {
		return undefined;
	}
	return source.models.find((model) => model.id === source.activeModelId);
}

/** The provider serving `model`. */
export function getProviderForModel(source: ModelResolutionSource, model: ModelConfig): ProviderConfig | undefined {
	return source.providers.find((provider) => provider.id === model.providerId);
}

/**
 * One selectable model, already named for a reader.
 *
 * Flattened out of the {@link ModelConfig}/{@link ProviderConfig} pair on
 * purpose. The chat panel's switcher renders a list and has to label each row
 * without holding both settings lists and doing the join itself — a component
 * that resolves ids at render time is a component that will disagree with the
 * settings tab about what a model is called.
 *
 * Both names are carried because neither is sufficient alone: two providers can
 * serve the same model id, and "gpt-4o-mini" listed twice is a choice the user
 * cannot make.
 */
export interface ModelChoice {
	/** The {@link ModelConfig} id, as `activeModelId` stores it. */
	id: string;
	/** The model's own name — its display name, or its raw api id. */
	name: string;
	/** The serving provider's name, or its base URL. */
	provider: string;
}

/**
 * The models a user can switch between, in configured order.
 *
 * A model whose provider is missing is omitted rather than listed as broken: it
 * has no base URL and no credential, so {@link getSelectedModel} would answer a
 * request for it from the builtin catalog instead — silently a different
 * endpoint. `normalizeSettings` already drops orphans on load, so this guards a
 * list edited live in the settings tab rather than an expected stored state.
 */
export function listModelChoices(source: ModelResolutionSource): ModelChoice[] {
	const providersById = new Map(source.providers.map((provider) => [provider.id, provider]));
	const choices: ModelChoice[] = [];
	for (const model of source.models) {
		const provider = providersById.get(model.providerId);
		if (!provider) {
			continue;
		}
		choices.push({ id: model.id, name: describeModelConfig(model), provider: describeProviderConfig(provider) });
	}
	return choices;
}

/**
 * One configured model resolved to what pi-ai dispatches on, by its choice id.
 *
 * Keyed on the {@link ModelConfig} id rather than the model's api id because api
 * ids are not unique — two providers serve the same `openai/gpt-oss-120b` with
 * different base URLs and costs, which is why {@link ModelChoice} carries both
 * names. Scoped to `settings.models` for the same reason {@link listModelChoices}
 * is: a builtin catalog entry has no configured credential, so resolving one
 * would hand back a model whose first request fails on auth.
 *
 * Undefined for an unknown id and for a model whose provider went missing —
 * the same orphan case {@link listModelChoices} omits, so the list a caller
 * offers and the ids it can resolve agree by construction.
 */
export function resolveModelChoice(source: ModelResolutionSource, choiceId: string): Model<string> | undefined {
	const model = source.models.find((entry) => entry.id === choiceId);
	if (!model) {
		return undefined;
	}
	const provider = getProviderForModel(source, model);
	return provider ? buildConfiguredModel(model, provider) : undefined;
}

/** The active model paired with its provider, when both resolve. */
export function getActiveConfiguration(source: ModelResolutionSource): { model: ModelConfig; provider: ProviderConfig } | undefined {
	const model = getActiveModelConfig(source);
	if (!model) {
		return undefined;
	}
	const provider = getProviderForModel(source, model);
	return provider ? { model, provider } : undefined;
}

/**
 * Resolves the model every request goes out on.
 *
 * A configured provider/model pair wins outright: mixing it with the builtin
 * fallback would mean a stored provider/model pair silently overriding what the
 * user configured. Only when nothing is configured does the fallback apply, and
 * it exists to be rendered rather than sent — see {@link ./net/builtinCatalog}.
 */
export function getSelectedModel(settings: PiemSettings): Model<string> {
	const active = getActiveConfiguration(settings);
	if (active) {
		return buildConfiguredModel(active.model, active.provider);
	}
	const models = getProviderModels(settings.provider);
	const selectedModel = models.find((model) => model.id === settings.modelId);
	if (selectedModel) {
		return selectedModel;
	}

	const fallbackModel = getProviderModels(DEFAULT_PROVIDER).find((model) => model.id === DEFAULT_MODEL_ID);
	if (!fallbackModel) {
		throw new Error(`Default model ${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID} is not available.`);
	}
	return fallbackModel;
}

/**
 * Resolves the model the quick-action suggestion request travels on.
 *
 * An explicit choice wins, resolved through {@link resolveModelChoice} so a
 * model whose provider was deleted resolves to nothing rather than to some
 * other endpoint. Without one the suggestion follows the active configured
 * model — the default the feature has always run on. Undefined — never a
 * builtin-catalog fallback — is the honest answer when neither resolves: the
 * builtin pair is render-only here and cannot send, so returning it would let
 * a suggestion request start on a model with no credential behind it.
 *
 * The suggestion cache keys on this result via {@link suggestionModelKey};
 * the two must move together or a model switch would resurrect another
 * model's chips.
 */
export function resolveSuggestionModel(settings: PiemSettings): Model<string> | undefined {
	const config = getSuggestionConfiguration(settings);
	return config ? buildConfiguredModel(config.model, config.provider) : undefined;
}

/**
 * The model/provider pair the suggestion request sends on, or undefined.
 *
 * The panel's test button needs the pair itself — `createObsidianModels` is
 * built around a provider, not a resolved pi model — so this is
 * {@link resolveSuggestionModel}'s body with the pair left un-built. Defined on
 * the {@link ModelResolutionSource} slice so the settings tab can call it on its
 * own settings object without the whole {@link PiemSettings} behind it.
 */
export function getSuggestionConfiguration(
	source: ModelResolutionSource,
): { model: ModelConfig; provider: ProviderConfig } | undefined {
	if (source.suggestionModelId) {
		const model = source.models.find((entry) => entry.id === source.suggestionModelId);
		if (!model) {
			return undefined;
		}
		const provider = source.providers.find((entry) => entry.id === model.providerId);
		return provider ? { model, provider } : undefined;
	}
	return getActiveConfiguration(source);
}

/**
 * The cache-key component for a suggestion model.
 *
 * `Model.provider` is the discriminator, not decoration: `buildConfiguredModel`
 * sets `Model.id` to the model's *api* id, which two providers can share, so
 * `${provider}/${id}` is the shortest identity that cannot collide across
 * configured endpoints. Callers must use this helper rather than re-joining
 * the parts — the join is the kind of thing that drifts apart in two call sites.
 */
export function suggestionModelKey(model: Model<string>): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Whether the builtin provider/model pair a vault is configured with is gone.
 *
 * The catalog this build ships is a subset of pi-ai's, so a vault configured
 * against a provider that has since been dropped resolves through
 * {@link getSelectedModel}'s last-resort fallback and silently starts talking to
 * a different model. That is the one outcome the catalog trimming had to avoid,
 * so the panel names it instead: this reports the stale pair, and the Models tab
 * renders it as a notice pointing at the configured-provider flow, which can
 * still reach any endpoint.
 *
 * Returns undefined when a configured model is active or when the pair resolves
 * — in each case nothing was substituted.
 */
export function findMissingBuiltinModel(settings: PiemSettings): { provider: string; modelId: string } | undefined {
	if (getActiveConfiguration(settings)) {
		return undefined;
	}
	if (getProviderModels(settings.provider).some((model) => model.id === settings.modelId)) {
		return undefined;
	}
	return { provider: settings.provider, modelId: settings.modelId };
}

/**
 * API key for the resolved configuration.
 *
 * A configured provider carries its own key; without one there is nothing to
 * send. No cross-lookup: a leftover key for a builtin catalog id is never
 * silently reused against a different server.
 */
export function getConfiguredApiKey(settings: PiemSettings): string | undefined {
	const active = getActiveConfiguration(settings);
	if (active) {
		return active.provider.apiKey.trim() || undefined;
	}
	return undefined;
}

/**
 * API key for one provider id, as pi-ai asks for it per request.
 *
 * Scoped to configured providers: a provider that was never added has no
 * credential to resolve, whatever else the settings may hold.
 */
export function getApiKeyForProvider(settings: PiemSettings, providerId: string): string | undefined {
	const configured = settings.providers.find((provider) => provider.id === providerId);
	if (configured) {
		return configured.apiKey.trim() || undefined;
	}
	return undefined;
}

/**
 * Names whatever requests currently target, for user-facing messages.
 *
 * A configured model is described by its display name and provider rather than
 * by internal ids, which would mean nothing to a user reading an error.
 */
export function describeModelTarget(settings: PiemSettings, t: Translator): string {
	const active = getActiveConfiguration(settings);
	if (active) {
		const providerName = active.provider.name || active.provider.baseUrl;
		return `${describeModelConfig(active.model)} (${providerName})`;
	}
	return `${settings.provider}/${settings.modelId}`.replace(/^./, (first) => first.toUpperCase());
}

/**
 * Whether `model` accepts image content alongside text.
 *
 * `Model.input` is the provider's declared capability list — `["text"]` for a
 * text-only model, `["text", "image"]` for a multimodal one. Custom endpoints
 * default to `["text"]` (see {@link buildConfiguredModel}) since their backing
 * model is unknown, so this conservatively reports `false` there until a
 * capability bit is configured. The caller gates image send on this so a
 * text-only model never receives a content array it cannot consume.
 */
export function modelSupportsImages(model: Model<string>): boolean {
	return model.input.includes("image");
}

/**
 * Obsidian's settings-tab entrypoint.
 *
 * Deliberately thin: it resolves what the panel needs from the plugin and hands
 * off. Everything about how the panel looks and behaves lives in
 * {@link buildSettingDefinitions} and the tab renderers behind it, which keeps
 * this module's schema and resolvers testable without constructing a
 * `PluginSettingTab`.
 */
export class PiemSettingTab extends PluginSettingTab {
	private readonly plugin: PiemPlugin;
	private readonly secretEnvironment: SecretEnvironment | null;
	/**
	 * What the rows keep between rebuilds.
	 *
	 * Owned here rather than by the modules that read it, because the tab is the
	 * thing whose lifetime it should share: `getSettingDefinitions()` runs again on
	 * every `update()`, and a slot that outlived the tab would show a previous
	 * vault's skills to the next one.
	 */
	private readonly panelState = new SettingsPanelState();

	constructor(app: App, plugin: PiemPlugin, secretEnvironment?: SecretEnvironment) {
		super(app, plugin);
		this.plugin = plugin;
		this.secretEnvironment = secretEnvironment ?? null;
	}

	/**
	 * Where keys land on this device.
	 *
	 * Reads through to the resolved environment rather than caching, so the panel
	 * and the storage layer can never disagree about which tier is in effect.
	 * Defaults to `manual` when no environment was injected, which is the honest
	 * answer for a tab constructed without one.
	 */
	get secretStorageTier(): SecretStorageTier {
		return this.secretEnvironment?.tier() ?? "manual";
	}

	/**
	 * Renders the panel imperatively.
	 *
	 * One page per tab, built in {@link buildSettingDefinitions}. Returning a
	 * non-empty array is what takes the deprecated `display()` out of the
	 * picture — Obsidian bypasses it entirely — and it is what puts these
	 * settings into the app's settings search, which is the actual reason to
	 * adopt the API rather than the deprecation notice.
	 *
	 * Called on every `update()` and once at registration for indexing, so it
	 * stays a pure assembly of definitions: the reads that cost something (the
	 * vault's skill folders, the agent's load report, the stored chat count) all
	 * sit behind the page factories, where they run on navigation instead of on
	 * a search that never opens the page.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return buildSettingDefinitions(this.buildHost(), this.panelState);
	}

	/**
	 * Reads the value a declarative `control` should render.
	 *
	 * Overridden rather than inherited because the base implementation reaches
	 * into `this.plugin.settings` by bare string. That is the same object this
	 * would read, but going through {@link readControlValue} is what makes the key
	 * checked against the settings type — an unrecognized key returns undefined
	 * here instead of silently rendering a row bound to nothing.
	 */
	getControlValue(key: string): unknown {
		return isControlKey(key) ? readControlValue(this.plugin.settings, key) : undefined;
	}

	/**
	 * Persists a declarative `control`'s new value.
	 *
	 * The override is required, not stylistic: the inherited version calls
	 * `saveData()` and stops, while this plugin's {@link PiemPlugin.saveSettings}
	 * also refreshes the running agent's configuration and redraws the chat
	 * header. A control that took the default path would appear to save and leave
	 * the agent on the previous model.
	 *
	 * A rejected value is not persisted. {@link writeControlValue} guards each
	 * union-typed setting, and writing a value it refused would put a chord or a
	 * log threshold nobody handles into the vault.
	 */
	async setControlValue(key: string, value: unknown): Promise<void> {
		if (!isControlKey(key) || !writeControlValue(this.plugin.settings, key, value)) {
			return;
		}
		await this.buildHost().save();
	}

	/**
	 * The panel's view of the plugin.
	 *
	 * Assembled per call rather than cached: the language is resolved once here
	 * and closed over by every label-producing callback, so a language change has
	 * to build a fresh host rather than mutate a stale one.
	 */
	private buildHost(): SettingsPanelHost {
		const language = resolveLanguage(this.app.vault as LanguageHost, this.plugin.settings.language);
		return {
			app: this.app,
			settings: this.plugin.settings,
			// A language change rewrites every label on the page, including the
			// navigation's, so the definitions are rebuilt rather than patched:
			// `update()` re-runs `getSettingDefinitions`, which re-resolves the
			// language into a new host. Comparing the resolved language (not the
			// setting) keeps "auto" from rebuilding when it resolves to what is
			// already shown.
			save: async () => {
				await this.plugin.saveSettings();
				if (resolveLanguage(this.app.vault as LanguageHost, this.plugin.settings.language) !== language) {
					this.update();
				}
			},
			// Structural mutations (add/remove rows) need fresh definitions; `update()`
			// is the framework-owned replacement for the old tab-local empty+render.
			refresh: () => this.update(),
			logger: this.plugin.panelLogger,
			secretStorage: this.secretStorageTier,
			readSecret: (id) => this.secretEnvironment?.keychain().read(id) ?? "",
			// Built and cached on the plugin, over the one credential store the
			// agent also reads through: a token the dialog just wrote must be the
			// token the next request rotates. Undefined only where the tab was
			// constructed without its plugin — the test harness.
			signIn: this.plugin.signInSession,
			openLogView: () => this.plugin.openLogView(),
			describeTarget: () => describeModelTarget(this.plugin.settings, getT(language)),
			t: getT(language),
			contextWindow: () => getSelectedModel(this.plugin.settings).contextWindow,
			countStoredSessions: () => this.plugin.countStoredSessions(),
			activeSessionDir: () => this.plugin.getActiveSessionDir(),
			countLegacySessions: () => this.plugin.countLegacySessions(),
			missingBuiltinModel: () => findMissingBuiltinModel(this.plugin.settings),
			manifest: { version: this.plugin.manifest.version },
			skills: (() => {
				// Built fresh per call, not cached on the tab: the manager is stateless
				// over the vault, so nothing is lost between calls. Its fetch is pinned
				// to `requestUrl` — an import fetches whatever URL the user pasted, and
				// on the `fetch` transport ordinary hosts (no CORS headers) would be
				// unreachable. Imports never stream, so `requestUrl` costs nothing.
				const manager = () => new SkillManager(createObsidianRequestUrlFetch(), new VaultExecutionEnv(this.app));
				return {
					list: () => manager().listSkills(),
					fetchSource: (url) => manager().fetchSource(url),
					install: (source, skill) => manager().install(source, skill),
					update: (dirName) => manager().update(dirName),
					remove: (dirName) => manager().remove(dirName),
					refreshAgent: () => this.plugin.refreshAgentSkills(),
					// The agent's own load, not one this panel performs. The panel used
					// to walk the folders itself, so the tab presented as the place
					// skill problems are reported could describe a read the agent never
					// did — and the two disagree exactly when it matters, a network
					// folder reattaching between them. `refreshAgent` above is what
					// makes this current, and the panel awaits it before every render.
					lastSkillLoad: () => this.plugin.agentSkillLoad(),
					// The agent's merged catalog before the disabled filter — the toggle
					// sections render it, and a disabled skill keeps its row with the
					// switch down so it can be turned back on.
					catalog: () => this.plugin.agentSkillCatalog(),
					// Probed rather than Platform.isDesktop: the same signal
					// loadUserSkills skips on, so the panel and the loader can
					// never disagree about whether this device has a node fs.
					userSkillsAvailable: userSkillsSupported(),
				};
			})(),
			mcp: {
				// Read at call time, not captured: the manager reads settings
				// through closures, so a row the user just toggled is what the
				// next states() reports.
				states: () => this.plugin.mcpManager.getServerStates(),
				test: (server) => this.plugin.mcpManager.testServer(server),
				// A retry is the user asking "is it fixed yet?": resolve the keychain
				// bindings first, so an entry corrected since load reaches the servers
				// here and not only through the edit form. The read is the same
				// idempotent pass the load path runs — see settingsSecrets.ts.
				reconnect: () => {
					if (this.secretEnvironment) {
						resolveSecretRefs(this.plugin.settings, this.secretEnvironment.keychain());
					}
					return this.plugin.mcpManager.connect();
				},
			},
		};
	}
}
