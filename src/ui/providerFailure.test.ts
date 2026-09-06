import { describe, expect, it } from "bun:test";
import { getT } from "../i18n";
import { classifyProviderFailure, describeProviderFailure, type ProviderFailureKind } from "./providerFailure";
import { assertOkResponse } from "../net/shims/apiHttp";
/*
 * pi's own composer, reached through its real location under `node_modules/`
 * because `utils/error-body.ts` is not in the package's `exports` map — the same
 * workaround `src/vault/editDiff.ts` documents. Importing it instead of
 * restating its output is the whole point of the matrix at the bottom of this
 * file: the strings under test are the ones pi will actually produce, so a
 * release that reformats them fails here rather than quietly retiring a
 * recogniser.
 */
import {
	formatProviderError,
	normalizeProviderError,
} from "../../node_modules/@earendil-works/pi-ai/dist/utils/error-body.js";

/**
 * The cases are real provider messages, not shapes invented to satisfy the
 * regexes. Where a family was placed above another in `RULES`, the message that
 * forced the placement is here — that pairing is the point of the table, and a
 * reorder that looks harmless will fail on the row that motivated it.
 */
const CASES: readonly (readonly [string, ProviderFailureKind])[] = [
	// The shape our own transport writes (`apiHttp.ts`, `describeErrorBody`); what
	// pi does to it on the way here is the matrix at the bottom of this file.
	["401 invalid API key", "auth"],
	["403 Forbidden", "auth"],
	["402 Payment Required", "quota"],
	["408 Request Timeout", "timeout"],
	["413 Payload Too Large", "contextLength"],
	["429 Rate limit reached for gpt-4o in organization org-abc on tokens per min", "rateLimit"],
	["451 content_policy_violation", "refused"],
	["500 Internal Server Error", "serverError"],
	["502 Bad Gateway", "serverError"],
	["503 Service Unavailable", "serverError"],
	["504 Gateway Time-out", "timeout"],
	["524 A timeout occurred", "timeout"],
	["529 overloaded_error: Overloaded", "rateLimit"],

	// The orderings that RULES' comment names, each with the message behind it.
	["429 You exceeded your current quota, please check your plan and billing details.", "quota"],
	["400 This model's maximum context length is 128000 tokens, however you requested 140000", "contextLength"],
	["400 Your request was rejected as a result of our safety system", "refused"],
	["429 Rate limit reached for requests on your API key", "rateLimit"],

	// Wording alone, with no leading status to lean on.
	["DeepSeek request failed: 401 invalid API key", "auth"],
	["Incorrect API key provided", "auth"],
	["Request timed out.", "timeout"],
	["getaddrinfo ENOTFOUND api.deepseek.com", "offline"],
	["connect ECONNREFUSED 127.0.0.1:11434", "offline"],
	["socket hang up: ECONNRESET", "offline"],
	["Failed to fetch", "offline"],
	["Your credit balance is too low to access the Anthropic API", "quota"],
	["prompt is too long: 210000 tokens > 200000 maximum", "contextLength"],

	// Nothing recognisable, and nothing invented.
	["", "unknown"],
	["   ", "unknown"],
	["Something odd happened", "unknown"],
	// The anchor on `leadingStatus` is what keeps this out of `serverError`: a
	// status read from anywhere in the string would find the one in this URL.
	["See https://example.com/errors/503 for details", "unknown"],
];

describe("classifyProviderFailure", () => {
	for (const [message, kind] of CASES) {
		it(`reads ${JSON.stringify(message.slice(0, 56))} as ${kind}`, () => {
			expect(classifyProviderFailure(message)).toBe(kind);
		});
	}
});

