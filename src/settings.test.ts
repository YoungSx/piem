import { describe, expect, it } from "bun:test";
import { DEFAULT_PROVIDER } from "./constants";
import { installObsidianStub } from "./testUtils/obsidianStub";
import type { PiemSettings } from "./settings";
import type { ModelConfig, ProviderConfig, WireProtocol } from "./modelConfig";

import { getT } from "./i18n";

const t = getT("en");
const zh = getT("zh-cn");

// `settings.ts` imports the `obsidian` module at runtime; the shared stub must
// be registered before the dynamic import below resolves it.
installObsidianStub();

const {
	describeModelTarget,
	listModelChoices,
	getActiveConfiguration,
	getApiKeyForProvider,
	getConfiguredApiKey,
	getSelectedModel,
	normalizeSettings,
	DEFAULT_SETTINGS,
} = await import("./settings");

/** Two models behind one named provider, as the switcher tests read them. */
function configured(): PiemSettings {
	return normalizeSettings({
		providers: [{ id: "p1", name: "My gateway", baseUrl: "https://gw/v1", protocol: "openai-completions", apiKey: "", secretRef: "", source: "user", oauthFlow: "" }],
		models: [
			{ id: "m1", providerId: "p1", modelApiId: "qwen-token-plan-individual", displayName: "Qwen Plus", reasoning: false, supportsImages: false },
			{ id: "m2", providerId: "p1", modelApiId: "raw-id", displayName: "", reasoning: false, supportsImages: false },
		],
		activeModelId: "m1",
	});
}

function builtinSettings(overrides: Partial<PiemSettings> = {}): PiemSettings {
	return { ...DEFAULT_SETTINGS, ...overrides };
}

describe("normalizeSettings drops the retired legacy layer", () => {
	it("does not resurrect a customEndpoint or providerApiKeys block from an old data.json", () => {
		// The plugin never shipped, so there is nothing to migrate: unknown keys in
		// stored data are simply not constructed, and the next save drops them.
		const settings = normalizeSettings({
			provider: "deepseek",
			modelId: "deepseek-v4-pro",
			providerApiKeys: { deepseek: "builtin-key" },
			customEndpoint: { baseUrl: "https://api.example.com/v1", apiKey: "sk-1", modelId: "gpt-4o-mini" },
		} as never);
		expect(settings).not.toHaveProperty("customEndpoint");
		expect(settings).not.toHaveProperty("providerApiKeys");
	});
});

describe("normalizeSettings narrowing the network transport", () => {
	it("defaults to the buffered transport when data.json says nothing", () => {
		// The default is the one that works from every origin without asking an
		// endpoint's permission, at the cost of streaming. Changing it is a product
		// decision, so it is pinned here rather than left to be read off a literal.
		expect(normalizeSettings({}).networkTransport).toBe("requestUrl");
		expect(DEFAULT_SETTINGS.networkTransport).toBe("requestUrl");
	});

	it("keeps an explicit fetch selection", () => {
		expect(normalizeSettings({ networkTransport: "fetch" }).networkTransport).toBe("fetch");
	});

	it("falls back to the buffered transport for anything the network layer cannot serve", () => {
		// The narrowing is a two-branch ternary, so every unrecognised value — a
		// hand-edited data.json, or a transport some future build adds that this
		// one does not implement — lands on the implementation that always exists
		// instead of reaching createFetchForTransport as an unknown string.
		expect(normalizeSettings({ networkTransport: "xhr" as never }).networkTransport).toBe("requestUrl");
		expect(normalizeSettings({ networkTransport: null as never }).networkTransport).toBe("requestUrl");
		expect(normalizeSettings({ networkTransport: "" as never }).networkTransport).toBe("requestUrl");
	});

	it("round-trips, so loading and saving does not drift the selection", () => {
		expect(normalizeSettings(normalizeSettings({ networkTransport: "fetch" })).networkTransport).toBe("fetch");
	});
});

