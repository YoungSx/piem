import type { StreamFn } from "@earendil-works/pi-agent-core";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import type { Api, CacheRetention, Model, Models, Provider, ProviderStreams, StreamOptions } from "@earendil-works/pi-ai";
import { createFetchForTransport, toFetchFunction, type FetchFn, type NetworkTransport } from "./obsidianFetch";
import { CUSTOM_ENDPOINT_PROVIDER, DEFAULT_PROVIDER } from "../constants";
import { isCustomEndpointActive, type CustomEndpointConfig } from "../customEndpoint";
import { describeProviderConfig, type ProviderConfig, type WireProtocol } from "../modelConfig";

/**
 * Provider plumbing for the agent.
 *
 * Three concerns are resolved here:
 *
 * 1. Provider dispatch uses the `Models` collection API rather than the
 *    deprecated `pi-ai/compat` entrypoint, whose docs state it is deleted with
 *    the coding-agent ModelManager migration.
 * 2. Obsidian's renderer enforces CORS for `window.fetch`, which blocks most
 *    provider endpoints. `requestUrl` bypasses it but cannot stream, so the
 *    transport is selected per the user's setting and surfaced through
 *    {@link NetworkTransport} rather than decided silently.
 * 3. Prompt cache retention is a plugin decision, not pi's: pi defaults to the
 *    five-minute cache its CLI loop never outlives, and an Obsidian reader's
 *    turns are minutes apart. {@link requestDefaults} is the one place the
 *    user's preference is turned into a request field, so both the turn path and
 *    the compaction path carry the same one — see `./cacheRetention`.
 *
 * Auth note: for ordinary turns the agent resolves the API key from plugin
 * settings and pi's loop forwards it as `options.apiKey`. pi-ai short-circuits
 * credential resolution on an explicit request key, so no environment variables
 * or credential files are consulted and the default in-memory credential store
 * stays empty.
 */
export interface ObsidianModelsBundle {
	/** Providers registered and ready for dispatch. */
	models: Models;
	/** Transport-specific `fetch` that provider requests must go through. */
	fetch: FetchFn;
}

export interface ObsidianModelsOptions {
	transport: NetworkTransport;
	/** User-configured endpoints; each becomes a registered provider. */
	providers?: readonly ProviderConfig[];
	/** Legacy single-endpoint form, registered under the synthetic provider id. */
	customEndpoint?: CustomEndpointConfig | null;
}

/** Builds the `Models` collection with the builtin fallback registered, plus the user's configured endpoints. */
export function createObsidianModels(options: ObsidianModelsOptions): ObsidianModelsBundle {
	const models = createModels();
	// The fallback pair an unconfigured vault resolves to (see
	// {@link ../net/builtinCatalog}) names {@link DEFAULT_PROVIDER}, so something
	// has to answer for that id or `streamSimple` throws "Unknown provider"
	// before the panel can say the real problem, which is that no endpoint is
	// configured. It goes through the same factory as a configured row rather
	// than pi-ai's own `deepseekProvider`: that factory would drag DeepSeek's
	// model catalog into the bundle, and the two differ in nothing that matters
	// here — both dispatch on `model.api` and resolve auth from the request key.
	models.setProvider(createConfiguredProvider(DEFAULT_PROVIDER, "DeepSeek"));
	// Configured endpoints are in no catalog, so their providers have to be
	// registered here — `streamSimple` throws "Unknown provider" otherwise.
	for (const provider of options.providers ?? []) {
		models.setProvider(createConfiguredProvider(provider.id, describeProviderConfig(provider)));
	}
	// A legacy endpoint that predates migration keeps working under the
	// synthetic id, unless a configured provider already claims it.
	const claimed = new Set((options.providers ?? []).map((provider) => provider.id));
	if (isCustomEndpointActive(options.customEndpoint) && !claimed.has(CUSTOM_ENDPOINT_PROVIDER)) {
		models.setProvider(createConfiguredProvider(CUSTOM_ENDPOINT_PROVIDER, "Custom endpoint"));
	}
	return { models, fetch: createFetchForTransport(options.transport) };
}

/**
 * Stream implementations for every protocol the plugin speaks.
 *
 * Handed to `createProvider` as a map so pi-ai dispatches on `model.api`
 * itself — a provider whose protocol changes needs no re-registration, and a
 * model naming an unimplemented protocol surfaces as a stream error rather
 * than a silent wrong-format request. Each api sets its own auth headers
 * through its official SDK, so nothing protocol-specific is needed here.
 */
function createProtocolApis(): Record<WireProtocol, ProviderStreams> {
	return {
		"openai-completions": openAICompletionsApi(),
		"openai-responses": openAIResponsesApi(),
		"anthropic-messages": anthropicMessagesApi(),
	};
}

