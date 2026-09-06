/**
 * The subscription sign-ins this build can perform.
 *
 * Each entry is one provider's device-code flow, filled into the shape
 * `src/auth/deviceCode.ts` drives. Endpoints and client ids are copied verbatim
 * from pi's own implementations under
 * `node_modules/@earendil-works/pi-ai/dist/auth/oauth/`, which is the source of
 * truth for them; that file's header explains why the flow itself is
 * reimplemented rather than imported, and the copying is the cost that decision
 * carries — a provider that rotates a client id needs a change here.
 *
 * Two providers, not the three the issue's first stage listed. GitHub Copilot is
 * a different shape rather than a third instance of this one: its long-lived
 * credential is a GitHub OAuth token that every refresh exchanges for a
 * short-lived Copilot token, its request endpoint is parsed back out of that
 * token per credential, and pi's api layers reach for Copilot-specific headers
 * keyed on the literal provider id `github-copilot`. None of that fits a table
 * entry, and shipping it inside this commit would mean shipping it unverified.
 *
 * What makes a flow eligible here is narrow and worth stating, because it is the
 * question to ask of any candidate: the whole exchange has to be plain HTTPS
 * against endpoints the plugin can reach, with no local callback server and no
 * `node:` builtin. That rules Anthropic and OpenRouter out of *this* table for a
 * different reason than Copilot — they need a pasted authorization code rather
 * than a device code, which is a second interaction shape (`manual_code`) and
 * the next piece of work on issue #181, not a missing endpoint.
 */

import type { OAuthAuth } from "@earendil-works/pi-ai";
import type { FetchFn } from "../net/obsidianFetch";
import { createDeviceCodeOAuth, type DeviceCodeFlow } from "./deviceCode";

/**
 * Stable identifier for one sign-in, persisted on a provider row.
 *
 * Persisted, so these strings are a compatibility surface: renaming one orphans
 * every row that named it. They match pi's own provider ids so the two can be
 * read side by side.
 */
export type OAuthFlowId = "xai" | "kimi-coding";

/** Every sign-in this build can perform, keyed by its persisted id. */
export const OAUTH_FLOWS: Readonly<Record<OAuthFlowId, DeviceCodeFlow>> = {
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

/**
 * The sign-ins in the order the settings dropdown lists them.
 *
 * A separate array rather than `Object.keys(OAUTH_FLOWS)` because the dropdown's
 * order is a decision, not an accident of object literal order, and because the
 * project's membership idiom is a readonly array (see `isWireProtocol`).
 */
export const OAUTH_FLOW_IDS: readonly OAuthFlowId[] = ["xai", "kimi-coding"];

/** Whether a persisted value names a sign-in this build still performs. */
export function isOAuthFlowId(value: unknown): value is OAuthFlowId {
	return typeof value === "string" && (OAUTH_FLOW_IDS as readonly string[]).includes(value);
}

/**
 * The `OAuthAuth` a provider advertises for one sign-in.
 *
 * Built per `Models` instance rather than cached, because it closes over the
 * transport: a cached one would keep serving whichever `fetch` happened to
 * create it. Construction is a closure over a table row, so there is nothing to
 * save.
 */
export function createOAuthAuth(id: OAuthFlowId, fetchImpl: FetchFn): OAuthAuth {
	return createDeviceCodeOAuth(OAUTH_FLOWS[id], { fetch: fetchImpl });
}

/** Display name for one sign-in, for panel copy that has to name the account. */
export function oauthFlowName(id: OAuthFlowId): string {
	return OAUTH_FLOWS[id].name;
}
