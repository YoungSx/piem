import { describe, expect, it } from "bun:test";
import {
	buildConfiguredModel,
	describeModelConfig,
	describeProviderConfig,
	DEFAULT_WIRE_PROTOCOL,
	emptyModelConfig,
	emptyProviderConfig,
	isWireProtocol,
	migrateCustomEndpoint,
	modelsForProvider,
	normalizeModelConfig,
	normalizeProviderAndModelLists,
	normalizeProviderConfig,
	WIRE_PROTOCOLS,
	type ModelConfig,
	type ProviderConfig,
} from "./modelConfig";
import { DEFAULT_CUSTOM_ENDPOINT_CONTEXT_WINDOW, DEFAULT_CUSTOM_ENDPOINT_MAX_TOKENS } from "./customEndpoint";

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
	return {
		id: "prov-1",
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com/v1",
		protocol: "openai-completions",
		apiKey: "sk-1",
		secretRef: "",
		source: "user",
		oauthFlow: "",
		...overrides,
	};
}

function model(overrides: Partial<ModelConfig> = {}): ModelConfig {
	return {
		id: "model-1",
		providerId: "prov-1",
		modelApiId: "deepseek-v4-pro",
		displayName: "DeepSeek V4 Pro",
		reasoning: true,
		supportsImages: false,
		...overrides,
	};
}

describe("isWireProtocol", () => {
	it("accepts every protocol the plugin implements", () => {
		for (const protocol of WIRE_PROTOCOLS) {
			expect(isWireProtocol(protocol)).toBe(true);
		}
	});

	it("rejects protocols this build cannot speak", () => {
		expect(isWireProtocol("google-generative-ai")).toBe(false);
		expect(isWireProtocol("")).toBe(false);
		expect(isWireProtocol(undefined)).toBe(false);
		expect(isWireProtocol(42)).toBe(false);
	});
});

describe("emptyProviderConfig / emptyModelConfig", () => {
	it("mints a distinct id each time so two new rows never collide", () => {
		expect(emptyProviderConfig().id).not.toBe(emptyProviderConfig().id);
		expect(emptyModelConfig("prov-1").id).not.toBe(emptyModelConfig("prov-1").id);
	});

	it("defaults a new provider to the most widely implemented protocol", () => {
		expect(emptyProviderConfig().protocol).toBe(DEFAULT_WIRE_PROTOCOL);
		expect(emptyProviderConfig().source).toBe("user");
	});

	it("binds a new model to the provider it was created under", () => {
		expect(emptyModelConfig("prov-7").providerId).toBe("prov-7");
	});
});

