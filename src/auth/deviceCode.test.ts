/**
 * The device-code flow, driven against a scripted transport.
 *
 * Everything interesting here is protocol arithmetic — when to wait, how long,
 * what a `slow_down` does to the next interval, which token response is usable —
 * so the transport is a queue of canned replies and `sleep` is a recorder. That
 * is the only way these cases can assert the backoff *rule* rather than spend the
 * wall-clock time it describes; a test that actually slept five seconds would
 * assert nothing except that `setTimeout` works.
 *
 * The counterpart cases that need real timers ({@link abortableSleep}) install
 * `window` themselves rather than relying on another test file having done it.
 */

import { describe, expect, it } from "bun:test";
import { stubWindowTimers } from "../testUtils/windowStub";
import type { FetchFn } from "../net/obsidianFetch";
import {
	LOGIN_CANCELLED,
	abortableSleep,
	createDeviceCodeOAuth,
	pollDeviceAuthorization,
	requestDeviceAuthorization,
	type DeviceCodeFlow,
} from "./deviceCode";

const FLOW: DeviceCodeFlow = {
	name: "Test Provider",
	loginLabel: "Sign in with Test",
	clientId: "client-1",
	deviceCodeUrl: "https://auth.example.com/device",
	tokenUrl: "https://auth.example.com/token",
	deviceCodeFields: { scope: "offline_access", referrer: "pi" },
	defaultTokenLifetimeSeconds: 3600,
	toAuth: (accessToken) => ({ apiKey: accessToken }),
};

interface Call {
	url: string;
	headers?: Record<string, string>;
	fields: Record<string, string>;
	json?: unknown;
}

/** A transport serving canned replies in order, recording what it was asked. */
function scriptedFetch(replies: { status?: number; body?: unknown; text?: string }[]): {
	fetch: FetchFn;
	calls: Call[];
} {
	const calls: Call[] = [];
	let index = 0;
	const fetch: FetchFn = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const raw = String(init?.body ?? "");
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch {
			// not json
		}
		const fields = Object.fromEntries(new URLSearchParams(raw));
		const rawHeaders = init?.headers;
		const headers: Record<string, string> =
			rawHeaders instanceof Headers
				? Object.fromEntries(rawHeaders.entries())
				: Array.isArray(rawHeaders)
					? Object.fromEntries(rawHeaders)
					: typeof rawHeaders === "object" && rawHeaders !== null
						? (rawHeaders as Record<string, string>)
						: {};
		calls.push({ url, headers, fields, json });
		const reply = replies[Math.min(index, replies.length - 1)];
		index += 1;
		if (!reply) {
			throw new Error("scriptedFetch ran out of replies");
		}
		const status = reply.status ?? 200;
		const body = reply.text ?? JSON.stringify(reply.body ?? {});
		return new Response(status === 204 ? null : body, { status });
	};
	return { fetch, calls };
}

/**
 * A clock and a `sleep` that move together, recording every wait.
 *
 * One helper rather than two because they cannot be independent: a `sleep` that
 * returns without advancing the clock makes the expiry deadline unreachable, and
 * the poll loop then runs forever against a transport that keeps replaying
 * `authorization_pending`. Time passing *is* the sleep, so the fake says so.
 */
function fakeClock(start = 1_700_000_000_000): {
	now: () => number;
	sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	waits: number[];
} {
	let value = start;
	const waits: number[] = [];
	return {
		now: () => value,
		waits,
		sleep: async (ms, signal) => {
			if (signal.aborted) {
				throw new Error(LOGIN_CANCELLED);
			}
			waits.push(ms);
			value += ms;
		},
	};
}

const DEVICE_BODY = {
	device_code: "dc-1",
	user_code: "WDJB-MJHT",
	verification_uri: "https://example.com/activate",
	interval: 5,
	expires_in: 900,
};

