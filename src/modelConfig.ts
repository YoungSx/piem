import { uuidv7 } from "@earendil-works/pi-ai";
import type { Translator } from "./i18n";
import type { Model } from "@earendil-works/pi-ai";
import { isValidSecretId } from "./keychain";

/**
 * Fallback context window for a configured model that does not state one.
 *
 * 128k is the de-facto standard for current OpenAI-compatible APIs. Guessing
 * too high risks compaction firing late; too low wastes paid context. The
 * model form's field exists precisely so users can correct the guess.
 */
export const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;

/**
 * Output cap advertised for a configured model without its own. Compaction
 * clamps its summary length against this, so a modest value keeps a
 * half-configured model from being asked for unbounded generations.
 */
export const DEFAULT_MODEL_MAX_TOKENS = 8_192;

/**
 * Provider and model configuration for user-supplied endpoints.
 *
 * The split between {@link ProviderConfig} and {@link ModelConfig} is the point
 * of this module: a provider owns *how to reach a server* (base URL, wire
 * protocol, credential) while a model owns *what to ask for* (the id the server
 * expects, plus how it should be presented and budgeted). Keeping them apart is
 * what allows several models to share one credential, and it is the shape
 * fallback/forward chains need later — those only reorder model references, so
 * they will not require another schema change.
 */

/**
 * Wire protocols the plugin can speak.
 *
 * All three implementations already ship inside the bundle: pi-ai's provider
 * factories pull in `@anthropic-ai/sdk` and `openai`, and esbuild inlines the
 * lazy api entrypoints. Supporting the extra two therefore costs no bundle size
 * and no request-path code — only the `Model.api` value changes.
 */
export type WireProtocol = "openai-completions" | "openai-responses" | "anthropic-messages";

export const WIRE_PROTOCOLS: readonly WireProtocol[] = ["openai-completions", "openai-responses", "anthropic-messages"];

/**
 * Default for new and migrated providers. OpenAI Chat Completions is the format
 * gateways and self-hosted servers implement most widely, so it is the safest
 * assumption when the user has not said otherwise.
 */
export const DEFAULT_WIRE_PROTOCOL: WireProtocol = "openai-completions";

/** Copy keys for the protocol labels, keyed by the value stored on a provider. */
const WIRE_PROTOCOL_COPY_KEYS = {
	"openai-completions": "wireProtocol.openaiChat",
	"openai-responses": "wireProtocol.openaiResponses",
	"anthropic-messages": "wireProtocol.anthropicMessages",
} as const;

/** Human-readable protocol label for the settings UI. */
export function wireProtocolLabel(protocol: WireProtocol, t: Translator): string {
	return t.t(WIRE_PROTOCOL_COPY_KEYS[protocol]);
}

/**
 * A reachable endpoint plus its credential — connection concerns only.
 *
 * Deliberately holds no model list: the same provider may serve many models,
 * and binding them here is exactly the coupling this rework removes.
 */
export interface ProviderConfig {
	/** Stable identity. Survives renames so model references never dangle. */
	id: string;
	/** Display name, e.g. "DeepSeek". */
	name: string;
	/** Root of the API, e.g. `https://api.example.com/v1`. */
	baseUrl: string;
	protocol: WireProtocol;
	/**
	 * Plaintext in memory. On disk this field is always `""` when
	 * {@link secretRef} is set: the credential lives in the keychain, and
	 * `data.json` holds only the reference. Non-empty on disk only on devices
	 * without keychain support, where this field is the storage.
	 */
	apiKey: string;
	/**
	 * Id of the keychain entry this provider is bound to, or `""` for inline
	 * keys. Exactly one of the two carries the credential: a set `secretRef`
	 * with a non-empty `apiKey` on disk is the manual field's copy that a
	 * load overwrites, never a second source of truth to merge.
	 */
	secretRef: string;
	/**
	 * Where this provider came from. Only `user` exists today; the field is
	 * present so partner and subscription entries can be distinguished later
	 * without migrating stored data again. Non-user rows are not user-editable.
	 *
	 * Deliberately *not* how a subscription sign-in is recorded — see
	 * {@link oauthFlow}. This field answers "who provisioned this row", and a row
	 * the user added by picking a preset and signing in is still theirs to edit
	 * and delete.
	 */
	source: ProviderSource;
	/**
	 * Which subscription sign-in authenticates this endpoint, or `""` for a key.
	 *
	 * The auth method is a second axis from the endpoint: xAI serves the same URL
	 * and protocol to an API key and to a Grok subscription, so the row has to say
	 * which of the two it holds. When set, the credential lives in the keychain
	 * under this plugin's own entry (`src/auth/credentialStore.ts`) and
	 * {@link apiKey}/{@link secretRef} are unused.
	 *
	 * Typed as a string rather than the flow-id union on purpose. A value this
	 * build does not recognise is kept as written and validated where it is used,
	 * for the same reason a dangling `secretRef` is kept: a vault written by a
	 * newer build should degrade to "this row cannot be served here", not lose the
	 * sign-in on the next save.
	 */
	oauthFlow: string;
}