describe("normalizeProviderConfig", () => {
	it("drops non-objects", () => {
		expect(normalizeProviderConfig(undefined)).toBeUndefined();
		expect(normalizeProviderConfig(null)).toBeUndefined();
		expect(normalizeProviderConfig("https://x")).toBeUndefined();
	});

	it("drops an entry without an id, which nothing could reference", () => {
		expect(normalizeProviderConfig({ baseUrl: "https://x/v1" })).toBeUndefined();
		expect(normalizeProviderConfig({ id: "  ", baseUrl: "https://x/v1" })).toBeUndefined();
	});

	it("drops an entry without a base URL, which nothing could reach", () => {
		expect(normalizeProviderConfig({ id: "p1" })).toBeUndefined();
		expect(normalizeProviderConfig({ id: "p1", baseUrl: "   " })).toBeUndefined();
	});

	it("trims stored strings", () => {
		expect(normalizeProviderConfig({ id: " p1 ", name: " DeepSeek ", baseUrl: " https://x/v1 ", apiKey: " sk-1 " })).toEqual({
			id: "p1",
			name: "DeepSeek",
			baseUrl: "https://x/v1",
			protocol: DEFAULT_WIRE_PROTOCOL,
			apiKey: "sk-1",
			secretRef: "",
			source: "user",
			oauthFlow: "",
		});
	});

	it("keeps every implemented protocol as stored", () => {
		for (const protocol of WIRE_PROTOCOLS) {
			expect(normalizeProviderConfig({ id: "p1", baseUrl: "https://x", protocol })?.protocol).toBe(protocol);
		}
	});

	it("falls back to the default protocol rather than discarding an endpoint written by a newer build", () => {
		const normalized = normalizeProviderConfig({ id: "p1", baseUrl: "https://x", protocol: "future-protocol" });
		expect(normalized?.protocol).toBe(DEFAULT_WIRE_PROTOCOL);
		expect(normalized?.baseUrl).toBe("https://x");
	});

	it("preserves partner and subscription sources while defaulting anything unknown to user", () => {
		expect(normalizeProviderConfig({ id: "p1", baseUrl: "https://x", source: "partner" })?.source).toBe("partner");
		expect(normalizeProviderConfig({ id: "p1", baseUrl: "https://x", source: "subscription" })?.source).toBe("subscription");
		expect(normalizeProviderConfig({ id: "p1", baseUrl: "https://x", source: "nonsense" })?.source).toBe("user");
	});

	it("reads a row with no sign-in as an API-key row", () => {
		expect(normalizeProviderConfig({ id: "p1", baseUrl: "https://x" })?.oauthFlow).toBe("");
		expect(normalizeProviderConfig({ id: "p1", baseUrl: "https://x", oauthFlow: 7 })?.oauthFlow).toBe("");
	});

	it("keeps a sign-in id this build cannot serve rather than erasing it", () => {
		// The same rule as a dangling `secretRef`: a vault written by a newer build
		// degrades to a row that will not run here, not to a row whose sign-in was
		// silently thrown away on the next save.
		expect(normalizeProviderConfig({ id: "p1", baseUrl: "https://x", oauthFlow: "anthropic" })?.oauthFlow).toBe("anthropic");
	});
});

describe("normalizeModelConfig", () => {
	it("requires the three fields without which a model cannot be sent", () => {
		expect(normalizeModelConfig({ providerId: "p1", modelApiId: "m" })).toBeUndefined();
		expect(normalizeModelConfig({ id: "m1", modelApiId: "m" })).toBeUndefined();
		expect(normalizeModelConfig({ id: "m1", providerId: "p1" })).toBeUndefined();
	});

	it("keeps a blank display name, which callers fall back from", () => {
		expect(normalizeModelConfig({ id: "m1", providerId: "p1", modelApiId: "gpt-4o" })).toEqual({
			id: "m1",
			providerId: "p1",
			modelApiId: "gpt-4o",
			displayName: "",
			reasoning: false,
			supportsImages: false,
		});
	});

	it("treats reasoning as opt-in so a strict server is never sent thinking fields by default", () => {
		expect(normalizeModelConfig({ id: "m1", providerId: "p1", modelApiId: "m", reasoning: "yes" })?.reasoning).toBe(false);
		expect(normalizeModelConfig({ id: "m1", providerId: "p1", modelApiId: "m", reasoning: true })?.reasoning).toBe(true);
	});

	it("treats image input as opt-in, so rows written before the field existed keep sending text-only", () => {
		expect(normalizeModelConfig({ id: "m1", providerId: "p1", modelApiId: "m" })?.supportsImages).toBe(false);
		expect(normalizeModelConfig({ id: "m1", providerId: "p1", modelApiId: "m", supportsImages: true })?.supportsImages).toBe(true);
		expect(normalizeModelConfig({ id: "m1", providerId: "p1", modelApiId: "m", supportsImages: "yes" })?.supportsImages).toBe(false);
	});

	it("keeps a max-tokens override and drops malformed values like the other numeric fields", () => {
		expect(normalizeModelConfig({ id: "m1", providerId: "p1", modelApiId: "m", maxTokens: 4096 })?.maxTokens).toBe(4096);
		expect(normalizeModelConfig({ id: "m1", providerId: "p1", modelApiId: "m", maxTokens: "4096" })?.maxTokens).toBe(4096);
		expect(normalizeModelConfig({ id: "m1", providerId: "p1", modelApiId: "m", maxTokens: 0 })?.maxTokens).toBeUndefined();
		expect(normalizeModelConfig({ id: "m1", providerId: "p1", modelApiId: "m", maxTokens: -1 })?.maxTokens).toBeUndefined();
	});

	it("accepts numeric-string context windows and drops unusable ones", () => {
		expect(normalizeModelConfig({ id: "m1", providerId: "p1", modelApiId: "m", contextWindow: "65536" })?.contextWindow).toBe(65536);
		expect(normalizeModelConfig({ id: "m1", providerId: "p1", modelApiId: "m", contextWindow: 0 })?.contextWindow).toBeUndefined();
		expect(normalizeModelConfig({ id: "m1", providerId: "p1", modelApiId: "m", contextWindow: -1 })?.contextWindow).toBeUndefined();
		expect(normalizeModelConfig({ id: "m1", providerId: "p1", modelApiId: "m", contextWindow: 1.5 })?.contextWindow).toBeUndefined();
	});
});

