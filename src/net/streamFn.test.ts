import { describe, expect, it } from "bun:test";
import type { Credential, CredentialStore, Model } from "@earendil-works/pi-ai";
import type { ProviderConfig, WireProtocol } from "../modelConfig";
import { installObsidianStub, requestUrlMock } from "../testUtils/obsidianStub";

installObsidianStub();

// Dynamic imports so the mocked `obsidian` module wins over any cached real one.
const { createObsidianModels, createObsidianStreamFn, withRequestDefaults } = await import("./streamFn");
const { createFetchForTransport, toFetchFunction } = await import("./obsidianFetch");
const { buildConfiguredModel } = await import("../modelConfig");

/** SSE body for a minimal completed chat-completions turn. */
function sseBody(text: string): string {
	const chunk = (delta: object, finish: string | null) =>
		`data: ${JSON.stringify({ id: "c1", choices: [{ delta, finish_reason: finish }] })}\n\n`;
	const usage =
		'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n';
	return `${chunk({ role: "assistant", content: text }, null)}${chunk({}, "stop")}${usage}data: [DONE]\n\n`;
}

/** SSE body for a minimal completed OpenAI Responses turn. */
function responsesSseBody(): string {
	const created = { type: "response.created", response: { id: "r1", status: "in_progress" } };
	const completed = {
		type: "response.completed",
		response: { id: "r1", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } },
	};
	return `data: ${JSON.stringify(created)}\n\ndata: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`;
}

/** A key row on the chat-completions protocol, minus whatever a case is about to override. */
function keyRow(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
	return {
		id: "p1",
		name: "Configured row",
		baseUrl: "https://gw.internal/v1",
		protocol: "openai-completions",
		apiKey: "sk-custom",
		secretRef: "",
		source: "user",
		oauthFlow: "",
		...overrides,
	};
}

/** The one model served by {@link keyRow}. */
function keyRowModel(row: ProviderConfig): Model<WireProtocol> {
	return buildConfiguredModel(
		{ id: "m1", providerId: row.id, modelApiId: "qwen3-32b", displayName: "Qwen", reasoning: false, supportsImages: false },
		row,
	);
}

/** Captures the request the provider stack issues against the row's endpoint. */
async function streamViaRequestUrl(
	model: Model<WireProtocol>,
	row: ProviderConfig,
	options: { apiKey?: string } = {},
): Promise<{ url: string; headers: Record<string, string>; body: Record<string, unknown>; errorMessage?: string }> {
	let captured: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | undefined;
	requestUrlMock.mockImplementation(async (params: unknown) => {
		const p = params as { url: string; headers: Record<string, string>; body: string };
		captured = { url: p.url, headers: p.headers ?? {}, body: JSON.parse(p.body) as Record<string, unknown> };
		return {
			status: 200,
			headers: { "content-type": "text/event-stream" },
			arrayBuffer: new TextEncoder().encode(sseBody("hello from custom")).buffer as ArrayBuffer,
		};
	});

	const bundle = createObsidianModels({ transport: "requestUrl", providers: [row] });
	const stream = bundle.models.streamSimple(
		model,
		{ messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }] },
		// The plugin always injects its transport fetch (via `withRequestDefaults`
		// or `createObsidianStreamFn`); without it pi's SDK would hit the network.
		{ ...options, fetch: toFetchFunction(createFetchForTransport("requestUrl")) },
	);
	const final = await stream.result();
	if (!captured) {
		throw new Error(`No request was issued; stream error: ${final.errorMessage}`);
	}
	return { ...captured, errorMessage: final.errorMessage };
}

/**
 * Serves one canned SSE turn and keeps the request body that asked for it.
 *
 * Distinct from {@link streamViaRequestUrl}, which builds its own bundle and
 * injects the transport by hand: these callers are testing the injection itself,
 * so they have to drive the real entry points and only borrow the mock.
 */
function captureRequest(): { body: () => Record<string, unknown> } {
	let last: Record<string, unknown> | undefined;
	requestUrlMock.mockImplementation(async (params: unknown) => {
		const p = params as { body: string };
		last = JSON.parse(p.body) as Record<string, unknown>;
		return {
			status: 200,
			headers: { "content-type": "text/event-stream" },
			arrayBuffer: new TextEncoder().encode(sseBody("streamed")).buffer as ArrayBuffer,
		};
	});
	return {
		body: () => {
			if (!last) {
				throw new Error("no request was issued");
			}
			return last;
		},
	};
}

