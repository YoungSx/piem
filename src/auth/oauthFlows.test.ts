/**
 * Invariants over the two sign-in tables.
 *
 * The values in them are copied from pi's implementations, which is the cost
 * `deviceCode.ts` accepts for owning the transport — so what is checkable here
 * is the *shape*: that every entry is reachable, that its urls are https
 * endpoints an Obsidian renderer can actually post to, and that the persisted
 * ids and the dropdown order cannot drift apart. Endpoint correctness itself is
 * not assertable offline and belongs to a live sign-in.
 */

import { describe, expect, it } from "bun:test";
import type { FetchFn } from "../net/obsidianFetch";
import {
	DEVICE_CODE_FLOWS,
	MANUAL_CODE_FLOWS,
	OAUTH_FLOW_IDS,
	createOAuthAuth,
	isOAuthFlowId,
	oauthFlowName,
} from "./oauthFlows";

const NEVER_CALLED: FetchFn = async () => {
	throw new Error("building an OAuthAuth must not touch the network");
};

describe("OAUTH_FLOW_IDS", () => {
	it("lists exactly the flows both tables define", () => {
		// The array drives the dropdown and the tables drive the flow; a value in
		// one and not the other is either an unreachable entry or a broken option.
		const tableIds = [...Object.keys(DEVICE_CODE_FLOWS), ...Object.keys(MANUAL_CODE_FLOWS)].sort().join(",");
		expect([...OAUTH_FLOW_IDS].sort().join(",")).toBe(tableIds);
	});

	it("accepts its own ids and rejects anything else", () => {
		for (const id of OAUTH_FLOW_IDS) {
			expect(isOAuthFlowId(id)).toBe(true);
		}
		// pi knows this one; this build does not perform it.
		expect(isOAuthFlowId("github-copilot")).toBe(false);
		expect(isOAuthFlowId("")).toBe(false);
		expect(isOAuthFlowId(undefined)).toBe(false);
		// A prototype member is not a flow, which is the case a bare `in` check gets
		// wrong.
		expect(isOAuthFlowId("toString")).toBe(false);
	});
});

describe("every device-code flow", () => {
	for (const [id, flow] of Object.entries(DEVICE_CODE_FLOWS)) {
		it(`${id}: posts only to https endpoints`, () => {
			// Both go through `requestUrl`, which will happily post to plaintext http;
			// a token exchange over one would put a refresh token on the wire.
			expect(new URL(flow.deviceCodeUrl).protocol).toBe("https:");
			expect(new URL(flow.tokenUrl).protocol).toBe("https:");
		});

		it(`${id}: names itself and its sign-in action`, () => {
			expect(flow.name.length).toBeGreaterThan(0);
			expect(flow.loginLabel.length).toBeGreaterThan(0);
			expect(oauthFlowName(id as keyof typeof DEVICE_CODE_FLOWS)).toBe(flow.name);
		});

		it(`${id}: has a client id and a fallback token lifetime`, () => {
			expect(flow.clientId.length).toBeGreaterThan(0);
			expect(flow.defaultTokenLifetimeSeconds).toBeGreaterThan(0);
		});

		it(`${id}: turns an access token into request auth that carries it`, () => {
			// Either spelling is fine — an api key or an Authorization header — but a
			// `toAuth` that dropped the token would leave every request unauthenticated
			// while the panel reported a live subscription.
			const auth = flow.toAuth("token-value");
			const carried = JSON.stringify(auth);
			expect(carried).toContain("token-value");
			expect(auth.apiKey !== undefined || auth.headers !== undefined).toBe(true);
		});

		it(`${id}: builds an OAuthAuth without a request`, () => {
			const auth = createOAuthAuth(id as keyof typeof DEVICE_CODE_FLOWS, NEVER_CALLED);
			expect(auth.name).toBe(flow.name);
			expect(auth.isSubscription).toBe(true);
		});
	}
});

describe("every manual-code flow", () => {
	for (const [id, flow] of Object.entries(MANUAL_CODE_FLOWS)) {
		it(`${id}: sends the user only to https endpoints`, () => {
			expect(new URL(flow.authorizeUrl).protocol).toBe("https:");
			expect(new URL(flow.tokenUrl).protocol).toBe("https:");
		});

		it(`${id}: names itself and its sign-in action`, () => {
			expect(flow.name.length).toBeGreaterThan(0);
			expect(flow.loginLabel.length).toBeGreaterThan(0);
			expect(oauthFlowName(id as keyof typeof MANUAL_CODE_FLOWS)).toBe(flow.name);
		});

		it(`${id}: produces a redirect address nothing has to be listening on`, () => {
			// The paste path copies the address out of the browser; the page never
			// loads. What the invariant guards is that the address exists and is a
			// URL — not that it repeats, which only Anthropic's does.
			const redirect = flow.redirectUri();
			expect(() => new URL(redirect)).not.toThrow();
		});

		it(`${id}: ${id === "openrouter" ? "freshens" : "keeps"} its redirect address across logins`, () => {
			// OpenRouter's uuid path is what makes a retried sign-in a new request
			// rather than a callback someone already used; Anthropic's is the fixed
			// loopback pi registered.
			const first = flow.redirectUri();
			const second = flow.redirectUri();
			if (id === "openrouter") {
				expect(first).not.toBe(second);
			} else {
				expect(first).toBe(second);
			}
		});

		it(`${id}: turns an access token into request auth that carries it`, () => {
			const auth = flow.toAuth("token-value");
			const carried = JSON.stringify(auth);
			expect(carried).toContain("token-value");
			expect(auth.apiKey !== undefined || auth.headers !== undefined).toBe(true);
		});

		it(`${id}: builds an OAuthAuth without a request`, () => {
			const auth = createOAuthAuth(id as keyof typeof MANUAL_CODE_FLOWS, NEVER_CALLED);
			expect(auth.name).toBe(flow.name);
			expect(auth.isSubscription).toBe(true);
		});
	}
});

describe("the two tables' shapes", () => {
	it("gives xAI the access token where an API key goes", () => {
		expect(DEVICE_CODE_FLOWS.xai.toAuth("at")).toEqual({ apiKey: "at" });
	});

	it("gives Kimi a bearer header, because its endpoint speaks Anthropic Messages", () => {
		// The Anthropic SDK would otherwise send `x-api-key`, which that endpoint
		// does not accept; pi's api layer takes an explicit authorization instead.
		expect(DEVICE_CODE_FLOWS["kimi-coding"].toAuth("at")).toEqual({ headers: { Authorization: "Bearer at" } });
	});

	it("makes Anthropic's exchange a token pair and OpenRouter's a permanent key", () => {
		// The grant kind decides the exchange body and the credential's lifetime;
		// asserting it here pins which provider behaves which way.
		expect(MANUAL_CODE_FLOWS.anthropic.grant).toBe("token-pair");
		expect(MANUAL_CODE_FLOWS.anthropic.clientId).toBeDefined();
		expect(MANUAL_CODE_FLOWS.openrouter.grant).toBe("permanent-key");
		expect(MANUAL_CODE_FLOWS.openrouter.clientId).toBeUndefined();
	});
});
