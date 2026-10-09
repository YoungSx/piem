/**
 * The subscription sign-ins this build can perform, in two tables.
 *
 * Endpoints, client ids and redirect shapes are copied verbatim from pi's own
 * implementations under `node_modules/@earendil-works/pi-ai/dist/auth/oauth/`,
 * which is the source of truth for them; `deviceCode.ts`'s header explains why
 * the flows themselves are reimplemented rather than imported, and the copying
 * is the cost that decision carries — a provider that rotates a client id needs
 * a change here rather than a dependency bump.
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
 * Both tables use plain HTTPS against endpoints the plugin can reach via
 * Obsidian's `requestUrl`, with no local callback server and no `node:` builtin,
 * making them fully operational on mobile (iOS/Android) and desktop.
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
export type DeviceCodeFlowId = "github-copilot" | "meta" | "xai" | "kimi-coding";

/** Stable identifiers for the pasted-code sign-ins, same compatibility surface. */
export type ManualCodeFlowId = "anthropic" | "openrouter";

/** Every sign-in this build can perform, by its persisted id. */
export type OAuthFlowId = DeviceCodeFlowId | ManualCodeFlowId;

/**
 * Extracts the user-specific Copilot API proxy endpoint from their token if present.
 * Defaults to the standard individual Copilot proxy endpoint.
 */
export function extractCopilotBaseUrl(token: string): string {
	const match = token.match(/proxy-ep=([^;]+)/);
	if (!match || !match[1]) {
		return "https://api.individual.githubcopilot.com";
	}
	const host = match[1].replace(/^proxy\./, "api.");
	return `https://${host}`;
}

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
	"github-copilot": {
		name: "GitHub Copilot",
		loginLabel: "Sign in with GitHub Copilot",
		clientId: "Iv1.b507a08c87ecfe98",
		deviceCodeUrl: "https://github.com/login/device/code",
		tokenUrl: "https://github.com/login/oauth/access_token",
		deviceCodeFields: {
			scope: "read:user",
		},
		defaultTokenLifetimeSeconds: 1800,
		flavor: "github-copilot",
		toAuth: (accessToken) => ({
			apiKey: accessToken,
			baseUrl: extractCopilotBaseUrl(accessToken),
			headers: {
				"User-Agent": "GitHubCopilotChat/0.35.0",
				"Editor-Version": "vscode/1.107.0",
				"Editor-Plugin-Version": "copilot-chat/0.35.0",
				"Copilot-Integration-Id": "vscode-chat",
				"Openai-Intent": "conversation-edits",
			},
		}),
	},
	meta: {
		name: "Meta (Muse subscription)",
		loginLabel: "Sign in with Meta",
		clientId: "1031625952748946",
		deviceCodeUrl: "https://auth.meta.com/oidc/device/authorization/",
		tokenUrl: "https://auth.meta.com/oidc/device/token/",
		defaultTokenLifetimeSeconds: 86400,
		flavor: "meta",
		toAuth: (accessToken) => ({ apiKey: accessToken }),
	},
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
		// pi's authorize request verbatim: PKCE S256 with the verifier mirrored in
		// `state`, so the paste path can verify the returned state matches the
		// exchange it is finishing.
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
export const OAUTH_FLOW_IDS: readonly OAuthFlowId[] = [
	"github-copilot",
	"meta",
	"xai",
	"kimi-coding",
	"anthropic",
	"openrouter",
];

/** Whether a persisted value names a sign-in this build still performs. */
export function isOAuthFlowId(value: unknown): value is OAuthFlowId {
	return typeof value === "string" && (OAUTH_FLOW_IDS as readonly string[]).includes(value);
}

/** Whether one id names a polling flow or a paste flow, for dispatch sites. */
function isDeviceCodeFlowId(id: OAuthFlowId): id is DeviceCodeFlowId {
	return id in DEVICE_CODE_FLOWS;
}

/**
 * Presents one configured sign-in as the `OAuthAuth` pi expects.
 *
 * Dispatches on table membership rather than a discriminated union: the two
 * tables already know their shapes, so adding a discriminator would be a third
 * place to say what the tables already declare.
 */
export function createOAuthAuth(
	id: OAuthFlowId,
	fetchImpl: FetchFn,
	sleepImpl?: (ms: number, signal: AbortSignal) => Promise<void>,
): OAuthAuth {
	if (isDeviceCodeFlowId(id)) {
		return createDeviceCodeOAuth(DEVICE_CODE_FLOWS[id], { fetch: fetchImpl, sleep: sleepImpl });
	}
	return createManualCodeOAuth(MANUAL_CODE_FLOWS[id], { fetch: fetchImpl });
}

/** Label for the provider settings row when an OAuth flow is selected. */
export function oauthFlowName(id: OAuthFlowId): string {
	if (isDeviceCodeFlowId(id)) {
		return DEVICE_CODE_FLOWS[id].name;
	}
	return MANUAL_CODE_FLOWS[id].name;
}