describe("normalizeSettings with cacheRetention", () => {
	it("gives a vault written before the setting existed the hour-long cache, not pi's five minutes", () => {
		// The one setting where this plugin overrides a pi default on purpose: pi's
		// "short" is tuned for turns seconds apart, and an Obsidian reader's are
		// minutes apart, so a five-minute cache expires between every pair of them.
		// Pinned here because it is a billing decision, not an implementation detail.
		expect(normalizeSettings({}).cacheRetention).toBe("long");
		expect(DEFAULT_SETTINGS.cacheRetention).toBe("long");
	});

	it("keeps an explicit preference", () => {
		expect(normalizeSettings({ cacheRetention: "short" }).cacheRetention).toBe("short");
		expect(normalizeSettings({ cacheRetention: "none" }).cacheRetention).toBe("none");
		expect(normalizeSettings({ cacheRetention: "long" }).cacheRetention).toBe("long");
	});

	it("repairs a value no provider would understand", () => {
		// It is spread straight into a provider request, so an unrecognised string
		// would travel to a paid endpoint as-is.
		expect(normalizeSettings({ cacheRetention: "1h" as never }).cacheRetention).toBe("long");
		expect(normalizeSettings({ cacheRetention: null as never }).cacheRetention).toBe("long");
		expect(normalizeSettings({ cacheRetention: "" as never }).cacheRetention).toBe("long");
	});

	it("round-trips, so loading and saving does not drift a reader's choice", () => {
		expect(normalizeSettings(normalizeSettings({ cacheRetention: "none" })).cacheRetention).toBe("none");
	});
});

describe("getSelectedModel priority", () => {
	it("uses the builtin catalog when no configured model is active", () => {
		const model = getSelectedModel(builtinSettings());
		expect(model.provider).toBe(DEFAULT_PROVIDER);
		expect(model.id).toBe("deepseek-v4-pro");
	});
});

describe("getConfiguredApiKey", () => {
	it("reads the active provider's own key", () => {
		const settings = normalizeSettings({
			providers: [{ id: "p1", name: "GW", baseUrl: "https://gw/v1", protocol: "openai-completions", apiKey: "configured-key", secretRef: "", source: "user", oauthFlow: "" }],
			models: [{ id: "m1", providerId: "p1", modelApiId: "m", displayName: "", reasoning: false, supportsImages: false }],
			activeModelId: "m1",
		});
		expect(getConfiguredApiKey(settings)).toBe("configured-key");
	});

	it("returns undefined without an active configuration — no cross-lookup, ever", () => {
		// A leftover key for a builtin catalog id is never silently reused against
		// a different server: there is nothing to resolve it against.
		expect(getConfiguredApiKey(builtinSettings({ providerApiKeys: { deepseek: "k" } } as never))).toBeUndefined();
		expect(getConfiguredApiKey(builtinSettings())).toBeUndefined();
	});
});

describe("describeModelTarget", () => {
	it("names provider and model for builtin configurations", () => {
		expect(describeModelTarget(builtinSettings(), t)).toBe("Deepseek/deepseek-v4-pro");
	});
});

/**
 * What the chat panel's model switcher renders from.
 *
 * The join lives here rather than in the component so the panel and the Models
 * tab cannot disagree about what a model is called — and so the orphan rule is
 * covered by a test, since an orphan is the one entry whose selection would
 * silently send requests somewhere else.
 */
describe("listModelChoices", () => {
	it("names each model and its endpoint the way the settings tab does", () => {
		const choices = listModelChoices(configured());

		expect(choices).toEqual([
			{ id: "m1", name: "Qwen Plus", provider: "My gateway" },
			{ id: "m2", name: "raw-id", provider: "My gateway" },
		]);
	});

	it("keeps stored order, so the menu matches the list the user arranged", () => {
		expect(listModelChoices(configured()).map((choice) => choice.id)).toEqual(["m1", "m2"]);
	});

	it("falls back to the base URL for an unnamed provider, never to a bare uuid", () => {
		const settings = configured();
		settings.providers[0]!.name = "";

		expect(listModelChoices(settings)[0]?.provider).toBe("https://gw/v1");
	});

	it("omits a model whose provider is gone rather than offering a dead choice", () => {
		// It has no base URL and no credential, so selecting it would hand the next
		// request to the builtin catalog — a different endpoint than the user
		// believes they picked.
		const settings = configured();
		settings.providers = [];

		expect(listModelChoices(settings)).toEqual([]);
	});

	it("returns nothing when no model is configured, which the switcher reads as a state", () => {
		expect(listModelChoices(builtinSettings())).toEqual([]);
	});
});