export type ProviderSource = "user" | "partner" | "subscription";

/**
 * One model the user can select, bound to the provider that serves it.
 *
 * `modelApiId` and `displayName` are separate because they answer to different
 * audiences: the former must match what the server accepts verbatim, the latter
 * exists so a panel never has to show `qwen-token-plan-individual`.
 */
export interface ModelConfig {
	/** Stable identity, referenced by `activeModelId`. Renaming is safe. */
	id: string;
	/** The {@link ProviderConfig} that serves this model. */
	providerId: string;
	/** Model identifier sent to the server, exactly as it expects it. */
	modelApiId: string;
	/** Name shown in the UI. Falls back to `modelApiId` when blank. */
	displayName: string;
	/** Tokens of context, used for compaction planning. */
	contextWindow?: number;
	/** Whether to advertise thinking support for this model. */
	reasoning: boolean;
	/**
	 * Whether this model accepts image content alongside text. Gates image send
	 * (see {@link settings.modelSupportsImages}); off until declared, because a
	 * multimodal claim against a text-only server fails at send time.
	 */
	supportsImages: boolean;
	/**
	 * Cap on the tokens a single reply may produce. Falls back to
	 * {@link DEFAULT_MODEL_MAX_TOKENS} when unset.
	 */
	maxTokens?: number;
}

function readTrimmedString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function readPositiveInteger(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) {
		return value;
	}
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number.parseInt(value, 10);
		if (Number.isInteger(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return undefined;
}

/** Whether a persisted value names a protocol this build can speak. */
export function isWireProtocol(value: unknown): value is WireProtocol {
	return typeof value === "string" && (WIRE_PROTOCOLS as readonly string[]).includes(value);
}

function readProviderSource(value: unknown): ProviderSource {
	return value === "partner" || value === "subscription" ? value : "user";
}

/** A blank provider for the "add provider" form to fill in. */
export function emptyProviderConfig(): ProviderConfig {
	return { id: uuidv7(), name: "", baseUrl: "", protocol: DEFAULT_WIRE_PROTOCOL, apiKey: "", secretRef: "", source: "user", oauthFlow: "" };
}

/** A blank model bound to `providerId`. */
export function emptyModelConfig(providerId: string): ModelConfig {
	return {
		id: uuidv7(),
		providerId,
		modelApiId: "",
		displayName: "",
		reasoning: false,
		supportsImages: false,
	};
}

/**
 * Coerces persisted provider data into a config, or `undefined` when it cannot
 * be repaired.
 *
 * An entry without an `id` is unreferenceable and an entry without a `baseUrl`
 * is unreachable, so both are dropped rather than kept as a row the user cannot
 * make work. An unrecognized protocol falls back to the default instead of
 * discarding the endpoint — a vault written by a newer build should degrade,
 * not lose data.
 */
export function normalizeProviderConfig(data: unknown): ProviderConfig | undefined {
	if (!data || typeof data !== "object") {
		return undefined;
	}
	const raw = data as Record<string, unknown>;
	const id = readTrimmedString(raw.id);
	const baseUrl = readTrimmedString(raw.baseUrl);
	if (!id || !baseUrl) {
		return undefined;
	}
	const secretRef = readTrimmedString(raw.secretRef);
	return {
		id,
		name: readTrimmedString(raw.name),
		baseUrl,
		protocol: isWireProtocol(raw.protocol) ? raw.protocol : DEFAULT_WIRE_PROTOCOL,
		apiKey: readTrimmedString(raw.apiKey),
		// A reference that cannot name a keychain entry is junk from a hand-edit,
		// and keeping it would mask the real state (nothing bound). A well-formed
		// one that names nothing stays — that is a dangling reference, which the
		// panel reports, and dropping it would silently lose the binding.
		secretRef: isValidSecretId(secretRef) ? secretRef : "",
		source: readProviderSource(raw.source),
		// Unvalidated on purpose: see {@link ProviderConfig.oauthFlow}. An id this
		// build cannot serve is still the user's sign-in, and blanking it here would
		// erase it the next time the vault is saved.
		oauthFlow: readTrimmedString(raw.oauthFlow),
	};
}

/**
 * Coerces persisted model data into a config, or `undefined` when unusable.
 *
 * Requires `id`, `providerId`, and `modelApiId`: without any one of them the
 * entry cannot be selected, routed, or sent.
 */
export function normalizeModelConfig(data: unknown): ModelConfig | undefined {
	if (!data || typeof data !== "object") {
		return undefined;
	}
	const raw = data as Record<string, unknown>;
	const id = readTrimmedString(raw.id);
	const providerId = readTrimmedString(raw.providerId);
	const modelApiId = readTrimmedString(raw.modelApiId);
	if (!id || !providerId || !modelApiId) {
		return undefined;
	}
	const config: ModelConfig = {
		id,
		providerId,
		modelApiId,
		displayName: readTrimmedString(raw.displayName),
		reasoning: raw.reasoning === true,
		// Conservative default: rows written before this field existed must keep
		// sending text-only, exactly as they did.
		supportsImages: raw.supportsImages === true,
	};
	const contextWindow = readPositiveInteger(raw.contextWindow);
	if (contextWindow !== undefined) {
		config.contextWindow = contextWindow;
	}
	const maxTokens = readPositiveInteger(raw.maxTokens);
	if (maxTokens !== undefined) {
		config.maxTokens = maxTokens;
	}
	return config;
}

/**
 * Drops providers and models that cannot be used, and models orphaned by a
 * missing provider.
 *
 * Orphan removal matters because a model whose provider is gone has no base URL
 * and no credential; leaving it selectable would produce a request that fails
 * with an error pointing at the wrong setting.
 */
export function normalizeProviderAndModelLists(
	rawProviders: unknown,
	rawModels: unknown,
): { providers: ProviderConfig[]; models: ModelConfig[] } {
	const providers = (Array.isArray(rawProviders) ? rawProviders : [])
		.map(normalizeProviderConfig)
		.filter((provider): provider is ProviderConfig => provider !== undefined);
	const providerIds = new Set(providers.map((provider) => provider.id));
	const models = (Array.isArray(rawModels) ? rawModels : [])
		.map(normalizeModelConfig)
		.filter((model): model is ModelConfig => model !== undefined)
		.filter((model) => providerIds.has(model.providerId));
	return { providers, models };
}

/** Name to show for a model: its display name, or the raw id as a fallback. */
export function describeModelConfig(model: ModelConfig): string {
	return model.displayName || model.modelApiId;
}

/** Name to show for a provider: its display name, or its base URL. */
export function describeProviderConfig(provider: ProviderConfig): string {
	return provider.name || provider.baseUrl;
}

/** Models served by one provider, for list rendering and delete guards. */
export function modelsForProvider(models: readonly ModelConfig[], providerId: string): ModelConfig[] {
	return models.filter((model) => model.providerId === providerId);
}

/**
 * Conservative compat overrides for arbitrary OpenAI Chat Completions servers.
 *
 * pi-ai auto-detects these from the base URL, which assumes modern OpenAI
 * behavior for hosts it does not recognize. Old gateways reject exactly those
 * assumptions, so the legacy wire format is pinned instead: `system` role
 * rather than `developer`, `max_tokens` rather than `max_completion_tokens`,
 * and no `store` field.
 *
 * The other two protocols get no overrides: their compat fields are all
 * optional and pi-ai's defaults are the correct baseline for a server that
 * genuinely implements the format.
 */
const OPENAI_COMPLETIONS_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	maxTokensField: "max_tokens",
} as const;

