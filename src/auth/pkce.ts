/**
 * The pasted-authorization-code OAuth flows (PKCE), implemented for Obsidian.
 *
 * pi ships these for Anthropic and OpenRouter under
 * `node_modules/@earendil-works/pi-ai/dist/auth/oauth/`, and neither can run
 * here. Both race the pasted code against a local callback server on
 * `node:http`, and a callback server is structurally unavailable to this
 * plugin: Obsidian's runtime has no Node builtins, and the transport rule
 * `deviceCode.ts` documents applies to these token exchanges exactly as it did
 * to the device-code ones. So the race is left out and the manual path is the
 * whole flow — the dialog shows the authorize URL, the user finishes sign-in in
 * whatever browser they have (often on another device), and pastes back either
 * the final redirect URL or the bare code.
 *
 * That is a deliberately thinner experience than pi's desktop CLI, bought with
 * no server process and one interaction shape. What it costs: the callback page
 * cannot confirm anything (it names an address nothing listens on), so the
 * dialog itself is the confirmation the user gets.
 *
 * The transport is pinned by the caller, in the way `deviceCode.ts` documents:
 * an exchange is one JSON round trip, so streaming buys nothing, and the CORS
 * reality says the browser path cannot even complete it.
 */

import type { ModelAuth, OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { FetchFn } from "../net/obsidianFetch";

/** What one provider's pasted-code flow differs in. */
export interface ManualCodeFlow {
	/** Shown wherever the auth method is named, e.g. "Anthropic (Claude Pro/Max)". */
	name: string;
	/** Call to action on the sign-in button. */
	loginLabel: string;
	/** The authorize page the dialog sends the user to. */
	authorizeUrl: string;
	/** Where the authorization code is exchanged for the credential. */
	tokenUrl: string;
	/**
	 * The redirect address the provider sends the user back to.
	 *
	 * A function because OpenRouter's is expected to be unique per login (a
	 * fresh UUID path), while Anthropic's is a fixed shape. Nothing in this
	 * build listens on it: the user copies what the browser lands on, and the
	 * page itself never has to load.
	 */
	redirectUri: () => string;
	/**
	 * What the exchange grants, which is also how the credential is used after.
	 *
	 * `"token-pair"` is the classic OAuth shape — an access token with a refresh
	 * token and a finite lifetime. `"permanent-key"` is OpenRouter's: the code
	 * buys a long-lived user-controlled API key, so there is nothing to refresh.
	 */
	grant: "token-pair" | "permanent-key";
	/** The client id to send, where the provider's exchange carries one. */
	clientId?: string;
	/**
	 * The authorize URL's query, composed per provider.
	 *
	 * A function on the row rather than generic fields here because the
	 * providers disagree on the shape itself, not just the values: Anthropic
	 * takes a full OAuth 2.0 authorization request (`response_type`,
	 * `redirect_uri`, `state`, scopes), OpenRouter takes exactly
	 * `{callback_url, code_challenge, code_challenge_method}` — no state to
	 * check, which is why its paste skips the state comparison.
	 */
	authorizeQuery(input: { challenge: string; verifier: string; redirectUri: string }): URLSearchParams;
	/**
	 * How a live access token authenticates an ordinary model request.
	 *
	 * Copied per provider from pi's own `toAuth` implementations, whose shapes
	 * the request path is written against.
	 */
	toAuth(accessToken: string): ModelAuth;
}

export interface ManualCodeDeps {
	/**
	 * The transport every request in this flow goes through.
	 *
	 * Required rather than defaulted so the pinning decision is visible at the
	 * wiring site, next to the other transport choices, instead of buried here.
	 */
	fetch: FetchFn;
}

/** The five minutes pi's Anthropic flow trims off the declared lifetime. */
const TOKEN_LIFETIME_SAFETY_MS = 5 * 60 * 1000;

/** The PKCE pair the flow both opens and closes with. Generated fresh per login. */
export interface PkcePair {
	/** The secret that stays here and comes back in the exchange. */
	verifier: string;
	/** Its hash, sent on the authorize URL so the exchange can be tied to it. */
	challenge: string;
}

/**
 * PKCE over Web Crypto, matching pi's `pkce.js` arithmetic.
 *
 * Reimplemented rather than imported for the same reason the endpoints below
 * are: pi authenticates its oauth modules with a Node-only import chain, and
 * the 43-character verifier plus its S256 challenge is six lines of Web Crypto
 * that run identically in Obsidian's renderer and in tests.
 */
export async function generatePkce(): Promise<PkcePair> {
	const verifierBytes = new Uint8Array(32);
	crypto.getRandomValues(verifierBytes);
	const verifier = base64UrlEncode(verifierBytes);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Turns whatever the user pasted into a `{code, state}` pair.
 *
 * The shapes a user can arrive with are not a fiction of ours — pi's CLI
 * accepts exactly these, and so does this: the browser's final URL, Anthropic's
 * displayed `code#state`, a bare code, or a query string. A URL that carries an
 * `error` wins over any code the pair might also name — the provider refused,
 * and an exchange would only re-refuse. An unparseable value is *not* an error
 * here: it is treated as a bare code, and the exchange is what reports the
 * verdict, because the paste is one click away from being a token the provider
 * still understands.
 */
export function parseAuthorizationInput(input: string): { code: string | undefined; state: string | undefined } {
	const value = input.trim();
	if (!value) {
		return { code: undefined, state: undefined };
	}
	// `new URL` throws on anything without a scheme, and its throw is a
	// TypeError — the parse-success and error-param paths are separated so the
	// provider's refusal surfaces as the error it names, not a parse verdict.
	const url = tryParseUrl(value);
	if (url) {
		if (url.searchParams.has("error")) {
			throw new Error(url.searchParams.get("error")!);
		}
		return { code: url.searchParams.get("code") || undefined, state: url.searchParams.get("state") || undefined };
	}
	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code: code || undefined, state: state || undefined };
	}
	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return { code: params.get("code") || undefined, state: params.get("state") || undefined };
	}
	return { code: value, state: undefined };
}

