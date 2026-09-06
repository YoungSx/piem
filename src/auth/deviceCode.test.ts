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
	fields: Record<string, string>;
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
		const fields = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
		calls.push({ url, fields });
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
	it("posts the client id and the flow's extra fields", async () => {
		const { fetch, calls } = scriptedFetch([{ body: DEVICE_BODY }]);
		await requestDeviceAuthorization(FLOW, { fetch }, new AbortController().signal);
		expect(calls[0]?.url).toBe("https://auth.example.com/device");
		expect(calls[0]?.fields).toEqual({ client_id: "client-1", scope: "offline_access", referrer: "pi" });
	});

	it("prefers the pre-filled verification URL when the server offers one", async () => {
		// It embeds the user code, so the user does not retype it. The code is still
		// displayed either way.
		const { fetch } = scriptedFetch([
			{ body: { ...DEVICE_BODY, verification_uri_complete: "https://example.com/activate?user_code=WDJB-MJHT" } },
		]);
		const device = await requestDeviceAuthorization(FLOW, { fetch }, new AbortController().signal);
		expect(device.verificationUri).toBe("https://example.com/activate?user_code=WDJB-MJHT");
	});

	it("falls back to RFC 8628 defaults when interval and expiry are absent", async () => {
		const { fetch } = scriptedFetch([{ body: { device_code: "dc", user_code: "UC", verification_uri: "https://e.com/a" } }]);
		const device = await requestDeviceAuthorization(FLOW, { fetch }, new AbortController().signal);
		expect(device.intervalSeconds).toBe(5);
		expect(device.expiresInSeconds).toBe(900);
	});

	it("refuses a verification URL that is not https", async () => {
		// The one value in this flow that ends up somewhere the user clicks, so a
		// response naming another scheme is not a URL to open.
		const { fetch } = scriptedFetch([{ body: { ...DEVICE_BODY, verification_uri: "javascript:alert(1)" } }]);
		await expect(requestDeviceAuthorization(FLOW, { fetch }, new AbortController().signal)).rejects.toThrow("unusable");
	});

	it("reports the provider's own error text", async () => {
		const { fetch } = scriptedFetch([
			{ status: 400, body: { error: "invalid_client", error_description: "Unknown client" } },
		]);
		await expect(requestDeviceAuthorization(FLOW, { fetch }, new AbortController().signal)).rejects.toThrow(
			"Test Provider device authorization failed (HTTP 400): invalid_client: Unknown client",
		);
	});

	it("reports a non-JSON body as a plain status failure rather than a parse error", async () => {
		const { fetch } = scriptedFetch([{ status: 502, text: "<html>bad gateway</html>" }]);
		await expect(requestDeviceAuthorization(FLOW, { fetch }, new AbortController().signal)).rejects.toThrow("HTTP 502");
	});
});

const DEVICE = {
	deviceCode: "dc-1",
	userCode: "WDJB-MJHT",
	verificationUri: "https://example.com/activate",
	intervalSeconds: 5,
	expiresInSeconds: 900,
};