describe("requestDeviceAuthorization", () => {
	it("posts the client id and extra fields, returning the parsed response", async () => {
		const { fetch, calls } = scriptedFetch([{ body: DEVICE_BODY }]);
		const device = await requestDeviceAuthorization(FLOW, { fetch }, new AbortController().signal);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://auth.example.com/device");
		expect(calls[0]?.fields).toEqual({
			client_id: "client-1",
			scope: "offline_access",
			referrer: "pi",
		});
		expect(device).toEqual({
			deviceCode: "dc-1",
			userCode: "WDJB-MJHT",
			verificationUri: "https://example.com/activate",
			intervalSeconds: 5,
			expiresInSeconds: 900,
		});
	});

	it("prefers verification_uri_complete when the server offers one", async () => {
		const { fetch } = scriptedFetch([
			{
				body: {
					...DEVICE_BODY,
					verification_uri_complete: "https://example.com/activate?user_code=WDJB-MJHT",
				},
			},
		]);
		const device = await requestDeviceAuthorization(FLOW, { fetch }, new AbortController().signal);
		expect(device.verificationUri).toBe("https://example.com/activate?user_code=WDJB-MJHT");
	});

	it("rejects a verification URL whose scheme is not https", async () => {
		// A compromised or misconfigured server might redirect to a custom scheme
		// or javascript: URL that this plugin would pass to `open`; https is the
		// only scheme the flow has any reason to accept.
		const { fetch } = scriptedFetch([{ body: { ...DEVICE_BODY, verification_uri: "http://example.com/activate" } }]);
		await expect(requestDeviceAuthorization(FLOW, { fetch }, new AbortController().signal)).rejects.toThrow("unusable");
	});

	it("fails with the provider's reason when the device request is refused", async () => {
		const { fetch } = scriptedFetch([
			{ status: 400, body: { error: "unauthorized_client", error_description: "bad client id" } },
		]);
		await expect(requestDeviceAuthorization(FLOW, { fetch }, new AbortController().signal)).rejects.toThrow(
			"Test Provider device authorization failed (HTTP 400): unauthorized_client: bad client id",
		);
	});
});

describe("pollDeviceAuthorization", () => {
	const DEVICE = {
		deviceCode: "dc-1",
		userCode: "WDJB-MJHT",
		verificationUri: "https://example.com/activate",
		intervalSeconds: 5,
		expiresInSeconds: 900,
	};

	it("waits the full interval BEFORE the first poll", async () => {
		// The user cannot have typed a code before opening the page; an immediate
		// poll is an empty round trip that wastes rate limit.
		const { fetch, calls } = scriptedFetch([
			{ body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 } },
		]);
		const { sleep, waits, now } = fakeClock();
		await pollDeviceAuthorization(FLOW, { fetch, sleep }, DEVICE, new AbortController().signal, now);
		expect(waits[0]).toBe(5000);
		expect(calls).toHaveLength(1);
	});

	it("polls repeatedly while the provider answers authorization_pending", async () => {
		const { fetch, calls } = scriptedFetch([
			{ status: 400, body: { error: "authorization_pending" } },
			{ status: 400, body: { error: "authorization_pending" } },
			{ body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 } },
		]);
		const { sleep, waits, now } = fakeClock();
		const credential = await pollDeviceAuthorization(
			FLOW,
			{ fetch, sleep },
			DEVICE,
			new AbortController().signal,
			now,
		);
		expect(calls).toHaveLength(3);
		expect(waits).toEqual([5000, 5000, 5000]);
		expect(credential).toEqual({
			type: "oauth",
			access: "at-1",
			refresh: "rt-1",
			expires: 1_700_000_000_000 + 15_000 + 3600 * 1000,
		});
	});

	it("adds five seconds to the interval when the server answers slow_down", async () => {
		// RFC 8628 §3.5: each slow_down must increase the interval by 5 seconds.
		const { fetch } = scriptedFetch([
			{ status: 400, body: { error: "slow_down" } },
			{ status: 400, body: { error: "authorization_pending" } },
			{ body: { access_token: "at", refresh_token: "rt", expires_in: 3600 } },
		]);
		const { sleep, waits, now } = fakeClock();
		await pollDeviceAuthorization(FLOW, { fetch, sleep }, DEVICE, new AbortController().signal, now);
		// First wait is initial interval (5s); slow_down raises it to 10s for the
		// next wait; subsequent pending keeps the 10s.
		expect(waits).toEqual([5000, 10_000, 10_000]);
	});

	it("obeys a server-supplied interval on slow_down when provided", async () => {
		const { fetch } = scriptedFetch([
			{ status: 400, body: { error: "slow_down", interval: 15 } },
			{ body: { access_token: "at", refresh_token: "rt", expires_in: 3600 } },
		]);
		const { sleep, waits, now } = fakeClock();
		await pollDeviceAuthorization(FLOW, { fetch, sleep }, DEVICE, new AbortController().signal, now);
		expect(waits).toEqual([5000, 15_000]);
	});

	it("fails with a clear message when the user denies the request", async () => {
		const { fetch } = scriptedFetch([{ status: 400, body: { error: "access_denied" } }]);
		const { sleep, now } = fakeClock();
		await expect(
			pollDeviceAuthorization(FLOW, { fetch, sleep }, DEVICE, new AbortController().signal, now),
		).rejects.toThrow("Test Provider sign-in was denied");
	});

	it("fails when the device code expires on the server", async () => {
		const { fetch } = scriptedFetch([{ status: 400, body: { error: "expired_token" } }]);
		const { sleep, now } = fakeClock();
		await expect(
			pollDeviceAuthorization(FLOW, { fetch, sleep }, DEVICE, new AbortController().signal, now),
		).rejects.toThrow("code expired");
	});

	it("fails locally when the deadline passes without the server completing", async () => {
		// A server that answers authorization_pending past `expires_in` would loop
		// indefinitely without a client-side ceiling.
		const shortLived = { ...DEVICE, expiresInSeconds: 12 };
		const { fetch } = scriptedFetch([{ status: 400, body: { error: "authorization_pending" } }]);
		const { sleep, now } = fakeClock();
		await expect(
			pollDeviceAuthorization(FLOW, { fetch, sleep }, shortLived, new AbortController().signal, now),
		).rejects.toThrow("code expired");
	});

	it("distinguishes a 5xx from a protocol denial so the user knows the server is down", async () => {
		const { fetch } = scriptedFetch([{ status: 503, text: "Service Unavailable" }]);
		const { sleep, now } = fakeClock();
		await expect(
			pollDeviceAuthorization(FLOW, { fetch, sleep }, DEVICE, new AbortController().signal, now),
		).rejects.toThrow("HTTP 503");
	});

	it("rejects a success body that cannot keep the session signed in", async () => {
		// No refresh token, and none to carry over on a first exchange: the session
		// would work until the access token died and then strand the user.
		const { fetch } = scriptedFetch([{ body: { access_token: "at", expires_in: 3600 } }]);
		const { sleep, now } = fakeClock();
		await expect(
			pollDeviceAuthorization(FLOW, { fetch, sleep }, DEVICE, new AbortController().signal, now),
		).rejects.toThrow("stay signed in");
	});

	it("stops when the flow is cancelled mid-wait", async () => {
		const controller = new AbortController();
		const { fetch } = scriptedFetch([{ status: 400, body: { error: "authorization_pending" } }]);
		const sleep = async (_ms: number, signal: AbortSignal): Promise<void> => {
			controller.abort();
			if (signal.aborted) {
				throw new Error(LOGIN_CANCELLED);
			}
		};
		await expect(
			pollDeviceAuthorization(FLOW, { fetch, sleep }, DEVICE, controller.signal, fakeClock().now),
		).rejects.toThrow(LOGIN_CANCELLED);
	});
});

