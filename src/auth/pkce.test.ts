/**
 * The pasted-authorization-code flows, driven against a scripted transport and
 * a scripted user.
 *
 * Layered like `deviceCode.test.ts`: pure parsing and the PKCE arithmetic are
 * tested directly, then `runManualCodeLogin` runs end to end with a fake
 * interaction (its `notify` recorded, its `prompt` answering from a queue) so
 * the assertions see the authorize URL the flow actually sent and the exchange
 * bodies it actually posted. No test sleeps and none touches the network —
 * `signal` is the only live wire, and every checkpoint it guards is exercised
 * with an already-aborted controller.
 */

import { describe, expect, it } from "bun:test";
import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { FetchFn } from "../net/obsidianFetch";
import {
	createManualCodeOAuth,
	generatePkce,
	parseAuthorizationInput,
	runManualCodeLogin,
	type ManualCodeFlow,
} from "./pkce";

interface Call {
	url: string;
	body: Record<string, unknown>;
}

/** A transport serving canned JSON replies in order, recording what it was asked. */
function scriptedFetch(replies: { status?: number; body?: unknown }[]): {
	fetch: FetchFn;
	calls: Call[];
} {
	const calls: Call[] = [];
	let index = 0;
	const fetch: FetchFn = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
		const reply = replies[Math.min(index, replies.length - 1)];
		index += 1;
		if (!reply) {
			throw new Error("scriptedFetch ran out of replies");
		}
		return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
	};
	return { fetch, calls };
}

/** A flow shaped like Anthropic's, with the fields a test can reason about. */
function tokenPairFlow(overrides: Partial<ManualCodeFlow> = {}): ManualCodeFlow {
	return {
		name: "Test Provider",
		loginLabel: "Sign in with Test",
		authorizeUrl: "https://auth.example.com/authorize",
		tokenUrl: "https://auth.example.com/token",
		redirectUri: () => "http://localhost:1/callback",
		grant: "token-pair",
		clientId: "client-1",
		authorizeQuery: ({ challenge, verifier, redirectUri }) =>
			new URLSearchParams({
				client_id: "client-1",
				response_type: "code",
				redirect_uri: redirectUri,
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: verifier,
			}),
		toAuth: (accessToken) => ({ apiKey: accessToken }),
		...overrides,
	};
}

/** An interaction whose prompt answers from a queue and whose events are recorded. */
function scriptedInteraction(answers: (string | (() => string))[], signal = new AbortController().signal): {
	interaction: ProviderAuthInteraction;
	events: unknown[];
	prompts: unknown[];
} {
	const events: unknown[] = [];
	const prompts: unknown[] = [];
	let index = 0;
	const interaction: ProviderAuthInteraction = {
		signal,
		notify: (event) => events.push(event),
		prompt: (prompt) => {
			prompts.push(prompt);
			const answer = answers[index];
			index += 1;
			if (answer === undefined) {
				throw new Error("scriptedInteraction ran out of answers");
			}
			// A function answer runs at prompt time, so it can read the events the
			// flow has already emitted — a paste that names what was actually shown.
			return Promise.resolve(typeof answer === "function" ? answer() : answer);
		},
	};
	return { interaction, events, prompts };
}

describe("parseAuthorizationInput", () => {
	it("reads code and state out of a full redirect URL", () => {
		const parsed = parseAuthorizationInput("https://localhost:53692/callback?code=abc&state=xyz");
		expect(parsed).toEqual({ code: "abc", state: "xyz" });
	});

	it("reads the displayed code#state pair", () => {
		expect(parseAuthorizationInput("abc#xyz")).toEqual({ code: "abc", state: "xyz" });
	});

	it("reads a bare query string", () => {
		expect(parseAuthorizationInput("code=abc&state=xyz")).toEqual({ code: "abc", state: "xyz" });
	});

	it("treats a bare code as a code", () => {
		expect(parseAuthorizationInput("abc")).toEqual({ code: "abc", state: undefined });
	});

	it("trims surrounding whitespace first", () => {
		expect(parseAuthorizationInput("  abc\n")).toEqual({ code: "abc", state: undefined });
	});

	it("answers empty input with no code and no state", () => {
		expect(parseAuthorizationInput("")).toEqual({ code: undefined, state: undefined });
		expect(parseAuthorizationInput("   ")).toEqual({ code: undefined, state: undefined });
	});

	it("reports a URL carrying an error rather than exchanging it", () => {
		// The provider refused; exchanging would only re-refuse with less context.
		expect(() => parseAuthorizationInput("https://localhost:53692/callback?error=access_denied")).toThrow(
			"access_denied",
		);
	});

	it("reads a trailing separator as no state rather than an empty one", () => {
		// A displayed pair with the state cut off must still sign in: an empty
		// segment is "absent" (pi's truthy rule), so the verifier stands in.
		expect(parseAuthorizationInput("code#")).toEqual({ code: "code", state: undefined });
	});
});

