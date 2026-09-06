/**
 * The subscription sign-ins this build can perform, in two tables.
 *
 * Endpoints, client ids and redirect shapes are copied verbatim from pi's own
 * implementations under `node_modules/@earendil-works/pi-ai/dist/auth/oauth/`,
 * which is the source of truth for them; `deviceCode.ts`'s header explains why
 * the flows themselves are reimplemented rather than imported, and the copying
 * is the cost that decision carries — a provider that rotates a client id needs
 * a change here.
 *
 * The two tables are two interaction shapes, and the split is load-bearing:
 *
 * - {@link DEVICE_CODE_FLOWS} poll — the user types a short code into the
 *   provider's page while this plugin asks the token endpoint in the
 *   background, until approval or expiry (`deviceCode.ts`).
 * - {@link MANUAL_CODE_FLOWS} paste — the plugin opens the authorize page, the
 *   user finishes sign-in in whatever browser they have, and pastes the code
 *   back (`pkce.ts`).
 *
 * GitHub Copilot is in neither table rather than a third one: its long-lived
 * credential is a GitHub OAuth token that every refresh exchanges for a
 * short-lived Copilot token, its request endpoint is parsed back out of that
 * token per credential, and pi's api layers reach for Copilot-specific headers
 * keyed on the literal provider id `github-copilot`. None of that fits a table
 * entry, and shipping it inside a commit would mean shipping it unverified.
 *
 * What makes a flow eligible for either table is the same question: the whole
 * exchange has to be plain HTTPS against endpoints the plugin can reach, with
 * no local callback server and no `node:` builtin. The paste flows qualify
 * precisely because the callback server is left out of them.
 */

import type { OAuthAuth } from "@earendil-works/pi-ai";
import type { FetchFn } from "../net/obsidianFetch";
import { createDeviceCodeOAuth, type DeviceCodeDeps, type DeviceCodeFlow } from "./deviceCode";
import { createManualCodeOAuth, type ManualCodeFlow } from "./pkce";

/**
 * Stable identifiers for the device-code sign-ins, persisted on provider rows.
 *
 * Persisted, so these strings are a compatibility surface: renaming one orphans
 * every row that named it. They match pi's own provider ids so the two can be
 * read side by side.
 */
export type DeviceCodeFlowId = "xai" | "kimi-coding";

/** Stable identifiers for the pasted-code sign-ins, same compatibility surface. */
export type ManualCodeFlowId = "anthropic" | "openrouter";

/** Every sign-in this build can perform, by its persisted id. */
export type OAuthFlowId = DeviceCodeFlowId | ManualCodeFlowId;

/**
 * The sign-ins that poll a device code.
 *
 * A separate table rather than one union-valued map so the two shapes stay
 * visible: an entry here implies polling and backoff, an entry in
 * {@link MANUAL_CODE_FLOWS} implies a paste, and a reader never has to wonder
 * which one a row is. Exported because the table's invariants are asserted,
 * not assumed — see `oauthFlows.test.ts`.
 */
export const DEVICE_CODE_FLOWS: Readonly<Record<DeviceCodeFlowId, DeviceCodeFlow>> = {
	xai: {
		name: "xAI (Grok/X subscription)",
		loginLabel: "Sign in with SuperGrok or X Premium",
		clientId: "b1a00492-073a-47ea-816f-4c329264a828",
		deviceCodeUrl: "https://auth.x.ai/oauth2/device/code",
		tokenUrl: "https://auth.x.ai/oauth2/token",
		deviceCodeFields: {
			scope: "openid profile email offline_access grok-cli:access api:access",
			// Sent because the client id above is pi's, and this is what that client
			// registers itself as. Substituting our own name here would be a request
			// the provider has never seen from this client.
			referrer: "pi",
		},
		defaultTokenLifetimeSeconds: 3600,
		// xAI takes the access token exactly where an API key would go, so the
		// OpenAI Responses path needs nothing provider-specific.
		toAuth: (accessToken) => ({ apiKey: accessToken }),
	},
	"kimi-coding": {
		name: "Kimi For Coding (subscription)",
		loginLabel: "Sign in with Kimi For Coding",
		clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
		deviceCodeUrl: "https://auth.kimi.com/api/oauth/device_authorization",
		tokenUrl: "https://auth.kimi.com/api/oauth/token",
		defaultTokenLifetimeSeconds: 3600,
		// A bearer header rather than an api key: the endpoint speaks Anthropic
		// Messages, whose SDK would otherwise send `x-api-key`. pi's api layer
		// accepts an explicit `authorization` in its place, which is what makes
		// this reachable without a bespoke provider.
		toAuth: (accessToken) => ({ headers: { Authorization: `Bearer ${accessToken}` } }),
	},
};