describe("createObsidianModels for a configured key row", () => {
	it("sends chat/completions requests to the row's base URL with the bearer key and model id", async () => {
		const row = keyRow();
		const request = await streamViaRequestUrl(keyRowModel(row), row, { apiKey: row.apiKey });
		expect(request.errorMessage).toBeUndefined();
		expect(request.url).toBe("https://gw.internal/v1/chat/completions");
		expect(request.headers.authorization).toBe(`Bearer ${row.apiKey}`);
		expect(request.body.model).toBe("qwen3-32b");
	});

	it("applies the least-common-denominator compat overrides to the wire format", async () => {
		const row = keyRow();
		const request = await streamViaRequestUrl(keyRowModel(row), row, { apiKey: row.apiKey });
		// Legacy max_tokens field, not max_completion_tokens.
		expect(request.body.max_tokens).toBeDefined();
		expect(request.body.max_completion_tokens).toBeUndefined();
		// supportsStore: false keeps the OpenAI-only store flag off the wire.
		expect(request.body.store).toBeUndefined();
		// Thinking off means no reasoning_effort field.
		expect(request.body.reasoning_effort).toBeUndefined();
	});
});

/*
 * The retention setting is only worth anything if it reaches the request body,
 * and nothing between the settings panel and the provider would report a value
 * that got dropped on the way — a lost `cacheRetention` looks exactly like a
 * working one, just billed at the five-minute rate. So these assert the wire
 * form rather than the option object: `prompt_cache_retention` is what the
 * OpenAI-compatible adapter emits for `"long"`, and its absence is what `"none"`
 * and `"short"` produce.
 */
describe("createObsidianStreamFn", () => {
	it("carries the long retention preference into the request body", async () => {
		const row = keyRow();
		const captured = captureRequest();

		const streamFn = createObsidianStreamFn({ transport: "requestUrl", providers: [row], cacheRetention: "long", maxRetries: 2 });
		await (
			await streamFn(
				keyRowModel(row),
				{ messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }] },
				// The agent loop forwards pi's `getApiKey(provider)` result here.
				{ apiKey: row.apiKey },
			)
		).result();

		expect(captured.body()["prompt_cache_retention"]).toBe("24h");
	});

	it("omits it when the reader has turned prompt caching off", async () => {
		const row = keyRow();
		const captured = captureRequest();

		const streamFn = createObsidianStreamFn({ transport: "requestUrl", providers: [row], cacheRetention: "none", maxRetries: 2 });
		await (
			await streamFn(
				keyRowModel(row),
				{ messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }] },
				{ apiKey: row.apiKey },
			)
		).result();

		expect(captured.body()["prompt_cache_retention"]).toBeUndefined();
		expect(captured.body()["prompt_cache_key"]).toBeUndefined();
	});
});

/*
 * Compaction reaches a provider through `completeSimple`, which takes no
 * transport, no key, and no retention of its own — `withRequestDefaults` is the
 * only thing that supplies them. It is a separate path from the turn above, and
 * the reason to test it separately is that the two used to spell the defaults out
 * independently: a summary billed at a different cache rate than the reply it
 * replaces is the exact failure this pins.
 */
describe("withRequestDefaults", () => {
	it("applies the retention getter to compaction's completeSimple, per call", async () => {
		const row = keyRow();
		const captured = captureRequest();
		const bundle = createObsidianModels({ transport: "requestUrl", providers: [row] });
		let retention: "none" | "short" | "long" = "long";
		const models = withRequestDefaults(bundle, () => row.apiKey, () => retention, () => 2);
		const context = { messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }], timestamp: Date.now() }] };

		await models.completeSimple(keyRowModel(row), context);
		expect(captured.body()["prompt_cache_retention"]).toBe("24h");

		// Read per call, not captured when the wrapper was built: a reader who turns
		// retention down mid-conversation must not keep paying the hour-long write
		// rate on summaries until the plugin reloads.
		retention = "none";
		await models.completeSimple(keyRowModel(row), context);
		expect(captured.body()["prompt_cache_retention"]).toBeUndefined();
	});
});

/** A credential store holding one prepared credential, and nothing else. */
function storeWith(credentials: Record<string, Credential>): CredentialStore {
	const held = new Map(Object.entries(credentials));
	return {
		read: async (providerId) => held.get(providerId),
		list: async () => [...held].map(([providerId, credential]) => ({ providerId, type: credential.type })),
		modify: async (providerId, fn) => {
			const next = await fn(held.get(providerId));
			if (next !== undefined) {
				held.set(providerId, next);
			}
			return held.get(providerId);
		},
		delete: async (providerId) => {
			held.delete(providerId);
		},
	};
}