describe("generatePkce", () => {
	it("makes a verifier long enough for RFC 7636's 43-character floor", async () => {
		// 32 random bytes are 43 base64url characters — exactly the spec's
		// minimum, without padding.
		expect(await generatePkceVerifiers()).toContain(43);
	});

	it("makes the challenge the base64url SHA-256 of the verifier", async () => {
		const { verifier, challenge } = await generatePkce();
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
		const expected = base64Url(new Uint8Array(digest));
		expect(challenge).toBe(expected);
	});

	it("generates a fresh pair per login", async () => {
		const first = await generatePkce();
		const second = await generatePkce();
		expect(first.verifier).not.toBe(second.verifier);
		expect(first.challenge).not.toBe(second.challenge);
	});
});

/** Collects verifier lengths without making the test a promise chain. */
async function generatePkceVerifiers(): Promise<number[]> {
	const lengths: number[] = [];
	for (let i = 0; i < 5; i += 1) {
		lengths.push((await generatePkce()).verifier.length);
	}
	return lengths;
}

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

describe("runManualCodeLogin (token-pair, the Anthropic shape)", () => {
	it("shows an authorize URL carrying the challenge and the state, then exchanges the paste", async () => {
		const { fetch, calls } = scriptedFetch([{ body: { access_token: "at", refresh_token: "rt", expires_in: 3600 } }]);
		const { interaction, events, prompts } = scriptedInteraction([
			// The paste names the state this login actually sent, read off the URL
			// the dialog showed — the verifier behind it is the flow's own business.
			() => {
				const shown = new URL((events[0] as { url: string }).url);
				return `https://localhost:1/callback?code=pasted-code&state=${shown.searchParams.get("state")}`;
			},
		]);
		const flow = tokenPairFlow();
		const credential = await runManualCodeLogin(flow, { fetch }, interaction);

		expect(events).toHaveLength(1);
		const url = new URL((events[0] as { type: string; url: string }).url);
		expect(url.origin + url.pathname).toBe("https://auth.example.com/authorize");
		expect(url.searchParams.get("state")).toEqual(expect.any(String));
		expect(prompts[0]).toMatchObject({ type: "manual_code", placeholder: "http://localhost:1/callback" });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://auth.example.com/token");
		const sentState = url.searchParams.get("state");
		expect(calls[0]?.body).toMatchObject({ code: "pasted-code", state: sentState });
		expect(credential).toEqual({
			type: "oauth",
			access: "at",
			refresh: "rt",
			expires: expect.any(Number),
		});
	});

	it("sends grant_type, client id, redirect address, and the verifier in place of a state", async () => {
		// The displayed bare code carries no state; pi's rule fills the exchange's
		// state slot with the verifier rather than leaving it empty.
		const { fetch, calls } = scriptedFetch([{ body: { access_token: "at", refresh_token: "rt", expires_in: 60 } }]);
		const { interaction } = scriptedInteraction(["bare-code"]);
		const flow = tokenPairFlow();
		await runManualCodeLogin(flow, { fetch }, interaction);
		expect(calls[0]?.body).toMatchObject({
			grant_type: "authorization_code",
			client_id: "client-1",
			code: "bare-code",
			redirect_uri: "http://localhost:1/callback",
		});
		expect(calls[0]?.body.state).toBe(calls[0]?.body.code_verifier);
	});

	it("ties the exchange to the challenge shown on the authorize URL", async () => {
		const { fetch, calls } = scriptedFetch([{ body: { access_token: "at", refresh_token: "rt", expires_in: 60 } }]);
		const { interaction, events } = scriptedInteraction(["bare-code"]);
		const flow = tokenPairFlow();
		await runManualCodeLogin(flow, { fetch }, interaction);
		const shown = new URL((events[0] as { url: string }).url);
		const challenge = shown.searchParams.get("code_challenge")!;
		// The hash cannot be inverted, so assert the direction it can: the
		// verifier the exchange posted must hash to the challenge that was shown.
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(calls[0]?.body.code_verifier)));
		expect(base64Url(new Uint8Array(digest))).toBe(challenge);
	});

	it("refuses a paste whose state is not the one this login sent", async () => {
		const { fetch, calls } = scriptedFetch([{}]);
		const { interaction } = scriptedInteraction(["https://localhost:1/callback?code=abc&state=from-elsewhere"]);
		await expect(runManualCodeLogin(tokenPairFlow(), { fetch }, interaction)).rejects.toThrow("state mismatch");
		expect(calls).toHaveLength(0);
	});

	it("accepts a paste with no state by falling back to the verifier", async () => {
		// pi's rule: the displayed bare code carries no state, and the exchange
		// still has to name one — the verifier is what the provider tied the
		// request to.
		const { fetch, calls } = scriptedFetch([{ body: { access_token: "at", refresh_token: "rt", expires_in: 60 } }]);
		const { interaction } = scriptedInteraction(["bare-code"]);
		const flow = tokenPairFlow();
		await runManualCodeLogin(flow, { fetch }, interaction);
		expect(calls[0]?.body.state).toBe(calls[0]?.body.code_verifier);
	});

	it("reports a paste with no code instead of posting an empty exchange", async () => {
		const { fetch, calls } = scriptedFetch([{}]);
		const { interaction } = scriptedInteraction([""]);
		await expect(runManualCodeLogin(tokenPairFlow(), { fetch }, interaction)).rejects.toThrow("No authorization code");
		expect(calls).toHaveLength(0);
	});

	it("subtracts pi's five-minute safety margin from the stored expiry", async () => {
		const { fetch } = scriptedFetch([{ body: { access_token: "at", refresh_token: "rt", expires_in: 3600 } }]);
		const { interaction } = scriptedInteraction(["code#"]);
		const before = Date.now();
		const credential = await runManualCodeLogin(tokenPairFlow(), { fetch }, interaction);
		const after = Date.now();
		// expires = exchange time + expires_in*1000 - 5min, and the exchange ran
		// between the two stamps: a 3,300,000 ms window pinned at each end.
		expect(credential.expires).toBeGreaterThanOrEqual(before + 3_300_000);
		expect(credential.expires).toBeLessThanOrEqual(after + 3_300_000);
	});

	it("reports an unusable token response instead of storing a half credential", async () => {
		const { fetch, calls } = scriptedFetch([{ body: { access_token: "at", expires_in: 3600 } }]);
		const { interaction } = scriptedInteraction(["code#"]);
		await expect(runManualCodeLogin(tokenPairFlow(), { fetch }, interaction)).rejects.toThrow("stay signed in");
		expect(calls).toHaveLength(1);
	});

	it("reports the provider's status line when the exchange fails", async () => {
		const { fetch } = scriptedFetch([{ status: 400, body: { error: "invalid_grant" } }]);
		const { interaction } = scriptedInteraction(["code#"]);
		await expect(runManualCodeLogin(tokenPairFlow(), { fetch }, interaction)).rejects.toThrow("HTTP 400");
	});
});