describe("normalizeProviderAndModelLists", () => {
	it("returns empty lists for absent or non-array data", () => {
		expect(normalizeProviderAndModelLists(undefined, undefined)).toEqual({ providers: [], models: [] });
		expect(normalizeProviderAndModelLists("nope", 42)).toEqual({ providers: [], models: [] });
	});

	it("drops models whose provider is gone, which would otherwise have no URL or key", () => {
		const result = normalizeProviderAndModelLists([provider({ id: "p1" })], [model({ providerId: "p1" }), model({ id: "m2", providerId: "deleted" })]);
		expect(result.models.map((entry) => entry.id)).toEqual(["model-1"]);
	});

	it("keeps several models pointing at one provider — the whole point of the split", () => {
		const result = normalizeProviderAndModelLists(
			[provider({ id: "p1" })],
			[model({ id: "m1", providerId: "p1" }), model({ id: "m2", providerId: "p1", modelApiId: "deepseek-lite" })],
		);
		expect(result.models).toHaveLength(2);
		expect(new Set(result.models.map((entry) => entry.providerId))).toEqual(new Set(["p1"]));
	});

	it("discards unusable rows without taking valid siblings with them", () => {
		const result = normalizeProviderAndModelLists(
			[provider({ id: "prov-1" }), { id: "", baseUrl: "https://x" }],
			[model({ providerId: "prov-1" }), { id: "bad" }],
		);
		expect(result.providers).toHaveLength(1);
		expect(result.models).toHaveLength(1);
	});
});

describe("describeModelConfig / describeProviderConfig", () => {
	it("prefers the display name and falls back to the raw identifier", () => {
		expect(describeModelConfig(model({ displayName: "DeepSeek V4 Pro" }))).toBe("DeepSeek V4 Pro");
		expect(describeModelConfig(model({ displayName: "", modelApiId: "qwen-token-plan-individual" }))).toBe("qwen-token-plan-individual");
	});

	it("falls back to the base URL when a provider has no name", () => {
		expect(describeProviderConfig(provider({ name: "" }))).toBe("https://api.deepseek.com/v1");
	});
});

describe("modelsForProvider", () => {
	it("selects only the models bound to one provider", () => {
		const models = [model({ id: "m1", providerId: "p1" }), model({ id: "m2", providerId: "p2" }), model({ id: "m3", providerId: "p1" })];
		expect(modelsForProvider(models, "p1").map((entry) => entry.id)).toEqual(["m1", "m3"]);
		expect(modelsForProvider(models, "absent")).toEqual([]);
	});
});

