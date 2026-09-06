/**
 * Mapping a configured model onto the vendor whose mark it wears.
 *
 * Two independent signals, deliberately kept as two functions rather than one
 * clever resolver:
 *
 * - {@link matchVendorByHost} answers issue #161's "only official providers
 *   get an icon". The only trustworthy official-ness signal is the endpoint
 *   host — `ProviderConfig.name` is free text a user can fill with anything —
 *   and the hosts below are the ones pi-ai itself dispatches to by default,
 *   with two official alternate domains (Moonshot's .cn, Z.ai's bigmodel.cn)
 *   users in the wild actually configure. Matching is exact and full-host: a
 *   reseller pointing its baseUrl at something that merely *contains* an
 *   official name gets nothing, because in a plugin that sends API keys an
 *   icon is a trust mark, and trust marks must not leak to proxies.
 *
 * - {@link matchVendorByModelId} answers issue #161's "models pick up their
 *   vendor's icon automatically". models.dev carries no vendor field on a
 *   model, so the match runs on the model id itself, in two passes: a
 *   gateway-served id's first path segment is an org slug (`deepseek-ai/
 *   DeepSeek-R1`, `meta-llama/…`), and a direct id names its family
 *   (`claude-…`, `qwen2.5-…`). Both are prefix-shaped — anchored, never
 *   substring — so `my-gpt-server` matches nothing and a reseller's arbitrary
 *   model names stay iconless rather than wearing whoever the stem table
 *   happens to hit.
 *
 * Neither function consults the network, so the whole table is frozen at
 * release and testable as data. That is the point: vendor marks change
 * rarely, and a rule that only needs the strings a user already configured
 * needs no cache, no probe, and no failure mode beyond "no icon".
 */

/** The vendors this plugin ships marks for. Mirrors the icon registry. */
export type VendorId =
	| "anthropic"
	| "openai"
	| "google"
	| "deepseek"
	| "groq"
	| "mistral"
	| "moonshotai"
	| "xai"
	| "zai"
	| "openrouter"
	| "qwen"
	| "meta"
	| "minimax";

/**
 * Official API hosts: every endpoint pi-ai ships a default for, plus every host
 * {@link ./providerPresets} offers as a ready-made configuration.
 *
 * The two sources are one table because a mark answers one question — is this
 * the vendor's own server — and a user who picked a preset must see the same
 * answer as one who typed the URL themselves. `providerPresets.test.ts` asserts
 * every preset host resolves here, so adding a preset without its host is a
 * test failure rather than a silently unmarked row.
 *
 * Keys are compared against the parsed URL's host, lowercased, exact — never
 * `endsWith`, never `includes`, so `api.anthropic.com.evil.example` and an
 * anthropic-branded reseller both stay unmarked.
 */
const VENDOR_BY_HOST: Record<string, VendorId> = {
	"api.anthropic.com": "anthropic",
	"api.openai.com": "openai",
	"generativelanguage.googleapis.com": "google",
	"api.deepseek.com": "deepseek",
	"api.groq.com": "groq",
	"api.mistral.ai": "mistral",
	"api.moonshot.ai": "moonshotai",
	"api.moonshot.cn": "moonshotai",
	// Kimi is Moonshot's product brand, which the alias table below already says;
	// the coding-subscription endpoint lives on its own host.
	"api.kimi.com": "moonshotai",
	"api.x.ai": "xai",
	"api.z.ai": "zai",
	"open.bigmodel.cn": "zai",
	"openrouter.ai": "openrouter",
	// Reached only through the preset table: MiniMax and Qwen ship marks and
	// model-id rules, but pi-ai carries no provider factory for either, so their
	// hosts had no entry until a preset started handing them out.
	"api.minimax.io": "minimax",
	"api.minimaxi.com": "minimax",
	"token-plan.ap-southeast-1.maas.aliyuncs.com": "qwen",
	"token-plan.cn-beijing.maas.aliyuncs.com": "qwen",
};

/**
 * Gateway-style first segments, mapped to the vendor that owns the models
 * behind them. Only segments models.dev's own provider listing uses — an
 * unknown slug falls through to the stem pass below rather than guessing.
 * OpenRouter is deliberately absent: its slug names the *gateway*, not the
 * family behind it, and `openrouter/claude-3.5` should wear Claude's mark —
 * the gateway itself is covered by {@link VENDOR_BY_HOST} instead.
 */
