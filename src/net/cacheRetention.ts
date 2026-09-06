import type { CacheRetention } from "@earendil-works/pi-ai";

/**
 * How long providers are asked to keep the prompt cache alive.
 *
 * pi models this as a three-way preference and each adapter maps it onto
 * whatever its provider understands — Anthropic-style `cache_control.ttl: "1h"`,
 * OpenAI's `prompt_cache_retention: "24h"`, Bedrock's `CacheTTL.ONE_HOUR` — and
 * drops the long form on any model whose `supportsLongCacheRetention` says no.
 * So the stored value is a preference, never a promise: no caller has to gate it
 * on what the active model supports, and a provider without a prompt cache at
 * all just ignores it.
 *
 * pi's own type is used rather than a parallel union declared here. The domain
 * of this setting *is* pi's domain — every value is handed straight to
 * `StreamOptions.cacheRetention` — and restating it locally would let the two
 * drift the first time pi adds a fourth level.
 */

/**
 * What a vault that has never stored the field gets.
 *
 * `"long"` where pi itself defaults to `"short"`, and the departure is
 * deliberate: pi's default is tuned for a CLI agent loop, where turns land
 * seconds apart and a five-minute cache never expires mid-conversation.
 * Obsidian's rhythm is the opposite one — ask a question, go write for ten
 * minutes, come back and follow up. A five-minute TTL expires in that gap
 * almost every time, so the whole resident prompt (system prompt, tool schemas,
 * skills, the active note) is billed as a fresh cache write on every single
 * turn instead of being read back at a tenth of the price.
 *
 * The arithmetic, for a resident prompt of P tokens and turns more than five
 * minutes apart. Anthropic's published ratios against base input are 1.25x for
 * a five-minute cache write, 2x for a one-hour write, and 0.1x for a read — the
 * first and third are in pi's model catalog, the second is applied by
 * `calculateCost` when a turn reports `cacheWrite1h`:
 *
 * | turns | `"short"` | `"long"` |
 * | ----- | --------- | -------- |
 * | 1     | 1.25 P    | 2.00 P   |
 * | 2     | 2.50 P    | 2.10 P   |
 * | 3     | 3.75 P    | 2.20 P   |
 *
 * Break-even is the second turn. What settles the default is not the crossover
 * but the asymmetry around it: picking `"long"` for a reader who only ever asks
 * one question costs them 0.75 P once and never again, while picking `"short"`
 * for a reader who comes back costs 1.15 P *per* turn, with no ceiling. The one
 * case `"short"` wins is also the case where the absolute sum is smallest — so
 * the setting exists for the reader who knows they are that case, and the
 * default answers for everyone who has not thought about it.
 */
export const DEFAULT_CACHE_RETENTION: CacheRetention = "long";

/**
 * Whether `value` is a retention preference pi accepts.
 *
 * Rejecting rather than coercing, for the same reason `isNetworkTransport` in
 * `controlKeys` does: this guard also backs the dropdown's write, and a control
 * that silently rewrote the value someone picked would be worse than one that
 * ignored the change.
 */
export function isCacheRetentionSetting(value: unknown): value is CacheRetention {
	return value === "none" || value === "short" || value === "long";
}

/**
 * Repairs a stored value into a retention preference.
 *
 * A corrupted or unknown value degrades to the default rather than throwing,
 * matching how every other enum-typed setting is read back — and absent is the
 * common case, since every vault written before this setting existed has no
 * field at all.
 */
export function readCacheRetention(value: unknown): CacheRetention {
	return isCacheRetentionSetting(value) ? value : DEFAULT_CACHE_RETENTION;
}
