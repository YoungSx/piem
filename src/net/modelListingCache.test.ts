import { describe, expect, it } from "bun:test";
import { ModelListingCache } from "./modelListingCache";
import type { ProviderConfig } from "../modelConfig";

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

/** A `fetch` that answers every call the same way and counts how often it was asked. */
function countingFetch(ids: string[], status = 200): { fetch: typeof globalThis.fetch; calls: string[] } {
	const calls: string[] = [];
	const fetch = (async (input: RequestInfo | URL) => {
		calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status });
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

/** A `fetch` the test resolves by hand, for observing what happens mid-request. */
function deferredFetch(): { fetch: typeof globalThis.fetch; calls: string[]; resolve: (ids: string[]) => void } {
	const calls: string[] = [];
	let release!: (ids: string[]) => void;
	const gate = new Promise<string[]>((resolve) => {
		release = resolve;
	});
	const fetch = (async (input: RequestInfo | URL) => {
		calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const ids = await gate;
		return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
	}) as typeof globalThis.fetch;
	return { fetch, calls, resolve: release };
}

describe("ModelListingCache", () => {
	it("asks the endpoint once per session, however often the form is opened", async () => {
		const { fetch, calls } = countingFetch(["a", "b"]);
		const cache = new ModelListingCache({ fetch });

		expect((await cache.ensure(provider())).modelIds).toEqual(["a", "b"]);
		expect((await cache.ensure(provider())).modelIds).toEqual(["a", "b"]);
		expect((await cache.ensure(provider())).modelIds).toEqual(["a", "b"]);

		expect(calls).toHaveLength(1);
	});

	it("shares one request between callers that arrive while it is still out", async () => {
		const { fetch, calls, resolve } = deferredFetch();
		const cache = new ModelListingCache({ fetch });

		const first = cache.ensure(provider());
		const second = cache.ensure(provider());
		resolve(["a"]);

		expect((await first).modelIds).toEqual(["a"]);
		expect((await second).modelIds).toEqual(["a"]);
		expect(calls).toHaveLength(1);
	});

	it("re-probes when the base URL, protocol, or credential changes", async () => {
		for (const changed of [{ baseUrl: "https://other.internal/v1" }, { protocol: "anthropic-messages" as const }, { apiKey: "sk-2" }]) {
			const { fetch, calls } = countingFetch(["a"]);
			const cache = new ModelListingCache({ fetch });

			await cache.ensure(provider());
			await cache.ensure(provider(changed));

			// The answer belonged to a different server, or a different view of one.
			expect(calls).toHaveLength(2);
		}
	});

	it("replaces a provider's earlier answer rather than listing it twice", async () => {
		const { fetch } = countingFetch(["a"]);
		const cache = new ModelListingCache({ fetch });

		await cache.ensure(provider({ baseUrl: "https://typo.internal/v1" }));
		await cache.ensure(provider({ baseUrl: "https://gw.internal/v1" }));

		const known = cache.known();
		expect(known).toHaveLength(1);
		expect(known[0]?.provider.baseUrl).toBe("https://gw.internal/v1");
	});

	it("keeps answers from different providers side by side", async () => {
		const { fetch } = countingFetch(["a"]);
		const cache = new ModelListingCache({ fetch });

		await cache.ensure(provider({ id: "prov-1" }));
		await cache.ensure(provider({ id: "prov-2", baseUrl: "https://two.internal/v1" }));

		expect(cache.known().map((listing) => listing.provider.id)).toEqual(["prov-1", "prov-2"]);
	});

	it("never issues a request from `known`, which is the typing path", async () => {
		const { fetch, calls } = countingFetch(["a"]);
		const cache = new ModelListingCache({ fetch });

		expect(cache.known()).toEqual([]);
		expect(calls).toHaveLength(0);

		await cache.ensure(provider());
		cache.known();
		cache.known();

		expect(calls).toHaveLength(1);
	});

	it("records an unreachable endpoint as nothing to suggest, and does not retry it", async () => {
		const calls: string[] = [];
		const fetch = (async () => {
			calls.push("attempt");
			throw new Error("net::ERR_NAME_NOT_RESOLVED");
		}) as unknown as typeof globalThis.fetch;
		const cache = new ModelListingCache({ fetch });

		// Resolves rather than rejects: a shorter suggestion list is not an error
		// the user needs told about.
		expect((await cache.ensure(provider())).modelIds).toEqual([]);
		await cache.ensure(provider());

		expect(calls).toHaveLength(1);
	});

	it("treats a non-2xx as no ids, whatever the status meant", async () => {
		for (const status of [401, 404, 500]) {
			const { fetch } = countingFetch(["a"], status);
			const cache = new ModelListingCache({ fetch });
			expect((await cache.ensure(provider())).modelIds).toEqual([]);
		}
	});

	it("lets a caller stop waiting without discarding the request others may still want", async () => {
		const { fetch, calls, resolve } = deferredFetch();
		const cache = new ModelListingCache({ fetch });
		const controller = new AbortController();

		const abandoned = cache.ensure(provider(), controller.signal);
		controller.abort();
		expect(abandoned).rejects.toThrow(/aborted/i);

		// The probe was left to finish, so its answer is there for the next opener
		// and no second request is issued.
		resolve(["a"]);
		expect((await cache.ensure(provider())).modelIds).toEqual(["a"]);
		expect(calls).toHaveLength(1);
	});

	it("rejects immediately for a signal that is already aborted", async () => {
		const { fetch } = countingFetch(["a"]);
		const cache = new ModelListingCache({ fetch });

		expect(cache.ensure(provider(), AbortSignal.abort())).rejects.toThrow(/aborted/i);
	});
});
