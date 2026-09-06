import type { OAuthFlowId } from "../auth/oauthFlows";
import type { ProviderConfig, WireProtocol } from "../modelConfig";

/**
 * Ready-made connection settings for the endpoints users configure most.
 *
 * The provider form asks for three things a user has to look up — base URL,
 * wire protocol, and which of a vendor's several hosts to talk to — before it
 * asks for the one thing only they have, the key. This table answers the first
 * three so that configuring OpenRouter is picking its name and pasting a key.
 *
 * It replaces a capability the settings rework dropped rather than restoring
 * the old mechanism. The panel used to offer pi-ai's builtin providers, which
 * meant carrying their provider factories, and a factory drags its whole model
 * catalog in with it — `providers/<id>.js` names `X_MODELS` inside
 * `createProvider`, so esbuild cannot shake the data loose from the code. The
 * old picker therefore cost ~183 KiB of bundle. This table costs about a
 * kilobyte, because a preset is not a provider: it is a filled-in form. What it
 * produces is an ordinary `source: "user"` {@link ProviderConfig}, indistinguishable
 * from a hand-typed one, dispatched through the same `createConfiguredProvider`
 * path every configured endpoint already uses.
 *
 * Nothing here is persisted. A preset's `id` exists only as the dropdown's
 * option value; stored settings hold the resulting URL and protocol, so
 * retiring or renaming an entry can never orphan a configured row.
 *
 * Data provenance: every `baseUrl`/`protocol` pair is the one models.dev
 * publishes, read out of pi-ai's snapshot under `dist/providers/data/*.json`,
 * and kept verbatim — including where upstream points at a plan-specific root.
 * Z.ai and Zhipu publish their coding-plan paths (`/api/coding/paas/v4`), and
 * Qwen publishes token-plan hosts. Those are the roots a subscriber's key is
 * issued against, and substituting a general path would offer a URL that plan is
 * not served on. Guessing in either direction is wrong for somebody, so the
 * table does not guess: a key scoped elsewhere fails the connection test
 * immediately, with the URL one field above it, already editable.
 *
 * The single exception is a protocol this build cannot speak. Google and Mistral
 * publish `google-generative-ai` and `mistral-conversations`, so both point at
 * the vendor's own OpenAI-compatible path instead — which is how Gemini has
 * always actually been reachable here; see {@link ./builtinCatalog}'s header.
 *
 * Paths are exact, because {@link ../net/shims/apiHttp}'s `buildRequestUrl` is a
 * concatenation: an `openai-completions` base must already end at the version
 * segment (the shim appends `/chat/completions`), while an `anthropic-messages`
 * base must not (it appends `/v1/messages`). Every URL below was verified to
 * answer 401/400 rather than 404 at its protocol's real path — see
 * `providerPresets.test.ts` for the invariants that keep the shapes honest.
 */

/** One filled-in provider form, offered by name in the add/edit modal. */
export interface ProviderPreset {
	/**
	 * Dropdown option value. Stable so a reopened form re-selects the same row,
	 * and stored nowhere, so it is free to change.
	 */
	id: string;
	/**
	 * Brand name written into {@link ProviderConfig.name}. Not translated —
	 * these are proper nouns, and a vendor's mainland-China service is named
	 * whatever that service is called there.
	 */
	name: string;
	/** Root of the API, exact to the segment the protocol's shim appends onto. */
	baseUrl: string;
	protocol: WireProtocol;
	/**
	 * The subscription sign-in this endpoint is reached through, if any.
	 *
	 * A fourth thing a preset owns, and the one that makes two entries able to
	 * share a URL: xAI serves the same host and protocol to an API key and to a
	 * Grok subscription, and only the auth method tells those rows apart. Absent
	 * means the endpoint takes a key the user pastes.
	 */
	oauthFlow?: OAuthFlowId;
}

/**
 * The presets, in dropdown order: the endpoints reachable from anywhere first,
 * then the mainland-China services. Within each group, no ranking is implied —
 * the order is the one the vendor list has always been written in.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
	// Subscription sign-ins first: they need no key at all, so a user who has one
	// should not have to read past sixteen key-taking rows to find it.
	{
		id: "xai-subscription",
		name: "xAI (SuperGrok / X Premium)",
		baseUrl: "https://api.x.ai/v1",
		protocol: "openai-responses",
		oauthFlow: "xai",
	},
	{
		id: "kimi-coding",
		name: "Kimi For Coding",
		baseUrl: "https://api.kimi.com/coding",
		protocol: "anthropic-messages",
		oauthFlow: "kimi-coding",
	},
	{
		id: "anthropic-subscription",
		name: "Anthropic (Claude Pro/Max)",
		baseUrl: "https://api.anthropic.com",
		protocol: "anthropic-messages",
		oauthFlow: "anthropic",
	},
	{
		id: "openrouter-subscription",
		name: "OpenRouter (subscription)",
		baseUrl: "https://openrouter.ai/api/v1",
		protocol: "openai-completions",
		oauthFlow: "openrouter",
	},
	{ id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com", protocol: "anthropic-messages" },
	{ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", protocol: "openai-responses" },
	{
		id: "google",
		name: "Google Gemini",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
		protocol: "openai-completions",
	},
	{ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", protocol: "openai-completions" },
	{ id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", protocol: "openai-completions" },
	{ id: "mistral", name: "Mistral AI", baseUrl: "https://api.mistral.ai/v1", protocol: "openai-completions" },
	{ id: "moonshotai", name: "Moonshot AI", baseUrl: "https://api.moonshot.ai/v1", protocol: "openai-completions" },
	{ id: "xai", name: "xAI", baseUrl: "https://api.x.ai/v1", protocol: "openai-responses" },
	{ id: "zai", name: "Z.ai", baseUrl: "https://api.z.ai/api/coding/paas/v4", protocol: "openai-completions" },
	{ id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", protocol: "openai-completions" },
	{ id: "minimax", name: "MiniMax", baseUrl: "https://api.minimax.io/anthropic", protocol: "anthropic-messages" },
	{
		id: "qwen",
		name: "Qwen",
		baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
		protocol: "openai-completions",
	},
	{
		id: "moonshotai-cn",
		name: "Moonshot AI 国内站",
		baseUrl: "https://api.moonshot.cn/v1",
		protocol: "openai-completions",
	},
	{
		id: "zai-cn",
		name: "智谱 GLM",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		protocol: "openai-completions",
	},
	{
		id: "qwen-cn",
		name: "通义千问",
		baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
		protocol: "openai-completions",
	},
	{ id: "minimax-cn", name: "MiniMax 国内站", baseUrl: "https://api.minimaxi.com/anthropic", protocol: "anthropic-messages" },
];

/** Option value standing for "none of these" — the hand-typed endpoint. */
export const CUSTOM_PRESET_ID = "";

