/**
 * The OAuth device-authorization flow (RFC 8628), implemented for Obsidian.
 *
 * pi ships this flow for seven providers already, and none of those
 * implementations can run here. Three independent reasons, each fatal on its
 * own:
 *
 * 1. **They call bare `fetch`.** There is no seam to pass a transport through —
 *    `OAuthAuth.login` takes an interaction and `refresh` takes a credential.
 *    Under Obsidian that resolves to the renderer's CORS-enforced `window.fetch`,
 *    and xAI's token endpoint answers a request from our origin with no
 *    `Access-Control-Allow-Origin` at all (measured 2026-09-06), so the browser
 *    discards a response the server happily sent. The only way to reach pi's
 *    implementation would be to swap `globalThis.fetch` for the duration —
 *    including during a refresh, which runs *concurrently with streaming* inside
 *    `credentials.modify` — which would redirect other plugins' and Obsidian's
 *    own requests through `requestUrl` for that window. Not a trade worth making
 *    for code we can write.
 * 2. **One of them drags a banned dependency.** `auth/oauth/github-copilot.js`
 *    imports `providers/github-copilot.models.js` at module scope, and
 *    `scripts/check-bundle.mjs` bans everything under `providers/` — 164 KiB of
 *    catalog JSON parsed on every launch.
 * 3. **Reaching them at all trips a ratchet.** `auth/oauth/load.js` imports
 *    through a variable specifier precisely so bundlers cannot follow it, which
 *    is the one construct Obsidian's eval-based loader cannot satisfy;
 *    `check-bundle` counts those and the budget is spent.
 *
 * So the flow lives here, taking its `fetch` as an argument. That is consistent
 * with where the rest of this plugin's provider concerns already sit: piem owns
 * provider registration, the model catalog, the connection presets, and the
 * transport choice, and uses pi-ai as a protocol library rather than a provider
 * registry. The cost is honest and worth stating: the client ids and endpoints
 * below are copied from pi's implementations, so a provider that rotates one
 * needs a change here rather than a dependency bump.
 *
 * The transport is pinned by the caller, and pinned to `requestUrl`. A token
 * exchange is a single-shot JSON round trip, so streaming buys nothing, and the
 * CORS measurement above says the streaming path cannot even complete. That is
 * the same rule `web_fetch`, skill import and the models.dev index already
 * follow.
 */

