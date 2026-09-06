import { describe, expect, it } from "bun:test";
import { modelListingUrl, probeModelListing, providerAuthHeaders } from "./modelListing";
import type { ProviderConfig, WireProtocol } from "../modelConfig";

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
	return {
		id: "prov-1",
		name: "My gateway",
		baseUrl: "https://gw.internal/v1",
		protocol: "openai-completions",
		apiKey: "sk-1",
		secretRef: "",
		source: "user",
		oauthFlow: "",
		...overrides,
	};
}

/** The URL a recorded request targeted, whichever `fetch` input shape it used. */
function requestUrlOf(input: RequestInfo | URL): string {
	if (typeof input === "string") {
		return input;
	}
	return input instanceof URL ? input.href : input.url;
}

interface RecordedRequest {
	url: string;
	method: string | undefined;
	headers: Record<string, string>;
	body: unknown;
	signal: AbortSignal | null | undefined;
}

/**
 * A `fetch` that answers with one canned response and records what it was asked.
 *
 * Injection is the seam the probe was designed around — `fetch` is a required
 * parameter — so no module mocking is needed, and these tests stay independent
 * of the process-global Obsidian stub.
 */
function stubFetch(status: number, body: string): { fetch: typeof globalThis.fetch; calls: RecordedRequest[] } {
	const calls: RecordedRequest[] = [];
	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
			headers[key.toLowerCase()] = value;
		}
		calls.push({ url: requestUrlOf(input), method: init?.method, headers, body: init?.body, signal: init?.signal });
		return new Response(body, { status });
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

describe("modelListingUrl", () => {
	it("puts both OpenAI protocols on the same path, since they share a surface", () => {
		for (const protocol of ["openai-completions", "openai-responses"] as const) {
			expect(modelListingUrl(provider({ protocol }))).toBe("https://gw.internal/v1/models");
		}
	});

	it("uses Anthropic's versioned path, which its SDK appends to the bare host", () => {
		expect(modelListingUrl(provider({ protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com" }))).toBe("https://api.anthropic.com/v1/models");
	});

	it("does not double the slash when the base URL already ends in one", () => {
		expect(modelListingUrl(provider({ baseUrl: "https://gw.internal/v1/" }))).toBe("https://gw.internal/v1/models");
	});

	it("keeps a base URL that is wrong for chat wrong here too, rather than repairing it", () => {
		// `…/v1/v1/models` mirrors the `…/v1/v1/messages` a real turn would send,
		// so the probe reproduces the user's mistake instead of hiding it.
		expect(modelListingUrl(provider({ protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1" }))).toBe("https://api.anthropic.com/v1/v1/models");
	});
});

describe("providerAuthHeaders", () => {
	it("sends a bearer token for both OpenAI protocols", () => {
		for (const protocol of ["openai-completions", "openai-responses"] as const) {
			expect(providerAuthHeaders(provider({ protocol }))).toEqual({ accept: "application/json", authorization: "Bearer sk-1" });
		}
	});

	it("sends Anthropic's key header and version instead", () => {
		expect(providerAuthHeaders(provider({ protocol: "anthropic-messages" }))).toEqual({
			accept: "application/json",
			"anthropic-version": "2023-06-01",
			"x-api-key": "sk-1",
		});
	});

	it("omits the credential entirely when no key is set, so a keyless server still answers", () => {
		for (const protocol of ["openai-completions", "anthropic-messages"] as const) {
			const headers = providerAuthHeaders(provider({ protocol, apiKey: "   " }));
			expect(headers.authorization).toBeUndefined();
			expect(headers["x-api-key"]).toBeUndefined();
		}
	});
});

describe("probeModelListing", () => {
	it("issues a bodyless GET to the listing URL and forwards the abort signal", async () => {
		const { fetch, calls } = stubFetch(200, JSON.stringify({ data: [] }));
		const controller = new AbortController();

		await probeModelListing(provider(), { fetch, signal: controller.signal });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://gw.internal/v1/models");
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.body).toBeUndefined();
		expect(calls[0]?.signal).toBe(controller.signal);
		expect(calls[0]?.headers.authorization).toBe("Bearer sk-1");
	});

	it("reads ids from OpenAI's `data` envelope", async () => {
		const { fetch } = stubFetch(200, JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }));
		expect((await probeModelListing(provider(), { fetch })).modelIds).toEqual(["a", "b"]);
	});

	it("reads ids from a `models` envelope, which some gateways use instead", async () => {
		const { fetch } = stubFetch(200, JSON.stringify({ models: [{ id: "a" }, { name: "b" }] }));
		expect((await probeModelListing(provider(), { fetch })).modelIds).toEqual(["a", "b"]);
	});

	it("reads a bare array of strings", async () => {
		const { fetch } = stubFetch(200, JSON.stringify(["a", "b"]));
		expect((await probeModelListing(provider(), { fetch })).modelIds).toEqual(["a", "b"]);
	});

	it("reports the status with no ids rather than throwing on a body it cannot parse", async () => {
		const { fetch } = stubFetch(200, "<html>not json</html>");
		const result = await probeModelListing(provider(), { fetch });
		expect(result.status).toBe(200);
		expect(result.modelIds).toEqual([]);
	});

	it("relays the server's own message from an error envelope", async () => {
		const { fetch } = stubFetch(401, JSON.stringify({ error: { message: "invalid api key" } }));
		const result = await probeModelListing(provider(), { fetch });
		expect(result.status).toBe(401);
		expect(result.message).toBe("invalid api key");
	});

	it("resolves a non-2xx instead of throwing, since the status is the finding", async () => {
		const { fetch } = stubFetch(404, "");
		expect((await probeModelListing(provider(), { fetch })).status).toBe(404);
	});

	it("propagates a transport failure, leaving the caller's error phrasing to handle it", async () => {
		const fetch = (async (_input: RequestInfo | URL): Promise<Response> => {
			throw new Error("net::ERR_NAME_NOT_RESOLVED");
		}) as typeof globalThis.fetch;
		let thrown: unknown;
		try {
			await probeModelListing(provider(), { fetch });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe("net::ERR_NAME_NOT_RESOLVED");
	});

	it("covers every protocol the plugin speaks", async () => {
		for (const protocol of ["openai-completions", "openai-responses", "anthropic-messages"] as WireProtocol[]) {
			const { fetch, calls } = stubFetch(200, JSON.stringify({ data: [{ id: "a" }] }));
			const result = await probeModelListing(provider({ protocol }), { fetch });
			expect(result.modelIds).toEqual(["a"]);
			expect(calls[0]?.url).toContain("models");
		}
	});
});
