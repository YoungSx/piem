import { describe, expect, it } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { installObsidianStub, requestUrlMock } from "../testUtils/obsidianStub";

installObsidianStub();

// Dynamic imports so the mocked `obsidian` module wins over any cached real one.
const { createObsidianModels, createObsidianStreamFn, withRequestDefaults } = await import("./streamFn");
const { createFetchForTransport, toFetchFunction } = await import("./obsidianFetch");
const { buildCustomEndpointModel } = await import("../customEndpoint");
const { CUSTOM_ENDPOINT_PROVIDER } = await import("../constants");

const ENDPOINT = { baseUrl: "https://gw.internal/v1", apiKey: "sk-custom", modelId: "qwen3-32b" };

/** SSE body for a minimal completed chat-completions turn. */
function sseBody(text: string): string {
	const chunk = (delta: object, finish: string | null) =>
		`data: ${JSON.stringify({ id: "c1", choices: [{ delta, finish_reason: finish }] })}\n\n`;
	const usage =
		'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n';
	return `${chunk({ role: "assistant", content: text }, null)}${chunk({}, "stop")}${usage}data: [DONE]\n\n`;
}

/** Captures the request the provider stack issues against the endpoint. */
async function streamViaRequestUrl(
	model: Model<"openai-completions">,
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

	const bundle = createObsidianModels({ transport: "requestUrl", customEndpoint: ENDPOINT });
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

describe("createObsidianModels with a custom endpoint", () => {
	it("registers the synthetic custom provider so its models dispatch instead of failing with Unknown provider", async () => {
		const model = buildCustomEndpointModel(ENDPOINT);
		expect(model.provider).toBe(CUSTOM_ENDPOINT_PROVIDER);

		const request = await streamViaRequestUrl(model, { apiKey: ENDPOINT.apiKey });
		expect(request.errorMessage).toBeUndefined();
	});

	it("sends chat/completions requests to the configured base URL with the bearer key and model id", async () => {
		const request = await streamViaRequestUrl(buildCustomEndpointModel(ENDPOINT), { apiKey: ENDPOINT.apiKey });
		expect(request.url).toBe("https://gw.internal/v1/chat/completions");
		expect(request.headers.authorization).toBe(`Bearer ${ENDPOINT.apiKey}`);
		expect(request.body.model).toBe(ENDPOINT.modelId);
	});

	it("applies the least-common-denominator compat overrides to the wire format", async () => {
		const request = await streamViaRequestUrl(buildCustomEndpointModel(ENDPOINT), { apiKey: ENDPOINT.apiKey });
		// Legacy max_tokens field, not max_completion_tokens.
		expect(request.body.max_tokens).toBeDefined();
		expect(request.body.max_completion_tokens).toBeUndefined();
		// supportsStore: false keeps the OpenAI-only store flag off the wire.
		expect(request.body.store).toBeUndefined();
		// Thinking off means no reasoning_effort field.
		expect(request.body.reasoning_effort).toBeUndefined();
	});

	it("refuses to resolve auth when no key is supplied, mirroring the plugin's missing-key error path", async () => {
		requestUrlMock.mockImplementation(async () => {
			throw new Error("request must never be issued without a key");
		});
		const bundle = createObsidianModels({ transport: "requestUrl", customEndpoint: ENDPOINT });
		const stream = bundle.models.streamSimple(
			buildCustomEndpointModel(ENDPOINT),
			{ messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }] },
			{},
		);
		const final = await stream.result();
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toBe("Provider is not configured: custom");
	});
});

describe("createObsidianModels without an active endpoint", () => {
	it("does not register the custom provider when no endpoint is active", () => {
		for (const customEndpoint of [undefined, null, { baseUrl: "", apiKey: "", modelId: "" }, { baseUrl: "https://x/v1", apiKey: "", modelId: "" }]) {
			const bundle = createObsidianModels({ transport: "requestUrl", customEndpoint: customEndpoint as never });
			expect(bundle.models.getProvider(CUSTOM_ENDPOINT_PROVIDER)).toBeUndefined();
		}
	});

	it("registers it once base URL and model id are both present", () => {
		const bundle = createObsidianModels({
			transport: "requestUrl",
			customEndpoint: { baseUrl: "https://x/v1", apiKey: "", modelId: "m" },
		});
		expect(bundle.models.getProvider(CUSTOM_ENDPOINT_PROVIDER)).toBeDefined();
	});
});

describe("createObsidianStreamFn with a custom endpoint", () => {
	it("routes ordinary turns through the same registered provider", async () => {
		// Only the canned response matters here; the body is asserted below.
		captureRequest();

		const streamFn = createObsidianStreamFn({ transport: "requestUrl", customEndpoint: ENDPOINT, cacheRetention: "long" });
		const stream = await streamFn(
			buildCustomEndpointModel(ENDPOINT),
			{ messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }] },
			// The agent loop forwards pi's `getApiKey(provider)` result here.
			{ apiKey: ENDPOINT.apiKey },
		);
		const final = await stream.result();
		expect(final.stopReason).not.toBe("error");
		expect(final.errorMessage).toBeUndefined();
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
	it("carries the long retention preference into the request body", async () => {
		const captured = captureRequest();

		const streamFn = createObsidianStreamFn({ transport: "requestUrl", customEndpoint: ENDPOINT, cacheRetention: "long" });
		await (
			await streamFn(
				buildCustomEndpointModel(ENDPOINT),
				{ messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }] },
				{ apiKey: ENDPOINT.apiKey },
			)
		).result();

		expect(captured.body()["prompt_cache_retention"]).toBe("24h");
	});

	it("omits it when the reader has turned prompt caching off", async () => {
		const captured = captureRequest();

		const streamFn = createObsidianStreamFn({ transport: "requestUrl", customEndpoint: ENDPOINT, cacheRetention: "none" });
		await (
			await streamFn(
				buildCustomEndpointModel(ENDPOINT),
				{ messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }] },
				{ apiKey: ENDPOINT.apiKey },
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
		const captured = captureRequest();
		const bundle = createObsidianModels({ transport: "requestUrl", customEndpoint: ENDPOINT });
		let retention: "none" | "short" | "long" = "long";
		const models = withRequestDefaults(bundle, () => ENDPOINT.apiKey, () => retention);
		const context = { messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }], timestamp: Date.now() }] };

		await models.completeSimple(buildCustomEndpointModel(ENDPOINT), context);
		expect(captured.body()["prompt_cache_retention"]).toBe("24h");

		// Read per call, not captured when the wrapper was built: a reader who turns
		// retention down mid-conversation must not keep paying the hour-long write
		// rate on summaries until the plugin reloads.
		retention = "none";
		await models.completeSimple(buildCustomEndpointModel(ENDPOINT), context);
		expect(captured.body()["prompt_cache_retention"]).toBeUndefined();
	});
});