import type { ModelAuth, OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { FetchFn } from "../net/obsidianFetch";

/** What one provider's device-code flow differs in. */
export interface DeviceCodeFlow {
	/** Shown wherever the auth method is named, e.g. "xAI (Grok/X subscription)". */
	name: string;
	/** Call to action on the sign-in button, e.g. "Sign in with SuperGrok". */
	loginLabel: string;
	/** The public client id the provider issued for CLI-style clients. */
	clientId: string;
	/** Where a device code is requested. */
	deviceCodeUrl: string;
	/** Where a device code, and later a refresh token, is exchanged. */
	tokenUrl: string;
	/** Extra form fields this provider's device request expects. */
	deviceCodeFields?: Readonly<Record<string, string>>;
	/** Lifetime to assume when a token response omits `expires_in`. */
	defaultTokenLifetimeSeconds: number;
	/**
	 * How a live access token authenticates an ordinary model request.
	 *
	 * A function rather than a flag because providers disagree: xAI takes the
	 * token as the API key its SDK would send, while Kimi wants an explicit
	 * `Authorization: Bearer` — which pi's Anthropic path accepts in place of
	 * `x-api-key`.
	 */
	toAuth(accessToken: string): ModelAuth;
}

export interface DeviceCodeDeps {
	/**
	 * The transport every request in this flow goes through.
	 *
	 * Required rather than defaulted so the pinning decision is visible at the
	 * wiring site, next to the other transport choices, instead of buried here.
	 */
	fetch: FetchFn;
	/**
	 * Waits, or rejects when the signal fires. Injectable so the polling cases
	 * assert backoff arithmetic without spending the wall-clock time it describes.
	 */
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Message every cancellation in this flow rejects with. */
export const LOGIN_CANCELLED = "Sign-in cancelled";

/** RFC 8628 §3.2: a server that omits `interval` means five seconds. */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
/** RFC 8628 §3.5: `slow_down` means add five seconds to the interval. */
const SLOW_DOWN_INCREMENT_MS = 5_000;
/** Floor on the poll interval, so a server reporting 0 cannot spin. */
const MIN_POLL_INTERVAL_MS = 1_000;
/** Ceiling on the wait when a server omits `expires_in`. */
const DEFAULT_DEVICE_CODE_LIFETIME_SECONDS = 15 * 60;

/** Waits `ms`, rejecting instead if `signal` fires first. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error(LOGIN_CANCELLED));
			return;
		}
		const onAbort = (): void => {
			window.clearTimeout(timer);
			reject(new Error(LOGIN_CANCELLED));
		};
		// `window.setTimeout` rather than the global, per Obsidian's own rule: a
		// popout window has its own timer scope, and the bare call resolves against
		// the wrong one there.
		const timer = window.setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/** A form POST that came back, whatever its status. */
interface FormResponse {
	ok: boolean;
	status: number;
	body: Record<string, unknown>;
}

/**
 * Posts a form-encoded body and reads a JSON object back.
 *
 * Non-JSON and non-object bodies become `{}` rather than an error, because the
 * status is the part that decides and every caller here already has a message
 * for "the provider said no". An empty body on a 200 then fails in the parser
 * below, which names the missing field.
 */
async function postForm(
	fetchImpl: FetchFn,
	url: string,
	fields: Readonly<Record<string, string>>,
	signal: AbortSignal,
): Promise<FormResponse> {
	const response = await fetchImpl(url, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(fields).toString(),
		signal,
	});
	let body: Record<string, unknown> = {};
	try {
		const parsed: unknown = await response.json();
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			body = parsed as Record<string, unknown>;
		}
	} catch {
		// Left as `{}`. See the doc comment.
	}
	return { ok: response.ok, status: response.status, body };
}