/** `new URL`, with "not a URL" as a value rather than a throw to tell apart. */
function tryParseUrl(value: string): URL | undefined {
	try {
		return new URL(value);
	} catch {
		return undefined;
	}
}

/** One POST with a JSON body, the shape both providers exchange with. */
async function postJsonExchange(
	deps: ManualCodeDeps,
	url: string,
	body: Record<string, unknown>,
	signal: AbortSignal,
): Promise<Record<string, unknown>> {
	const response = await deps.fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	const text = await response.text();
	if (!response.ok) {
		const detail = text.trim() || "(empty response body)";
		throw new Error(`HTTP ${response.status} from the ${flowNoun(url)} exchange: ${detail}`);
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new SyntaxError("not a JSON object");
		}
		return parsed as Record<string, unknown>;
	} catch {
		throw new Error(`The ${flowNoun(url)} exchange answered with something other than a JSON object.`);
	}
}

/** The last path segment, the only part that survives a long error line. */
function flowNoun(url: string): string {
	const withoutQuery = url.split("?", 1)[0]!;
	return withoutQuery.split("/").filter(Boolean).at(-1) ?? url;
}

function readString(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Reads a declared lifetime as a whole number of seconds. */
function readExpiresIn(body: Record<string, unknown>): number | undefined {
	const value = body.expires_in;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** The parts an exchange needs, already checked against the verifier. */
export interface ExchangeInput {
	code: string;
	verifier: string;
	redirectUri: string;
	/** The state to echo; the verifier when the paste carried none. */
	state: string;
}

function exchangeAuthorizationCode(
	flow: ManualCodeFlow,
	deps: ManualCodeDeps,
	input: ExchangeInput,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	return flow.grant === "permanent-key"
		? exchangePermanentKey(flow, deps, input, signal)
		: exchangeTokenPair(flow, deps, input, signal);
}

/**
 * Anthropic's shape: a full OAuth grant, whose credential is an access and
 * refresh pair.
 *
 * The five minutes off the lifetime is pi's own arithmetic — it keeps the
 * stored token out of the window where a clock skewed by a few minutes would
 * send a request that fails at the provider, and a refresh is cheaper than
 * diagnosing that.
 */
async function exchangeTokenPair(
	flow: ManualCodeFlow,
	deps: ManualCodeDeps,
	input: ExchangeInput,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	const body = await postJsonExchange(deps, flow.tokenUrl, {
		grant_type: "authorization_code",
		client_id: flow.clientId,
		code: input.code,
		state: input.state,
		redirect_uri: input.redirectUri,
		code_verifier: input.verifier,
	}, signal);
	const access = readString(body, "access_token");
	const refresh = readString(body, "refresh_token");
	const expiresIn = readExpiresIn(body);
	if (!access || !refresh || expiresIn === undefined) {
		throw new Error(`${flow.name} returned a token response without the fields needed to stay signed in.`);
	}
	return { type: "oauth", access, refresh, expires: Date.now() + expiresIn * 1000 - TOKEN_LIFETIME_SAFETY_MS };
}

/**
 * OpenRouter's shape: the code buys a permanent, user-controlled API key.
 *
 * No client id and no state — OpenRouter ties the grant to the verifier alone —
 * and no refresh, so the credential's lifetime is "forever" by construction
 * rather than a big number that could be wrong.
 */
async function exchangePermanentKey(
	flow: ManualCodeFlow,
	deps: ManualCodeDeps,
	input: ExchangeInput,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	const body = await postJsonExchange(deps, flow.tokenUrl, {
		code: input.code,
		code_verifier: input.verifier,
		code_challenge_method: "S256",
	}, signal);
	const key = readString(body, "key");
	if (!key) {
		throw new Error(`${flow.name} did not return an API key in its exchange response.`);
	}
	return { type: "oauth", access: key, refresh: "", expires: Number.MAX_SAFE_INTEGER };
}

/**
 * Runs one pasted-code login to completion.
 *
 * The dialog paints the authorize URL and asks for the paste; this function
 * only reconvenes once that answer settles — cancellation included, for which
 * the dialog aborting `signal` is the sole party. There is no poll to cancel
 * out from under, which is why this flow has no `sleep` dependency in the way
 * `deviceCode.ts` does.
 */
export async function runManualCodeLogin(
	flow: ManualCodeFlow,
	deps: ManualCodeDeps,
	interaction: ProviderAuthInteraction,
): Promise<OAuthCredential> {
	interaction.signal.throwIfAborted();
	const { verifier, challenge } = await generatePkce();
	const redirectUri = flow.redirectUri();
	const authorizeQuery = flow.authorizeQuery({ challenge, verifier, redirectUri });
	const authorizeUrl = new URL(flow.authorizeUrl);
	authorizeUrl.search = authorizeQuery.toString();
	interaction.notify({ type: "auth_url", url: authorizeUrl.toString() });
	const pasted = await interaction.prompt({
		type: "manual_code",
		message: "",
		placeholder: redirectUri,
	});
	interaction.signal.throwIfAborted();
	const { code, state: pastedState } = parseAuthorizationInput(pasted);
	// Only checked when the paste carries a state, and only when this flow sent
	// one: OpenRouter's authorize request names no state at all, so a paste for
	// that provider has nothing to compare against. What it compares against is
	// the state this login actually sent — which today is the verifier, but the
	// check is written against the wire value, not that coincidence.
	const sentState = authorizeQuery.get("state") ?? undefined;
	if (sentState !== undefined && pastedState !== undefined && pastedState !== sentState) {
		throw new Error("The pasted authorization does not belong to this sign-in request (state mismatch). Start again.");
	}
	if (!code) {
		throw new Error("No authorization code in what was pasted. Paste the full redirect URL, or the code the provider showed.");
	}
	// pi's fallback when the paste carries no state is the verifier; echoing the
	// state that was sent is the same rule read off the wire.
	return exchangeAuthorizationCode(
		flow,
		deps,
		{ code, verifier, redirectUri, state: pastedState ?? sentState ?? verifier },
		interaction.signal,
	);
}

/**
 * Exchanges a refresh token, for the one flow whose credential expires.
 *
 * There is deliberately no retry around it, matching `deviceCode.ts`: pi runs
 * refresh inside the credential-store lock, so a backoff long enough to help
 * would hold the lock every concurrent request queues behind. A failed refresh
 * surfaces as a `ModelsError` and leaves the stored credential in place; the
 * next request is the retry.
 */
export async function refreshManualCodeCredential(
	flow: ManualCodeFlow,
	deps: ManualCodeDeps,
	credential: OAuthCredential,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	if (flow.grant === "permanent-key") {
		// A permanent key cannot expire, so pi's OpenRouter refresh is the
		// identity. Kept as a branch rather than omitted so the `OAuthAuth`
		// shape stays uniform for the caller.
		return credential;
	}
	const body = await postJsonExchange(deps, flow.tokenUrl, {
		grant_type: "refresh_token",
		client_id: flow.clientId,
		refresh_token: credential.refresh,
	}, signal);
	const access = readString(body, "access_token");
	const refresh = readString(body, "refresh_token") ?? credential.refresh;
	const expiresIn = readExpiresIn(body);
	if (!access || expiresIn === undefined) {
		throw new Error(`${flow.name} returned a refresh response without the fields needed to stay signed in.`);
	}
	return { type: "oauth", access, refresh, expires: Date.now() + expiresIn * 1000 - TOKEN_LIFETIME_SAFETY_MS };
}

/**
 * Presents one pasted-code flow as the `OAuthAuth` a pi provider advertises.
 *
 * Built per call and closed over the transport, matching `oauthFlows.ts`'s rule:
 * a cached flow object would keep serving whichever `fetch` happened to create
 * it.
 */
export function createManualCodeOAuth(flow: ManualCodeFlow, deps: ManualCodeDeps): OAuthAuth {
	return {
		name: flow.name,
		isSubscription: true,
		loginLabel: flow.loginLabel,
		async login(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
			return runManualCodeLogin(flow, deps, interaction);
		},
		async refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
			return refreshManualCodeCredential(flow, deps, credential, signal);
		},
		toAuth(credential: OAuthCredential): Promise<ModelAuth> {
			return Promise.resolve(flow.toAuth(credential.access));
		},
	};
}