describe("createDeviceCodeOAuth", () => {
	it("advertises itself as a subscription with the flow's own labels", () => {
		const { fetch } = scriptedFetch([{}]);
		const auth = createDeviceCodeOAuth(FLOW, { fetch });
		expect(auth.name).toBe("Test Provider");
		expect(auth.isSubscription).toBe(true);
		expect(auth.loginLabel).toBe("Sign in with Test");
	});

	it("notifies the device code before it starts polling", async () => {
		// The modal has nothing to show until this arrives, and it arrives before the
		// first wait — which is the whole reason the wait comes first.
		const { fetch } = scriptedFetch([
			{ body: DEVICE_BODY },
			{ body: { access_token: "at", refresh_token: "rt", expires_in: 3600 } },
		]);
		const events: unknown[] = [];
		const auth = createDeviceCodeOAuth(FLOW, { fetch, sleep: async () => {} });
		const credential = await auth.login({
			signal: new AbortController().signal,
			prompt: async () => {
				throw new Error("a device-code flow asks nothing of the user");
			},
			notify: (event) => events.push(event),
		});
		expect(events).toEqual([
			{
				type: "device_code",
				userCode: "WDJB-MJHT",
				verificationUri: "https://example.com/activate",
				intervalSeconds: 5,
				expiresInSeconds: 900,
			},
		]);
		expect(credential.access).toBe("at");
	});

	it("exchanges the refresh token", async () => {
		const { fetch, calls } = scriptedFetch([{ body: { access_token: "at-2", refresh_token: "rt-2", expires_in: 900 } }]);
		const auth = createDeviceCodeOAuth(FLOW, { fetch });
		const next = await auth.refresh(
			{ type: "oauth", access: "at-1", refresh: "rt-1", expires: 0 },
			new AbortController().signal,
		);
		expect(calls[0]?.fields).toEqual({ client_id: "client-1", grant_type: "refresh_token", refresh_token: "rt-1" });
		expect(next.access).toBe("at-2");
		expect(next.refresh).toBe("rt-2");
	});

	it("keeps the old refresh token when the provider does not rotate it", async () => {
		// Providers disagree on rotation, and treating "unchanged" as an error would
		// sign the user out of a session that is working.
		const { fetch } = scriptedFetch([{ body: { access_token: "at-2", expires_in: 900 } }]);
		const auth = createDeviceCodeOAuth(FLOW, { fetch });
		const next = await auth.refresh(
			{ type: "oauth", access: "at-1", refresh: "rt-1", expires: 0 },
			new AbortController().signal,
		);
		expect(next.refresh).toBe("rt-1");
	});

	it("fails the refresh with the provider's reason rather than silently signing out", async () => {
		// pi turns this into `ModelsError` code "oauth", which keeps the stored
		// credential for a retry and tells the panel to offer re-login.
		const { fetch } = scriptedFetch([{ status: 400, body: { error: "invalid_grant" } }]);
		const auth = createDeviceCodeOAuth(FLOW, { fetch });
		await expect(
			auth.refresh({ type: "oauth", access: "a", refresh: "r", expires: 0 }, new AbortController().signal),
		).rejects.toThrow("token refresh failed (HTTP 400): invalid_grant");
	});

	it("derives request auth the way the flow says, without touching the network", async () => {
		const { fetch, calls } = scriptedFetch([{}]);
		const bearer = createDeviceCodeOAuth(
			{ ...FLOW, toAuth: (token) => ({ headers: { Authorization: `Bearer ${token}` } }) },
			{ fetch },
		);
		expect(await bearer.toAuth({ type: "oauth", access: "at", refresh: "rt", expires: 0 })).toEqual({
			headers: { Authorization: "Bearer at" },
		});
		expect(calls).toHaveLength(0);
	});
});