/**
 * Dropdown label for one preset: its name, then the host it reaches.
 *
 * The host is shown rather than hidden because it is the part a user needs
 * *before* choosing. Several vendors run more than one service — a mainland
 * site and an international one — and the name alone cannot say which of them a
 * key was issued for. Appending it also keeps the label honest without a
 * translated "(China)" suffix on every such row.
 */
export function providerPresetLabel(preset: ProviderPreset): string {
	return `${preset.name} · ${presetHost(preset.baseUrl)}`;
}

/** Host of a preset URL, for labelling. Presets are literals, so this cannot throw. */
function presetHost(baseUrl: string): string {
	return new URL(baseUrl).host;
}

/**
 * Compares two base URLs the way a server would.
 *
 * Host case is insignificant per RFC 3986 and a pasted URL commonly carries a
 * capital; path case is significant and deliberately preserved, so a draft
 * pointing at `/V1` is *not* reported as the OpenAI preset — it is a different
 * path, and one that endpoint rejects. A single trailing slash is dropped
 * because `buildRequestUrl` already treats the two forms as one request.
 */
function canonicalBaseUrl(baseUrl: string): string | undefined {
	const trimmed = baseUrl.trim();
	if (!trimmed) {
		return undefined;
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return undefined;
	}
	const path = parsed.pathname.endsWith("/") ? parsed.pathname.slice(0, -1) : parsed.pathname;
	return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
}

/** The three fields that decide which preset a row is. */
export type ProviderPresetKey = Pick<ProviderConfig, "baseUrl" | "protocol" | "oauthFlow">;

/**
 * The preset a draft currently matches, or undefined for a hand-typed endpoint.
 *
 * All three fields have to agree, and each for its own reason. An OpenRouter URL
 * switched to Anthropic Messages is no longer the OpenRouter preset, and
 * reporting it as one would let the dropdown claim a configuration the form is
 * not holding. The sign-in joined them because it is the only thing separating
 * two rows that are otherwise identical: xAI serves the same host and protocol
 * to an API key and to a Grok subscription, so without it the dropdown would
 * pick whichever of the two comes first in the table and quietly relabel the
 * other.
 *
 * That is the whole job of this function — the dropdown opens on its answer, so
 * an edited row shows which preset it came from, and a hand-typed one shows
 * "Custom".
 */
export function matchProviderPreset(key: ProviderPresetKey): ProviderPreset | undefined {
	const canonical = canonicalBaseUrl(key.baseUrl);
	if (canonical === undefined) {
		return undefined;
	}
	return PROVIDER_PRESETS.find(
		(preset) =>
			preset.protocol === key.protocol &&
			(preset.oauthFlow ?? "") === key.oauthFlow &&
			canonicalBaseUrl(preset.baseUrl) === canonical,
	);
}

/**
 * A draft with one preset applied: name, URL and protocol are the preset's.
 *
 * All three unconditionally, because a preset does not merely pre-fill them — it
 * owns them. The form hides those rows while a preset is selected, since there is
 * nothing to decide: an edited OpenRouter URL is not OpenRouter, and a row named
 * something else that points at Anthropic is a label that lies. So there is no
 * "the user's own value" here to protect. Someone who does want to name or steer
 * the endpoint themselves picks Custom, which reveals the three rows still
 * holding whatever the preset left in them.
 *
 * The credential is deliberately untouched. It is almost certainly wrong for the
 * new endpoint, but clearing a just-pasted key on a stray dropdown change costs
 * more than the stale key does — the connection test says so immediately, and the
 * field is right there. A subscription preset makes that harmless rather than
 * merely cheap: the provider it produces advertises no api-key auth at all, so a
 * leftover key cannot be sent, and switching back reveals the field still holding
 * it.
 */
export function applyProviderPreset(draft: ProviderConfig, preset: ProviderPreset): ProviderConfig {
	return {
		...draft,
		name: preset.name,
		baseUrl: preset.baseUrl,
		protocol: preset.protocol,
		// Written unconditionally in both directions, including back to `""`.
		// Leaving a stale sign-in behind when someone switches from a subscription
		// preset to a key-taking one would produce a row that ignores the key they
		// are about to paste — the same class of lie as a stale base URL.
		oauthFlow: preset.oauthFlow ?? "",
	};
}

/** Looks a preset up by dropdown value; undefined for {@link CUSTOM_PRESET_ID}. */
export function findProviderPreset(id: string): ProviderPreset | undefined {
	return id === CUSTOM_PRESET_ID ? undefined : PROVIDER_PRESETS.find((preset) => preset.id === id);
}