/**
 * Provider backing one user-configured endpoint.
 *
 * Auth resolves only from the credential pi hands it — the plugin always
 * passes an explicit key per request (`withRequestDefaults` for compaction,
 * the agent's `getApiKey` for turns), which pi-ai forwards as a synthetic
 * api_key credential. Resolving to nothing without one keeps ambient env
 * vars out of the picture and lets a missing key surface as the plugin's own
 * settings error rather than a silent env fallback.
 */
function createConfiguredProvider(id: string, name: string): Provider<WireProtocol> {
	return createProvider<WireProtocol>({
		id,
		name,
		auth: {
			apiKey: {
				name: `${name} API key`,
				resolve: async ({ credential }) => {
					const apiKey = credential?.type === "api_key" ? credential.key?.trim() : undefined;
					if (!apiKey) {
						return undefined;
					}
					return { auth: { apiKey }, source: "plugin settings" };
				},
			},
		},
		models: [],
		api: createProtocolApis(),
	});
}

/**
 * The stream options every provider request carries, whatever path reaches one.
 *
 * There are two such paths — the agent's turn (`resolveStreamFn` in
 * `ObsidianAgentService`) and compaction's `completeSimple` (through
 * {@link withRequestDefaults}) — and pi's own loop supplies neither of these
 * fields, so each path has to add them itself. Naming the pair here is what
 * keeps them from diverging: an earlier revision had the transport spelled out
 * at both call sites, and adding retention to one of them is exactly how a
 * setting ends up applying to replies but not to the summaries that replace
 * them.
 *
 * Typed as a `Pick` of pi's own options rather than a local interface, so a field
 * renamed upstream fails to compile here instead of being spread into a request
 * that quietly ignores it.
 */
export function requestDefaults(fetchImpl: FetchFn, cacheRetention: CacheRetention): Pick<StreamOptions, "fetch" | "cacheRetention"> {
	// toFetchFunction: the one named FetchFn→pi-ai conversion at this seam.
	return { fetch: toFetchFunction(fetchImpl), cacheRetention };
}

/**
 * Wraps a bundle so every request carries the Obsidian transport, API key, and
 * cache retention.
 *
 * Compaction calls `models.completeSimple` internally and accepts none of the
 * three, so the only way to reach it is to bake them into the `Models` instance
 * itself. Both the key and the retention are read per call rather than captured,
 * so a settings change takes effect without rebuilding anything — and a reader
 * who turns retention down does not keep paying for hour-long cache writes on
 * summaries until the plugin reloads.
 */
export function withRequestDefaults(
	bundle: ObsidianModelsBundle,
	getApiKey: (provider: string) => string | undefined,
	getCacheRetention: () => CacheRetention,
): Models {
	const { models, fetch: fetchImpl } = bundle;
	const applyDefaults = (model: Model<Api>) => ({ apiKey: getApiKey(model.provider), ...requestDefaults(fetchImpl, getCacheRetention()) });
	return {
		...models,
		streamSimple: (model, context, streamOptions) => models.streamSimple(model, context, { ...streamOptions, ...applyDefaults(model) }),
		completeSimple: (model, context, streamOptions) => models.completeSimple(model, context, { ...streamOptions, ...applyDefaults(model) }),
	};
}

/**
 * What a standalone stream function needs beyond provider registration.
 *
 * Separate from {@link ObsidianModelsOptions} because the two answer different
 * questions: that one says which providers exist, this one says how a request
 * goes out. Retention is required rather than defaulted, so
 * `DEFAULT_CACHE_RETENTION` stays applied in exactly one place — the settings
 * normalizer — and a caller that builds a stream function outside the settings
 * path has to say what it wants rather than inherit a choice made for someone
 * else.
 */
export interface ObsidianStreamFnOptions extends ObsidianModelsOptions {
	/** How long providers are asked to keep the prompt cache alive. */
	cacheRetention: CacheRetention;
}

/**
 * Builds a stream function against a fixed provider registration.
 *
 * Frozen at construction, which is why the agent does not use it:
 * `ObsidianAgentService.resolveStreamFn` resolves the bundle per request so a
 * newly configured endpoint is reachable without rebuilding the agent. This
 * form remains for callers that own a settled configuration.
 */
export function createObsidianStreamFn(options: ObsidianStreamFnOptions): StreamFn {
	const { models, fetch: fetchImpl } = createObsidianModels(options);
	return (model, context, streamOptions) =>
		models.streamSimple(model, context, {
			...streamOptions,
			...requestDefaults(fetchImpl, options.cacheRetention),
		});
}