describe("buildConfiguredModel", () => {
	it("routes on the provider's protocol, which is all pi-ai dispatches on", () => {
		expect(buildConfiguredModel(model(), provider({ protocol: "openai-completions" })).api).toBe("openai-completions");
		expect(buildConfiguredModel(model(), provider({ protocol: "openai-responses" })).api).toBe("openai-responses");
		expect(buildConfiguredModel(model(), provider({ protocol: "anthropic-messages" })).api).toBe("anthropic-messages");
	});

	it("sends the raw model id while showing the display name", () => {
		const built = buildConfiguredModel(model({ modelApiId: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" }), provider());
		expect(built.id).toBe("deepseek-v4-pro");
		expect(built.name).toBe("DeepSeek V4 Pro");
	});

	it("takes its endpoint and identity from the provider so a base URL change needs no model edit", () => {
		const built = buildConfiguredModel(model(), provider({ id: "prov-9", baseUrl: "https://gw.internal/v1" }));
		expect(built.provider).toBe("prov-9");
		expect(built.baseUrl).toBe("https://gw.internal/v1");
	});

	it("pins the legacy wire format for Chat Completions, which old gateways require", () => {
		const built = buildConfiguredModel(model(), provider({ protocol: "openai-completions" }));
		expect(built.compat).toEqual({ supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" });
	});

	it("leaves the other protocols to pi-ai's own detection", () => {
		expect(buildConfiguredModel(model(), provider({ protocol: "openai-responses" })).compat).toBeUndefined();
		expect(buildConfiguredModel(model(), provider({ protocol: "anthropic-messages" })).compat).toBeUndefined();
	});

	it("honors the model's reasoning flag rather than forcing it off", () => {
		expect(buildConfiguredModel(model({ reasoning: true }), provider()).reasoning).toBe(true);
		expect(buildConfiguredModel(model({ reasoning: false }), provider()).reasoning).toBe(false);
	});

	it("reports zero cost, since BYOK pricing is unknowable and a guess would render as fact", () => {
		expect(buildConfiguredModel(model(), provider()).cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("honors a context-window override and otherwise uses the standard default", () => {
		expect(buildConfiguredModel(model({ contextWindow: 4096 }), provider()).contextWindow).toBe(4096);
		expect(buildConfiguredModel(model(), provider()).contextWindow).toBe(DEFAULT_CUSTOM_ENDPOINT_CONTEXT_WINDOW);
		expect(buildConfiguredModel(model(), provider()).maxTokens).toBe(DEFAULT_CUSTOM_ENDPOINT_MAX_TOKENS);
	});

	it("honors a max-tokens override, since the shipped default is a guess about the server", () => {
		expect(buildConfiguredModel(model({ maxTokens: 32768 }), provider()).maxTokens).toBe(32768);
	});

	it("advertises image input only when the model declares it, which is what gates image send", () => {
		expect(buildConfiguredModel(model({ supportsImages: false }), provider()).input).toEqual(["text"]);
		expect(buildConfiguredModel(model({ supportsImages: true }), provider()).input).toEqual(["text", "image"]);
	});
});

describe("migrateCustomEndpoint", () => {
	it("reuses the legacy provider id so an already-stored API key still resolves", () => {
		const { provider: migrated } = migrateCustomEndpoint({ baseUrl: "https://x/v1", apiKey: "sk-1", modelId: "m" }, "custom");
		expect(migrated.id).toBe("custom");
		expect(migrated.apiKey).toBe("sk-1");
	});

	it("assumes Chat Completions, which is what the old form always sent", () => {
		const { provider: migrated } = migrateCustomEndpoint({ baseUrl: "https://x/v1", apiKey: "", modelId: "m" }, "custom");
		expect(migrated.protocol).toBe("openai-completions");
	});

	it("carries the endpoint's model id and context window across", () => {
		const { model: migrated } = migrateCustomEndpoint(
			{ baseUrl: "https://x/v1", apiKey: "", modelId: "qwen3-32b", contextWindow: 65536 },
			"custom",
		);
		expect(migrated.modelApiId).toBe("qwen3-32b");
		expect(migrated.displayName).toBe("qwen3-32b");
		expect(migrated.contextWindow).toBe(65536);
		expect(migrated.providerId).toBe("custom");
	});

	it("leaves the context window unset when the legacy config had none", () => {
		const { model: migrated } = migrateCustomEndpoint({ baseUrl: "https://x/v1", apiKey: "", modelId: "m" }, "custom");
		expect(migrated.contextWindow).toBeUndefined();
	});

	it("keeps thinking off, matching what the legacy endpoint advertised", () => {
		const { model: migrated } = migrateCustomEndpoint({ baseUrl: "https://x/v1", apiKey: "", modelId: "m" }, "custom");
		expect(migrated.reasoning).toBe(false);
	});
});