describe("abortableSleep", () => {
	it("resolves after the delay", async () => {
		const restore = stubWindowTimers();
		try {
			const started = Date.now();
			await abortableSleep(5, new AbortController().signal);
			expect(Date.now() - started).toBeGreaterThanOrEqual(4);
		} finally {
			restore();
		}
	});

	it("rejects immediately on an already-aborted signal", async () => {
		const restore = stubWindowTimers();
		try {
			await expect(abortableSleep(60_000, AbortSignal.abort())).rejects.toThrow(LOGIN_CANCELLED);
		} finally {
			restore();
		}
	});

	it("rejects when the signal fires mid-wait, and clears its timer", async () => {
		// A left-armed timer keeps the wait alive after the user has cancelled, which
		// is a whole poll interval of a flow nobody is watching.
		const restore = stubWindowTimers();
		try {
			const controller = new AbortController();
			const waiting = abortableSleep(60_000, controller.signal);
			controller.abort();
			await expect(waiting).rejects.toThrow(LOGIN_CANCELLED);
		} finally {
			restore();
		}
	});
});

describe("openai-codex device authorization", () => {
	const OPENAI_FLOW: DeviceCodeFlow = {
		name: "OpenAI (ChatGPT Plus/Pro)",
		loginLabel: "Sign in with ChatGPT Plus/Pro",
		clientId: "app_test",
		deviceCodeUrl: "https://auth.openai.com/api/accounts/deviceauth/usercode",
		tokenUrl: "https://auth.openai.com/oauth/token",
		defaultTokenLifetimeSeconds: 3600,
		flavor: "openai-codex",
		verificationUri: "https://auth.openai.com/codex/device",
		pollUrl: "https://auth.openai.com/api/accounts/deviceauth/token",
		redirectUri: "https://auth.openai.com/deviceauth/callback",
		toAuth: (accessToken) => ({ apiKey: accessToken }),
	};

	function fakeJwt(accountId?: string): string {
		const header = btoa(JSON.stringify({ alg: "RS256" }));
		const payloadObj = accountId
			? { "https://api.openai.com/auth": { chatgpt_account_id: accountId } }
			: {};
		const payload = btoa(JSON.stringify(payloadObj));
		return `${header}.${payload}.sig`;
	}

	it("requests device authorization using JSON and default verificationUri", async () => {
		const { fetch, calls } = scriptedFetch([
			{ body: { device_auth_id: "da-123", user_code: "OPEN-1234", interval: 5 } },
		]);
		const auth = await requestDeviceAuthorization(OPENAI_FLOW, { fetch }, new AbortController().signal);
		expect(auth.deviceCode).toBe("da-123");
		expect(auth.userCode).toBe("OPEN-1234");
		expect(auth.verificationUri).toBe("https://auth.openai.com/codex/device");
		expect(calls[0]?.json).toEqual({ client_id: "app_test" });
	});

	it("polls with JSON, backs up on slow_down, and exchanges authorization code", async () => {
		const token = fakeJwt("acct_chatgpt_456");
		const { fetch, calls } = scriptedFetch([
			{ status: 403, body: { error: { code: "deviceauth_authorization_pending" } } },
			{ status: 400, body: { error: "slow_down" } },
			{ body: { authorization_code: "code_999", code_verifier: "verifier_888" } },
			{ body: { access_token: token, refresh_token: "rf_000", expires_in: 3600 } },
		]);
		const { sleep, waits, now } = fakeClock();
		const credential = await pollDeviceAuthorization(
			OPENAI_FLOW,
			{ fetch, sleep },
			{
				deviceCode: "da-123",
				userCode: "OPEN-1234",
				verificationUri: "https://auth.openai.com/codex/device",
				intervalSeconds: 5,
				expiresInSeconds: 900,
			},
			new AbortController().signal,
			now,
		);

		expect(credential.access).toBe(token);
		expect(credential.refresh).toBe("rf_000");
		expect(credential.accountId).toBe("acct_chatgpt_456");
		expect(waits).toEqual([5000, 5000, 10_000]);

		expect(calls[0]?.json).toEqual({ device_auth_id: "da-123", user_code: "OPEN-1234" });
		expect(calls[3]?.fields).toEqual({
			grant_type: "authorization_code",
			client_id: "app_test",
			code: "code_999",
			code_verifier: "verifier_888",
			redirect_uri: "https://auth.openai.com/deviceauth/callback",
		});
	});
});

