import { describe, expect, it } from "bun:test";
import type { ModelsDevIndex } from "./modelsDev";
import { installObsidianStub } from "../testUtils/obsidianStub";

// `modelsDev` builds its transport through `obsidianFetch`, which imports
// `obsidian` for `requestUrl` — and that module ships types only, so the stub has
// to be registered before the import resolves. A static import would resolve
// first: the file then passed only under a full `bun test`, riding on a
// registration some earlier file had already done, and failed on its own with
// "Cannot find package 'obsidian'".
installObsidianStub();
const { fetchModelsDevIndex, parseModelsDevIndex, resetModelsDevIndexForTests } = await import("./modelsDev");

/**
 * models.dev is a living dataset fetched at runtime, so the parser cannot know
 * what shape arrives: a provider section can gain a field, drop `models`, or
 * carry an entry whose limit block is missing or mis-typed. These tests pin the
 * lenient contract — keep every entry that can still answer a yes/no question,
 * drop the rest, and never throw on a payload that drifted.
 */

/** Minimal models.dev entry with every field this plugin reads. */
function fullModel(): Record<string, unknown> {
	return { reasoning: true, modalities: { input: ["text", "image"] }, limit: { context: 200000, output: 8192 } };
}

/** A payload holding one model under one provider, the common shape. */
function payloadWith(id: string, model: unknown): unknown {
	return { "example-provider": { models: { [id]: model } } };
}

describe("parseModelsDevIndex", () => {
	it("extracts reasoning, images, and limits from a well-formed entry", () => {
		const index = parseModelsDevIndex(payloadWith("gpt-x", fullModel()));
		expect(index.exact.get("gpt-x")).toEqual({ reasoning: true, images: true, contextWindow: 200000, maxTokens: 8192 });
	});

	it("normalizes ids to trimmed lowercase, the way users type them", () => {
		const index = parseModelsDevIndex(payloadWith("  GPT-X  ", fullModel()));
		expect(index.exact.has("gpt-x")).toBe(true);
	});

	it("keeps a text-only entry without a limit block", () => {
		const index = parseModelsDevIndex(payloadWith("text-only", { reasoning: false, modalities: { input: ["text"] } }));
		expect(index.exact.get("text-only")).toEqual({ reasoning: false, images: false });
	});

	it("drops entries without the reasoning boolean, which cannot answer a yes/no question", () => {
		const index = parseModelsDevIndex(payloadWith("shapeless", { modalities: { input: ["image"] } }));
		expect(index.exact.size).toBe(0);
		expect(index.tail.size).toBe(0);
	});

	it("ignores malformed limit fields instead of rejecting the entry", () => {
		const model = { reasoning: true, modalities: { input: ["text"] }, limit: { context: "big", output: -5 } };
		const index = parseModelsDevIndex(payloadWith("odd-limits", model));
		expect(index.exact.get("odd-limits")).toEqual({ reasoning: true, images: false });
	});

	it("indexes gateway-namespaced ids under their final path segment too", () => {
		const index = parseModelsDevIndex(payloadWith("anthropic/claude-x", fullModel()));
		expect(index.tail.get("claude-x")).toBeDefined();
	});

	it("keeps the first entry for a duplicated id", () => {
		const payload = {
			"provider-one": { models: { dup: { reasoning: true, modalities: { input: ["image"] } } } },
			"provider-two": { models: { dup: { reasoning: false, modalities: { input: ["text"] } } } },
		};
		const index = parseModelsDevIndex(payload);
		expect(index.exact.get("dup")).toEqual({ reasoning: true, images: true });
	});

	it("survives a payload that drifted away from the documented shape", () => {
		expect(parseModelsDevIndex(undefined)).toEqual({ exact: new Map(), tail: new Map() });
		expect(parseModelsDevIndex("not-an-object")).toEqual({ exact: new Map(), tail: new Map() });
		expect(parseModelsDevIndex({ "empty-provider": {}, "no-models": [1, 2] })).toEqual({ exact: new Map(), tail: new Map() });
	});
});

describe("fetchModelsDevIndex", () => {
	/** A Response-shaped stub serving a fixed body, counting how often it was hit. */
	function stubFetch(payload: unknown, ok = true): { fetch: typeof globalThis.fetch; calls: () => number } {
		let calls = 0;
		// The cast is deliberate: a full `typeof fetch` contract (preconnect and
		// all) is noise here; only the call-and-response shape is under test.
		const impl = (async () => {
			calls += 1;
			return { ok, status: ok ? 200 : 503, text: async () => JSON.stringify(payload) } as unknown as Response;
		}) as unknown as typeof globalThis.fetch;
		return { fetch: impl, calls: () => calls };
	}

	it("fetches once per session and parses the payload", async () => {
		resetModelsDevIndexForTests();
		const { fetch, calls } = stubFetch(payloadWith("gpt-x", fullModel()));
		const first = await fetchModelsDevIndex({ fetch });
		const second = await fetchModelsDevIndex({ fetch });
		expect(calls()).toBe(1);
		expect(first.exact.has("gpt-x")).toBe(true);
		expect(second).toBe(first);
	});

	it("clears the session cache on failure, so the next open retries", async () => {
		resetModelsDevIndexForTests();
		const { fetch, calls } = stubFetch({}, false);
		const first = fetchModelsDevIndex({ fetch });
		let rejected = false;
		try {
			await first;
		} catch {
			rejected = true;
		}
		expect(rejected).toBe(true);
		const second = await fetchModelsDevIndex({ fetch: stubFetch(payloadWith("gpt-x", fullModel())).fetch });
		// The retry used a different fetch than the failed attempt: the dead
		// promise did not linger as the session's only answer.
		expect(second).toBeDefined();
		expect(calls()).toBe(1);
	});

	it("resolves to a usable empty index for a drifted payload", async () => {
		resetModelsDevIndexForTests();
		const { fetch } = stubFetch("not-an-object");
		const index: ModelsDevIndex = await fetchModelsDevIndex({ fetch });
		expect(index.exact.size).toBe(0);
	});
});