/** The sign-ins that ask for a pasted authorization code. See the header. */
export const MANUAL_CODE_FLOWS: Readonly<Record<ManualCodeFlowId, ManualCodeFlow>> = {
	anthropic: {
		name: "Anthropic (Claude Pro/Max)",
		loginLabel: "Sign in with Claude Pro/Max",
		authorizeUrl: "https://claude.ai/oauth/authorize",
		tokenUrl: "https://platform.claude.com/v1/oauth/token",
		// pi's registered loopback address, verbatim. The user's browser lands
		// there and finds nothing — that is fine, because in this flow they copy
		// the address rather than wait for it to load.
		redirectUri: () => "http://localhost:53692/callback",
		grant: "token-pair",
		clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
		// pi's authorize request verbatim. `code: "true"` is what makes
		// Anthropic's page display the code as text instead of only redirecting —
		// the display the manual path reads from. Returned as URLSearchParams so
		// `has("state")` means "this flow sent a state", which the paste path
		// checks against; a flow that sends none is never asked to match one.
		authorizeQuery: ({ challenge, verifier, redirectUri }) =>
			new URLSearchParams({
				code: "true",
				client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
				response_type: "code",
				redirect_uri: redirectUri,
				scope:
					"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: verifier,
			}),
		// Copied from pi's anthropicOAuth.toAuth.
		toAuth: (accessToken) => ({ apiKey: accessToken }),
	},
	openrouter: {
		name: "OpenRouter (subscription)",
		loginLabel: "Sign in with OpenRouter",
		authorizeUrl: "https://openrouter.ai/auth",
		tokenUrl: "https://openrouter.ai/api/v1/auth/keys",
		// A fresh path per login, matching pi: the uuid is what makes a retried
		// sign-in a new request instead of a callback someone already used.
		redirectUri: () => `http://127.0.0.1:53692/oauth/callback/${crypto.randomUUID()}`,
		grant: "permanent-key",
		// pi's authorize request verbatim: OpenRouter's shape names the callback
		// rather than a redirect_uri, and carries no state — the exchange is tied
		// to the verifier alone, so the paste path has nothing to compare against.
		authorizeQuery: ({ challenge, redirectUri }) =>
			new URLSearchParams({
				callback_url: redirectUri,
				code_challenge: challenge,
				code_challenge_method: "S256",
			}),
		toAuth: (accessToken) => ({ apiKey: accessToken }),
	},
};

/**
 * The sign-ins in the order the settings dropdown lists them.
 *
 * Separate arrays rather than `Object.keys(...)` because the dropdown's order
 * is a decision, not an accident of object literal order, and because the
 * project's membership idiom is a readonly array (see `isWireProtocol`).
 */
export const OAUTH_FLOW_IDS: readonly OAuthFlowId[] = ["xai", "kimi-coding", "anthropic", "openrouter"];

/** Whether a persisted value names a sign-in this build still performs. */
export function isOAuthFlowId(value: unknown): value is OAuthFlowId {
	return typeof value === "string" && (OAUTH_FLOW_IDS as readonly string[]).includes(value);
}

/** Whether one id names a polling flow or a paste flow, for dispatch sites. */
function isDeviceCodeFlowId(id: OAuthFlowId): id is DeviceCodeFlowId {
	return id in DEVICE_CODE_FLOWS;
}

/**
 * The `OAuthAuth` a provider advertises for one sign-in.
 *
 * Built per `Models` instance rather than cached, because it closes over the
 * transport: a cached one would keep serving whichever `fetch` happened to
 * create it. Construction is a closure over a table row, so there is nothing to
 * save. The sleep injection exists for the polling flows' tests alone; a paste
 * flow has no wait to substitute, and passing one here would be a promise the
 * shape cannot keep.
 */
export function createOAuthAuth(id: OAuthFlowId, fetchImpl: FetchFn, sleep?: DeviceCodeDeps["sleep"]): OAuthAuth {
	if (isDeviceCodeFlowId(id)) {
		return createDeviceCodeOAuth(DEVICE_CODE_FLOWS[id], { fetch: fetchImpl, sleep });
	}
	return createManualCodeOAuth(MANUAL_CODE_FLOWS[id], { fetch: fetchImpl });
}

/** Display name for one sign-in, for panel copy that has to name the account. */
export function oauthFlowName(id: OAuthFlowId): string {
	return isDeviceCodeFlowId(id) ? DEVICE_CODE_FLOWS[id].name : MANUAL_CODE_FLOWS[id].name;
}