describe("describeProviderFailure", () => {
	const t = getT("en");

	it("resolves a sentence and a spoken form for every family", () => {
		const kinds: readonly ProviderFailureKind[] = [
			"auth",
			"quota",
			"contextLength",
			"refused",
			"rateLimit",
			"timeout",
			"offline",
			"serverError",
			"unknown",
		];
		for (const [message] of CASES) {
			const failure = describeProviderFailure(message, t);

			expect(kinds).toContain(failure.kind);
			expect(failure.line.length).toBeGreaterThan(0);
			expect(failure.spoken.length).toBeGreaterThan(0);
		}
	});

	/*
	 * The flag decides whether the transcript offers to send the same turn again.
	 * A retry on the four refusals below would bill a second identical rejection,
	 * so their sentences name the fix instead.
	 */
	it("offers a retry only where sending the same words again could work", () => {
		expect(describeProviderFailure("504 Gateway Time-out", t).retryable).toBe(true);
		expect(describeProviderFailure("429 Rate limit reached", t).retryable).toBe(true);
		expect(describeProviderFailure("500 Internal Server Error", t).retryable).toBe(true);
		expect(describeProviderFailure("getaddrinfo ENOTFOUND api.x.com", t).retryable).toBe(true);
		expect(describeProviderFailure("", t).retryable).toBe(true);

		expect(describeProviderFailure("401 invalid API key", t).retryable).toBe(false);
		expect(describeProviderFailure("402 Payment Required", t).retryable).toBe(false);
		expect(describeProviderFailure("413 Payload Too Large", t).retryable).toBe(false);
		expect(describeProviderFailure("451 content_policy_violation", t).retryable).toBe(false);
	});

	/*
	 * The spoken form is appended after an em-dash in `assistantSpeech`, so it has
	 * to continue a sentence rather than open one. Checked on the English table
	 * only: Chinese has no case to get wrong.
	 */
	it("writes the spoken form to continue a sentence", () => {
		for (const [message] of CASES) {
			const { spoken } = describeProviderFailure(message, t);
			const first = spoken[0] ?? "";

			// "Piem" is the one proper noun that legitimately opens one.
			if (spoken.startsWith("Piem")) continue;
			expect(first).toBe(first.toLowerCase());
		}
	});

	/*
	 * The spoken form is the *whole* sentence, lower-cased at the front — the shape
	 * `youStoppedSpoken` and `replyTruncatedSpoken` already use. An earlier cut
	 * truncated it to the diagnosis and dropped the remedy, so a screen-reader user
	 * heard what went wrong and never what to do about it. This pins the pair
	 * together in both languages, since a translator editing one is the way the two
	 * drift apart.
	 */
	it("keeps the remedy in the spoken form, in both languages", () => {
		for (const lang of ["en", "zh-cn"] as const) {
			const translator = getT(lang);
			for (const [message] of CASES) {
				const { line, spoken } = describeProviderFailure(message, translator);
				const tail = (text: string): string => text.slice(1);

				expect(tail(spoken)).toBe(tail(line));
			}
		}
	});

	it("speaks Chinese when the panel does", () => {
		const zh = describeProviderFailure("504 Gateway Time-out", getT("zh-cn"));

		expect(zh.kind).toBe("timeout");
		expect(zh.line).toContain("供应商");
	});
});

/**
 * What each protocol this plugin speaks does to one transport failure before it
 * reaches the classifier.
 *
 * The table above pins the wording rules against messages providers really send.
 * This one pins something the wording rules cannot see: the string that arrives
 * is not the string our transport wrote. Every entry names the pi source that
 * rewrites it, because that is what has to be re-read when a pi release lands.
 */
const WIRE_PROTOCOLS: readonly (readonly [string, (error: unknown) => string])[] = [
	// api/anthropic-messages.js: `output.errorMessage = error.message`, verbatim.
	["anthropic-messages", (error) => (error as Error).message],
	// api/openai-completions.js: `formatProviderError(normalizeProviderError(error))`.
	["openai-completions", (error) => formatProviderError(normalizeProviderError(error))],
	// api/openai-responses.js, through `formatOpenAIResponsesError`: the same,
	// with the provider's name prefixed ahead of the status.
	["openai-responses", (error) => formatProviderError(normalizeProviderError(error), "OpenAI API error")],
];

/** The error our shims throw for a non-2xx response, from the real code path. */
async function transportFailure(status: number, body: string): Promise<unknown> {
	const response = new Response(body, { status, headers: { "content-type": "application/json" } });
	return await assertOkResponse(response).then(
		() => {
			throw new Error("expected a rejection");
		},
		(error: unknown) => error,
	);
}

/*
 * The bodyless rows are the load-bearing ones. A gateway that answers with a
 * status and nothing else — nginx on a large request, Cloudflare on a slow
 * upstream — leaves no wording for `pattern` to recognise, so the hard marker is
 * the only thing standing between the reader and "did not say why".
 */
const TRANSPORT_CASES: readonly (readonly [number, string, ProviderFailureKind])[] = [
	[429, JSON.stringify({ error: { message: "Rate limit reached for gpt-4o on tokens per min" } }), "rateLimit"],
	[402, JSON.stringify({ error: { message: "Your team has run out of credits." } }), "quota"],
	[401, JSON.stringify({ error: { message: "Incorrect API key provided: sk-***" } }), "auth"],
	[413, "", "contextLength"],
	[408, "", "timeout"],
	[500, "", "serverError"],
];

describe("the string each wire protocol actually delivers", () => {
	for (const [status, body, expected] of TRANSPORT_CASES) {
		for (const [protocol, deliver] of WIRE_PROTOCOLS) {
			it(`reads ${status}${body ? "" : " with no body"} from ${protocol} as ${expected}`, async () => {
				expect(classifyProviderFailure(deliver(await transportFailure(status, body)))).toBe(expected);
			});
		}
	}

	/*
	 * The classified sentence is a guess and the raw text is what makes it safe to
	 * make — so the raw text has to be readable. pi prints the serialized body
	 * whenever it believes our message left it out, which is why the transport
	 * withholds a body it has already spoken for (`ErrorBodyDescription.body`).
	 */
	for (const [protocol, deliver] of WIRE_PROTOCOLS) {
		it(`leaves the provider's own sentence readable on ${protocol}`, async () => {
			const error = await transportFailure(429, JSON.stringify({ error: { message: "slow down", type: "tokens" } }));
			const delivered = deliver(error);

			expect(delivered).toContain("429 slow down");
			expect(delivered).not.toContain('"type"');
		});
	}
});