const VENDOR_BY_SLUG: Record<string, VendorId> = {
	anthropic: "anthropic",
	openai: "openai",
	google: "google",
	deepseek: "deepseek",
	"deepseek-ai": "deepseek",
	groq: "groq",
	mistral: "mistral",
	mistralai: "mistral",
	moonshot: "moonshotai",
	moonshotai: "moonshotai",
	xai: "xai",
	"x-ai": "xai",
	zai: "zai",
	"z-ai": "zai",
	"zai-org": "zai",
	qwen: "qwen",
	"meta-llama": "meta",
	meta: "meta",
	minimax: "minimax",
};

/**
 * Model-family stems, each anchored at the start of the (slugless) id and
 * required to end at a delimiter, digit, or end of string — `gpt-4o` hits,
 * `mygpt` and `gptified` do not. One entry per family a vendor actually names:
 * Mistral gets its whole derived line because `mistral` alone covers barely a
 * quarter of its ids (`devstral`, `codestral`, `mixtral`…), and OpenAI gets the
 * bare o-series numbers because `o1`/`o3`/`o4` anchor nowhere else.
 */
const VENDOR_STEMS: ReadonlyArray<readonly [stem: string, vendor: VendorId]> = [
	["claude", "anthropic"],
	["gpt", "openai"],
	["chatgpt", "openai"],
	["o1", "openai"],
	["o3", "openai"],
	["o4", "openai"],
	["gemini", "google"],
	["gemma", "google"],
	["deepseek", "deepseek"],
	["mistral", "mistral"],
	["mixtral", "mistral"],
	["codestral", "mistral"],
	["devstral", "mistral"],
	["magistral", "mistral"],
	["ministral", "mistral"],
	["pixtral", "mistral"],
	["voxtral", "mistral"],
	["mathstral", "mistral"],
	["moonshot", "moonshotai"],
	["kimi", "moonshotai"],
	["grok", "xai"],
	["glm", "zai"],
	["chatglm", "zai"],
	["qwen", "qwen"],
	["qwq", "qwen"],
	["qvq", "qwen"],
	["llama", "meta"],
	["minimax", "minimax"],
	["abab", "minimax"],
];

/**
 * The vendor behind an official endpoint, or undefined when the base URL is
 * unset, unparsable, or not one of the hosts above.
 *
 * Hosts are compared lowercase against the URL's `host` — which already folds
 * the scheme, port, path, and trailing `/v1` — so any base URL a provider
 * ships resolves to the same answer.
 */
export function matchVendorByHost(baseUrl: string | undefined): VendorId | undefined {
	if (!baseUrl) {
		return undefined;
	}
	let host: string;
	try {
		host = new URL(baseUrl.trim()).host.toLowerCase();
	} catch {
		// A malformed base URL has no trustworthy host; the model-id pass still
		// gets a chance below, so this stays silent rather than throwing.
		return undefined;
	}
	return VENDOR_BY_HOST[host];
}

/**
 * The vendor behind a model id, or undefined when neither its slug segment nor
 * its stem names one. Ids are matched case-insensitively: users type
 * `Qwen2.5-Coder-32B`, gateways serve `DeepSeek-R1`.
 */
export function matchVendorByModelId(modelApiId: string | undefined): VendorId | undefined {
	const id = modelApiId?.trim().toLowerCase();
	if (!id) {
		return undefined;
	}
	const slash = id.indexOf("/");
	if (slash > 0) {
		const vendor = VENDOR_BY_SLUG[id.slice(0, slash)];
		if (vendor) {
			return vendor;
		}
	}
	// Past the slug pass, match on the first path segment when one existed —
	// the stem identifies the family the gateway serves — and on the whole id
	// otherwise.
	const candidate = slash > 0 ? id.slice(slash + 1) : id;
	for (const [stem, vendor] of VENDOR_STEMS) {
		if (candidate.startsWith(stem)) {
			const next = candidate.charAt(stem.length);
			if (next === "" || /[-_.\d]/.test(next)) {
				return vendor;
			}
		}
	}
	return undefined;
}

/**
 * The vendor mark to show for one model, family first.
 *
 * The mark prefixes a *model* name, so the model id's own claim wins: a
 * gateway route like `openrouter/claude-3.5` wears Claude's mark, because
 * "what answers this turn" is the question the surface is answering. The
 * official-host pass steps in only where the id is silent — an endpoint the
 * tables know serving an id they have never seen (`openrouter/auto`, a
 * freshly renamed model) still gets its mark, and nothing else does.
 * `undefined` means "no mark", the only answer the plugin owes a match it
 * cannot make.
 */
export function matchVendorForModel(modelApiId: string | undefined, providerBaseUrl: string | undefined): VendorId | undefined {
	return matchVendorByModelId(modelApiId) ?? matchVendorByHost(providerBaseUrl);
}
