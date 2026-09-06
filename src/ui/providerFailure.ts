/**
 * What a provider failure means, in the reader's language.
 *
 * Free of React and DOM imports for the same reason `replyCutoff.ts` is: the
 * rules and the wording are the part worth unit-testing, and the subagent
 * inspector reports the same class of failure from a different renderer.
 *
 * The panel used to show `error.message` verbatim. That string is written for
 * whoever is reading a provider's logs — `429 Rate limit reached for
 * gpt-4o in organization org-… on tokens per min` — and the reader here is
 * someone who does not write code and does not want to. So this maps the
 * recognisable families onto one sentence each, naming what happened and what
 * to do about it.
 *
 * **The raw text is never replaced, only led.** Every caller keeps the original
 * on screen behind a disclosure, which is what makes classifying by wording
 * safe at all: a family this guesses wrong costs a slightly-off headline above
 * the exact words the provider sent, never a swallowed error. That is the same
 * degradation `isUserAbortReport` chose — when the signal is soft, fail towards
 * showing more, not less.
 */

import type { Translator } from "../i18n";

/**
 * Which family a failure belongs to, chosen by what the reader should do next
 * rather than by protocol shape. Two families that need the same sentence would
 * be one family; `rateLimit` and `quota` are separate because waiting fixes one
 * and only paying fixes the other.
 */
export type ProviderFailureKind =
	| "auth"
	| "quota"
	| "contextLength"
	| "refused"
	| "rateLimit"
	| "timeout"
	| "offline"
	| "serverError"
	| "unknown";

/** A classified provider failure, ready to render. */
export interface ProviderFailure {
	kind: ProviderFailureKind;
	/** The headline, above the provider's own words. */
	line: string;
	/**
	 * The same fact for a screen reader, phrased to continue a sentence — it is
	 * read as the tail of the reply it interrupted, not as its own announcement.
	 * Mirrors `ReplyCutoff.spoken`.
	 */
	spoken: string;
	/**
	 * Whether sending the same turn again is a reasonable next move. False for
	 * the families where it would bill a second identical refusal; those
	 * sentences name the fix instead.
	 */
	retryable: boolean;
}

/**
 * One family's recognisers.
 *
 * `status` is checked first within a rule because a status written by code is
 * the one hard marker available here — everything else is wording, and wording
 * is provider-specific. {@link hardStatus} owns the shapes it arrives in.
 * `pattern` carries the cases a status cannot settle: OpenAI answers
 * `context_length_exceeded` with a 400, the same status a content refusal uses.
 */
interface FailureRule {
	kind: ProviderFailureKind;
	status?: readonly number[];
	pattern?: RegExp;
}

/**
 * Ordered, and the order is load-bearing: the first match wins, so a family
 * whose wording overlaps a broader one sits above it. Each of these placements
 * is a real message, not a hypothetical.
 *
 * - `quota` above `rateLimit`, because OpenAI reports an exhausted balance as
 *   `429 You exceeded your current quota` — the same status as a rate limit,
 *   and waiting does not fix it.
 * - `contextLength` above `rateLimit`, because a length refusal counts tokens
 *   and a rate limit counts tokens per minute.
 * - `refused` above `auth`, because some gateways answer a policy refusal with
 *   403, and "check the key" would be the wrong instruction.
 * - `rateLimit` above `auth`, because a 429 body may name the API key it is
 *   throttling, and `auth`'s recogniser is deliberately broad.
 */