describe("runManualCodeLogin (permanent-key, the OpenRouter shape)", () => {
	function permanentKeyFlow(): ManualCodeFlow {
		return tokenPairFlow({
			grant: "permanent-key",
			clientId: undefined,
			redirectUri: () => `http://127.0.0.1:1/oauth/callback/${crypto.randomUUID()}`,
			authorizeQuery: ({ challenge, redirectUri }) =>
				new URLSearchParams({
					callback_url: redirectUri,
					code_challenge: challenge,
					code_challenge_method: "S256",
				}),
		});
	}

	it("posts only the code, verifier, and method — no client id, no state", async () => {
		const { fetch, calls } = scriptedFetch([{ body: { key: "sk-or-1" } }]);
		const { interaction, events } = scriptedInteraction(["https://127.0.0.1:1/cb?code=pasted&state=anything"]);
		// A state on the paste is ignored, because this flow never sent one to
		// compare it against.
		const credential = await runManualCodeLogin(permanentKeyFlow(), { fetch }, interaction);
		expect(calls[0]?.body).toEqual({
			code: "pasted",
			code_verifier: expect.any(String),
			code_challenge_method: "S256",
		});
		expect(credential).toEqual({ type: "oauth", access: "sk-or-1", refresh: "", expires: Number.MAX_SAFE_INTEGER });
		expect((events[0] as { url: string }).url).toContain("callback_url=");
	});

	it("asks for a fresh callback address per login", async () => {
		// The uuid path is what makes a retried sign-in a new request rather than
		// a callback someone already used — so two logins must show two addresses.
		const { fetch } = scriptedFetch([{ body: { key: "sk-or-1" } }, { body: { key: "sk-or-2" } }]);
		const first = scriptedInteraction(["bare-code"]);
		const second = scriptedInteraction(["bare-code"]);
		await runManualCodeLogin(permanentKeyFlow(), { fetch }, first.interaction);
		await runManualCodeLogin(permanentKeyFlow(), { fetch }, second.interaction);
		const firstUrl = new URL((first.events[0] as { url: string }).url);
		const secondUrl = new URL((second.events[0] as { url: string }).url);
		const callback = (url: URL): string => url.searchParams.get("callback_url")!;
		expect(callback(firstUrl)).not.toBe(callback(secondUrl));
	});

	it("rejects a response with no key rather than storing an empty credential", async () => {
		const { fetch } = scriptedFetch([{ body: {} }]);
		const { interaction } = scriptedInteraction(["code#"]);
		await expect(runManualCodeLogin(permanentKeyFlow(), { fetch }, interaction)).rejects.toThrow("did not return an API key");
	});
});