describe("normalizeSettings ignores a legacy endpoint once a provider row exists", () => {
	it("serves the configured row, not a synthetic id from an old vault", () => {
		const settings = normalizeSettings({
			providers: [{ id: "p1", name: "GW", baseUrl: "https://gw/v1", protocol: "openai-completions", apiKey: "sk-1", secretRef: "", source: "user", oauthFlow: "" }],
			models: [{ id: "m1", providerId: "p1", modelApiId: "m", displayName: "", reasoning: false, supportsImages: false }],
			activeModelId: "m1",
			customEndpoint: { baseUrl: "https://old/v1", apiKey: "sk-old", modelId: "old-model" },
		} as never);
		expect(settings.providers).toHaveLength(1);
		expect(settings.models).toHaveLength(1);
		expect(settings.activeModelId).toBe("m1");
	});
});

describe("normalizeSettings with configured providers", () => {
	const provider: ProviderConfig = {
		id: "p1",
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com/v1",
		protocol: "anthropic-messages",
		apiKey: "sk-1",
		secretRef: "",
		source: "user",
		oauthFlow: "",
	};
	const model: ModelConfig = { id: "m1", providerId: "p1", modelApiId: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", reasoning: true, supportsImages: false };

	it("keeps a valid provider/model pair and its selection", () => {
		const settings = normalizeSettings({ providers: [provider], models: [model], activeModelId: "m1" });
		expect(settings.providers).toHaveLength(1);
		expect(settings.activeModelId).toBe("m1");
	});

	it("clears a selection pointing at a model that no longer exists", () => {
		const settings = normalizeSettings({ providers: [provider], models: [model], activeModelId: "deleted" });
		expect(settings.activeModelId).toBeUndefined();
	});

	it("clears a selection orphaned by a deleted provider", () => {
		const settings = normalizeSettings({ providers: [], models: [model], activeModelId: "m1" });
		expect(settings.models).toEqual([]);
		expect(settings.activeModelId).toBeUndefined();
	});
});

describe("getSelectedModel for configured providers", () => {
	function configured(protocol: WireProtocol) {
		return normalizeSettings({
			providers: [{ id: "p1", name: "Gateway", baseUrl: "https://gw.internal/v1", protocol, apiKey: "sk-1", secretRef: "", source: "user", oauthFlow: "" }],
			models: [{ id: "m1", providerId: "p1", modelApiId: "some-model", displayName: "Some Model", reasoning: false, supportsImages: false }],
			activeModelId: "m1",
		});
	}

	it("dispatches on the provider's protocol", () => {
		expect(getSelectedModel(configured("openai-completions")).api).toBe("openai-completions");
		expect(getSelectedModel(configured("openai-responses")).api).toBe("openai-responses");
		expect(getSelectedModel(configured("anthropic-messages")).api).toBe("anthropic-messages");
	});

	it("outranks the builtin dropdowns, as the legacy endpoint did", () => {
		const settings = normalizeSettings({
			provider: "anthropic",
			modelId: "claude-something",
			providers: [{ id: "p1", name: "GW", baseUrl: "https://gw/v1", protocol: "openai-responses", apiKey: "", secretRef: "", source: "user", oauthFlow: "" }],
			models: [{ id: "m1", providerId: "p1", modelApiId: "m", displayName: "", reasoning: false, supportsImages: false }],
			activeModelId: "m1",
		});
		expect(getSelectedModel(settings).provider).toBe("p1");
	});

	it("falls back to the builtin catalog once the selection is cleared", () => {
		const settings = normalizeSettings({ providers: [], models: [], activeModelId: "gone" });
		expect(getSelectedModel(settings).provider).toBe(DEFAULT_PROVIDER);
	});
});

describe("getApiKeyForProvider", () => {
	const settings = () =>
		normalizeSettings({
			providers: [{ id: "p1", name: "GW", baseUrl: "https://gw/v1", protocol: "openai-completions", apiKey: "configured-key", secretRef: "", source: "user", oauthFlow: "" }],
			models: [{ id: "m1", providerId: "p1", modelApiId: "m", displayName: "", reasoning: false, supportsImages: false }],
			activeModelId: "m1",
		});

	it("resolves a configured provider by its own id", () => {
		expect(getApiKeyForProvider(settings(), "p1")).toBe("configured-key");
	});

	it("returns undefined for a provider that was never added, whatever else the settings hold", () => {
		// A builtin catalog id is not a credential source: nothing configured it.
		expect(getApiKeyForProvider(settings(), "deepseek")).toBeUndefined();
	});

	it("returns undefined for a provider with no key, so the error names the right setting", () => {
		expect(getApiKeyForProvider(settings(), "unknown")).toBeUndefined();
	});
});

describe("describeModelTarget for configured providers", () => {
	it("names the model and provider a user recognises, not internal ids", () => {
		const settings = normalizeSettings({
			providers: [{ id: "p1", name: "My gateway", baseUrl: "https://gw/v1", protocol: "openai-completions", apiKey: "", secretRef: "", source: "user", oauthFlow: "" }],
			models: [{ id: "m1", providerId: "p1", modelApiId: "qwen-token-plan-individual", displayName: "Qwen Plus", reasoning: false, supportsImages: false }],
			activeModelId: "m1",
		});
		expect(describeModelTarget(settings, t)).toBe("Qwen Plus (My gateway)");
	});

	it("falls back to the raw model id when no display name was given", () => {
		const settings = normalizeSettings({
			providers: [{ id: "p1", name: "", baseUrl: "https://gw/v1", protocol: "openai-completions", apiKey: "", secretRef: "", source: "user", oauthFlow: "" }],
			models: [{ id: "m1", providerId: "p1", modelApiId: "raw-id", displayName: "", reasoning: false, supportsImages: false }],
			activeModelId: "m1",
		});
		expect(describeModelTarget(settings, t)).toBe("raw-id (https://gw/v1)");
	});
});

describe("getActiveConfiguration", () => {
	it("returns nothing when no configured model is selected", () => {
		expect(getActiveConfiguration(builtinSettings())).toBeUndefined();
	});

	it("pairs the active model with the provider that serves it", () => {
		const settings = normalizeSettings({
			providers: [{ id: "p1", name: "GW", baseUrl: "https://gw/v1", protocol: "openai-completions", apiKey: "", secretRef: "", source: "user", oauthFlow: "" }],
			models: [{ id: "m1", providerId: "p1", modelApiId: "m", displayName: "", reasoning: false, supportsImages: false }],
			activeModelId: "m1",
		});
		const active = getActiveConfiguration(settings);
		expect(active?.model.id).toBe("m1");
		expect(active?.provider.id).toBe("p1");
	});
});

describe("normalizeSettings with the send shortcut", () => {
	it("gives a vault written before the setting existed a bare Enter", () => {
		// This adds a way to send rather than moving one: Ctrl/Cmd+Enter, the chord
		// those users already know, still sends under `enter` — see `isSendShortcut`.
		expect(normalizeSettings({}).sendShortcut).toBe("enter");
	});

	it("keeps an explicit choice", () => {
		expect(normalizeSettings({ sendShortcut: "modEnter" }).sendShortcut).toBe("modEnter");
		expect(normalizeSettings({ sendShortcut: "enter" }).sendShortcut).toBe("enter");
	});

	it("falls back rather than persisting a chord the build cannot honour", () => {
		// A stored value this build does not recognize would reach `isSendShortcut`
		// as an unknown chord, which sends on neither key.
		expect(normalizeSettings({ sendShortcut: "shiftEnter" as never }).sendShortcut).toBe("enter");
		expect(normalizeSettings({ sendShortcut: null as never }).sendShortcut).toBe("enter");
	});
});

describe("normalizeSettings with traceExpand", () => {
	it("gives a vault written before the setting existed the collapsed transcript", () => {
		// The issue made all-collapsed the default; legacy vaults were already
		// reading that transcript, so the choice changes nothing for them.
		expect(normalizeSettings({}).traceExpand).toBe("collapsed");
	});

	it("keeps an explicit mode", () => {
		expect(normalizeSettings({ traceExpand: "highValue" }).traceExpand).toBe("highValue");
		expect(normalizeSettings({ traceExpand: "expanded" }).traceExpand).toBe("expanded");
		expect(normalizeSettings({ traceExpand: "collapsed" }).traceExpand).toBe("collapsed");
	});

	it("falls back rather than persisting a mode the panel cannot honour", () => {
		expect(normalizeSettings({ traceExpand: "open" as never }).traceExpand).toBe("collapsed");
		expect(normalizeSettings({ traceExpand: null as never }).traceExpand).toBe("collapsed");
	});
});

describe("normalizeSettings with promptQueueStrategy", () => {
	it("gives a vault written before the setting existed the whole-answer timing", () => {
		// Which is what a mid-run send has always had: the queue only ever departed
		// when the run ended, so the default changes nothing for a legacy vault.
		expect(normalizeSettings({}).promptQueueStrategy).toBe("afterRun");
	});

	it("keeps an explicit timing", () => {
		expect(normalizeSettings({ promptQueueStrategy: "afterTurn" }).promptQueueStrategy).toBe("afterTurn");
		expect(normalizeSettings({ promptQueueStrategy: "afterRun" }).promptQueueStrategy).toBe("afterRun");
	});

	it("falls back rather than persisting a timing the service cannot honour", () => {
		expect(normalizeSettings({ promptQueueStrategy: "immediately" as never }).promptQueueStrategy).toBe("afterRun");
		expect(normalizeSettings({ promptQueueStrategy: null as never }).promptQueueStrategy).toBe("afterRun");
	});
});

describe("normalizeSettings with mcpServers", () => {
	it("gives a vault written before the setting existed an empty list", () => {
		expect(normalizeSettings({}).mcpServers).toEqual([]);
	});

	it("keeps a stored server whole: token passes untrimmed, order preserved", () => {
		const settings = normalizeSettings({
			mcpServers: [
				{ id: "srv-1", name: " GitHub ", url: " https://gh.example.com/mcp ", token: "enc:v1:AAAA", secretRef: "", enabled: false },
			],
		});
		expect(settings.mcpServers).toEqual([
			{ id: "srv-1", name: "GitHub", url: "https://gh.example.com/mcp", token: "enc:v1:AAAA", secretRef: "", enabled: false },
		]);
	});

	it("drops unusable rows so a junk entry cannot join the agent's tools", () => {
		// Cast rather than shaped: the junk here is exactly what the raw
		// persisted array can hold, and normalizeSettings is what must reject it.
		const settings = normalizeSettings({
			mcpServers: [
				{ id: "srv-2", name: "No url", url: "not-a-url", token: "", enabled: true },
				{ name: "No id", url: "https://x.example.com", token: "", enabled: true },
				"garbage",
			] as never,
		});
		expect(settings.mcpServers).toEqual([]);
	});
});

describe("normalizeSettings with mobileComposerCollapsed", () => {
	it("gives a vault written before the field existed an expanded composer, stored as absence", () => {
		// The field is persisted UI state, not a preference: "absent" is what
		// "expanded" is stored as, so a legacy data.json loads byte-identical and
		// a user who never folds never gains a key in their file.
		expect(normalizeSettings({}).mobileComposerCollapsed).toBeUndefined();
	});

	it("keeps an explicit fold", () => {
		expect(normalizeSettings({ mobileComposerCollapsed: true }).mobileComposerCollapsed).toBe(true);
	});

	it("collapses every other value back into absence rather than storing it", () => {
		// A hand-edited data.json or a stale writer can put anything here; only
		// `true` means folded, and `false` means the same thing as no key at all.
		expect(normalizeSettings({ mobileComposerCollapsed: false as never }).mobileComposerCollapsed).toBeUndefined();
		expect(normalizeSettings({ mobileComposerCollapsed: "yes" as never }).mobileComposerCollapsed).toBeUndefined();
		expect(normalizeSettings({ mobileComposerCollapsed: null as never }).mobileComposerCollapsed).toBeUndefined();
	});
});