describe("meta device authorization", () => {
	const META_FLOW: DeviceCodeFlow = {
		name: "Meta (Muse subscription)",
		loginLabel: "Sign in with Meta",
		clientId: "1031625952748946",
		deviceCodeUrl: "https://auth.meta.com/oidc/device/authorization/",
		tokenUrl: "https://auth.meta.com/oidc/device/token/",
		defaultTokenLifetimeSeconds: 86400,
		flavor: "meta",
		toAuth: (accessToken) => ({ apiKey: accessToken }),
	};

	it("polls token endpoint, mints Model API key and sets 24h expiration", async () => {
		const { fetch, calls } = scriptedFetch([
			{ body: { access_token: "meta_identity_token_123", expires_in: 86400 } },
			{ body: { api_key: "muse_model_key_456" } },
		]);
		const { sleep, now } = fakeClock();
		const credential = await pollDeviceAuthorization(
			META_FLOW,
			{ fetch, sleep },
			{
				deviceCode: "meta-dc-1",
				userCode: "ABCD-EFGH",
				verificationUri: "https://auth.meta.com",
				intervalSeconds: 5,
				expiresInSeconds: 300,
			},
			new AbortController().signal,
			now,
		);

		expect(credential.access).toBe("muse_model_key_456");
		expect(credential.refresh).toBe("meta_identity_token_123");
		expect(credential.expires).toBe(1_700_000_000_000 + 5000 + 24 * 60 * 60 * 1000);

		expect(calls[0]?.url).toBe("https://auth.meta.com/oidc/device/token/");
		expect(calls[1]?.url).toBe("https://api.meta.ai/muse-code/key");
		expect(calls[1]?.headers?.Authorization).toBe("Bearer meta_identity_token_123");
	});

	it("refreshes Meta credential by re-minting an API key", async () => {
		const { fetch, calls } = scriptedFetch([
			{ body: { api_key: "refreshed_muse_key_789" } },
		]);
		const auth = createDeviceCodeOAuth(META_FLOW, { fetch });
		const next = await auth.refresh(
			{ type: "oauth", access: "old_key", refresh: "saved_identity_token", expires: 0 },
			new AbortController().signal,
		);
		expect(next.access).toBe("refreshed_muse_key_789");
		expect(next.refresh).toBe("saved_identity_token");
		expect(calls[0]?.url).toBe("https://api.meta.ai/muse-code/key");
		expect(calls[0]?.headers?.Authorization).toBe("Bearer saved_identity_token");
	});

	it("fails refresh when Meta session has expired", async () => {
		const { fetch } = scriptedFetch([
			{ status: 401, body: { error: "unauthorized" } },
		]);
		const auth = createDeviceCodeOAuth(META_FLOW, { fetch });
		await expect(
			auth.refresh(
				{ type: "oauth", access: "old_key", refresh: "expired_identity_token", expires: 0 },
				new AbortController().signal,
			),
		).rejects.toThrow("Meta session expired");
	});
});

