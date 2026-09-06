/**
 * Invariants over the sign-in table.
 *
 * The values in it are copied from pi's implementations, which is the cost
 * `deviceCode.ts` accepts for owning the transport — so what is checkable here is
 * the *shape*: that every entry is reachable, that its urls are https endpoints
 * an Obsidian renderer can actually post to, and that the persisted ids and the
 * dropdown order cannot drift apart. Endpoint correctness itself is not
 * assertable offline and belongs to a live sign-in.
 */

import { describe, expect, it } from "bun:test";
import type { FetchFn } from "../net/obsidianFetch";
import { OAUTH_FLOWS, OAUTH_FLOW_IDS, createOAuthAuth, isOAuthFlowId, oauthFlowName } from "./oauthFlows";

const NEVER_CALLED: FetchFn = async () => {
	throw new Error("building an OAuthAuth must not touch the network");
};

describe("OAUTH_FLOW_IDS", () => {
	it("lists exactly the flows the table defines", () => {
		// The array drives the dropdown and the table drives the flow; a value in one
		// and not the other is either an unreachable entry or a broken option.
		expect([...OAUTH_FLOW_IDS].sort().join(",")).toBe(Object.keys(OAUTH_FLOWS).sort().join(","));
	});

	it("accepts its own ids and rejects anything else", () => {
		for (const id of OAUTH_FLOW_IDS) {
			expect(isOAuthFlowId(id)).toBe(true);
		}
		expect(isOAuthFlowId("anthropic")).toBe(false);
		expect(isOAuthFlowId("")).toBe(false);
		expect(isOAuthFlowId(undefined)).toBe(false);
		// A prototype member is not a flow, which is the case a bare `in` check gets
		// wrong.
		expect(isOAuthFlowId("toString")).toBe(false);
	});
});

describe("every flow", () => {
	for (const id of OAUTH_FLOW_IDS) {
		const flow = OAUTH_FLOWS[id];

		it(`${id}: posts only to https endpoints`, () => {
			// Both go through `requestUrl`, which will happily post to plaintext http;
			// a token exchange over one would put a refresh token on the wire.
			expect(new URL(flow.deviceCodeUrl).protocol).toBe("https:");
			expect(new URL(flow.tokenUrl).protocol).toBe("https:");
		});

		it(`${id}: names itself and its sign-in action`, () => {
			expect(flow.name.length).toBeGreaterThan(0);
			expect(flow.loginLabel.length).toBeGreaterThan(0);
			expect(oauthFlowName(id)).toBe(flow.name);
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
			const auth = createOAuthAuth(id, NEVER_CALLED);
			expect(auth.name).toBe(flow.name);
			expect(auth.isSubscription).toBe(true);
		});
	}
});

describe("the two flows in the table", () => {
	it("gives xAI the access token where an API key goes", () => {
		expect(OAUTH_FLOWS.xai.toAuth("at")).toEqual({ apiKey: "at" });
	});

	it("gives Kimi a bearer header, because its endpoint speaks Anthropic Messages", () => {
		// The Anthropic SDK would otherwise send `x-api-key`, which that endpoint
		// does not accept; pi's api layer takes an explicit authorization instead.
		expect(OAUTH_FLOWS["kimi-coding"].toAuth("at")).toEqual({ headers: { Authorization: "Bearer at" } });
	});
});
