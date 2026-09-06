import { describe, expect, it } from "bun:test";
import { installObsidianStub } from "../testUtils/obsidianStub";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER } from "../constants";
import { getBuiltinModels, getBuiltinProviders } from "./builtinCatalog";

installObsidianStub();
// Dynamic import so the mocked `obsidian` module wins over any cached real one.
const { createObsidianModels } = await import("./streamFn");

/**
 * The seam between "what this build knows a model about" and "what can dispatch
 * a request for it".
 *
 * These used to police two hand-written lists of nine providers against each
 * other. Both lists are gone — the factories went with pi-ai's catalog data,
 * which is welded to them (see {@link ./builtinCatalog}'s header) — so what is
 * left is one literal on one side and one registration on the other. The
 * invariant is unchanged and still the one that matters: a model this build
 * resolves must have a provider registered under the id it names, or the request
 * fails at send time with "Unknown provider", which reads as a broken model
 * rather than as an unconfigured plugin.
 */
describe("builtin fallback", () => {
	it("keeps the default model resolvable, since an unconfigured plugin falls back to it", () => {
		// `getSelectedModel` throws at load time without this, taking the whole
		// plugin down rather than degrading.
		const models = getBuiltinModels(DEFAULT_PROVIDER);

		expect(models.some((model) => model.id === DEFAULT_MODEL_ID)).toBe(true);
	});

	it("gives every advertised provider at least one model", () => {
		for (const provider of getBuiltinProviders()) {
			expect(getBuiltinModels(provider).length).toBeGreaterThan(0);
		}
	});

	it("has the fallback model name the provider it is filed under", () => {
		// The lookup is by key, but dispatch reads `model.provider`. A mismatch
		// would resolve here and then fail to send.
		const model = getBuiltinModels(DEFAULT_PROVIDER).find((entry) => entry.id === DEFAULT_MODEL_ID);

		expect(model?.provider).toBe(DEFAULT_PROVIDER);
	});

	it("registers a provider for the id the fallback names", () => {
		// The other half of the old two-list invariant: with no pi-ai factory left,
		// `createObsidianModels` is what has to answer for DEFAULT_PROVIDER.
		const { models } = createObsidianModels({ transport: "requestUrl" });

		expect(models.getProvider(DEFAULT_PROVIDER)).toBeDefined();
	});

	it("lets a configured row claim the fallback id rather than being shadowed by it", () => {
		// A user may well name a provider "deepseek". Theirs has to win: it carries
		// a base URL and a credential, and the fallback carries neither.
		const { models } = createObsidianModels({
			transport: "requestUrl",
			providers: [
				{
					id: DEFAULT_PROVIDER,
					name: "My DeepSeek",
					baseUrl: "https://gw.internal/v1",
					protocol: "openai-completions",
					apiKey: "sk-mine",
					secretRef: "",
					source: "user",
					oauthFlow: "",
				},
			],
		});

		expect(models.getProvider(DEFAULT_PROVIDER)?.name).toBe("My DeepSeek");
	});

	it("returns nothing for a provider it does not carry, rather than throwing", () => {
		// A vault configured against a provider this build dropped must degrade to
		// the fallback, not crash on the way to the panel.
		expect(getBuiltinModels("amazon-bedrock")).toEqual([]);
		expect(getBuiltinModels("openrouter")).toEqual([]);
		expect(getBuiltinModels("")).toEqual([]);
	});

	it("carries the fields the plugin reads off a model", () => {
		const model = getBuiltinModels(DEFAULT_PROVIDER).find((entry) => entry.id === DEFAULT_MODEL_ID);

		expect(model?.contextWindow).toBeGreaterThan(0);
		expect(model?.maxTokens).toBeGreaterThan(0);
		expect(typeof model?.api).toBe("string");
		expect(model?.name).not.toBe("");
	});
});