describe("pollDeviceAuthorization", () => {
	it("waits the server's interval before the first poll", async () => {
		// An immediate poll is a guaranteed `authorization_pending`: the user has not
		// had time to open a browser, so it only spends a request against the
		// provider's rate limit.
		const { fetch, calls } = scriptedFetch([{ body: { access_token: "at", refresh_token: "rt", expires_in: 3600 } }]);
		const { sleep, waits, now } = fakeClock();
		await pollDeviceAuthorization(FLOW, { fetch, sleep }, DEVICE, new AbortController().signal, now);
		expect(waits).toEqual([5000]);
		expect(calls).toHaveLength(1);
	});

	it("returns the credential with the true expiry, no margin subtracted", async () => {
		// pi refreshes anything with under five minutes left, so a second margin here
		// would only move every refresh ten minutes early while making the stored
		// number mean something other than what it says.
		const { fetch } = scriptedFetch([{ body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 } }]);
		const clock = fakeClock();
		const credential = await pollDeviceAuthorization(FLOW, { fetch, sleep: clock.sleep }, DEVICE, new AbortController().signal, clock.now);
		expect(credential).toEqual({ type: "oauth", access: "at-1", refresh: "rt-1", expires: clock.now() + 3_600_000 });
	});

	it("keeps polling at the same interval while authorization is pending", async () => {
		const { fetch, calls } = scriptedFetch([
			{ status: 400, body: { error: "authorization_pending" } },
			{ status: 400, body: { error: "authorization_pending" } },
			{ body: { access_token: "at", refresh_token: "rt", expires_in: 60 } },
		]);
		const { sleep, waits, now } = fakeClock();
		await pollDeviceAuthorization(FLOW, { fetch, sleep }, DEVICE, new AbortController().signal, now);
		expect(calls).toHaveLength(3);
		expect(waits).toEqual([5000, 5000, 5000]);
	});

	it("adds five seconds on slow_down when the server names no new interval", async () => {
		const { fetch } = scriptedFetch([
			{ status: 400, body: { error: "slow_down" } },
			{ body: { access_token: "at", refresh_token: "rt", expires_in: 60 } },
		]);
		const { sleep, waits, now } = fakeClock();
		await pollDeviceAuthorization(FLOW, { fetch, sleep }, DEVICE, new AbortController().signal, now);
		expect(waits).toEqual([5000, 10_000]);
	});

	it("prefers the interval the server names over its own arithmetic", async () => {
		// A client that only ever increments locally polls early forever once its
		// clock has drifted — a suspended laptop, a VM — and never leaves backoff.
		const { fetch } = scriptedFetch([
			{ status: 400, body: { error: "slow_down", interval: 30 } },
			{ body: { access_token: "at", refresh_token: "rt", expires_in: 60 } },
		]);
		const { sleep, waits, now } = fakeClock();
		await pollDeviceAuthorization(FLOW, { fetch, sleep }, DEVICE, new AbortController().signal, now);
		expect(waits).toEqual([5000, 30_000]);
	});

	it("floors the interval so a server reporting zero cannot spin", async () => {
		const { fetch } = scriptedFetch([{ body: { access_token: "at", refresh_token: "rt", expires_in: 60 } }]);
		const { sleep, waits, now } = fakeClock();
		await pollDeviceAuthorization(FLOW, { fetch, sleep }, { ...DEVICE, intervalSeconds: 0.1 }, new AbortController().signal, now);
		expect(waits).toEqual([1000]);
	});

	it("clips the wait to the code's own expiry rather than overshooting it", async () => {
		const { fetch, calls } = scriptedFetch([{ status: 400, body: { error: "authorization_pending" } }]);
		const { sleep, waits, now } = fakeClock();
		await expect(
			pollDeviceAuthorization(FLOW, { fetch, sleep }, { ...DEVICE, expiresInSeconds: 3 }, new AbortController().signal, now),
		).rejects.toThrow("expired");
		// Three seconds left against a five-second interval. The wait is clipped,
		// and the deadline it lands exactly on means there is no point polling.
		expect(waits).toEqual([3000]);
		expect(calls).toHaveLength(0);
	});

	it("gives up once the deadline passes instead of polling forever", async () => {
		const { fetch, calls } = scriptedFetch([{ status: 400, body: { error: "authorization_pending" } }]);
		const { sleep, waits, now } = fakeClock();
		await expect(
			pollDeviceAuthorization(FLOW, { fetch, sleep }, { ...DEVICE, expiresInSeconds: 6 }, new AbortController().signal, now),
		).rejects.toThrow("expired");
		// One poll fits inside the six seconds; the second wait is clipped to the
		// remaining one, and the loop then sees the deadline.
		expect(waits).toEqual([5000, 1000]);
		expect(calls).toHaveLength(1);
	});

	it("reports a denial as a denial, not an expiry", async () => {
		const { fetch } = scriptedFetch([{ status: 400, body: { error: "access_denied" } }]);
		const { sleep, now } = fakeClock();
		await expect(
			pollDeviceAuthorization(FLOW, { fetch, sleep }, DEVICE, new AbortController().signal, now),
		).rejects.toThrow("was denied");
	});

	it("distinguishes a provider outage from a protocol error", async () => {
		// Nothing about the device code is wrong, so telling the user it expired
		// sends them round a loop that cannot help.
		const { fetch } = scriptedFetch([{ status: 503, body: {} }]);
		const { sleep, now } = fakeClock();
		await expect(
			pollDeviceAuthorization(FLOW, { fetch, sleep }, DEVICE, new AbortController().signal, now),
		).rejects.toThrow("not responding");
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