/** The provider's own error text when it has one, for a message worth reading. */
function describeFailure(flow: DeviceCodeFlow, action: string, response: FormResponse): Error {
	const error = typeof response.body.error === "string" ? response.body.error : undefined;
	const description = typeof response.body.error_description === "string" ? response.body.error_description : undefined;
	const detail = [error, description].filter(Boolean).join(": ");
	return new Error(`${flow.name} ${action} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
}

function readString(body: Record<string, unknown>, field: string): string | undefined {
	const value = body[field];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readPositiveNumber(body: Record<string, unknown>, field: string): number | undefined {
	const value = body[field];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * A verification URL safe to hand the user, or undefined.
 *
 * https only. The URL comes off the wire and ends up somewhere the user clicks,
 * so a response that names another scheme is not a URL to open — it is the one
 * input in this flow an attacker would aim at. Both providers here publish https
 * endpoints, so the restriction costs nothing real.
 */
function trustedUrl(raw: string | undefined): string | undefined {
	if (!raw) {
		return undefined;
	}
	try {
		return new URL(raw).protocol === "https:" ? new URL(raw).href : undefined;
	} catch {
		return undefined;
	}
}

/** The device authorization a provider granted, normalized. */
export interface DeviceAuthorization {
	deviceCode: string;
	userCode: string;
	/** Where the user goes. Prefers the pre-filled form when the server offers one. */
	verificationUri: string;
	intervalSeconds: number;
	expiresInSeconds: number;
}

/** Asks the provider for a device code, or throws with its reason. */
export async function requestDeviceAuthorization(
	flow: DeviceCodeFlow,
	deps: DeviceCodeDeps,
	signal: AbortSignal,
): Promise<DeviceAuthorization> {
	const response = await postForm(
		deps.fetch,
		flow.deviceCodeUrl,
		{ client_id: flow.clientId, ...flow.deviceCodeFields },
		signal,
	);
	if (!response.ok) {
		throw describeFailure(flow, "device authorization", response);
	}
	const deviceCode = readString(response.body, "device_code");
	const userCode = readString(response.body, "user_code");
	// The complete form embeds the code so the user does not retype it; the plain
	// one is the fallback, and the code is displayed either way.
	const verificationUri =
		trustedUrl(readString(response.body, "verification_uri_complete")) ??
		trustedUrl(readString(response.body, "verification_uri"));
	if (!deviceCode || !userCode || !verificationUri) {
		throw new Error(`${flow.name} returned an unusable device authorization response.`);
	}
	return {
		deviceCode,
		userCode,
		verificationUri,
		intervalSeconds: readPositiveNumber(response.body, "interval") ?? DEFAULT_POLL_INTERVAL_SECONDS,
		expiresInSeconds: readPositiveNumber(response.body, "expires_in") ?? DEFAULT_DEVICE_CODE_LIFETIME_SECONDS,
	};
}

/**
 * Turns a token response into a credential.
 *
 * `expires` is the moment the token actually dies, with no safety margin
 * subtracted. pi already refreshes anything with under five minutes left
 * (`resolveStoredOAuth`), so baking a second margin in here would only move the
 * refresh ten minutes early while making the stored number mean something other
 * than what it says.
 *
 * A missing `refresh_token` reuses the one we sent. Providers differ on whether
 * a refresh rotates it, and treating "unchanged" as an error would sign the user
 * out of a working session.
 */
function credentialFromTokenBody(
	flow: DeviceCodeFlow,
	body: Record<string, unknown>,
	previousRefresh: string | undefined,
	now: number,
): OAuthCredential {
	const access = readString(body, "access_token");
	const refresh = readString(body, "refresh_token") ?? previousRefresh;
	if (!access || !refresh) {
		throw new Error(`${flow.name} returned a token response without the fields needed to stay signed in.`);
	}
	const lifetime = readPositiveNumber(body, "expires_in") ?? flow.defaultTokenLifetimeSeconds;
	return { type: "oauth", access, refresh, expires: now + lifetime * 1000 };
}

/** What one poll of the token endpoint concluded. */
type PollOutcome =
	| { status: "pending" }
	| { status: "slow_down"; intervalSeconds?: number }
	| { status: "failed"; message: string }
	| { status: "complete"; credential: OAuthCredential };

/** Reads one token-endpoint response as a poll outcome. */
function readPollOutcome(flow: DeviceCodeFlow, response: FormResponse, now: number): PollOutcome {
	if (response.ok) {
		try {
			return { status: "complete", credential: credentialFromTokenBody(flow, response.body, undefined, now) };
		} catch (error) {
			return { status: "failed", message: error instanceof Error ? error.message : String(error) };
		}
	}
	const error = readString(response.body, "error");
	if (error === "authorization_pending") {
		return { status: "pending" };
	}
	if (error === "slow_down") {
		return { status: "slow_down", intervalSeconds: readPositiveNumber(response.body, "interval") };
	}
	if (error === "access_denied" || error === "authorization_denied") {
		return { status: "failed", message: `${flow.name} sign-in was denied.` };
	}
	if (error === "expired_token") {
		return { status: "failed", message: `The ${flow.name} sign-in code expired. Start again.` };
	}
	// A 5xx is the one case worth distinguishing from a protocol error: nothing
	// about the device code is wrong, so saying "expired" would send the user
	// round a loop that cannot help.
	if (response.status >= 500) {
		return { status: "failed", message: `${flow.name} is not responding (HTTP ${response.status}). Try again shortly.` };
	}
	return { status: "failed", message: describeFailure(flow, "device token exchange", response).message };
}

/**
 * Polls the token endpoint until the user finishes, the code expires, or the
 * flow is cancelled.
 *
 * The interval is the server's, floored at a second and raised on `slow_down` —
 * preferring the interval the server names over a locally tracked one, because a
 * client whose clock drifts (a VM, a suspended laptop) otherwise polls early
 * forever and never leaves the backoff.
 *
 * The first wait happens *before* the first poll. The user has not had time to
 * open a browser, so an immediate poll is a guaranteed `authorization_pending`
 * that only spends a request against the provider's rate limit.
 */
export async function pollDeviceAuthorization(
	flow: DeviceCodeFlow,
	deps: DeviceCodeDeps,
	device: DeviceAuthorization,
	signal: AbortSignal,
	now: () => number = Date.now,
): Promise<OAuthCredential> {
	const sleep = deps.sleep ?? abortableSleep;
	const deadline = now() + device.expiresInSeconds * 1000;
	let intervalMs = Math.max(MIN_POLL_INTERVAL_MS, Math.floor(device.intervalSeconds * 1000));
	const waitOrStop = async (): Promise<boolean> => {
		const remaining = deadline - now();
		if (remaining <= 0) {
			return false;
		}
		await sleep(Math.min(intervalMs, remaining), signal);
		return true;
	};
	if (!(await waitOrStop())) {
		throw new Error(`The ${flow.name} sign-in code expired. Start again.`);
	}
	while (now() < deadline) {
		signal.throwIfAborted();
		const response = await postForm(
			deps.fetch,
			flow.tokenUrl,
			{
				client_id: flow.clientId,
				device_code: device.deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			},
			signal,
		);
		const outcome = readPollOutcome(flow, response, now());
		if (outcome.status === "complete") {
			return outcome.credential;
		}
		if (outcome.status === "failed") {
			throw new Error(outcome.message);
		}
		if (outcome.status === "slow_down") {
			intervalMs =
				outcome.intervalSeconds !== undefined
					? Math.max(MIN_POLL_INTERVAL_MS, Math.floor(outcome.intervalSeconds * 1000))
					: Math.max(MIN_POLL_INTERVAL_MS, intervalMs + SLOW_DOWN_INCREMENT_MS);
		}
		if (!(await waitOrStop())) {
			break;
		}
	}
	throw new Error(`The ${flow.name} sign-in code expired. Start again.`);
}

/**
 * Presents one device-code flow as the `OAuthAuth` a pi provider advertises.
 *
 * There is deliberately no retry around `refresh`. pi runs it inside the
 * credential-store lock under a 15-second `AbortSignal.timeout`, so a backoff
 * loop long enough to help would be cut off mid-wait — and while it waited it
 * would hold the lock every concurrent request is queued behind. A failed
 * refresh surfaces as `ModelsError` code `"oauth"`, which leaves the stored
 * credential in place for the next request to retry; that is the retry.
 */
export function createDeviceCodeOAuth(flow: DeviceCodeFlow, deps: DeviceCodeDeps): OAuthAuth {
	return {
		name: flow.name,
		isSubscription: true,
		loginLabel: flow.loginLabel,
		async login(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
			const device = await requestDeviceAuthorization(flow, deps, interaction.signal);
			interaction.notify({
				type: "device_code",
				userCode: device.userCode,
				verificationUri: device.verificationUri,
				intervalSeconds: device.intervalSeconds,
				expiresInSeconds: device.expiresInSeconds,
			});
			return pollDeviceAuthorization(flow, deps, device, interaction.signal);
		},
		async refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
			const response = await postForm(
				deps.fetch,
				flow.tokenUrl,
				{ client_id: flow.clientId, grant_type: "refresh_token", refresh_token: credential.refresh },
				signal,
			);
			if (!response.ok) {
				throw describeFailure(flow, "token refresh", response);
			}
			return credentialFromTokenBody(flow, response.body, credential.refresh, Date.now());
		},
		async toAuth(credential: OAuthCredential): Promise<ModelAuth> {
			return flow.toAuth(credential.access);
		},
	};
}