describe("github-copilot device authorization", () => {
	const COPILOT_FLOW: DeviceCodeFlow = {
		name: "GitHub Copilot",
		loginLabel: "Sign in with GitHub Copilot",
		clientId: "Iv1.b507a08c87ecfe98",
		deviceCodeUrl: "https://github.com/login/device/code",
		tokenUrl: "https://github.com/login/oauth/access_token",
		deviceCodeFields: { scope: "read:user" },
		defaultTokenLifetimeSeconds: 1800,
		flavor: "github-copilot",
		toAuth: (accessToken) => ({
			apiKey: accessToken,
			headers: { "Editor-Version": "vscode/1.107.0", "Copilot-Integration-Id": "vscode-chat" },
		}),
	};

	it("sends User-Agent on device code request", async () => {
		const { fetch, calls } = scriptedFetch([
			{ body: { device_code: "gh_dc", user_code: "1234-5678", verification_uri: "https://github.com/login/device" } },
		]);
		const auth = await requestDeviceAuthorization(COPILOT_FLOW, { fetch }, new AbortController().signal);
		expect(auth.deviceCode).toBe("gh_dc");
		expect(auth.userCode).toBe("1234-5678");
		expect(calls[0]?.headers?.["User-Agent"]).toBe("GitHubCopilotChat/0.35.0");
	});

	it("polls token endpoint, exchanges for internal copilot token", async () => {
		const { fetch, calls } = scriptedFetch([
			{ body: { access_token: "ghu_oauth_token", expires_in: 28800 } },
			{ body: { token: "tid=copilot_internal_bearer_token", expires_at: 1700003600 } },
		]);
		const { sleep, now } = fakeClock();
		const credential = await pollDeviceAuthorization(
			COPILOT_FLOW,
			{ fetch, sleep },
			{
				deviceCode: "gh_dc",
				userCode: "1234-5678",
				verificationUri: "https://github.com/login/device",
				intervalSeconds: 5,
				expiresInSeconds: 900,
			},
			new AbortController().signal,
			now,
		);

		expect(credential.access).toBe("tid=copilot_internal_bearer_token");
		expect(credential.refresh).toBe("ghu_oauth_token");
		expect(credential.expires).toBe(1700003600 * 1000 - 5 * 60 * 1000);

		expect(calls[0]?.url).toBe("https://github.com/login/oauth/access_token");
		expect(calls[0]?.headers?.["User-Agent"]).toBe("GitHubCopilotChat/0.35.0");
		expect(calls[1]?.url).toBe("https://api.github.com/copilot_internal/v2/token");
		expect(calls[1]?.headers?.Authorization).toBe("Bearer ghu_oauth_token");
		expect(calls[1]?.headers?.["Editor-Version"]).toBe("vscode/1.107.0");
	});

	it("refreshes GitHub Copilot credential using stored GitHub token", async () => {
		const { fetch, calls } = scriptedFetch([
			{ body: { token: "refreshed_copilot_token", expires_at: 1700007200 } },
		]);
		const auth = createDeviceCodeOAuth(COPILOT_FLOW, { fetch });
		const next = await auth.refresh(
			{ type: "oauth", access: "old_token", refresh: "ghu_oauth_token", expires: 0 },
			new AbortController().signal,
		);
		expect(next.access).toBe("refreshed_copilot_token");
		expect(next.refresh).toBe("ghu_oauth_token");
		expect(calls[0]?.url).toBe("https://api.github.com/copilot_internal/v2/token");
		expect(calls[0]?.headers?.Authorization).toBe("Bearer ghu_oauth_token");
	});

	it("fails refresh when user subscription is unauthorized", async () => {
		const { fetch } = scriptedFetch([
			{ status: 401, body: { message: "Unauthorized" } },
		]);
		const auth = createDeviceCodeOAuth(COPILOT_FLOW, { fetch });
		await expect(
			auth.refresh(
				{ type: "oauth", access: "old_token", refresh: "ghu_oauth_token", expires: 0 },
				new AbortController().signal,
			),
		).rejects.toThrow("Check your subscription");
	});
});
