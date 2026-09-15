import type { Model } from "@earendil-works/pi-ai";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER } from "../constants";
import type { WireProtocol } from "../modelConfig";

/**
 * The one model this build knows about without being told.
 *
 * This module used to carry a slice of pi-ai's builtin catalog — nine provider
 * factories beside nine model catalogs — so the panel could suggest model ids
 * and fall back to a working pair before anything was configured. Measurement
 * retired that shape. The catalog data and the factories are welded together
 * upstream: every `providers/<id>.js` imports its `X_MODELS` at module scope and
 * names it inside `createProvider`, so esbuild cannot shake the data loose from
 * the code. Importing nine factories therefore cost 283 KiB of bundle — 164 KiB
 * of it JSON, and 125 KiB of *that* OpenRouter's 351 entries alone — every byte
 * of which Obsidian parses on every launch, phones included. Dropping the
 * factories takes the same seam to 102 KiB.
 *
 * What is lost is narrower than the byte count suggests, because the shipped
 * catalog was already the third source consulted, behind two better ones:
 *
 * - Model id suggestions come first from {@link ../net/modelListingCache}, which
 *   asks the user's own endpoint what it serves. That answer is authoritative
 *   and current where a snapshot is neither, and it is the only one that knows
 *   anything at all about a private gateway.
 * - Capability hints come first from the live models.dev index
 *   ({@link ./modelsDev}), 7,561 models against the snapshot's 460.
 *
 * So the catalog only ever answered in one window: offline, on the first model
 * form of a cold start. It is also where the suggestions were least useful —
 * every id it knew belonged to a vendor whose own endpoint would have listed
 * more of them. And nothing became unreachable: the field accepts any id typed
 * into it, {@link ../net/providerPresets} fills the connection details in for
 * every vendor the catalog used to name, and each capability control stays
 * editable with a working default.
 *
 * What could not go is the fallback pair. {@link ../settings}'s `getSelectedModel`
 * resolves {@link DEFAULT_PROVIDER}/{@link DEFAULT_MODEL_ID} through this module
 * when nothing is configured, and throws if it cannot — which would take the
 * whole plugin down at load rather than degrade. So the entry below is that one
 * pair, written out as a literal.
 *
 * It is a copy of what models.dev published for it, taken from pi-ai's snapshot
 * on 2026-09-05 and deliberately not kept in sync: this is a placeholder that
 * has to resolve, not a claim about DeepSeek's current pricing. Note also that
 * it can never actually serve a request — the settings panel has no field for a
 * builtin provider's key, so an unconfigured vault reaching here has none. Its
 * job is to give the panel a name to render and compaction a context window to
 * plan against, so that "not configured yet" looks like a setting to finish
 * rather than a crash.
 */
const FALLBACK_MODEL: Model<WireProtocol> = {
	id: DEFAULT_MODEL_ID,
	name: "DeepSeek V4 Flash",
	api: "openai-completions",
	baseUrl: "https://api.deepseek.com",
	provider: DEFAULT_PROVIDER,
	reasoning: true,
	input: ["text"],
	cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 384_000,
	compat: {
		supportsStore: false,
		supportsDeveloperRole: false,
		maxTokensField: "max_tokens",
		requiresReasoningContentOnAssistantMessages: true,
		thinkingFormat: "deepseek",
	},
	thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" },
};

/**
 * Provider ids this build carries a model for — now exactly one.
 *
 * Kept as a list rather than collapsed to a constant because its callers iterate
 * it ({@link ../ui/settings/ModelModal}'s suggestions,
 * {@link ../ui/settings/catalogCapabilityHint}'s snapshot pass), and a list of
 * one keeps those loops correct without special-casing.
 */
export function getBuiltinProviders(): string[] {
	return [DEFAULT_PROVIDER];
}

/** Models this build knows about for one provider, or none for any other id. */
export function getBuiltinModels(provider: string): Model<string>[] {
	return provider === DEFAULT_PROVIDER ? [FALLBACK_MODEL] : [];
}