/**
 * Builds the pi-ai `Model` for a configured model/provider pair.
 *
 * Field choices are least-common-denominator for servers of unknown capability:
 *
 * - `api` is the provider's protocol, which is the only thing pi-ai dispatches
 *   on — `createProvider`'s api map routes each request by `model.api`.
 * - `cost` is zero because BYOK pricing is unknowable, and a made-up rate would
 *   render as a fabricated number in the usage readout.
 * - `contextWindow` honors the user's override since compaction schedules
 *   against it.
 *
 * Auth is absent by design: each protocol's official SDK sets its own headers
 * (`x-api-key` plus `anthropic-version` for Anthropic, `Authorization` for
 * OpenAI), so the plugin only has to supply the key as `options.apiKey`.
 */
export function buildConfiguredModel(model: ModelConfig, provider: ProviderConfig): Model<WireProtocol> {
	// Image input is a capability the user declares (or the builtin catalog
	// recommends), so the send path can gate attachments on it. Annotated so the
	// array literals keep their literal element type — bare they widen to
	// `string[]` and the protocol branches below stop typechecking.
	const modelInput: ("text" | "image")[] = model.supportsImages ? ["text", "image"] : ["text"];
	const base = {
		id: model.modelApiId,
		name: describeModelConfig(model),
		provider: provider.id,
		baseUrl: provider.baseUrl,
		reasoning: model.reasoning,
		input: modelInput,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
		maxTokens: model.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS,
	};
	// `compat` is a conditional type keyed on the api, so each protocol is
	// constructed in its own branch rather than through a shared object literal
	// that would not typecheck against the narrowed shape.
	switch (provider.protocol) {
		case "openai-completions":
			return { ...base, api: "openai-completions", compat: OPENAI_COMPLETIONS_COMPAT };
		case "openai-responses":
			return { ...base, api: "openai-responses" };
		case "anthropic-messages":
			return { ...base, api: "anthropic-messages" };
	}
}