const RULES: readonly FailureRule[] = [
	{
		kind: "quota",
		status: [402],
		pattern: /insufficient[_ ]quota|current quota|billing|credit balance|not enough (?:credit|balance)|out of credit/i,
	},
	{
		kind: "contextLength",
		status: [413],
		pattern: /context[_ -]?length|context window|maximum context|(?:prompt|input|request) is too long|reduce the length/i,
	},
	/*
	 * `\brefus` and not `refus`: the unanchored form matched `ECONNREFUSED`, so a
	 * provider Piem could not connect to was reported as a provider that had
	 * declined to answer. The boundary holds because the `R` inside that token is
	 * preceded by a word character.
	 */
	{ kind: "refused", status: [451], pattern: /content[_ ]filter|content[_ ]policy|safety|moderation|\brefus/i },
	{ kind: "rateLimit", status: [429, 529], pattern: /rate[_ ]?limit|too many requests|overloaded|slow down/i },
	{
		kind: "auth",
		status: [401, 403],
		pattern: /invalid[_ ]api[_ ]key|incorrect api key|api key|unauthorized|authenticat|invalid[_ ]token|forbidden/i,
	},
	{
		kind: "timeout",
		status: [408, 504, 524],
		pattern: /timed?[_ ]?out|timeout|etimedout|deadline exceeded|gateway time/i,
	},
	{
		kind: "offline",
		pattern: /enotfound|econnrefused|econnreset|eai_again|epipe|failed to fetch|net::|network|dns|offline|unreachable/i,
	},
	{ kind: "serverError", status: [500, 502, 503], pattern: /internal server error|bad gateway|service unavailable/i },
];

/** Families where sending the same words again is worth a try. */
const RETRYABLE: ReadonlySet<ProviderFailureKind> = new Set<ProviderFailureKind>([
	"rateLimit",
	"timeout",
	"offline",
	"serverError",
	"unknown",
]);

/**
 * The two shapes a status arrives in, each pinned to the code that writes it.
 *
 * `429 Rate limit reached for…` is ours (`apiHttp.ts`, `describeErrorBody`), and
 * reaches here unchanged from `api/anthropic-messages.js` and from
 * `api/openai-completions.js`. `OpenAI API error (429): 429 Rate limit
 * reached for…` is pi's: `formatProviderError` prefixes the provider's name
 * whenever an api passes one, which `api/openai-responses.js` does, and that
 * displaces our status from the front of the string.
 *
 * The prefixed form is confined to the segment before the first colon so a
 * `(404)` deeper in a provider's prose cannot pose as the marker.
 */
const HARD_STATUS_MARKERS: readonly RegExp[] = [/^\s*(\d{3})\b/, /^[^:]{0,64}\((\d{3})\)\s*:/];

/**
 * The HTTP status, when the string carries one as a hard marker rather than as
 * prose — `undefined` when it does not.
 *
 * Both recognisers are anchored at the start deliberately. A status found
 * anywhere in the string would read the `404` out of a URL in a provider's
 * prose, and a wrong hard marker is worse than no hard marker: it would outrank
 * the wording rules that would have classified the message correctly. Reading
 * two pinned shapes is what keeps that anchoring affordable — the alternative
 * that fits every protocol is a loose search, which is the one thing this must
 * not do.
 *
 * Recognising only the leading form cost the families that have no wording to
 * fall back on. A gateway answering `openai-responses` with a bare status
 * arrives as `OpenAI API error (413): 413 status code (no body)`, where every
 * `pattern` misses and the marker was unreachable — so a conversation too long
 * for the model was reported as "the provider did not answer, and did not say
 * why".
 */
function hardStatus(message: string): number | undefined {
	for (const marker of HARD_STATUS_MARKERS) {
		const found = marker.exec(message);
		const status = found ? Number(found[1]) : Number.NaN;
		if (status >= 400 && status <= 599) {
			return status;
		}
	}
	return undefined;
}

/** Which family `message` belongs to. `unknown` when nothing recognises it. */
export function classifyProviderFailure(message: string): ProviderFailureKind {
	const status = hardStatus(message);
	for (const rule of RULES) {
		if (status !== undefined && rule.status?.includes(status)) {
			return rule.kind;
		}
		if (rule.pattern?.test(message)) {
			return rule.kind;
		}
	}
	return "unknown";
}

/**
 * Classifies `message` and resolves its copy.
 *
 * An empty or whitespace-only message still returns a `ProviderFailure` —
 * `unknown` — because a provider that failed without saying anything is exactly
 * the case the reader most needs a sentence for.
 */
export function describeProviderFailure(message: string, t: Translator): ProviderFailure {
	const kind = classifyProviderFailure(message);
	return {
		kind,
		line: t.t(`chat.providerFailure.${kind}`),
		spoken: t.t(`chat.providerFailure.${kind}Spoken`),
		retryable: RETRYABLE.has(kind),
	};
}