const LIVE_TOKEN: Credential = {
	type: "oauth",
	access: "at-live",
	refresh: "rt-live",
	// Comfortably past pi's five-minute refresh window, so resolution uses the
	// stored token instead of trying to rotate it.
	expires: Date.now() + 3_600_000,
};

describe("createObsidianModels for a subscription row", () => {
	it("offers the sign-in as the row's only auth method", () => {
		// Not alongside an api key: pi short-circuits on any defined
		// `options.apiKey`, so a key left in the row from before the switch would
		// otherwise outrank the subscription without saying so.
		const bundle = createObsidianModels({ transport: "requestUrl", providers: [keyRow({ oauthFlow: "xai", apiKey: "sk-stale" })] });
		const auth = bundle.models.getProvider("p1")?.auth;
		expect(auth?.oauth?.isSubscription).toBe(true);
		expect(auth?.apiKey).toBeUndefined();
	});

	it("keeps an api key as the only method for a row with no sign-in", () => {
		const bundle = createObsidianModels({ transport: "requestUrl", providers: [keyRow()] });
		const auth = bundle.models.getProvider("p1")?.auth;
		expect(auth?.apiKey).toBeDefined();
		expect(auth?.oauth).toBeUndefined();
	});

	it("leaves a row with an unrecognised sign-in unconfigured rather than key-taking", () => {
		// A vault written by a newer build. The row has no key, so falling back to
		// one would report a failure against a field that is not the problem.
		const bundle = createObsidianModels({ transport: "requestUrl", providers: [keyRow({ oauthFlow: "future-flow", apiKey: "" })] });
		const auth = bundle.models.getProvider("p1")?.auth;
		expect(auth?.apiKey).toBeUndefined();
		expect(auth?.oauth).toBeUndefined();
	});

	it("resolves request auth from the stored credential", async () => {
		const bundle = createObsidianModels({
			transport: "requestUrl",
			providers: [keyRow({ oauthFlow: "xai", apiKey: "" })],
			credentials: storeWith({ p1: LIVE_TOKEN }),
		});
		expect(await bundle.models.getAuth("p1")).toEqual({ auth: { apiKey: "at-live" }, source: "OAuth" });
	});

	it("reports a signed-out row as unconfigured", async () => {
		const bundle = createObsidianModels({
			transport: "requestUrl",
			providers: [keyRow({ oauthFlow: "xai", apiKey: "" })],
			credentials: storeWith({}),
		});
		expect(await bundle.models.getAuth("p1")).toBeUndefined();
		expect(await bundle.models.checkAuth("p1")).toBeUndefined();
	});

	it("reports a signed-in row as authenticated by its subscription", async () => {
		const bundle = createObsidianModels({
			transport: "requestUrl",
			providers: [keyRow({ oauthFlow: "xai", apiKey: "" })],
			credentials: storeWith({ p1: LIVE_TOKEN }),
		});
		expect(await bundle.models.checkAuth("p1")).toEqual({ source: "OAuth", type: "oauth" });
	});

	it("cannot be signed in at all without a credential store, which is what a draft test wants", async () => {
		// The default store is in-memory and always empty, so a throwaway collection
		// built to probe one draft reports every subscription as signed out rather
		// than borrowing the session's real credentials.
		const bundle = createObsidianModels({ transport: "requestUrl", providers: [keyRow({ oauthFlow: "xai", apiKey: "" })] });
		expect(await bundle.models.getAuth("p1")).toBeUndefined();
	});

	it("sends the subscription token on a real request, with no key in play", async () => {
		let captured: Record<string, string> = {};
		requestUrlMock.mockImplementation(async (params: unknown) => {
			captured = (params as { headers?: Record<string, string> }).headers ?? {};
			return {
				status: 200,
				headers: { "content-type": "text/event-stream" },
				arrayBuffer: new TextEncoder().encode(responsesSseBody()).buffer as ArrayBuffer,
			};
		});
		const subscriptionRow = keyRow({ protocol: "openai-responses", oauthFlow: "xai", apiKey: "" });
		const bundle = createObsidianModels({
			transport: "requestUrl",
			providers: [subscriptionRow],
			credentials: storeWith({ p1: LIVE_TOKEN }),
		});
		const model = buildConfiguredModel(
			{ id: "m1", providerId: "p1", modelApiId: "grok-4", displayName: "Grok", reasoning: false, supportsImages: false },
			subscriptionRow,
		);
		const stream = bundle.models.streamSimple(
			model,
			{ messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }] },
			{ fetch: toFetchFunction(createFetchForTransport("requestUrl")) },
		);
		await stream.result();
		expect(captured.authorization).toBe("Bearer at-live");
	});
});