describe("abort checkpoints", () => {
	it("refuses to start once the signal has fired", async () => {
		const { fetch, calls } = scriptedFetch([{}]);
		const controller = new AbortController();
		controller.abort();
		const { interaction, events } = scriptedInteraction(["code#"], controller.signal);
		await expect(runManualCodeLogin(tokenPairFlow(), { fetch }, interaction)).rejects.toThrow();
		expect(calls).toHaveLength(0);
		expect(events).toHaveLength(0);
	});

	it("refuses to exchange once the signal has fired after the paste", async () => {
		// The prompt resolved, but the dialog closed before the answer was used —
		// the exchange must not run for a sign-in nobody is watching.
		const { fetch, calls } = scriptedFetch([{}]);
		const controller = new AbortController();
		const { interaction } = scriptedInteraction(["code#"], controller.signal);
		controller.abort();
		await expect(runManualCodeLogin(tokenPairFlow(), { fetch }, interaction)).rejects.toThrow();
		expect(calls).toHaveLength(0);
	});
});

describe("createManualCodeOAuth", () => {
	it("advertises itself as a subscription with the flow's own labels", () => {
		const { fetch } = scriptedFetch([{}]);
		const auth = createManualCodeOAuth(tokenPairFlow(), { fetch });
		expect(auth.name).toBe("Test Provider");
		expect(auth.isSubscription).toBe(true);
		expect(auth.loginLabel).toBe("Sign in with Test");
	});

	it("runs the login through its interaction", async () => {
		const { fetch, calls } = scriptedFetch([{ body: { access_token: "at", refresh_token: "rt", expires_in: 60 } }]);
		const auth = createManualCodeOAuth(tokenPairFlow(), { fetch });
		const credential = await auth.login(scriptedInteraction(["code#"]).interaction);
		expect(credential.access).toBe("at");
		expect(calls).toHaveLength(1);
	});

	it("derives request auth from the access token without touching the network", async () => {
		const { fetch, calls } = scriptedFetch([{}]);
		const auth = createManualCodeOAuth(tokenPairFlow(), { fetch });
		expect(await auth.toAuth({ type: "oauth", access: "at", refresh: "rt", expires: 0 })).toEqual({ apiKey: "at" });
		expect(calls).toHaveLength(0);
	});

	it("refreshes a token pair and rotates the refresh token when given", async () => {
		const { fetch, calls } = scriptedFetch([{ body: { access_token: "at-2", refresh_token: "rt-2", expires_in: 900 } }]);
		const auth = createManualCodeOAuth(tokenPairFlow(), { fetch });
		const next = await auth.refresh({ type: "oauth", access: "at-1", refresh: "rt-1", expires: 0 }, new AbortController().signal);
		expect(calls[0]?.body).toEqual({
			grant_type: "refresh_token",
			client_id: "client-1",
			refresh_token: "rt-1",
		});
		expect(next).toEqual({ type: "oauth", access: "at-2", refresh: "rt-2", expires: expect.any(Number) });
	});

	it("keeps the old refresh token when the provider does not rotate it", async () => {
		const { fetch } = scriptedFetch([{ body: { access_token: "at-2", expires_in: 900 } }]);
		const auth = createManualCodeOAuth(tokenPairFlow(), { fetch });
		const next = await auth.refresh({ type: "oauth", access: "at-1", refresh: "rt-1", expires: 0 }, new AbortController().signal);
		expect(next.refresh).toBe("rt-1");
	});

	it("treats a permanent key's refresh as the identity", async () => {
		// No request, same credential back — a key that cannot expire has nothing
		// to refresh.
		const { fetch, calls } = scriptedFetch([{}]);
		const flow = tokenPairFlow({ grant: "permanent-key", clientId: undefined });
		const auth = createManualCodeOAuth(flow, { fetch });
		const current = { type: "oauth" as const, access: "sk-or-1", refresh: "", expires: Number.MAX_SAFE_INTEGER };
		const next = await auth.refresh(current, new AbortController().signal);
		expect(next).toBe(current);
		expect(calls).toHaveLength(0);
	});
});
