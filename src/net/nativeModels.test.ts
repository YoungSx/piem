import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import type { ModelConfig, ProviderConfig } from "../modelConfig";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { installObsidianStub, requestUrlMock } from "../testUtils/obsidianStub";
import { stubWindowMembers } from "../testUtils/windowStub";

installObsidianStub();
const { createObsidianModels, withRequestDefaults } = await import("./streamFn");
const { withNativeModelLookup } = await import("./nativeModels");

function settings() {
	const provider: ProviderConfig = {
		id: "endpoint", name: "Endpoint", baseUrl: "https://example.test/v1",
		protocol: "openai-completions", apiKey: "test-key", secretRef: "", source: "user", oauthFlow: "",
	};
	const model: ModelConfig = {
		id: "small", providerId: provider.id, modelApiId: "shared-api-model", displayName: "Small",
		contextWindow: 16_000, maxTokens: 512, reasoning: false, supportsImages: false,
	};
	return { providers: [provider], models: [model, { ...model, id: "large", contextWindow: 128_000, maxTokens: 4096, supportsImages: true }] };
}

test("native model references keep same-API configuration rows separate and reject stale references", () => {
	const config = settings();
	const bundle = createObsidianModels({ transport: "requestUrl", providers: config.providers });
	const models = withNativeModelLookup(() => bundle.models, () => config);
	expect(models.getModel("endpoint", "small")).toMatchObject({ id: "shared-api-model", contextWindow: 16_000, input: ["text"] });
	expect(models.getModel("endpoint", "large")).toMatchObject({ id: "shared-api-model", contextWindow: 128_000, input: ["text", "image"] });
	expect(models.getModelOfType("chat", "endpoint", "large")).toEqual(models.getModel("endpoint", "large"));
	expect(models.getModelOfType("chat", "endpoint", "shared-api-model")).toBeUndefined();
	expect(models.getModelOfType("image", "endpoint", "large")).toBeUndefined();
	expect(models.getModel("endpoint", "shared-api-model")).toBeUndefined();
	expect(models.getModel("another-endpoint", "small")).toBeUndefined();
	config.models = config.models.filter(model => model.id !== "small");
	expect(models.getModel("endpoint", "small")).toBeUndefined();
	config.providers = [];
	expect(models.getModel("endpoint", "large")).toBeUndefined();
	// The view only changes reference resolution, not auth or dispatch semantics.
	expect(models.getProviders()).toEqual(bundle.models.getProviders());
	expect(models.getProvider("endpoint")).toBe(bundle.models.getProvider("endpoint"));
});

test("native submit dispatches the API id through Obsidian transport with live model and key settings", async () => {
	const config = settings();
	const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
	requestUrlMock.mockImplementation(async (params: unknown) => {
		const request = params as { url: string; headers: Record<string, string>; body: string };
		requests.push({ ...request, body: JSON.parse(request.body) as Record<string, unknown> });
		const data = [
			{ id: "answer", choices: [{ delta: { role: "assistant", content: "Done" }, finish_reason: null }] },
			{ id: "answer", choices: [{ delta: {}, finish_reason: "stop" }] },
		].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
		return { status: 200, headers: { "content-type": "text/event-stream" }, arrayBuffer: new TextEncoder().encode(data).buffer as ArrayBuffer };
	});
	const getDefaults = () => withRequestDefaults(createObsidianModels({ transport: "requestUrl", providers: config.providers }), provider => config.providers.find(row => row.id === provider)?.apiKey, () => "none", () => 0);
	const models = withNativeModelLookup(getDefaults, () => config);
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
	try {
		const root = await harness.root(context, { agent: { model: { provider: "endpoint", modelId: "small" } } });
		expect((await (await root.submit({ type: "input", content: "First" }, context)).wait(context)).status).toBe("done");
		config.providers[0]!.apiKey = "rotated-key";
		config.providers[0]!.baseUrl = "https://moved.test/v1";
		config.models[1]!.modelApiId = "updated-api-model";
		await root.configure({ model: { provider: "endpoint", modelId: "large" } }, context);
		expect((await (await root.submit({ type: "input", content: "Second" }, context)).wait(context)).status).toBe("done");
		expect(requests).toHaveLength(2);
		expect(requests[0]).toMatchObject({ url: "https://example.test/v1/chat/completions", headers: { authorization: "Bearer test-key" }, body: { model: "shared-api-model", max_tokens: 512 } });
		expect(requests[1]).toMatchObject({ url: "https://moved.test/v1/chat/completions", headers: { authorization: "Bearer rotated-key" }, body: { model: "updated-api-model", max_tokens: 4096 } });
	} finally { await harness.close(context); }
});

test("native dispatch sees replaced protocol, OAuth registration and mobile transport without rebuilding the view", async () => {
	const config = settings();
	let transport: "requestUrl" | "fetch" = "requestUrl";
	let fetchCalls = 0;
	const response = JSON.stringify({ type: "response.completed", response: { id: "r1", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } });
	const restore = stubWindowMembers({ fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
		fetchCalls++;
		expect(String(input)).toBe("https://example.test/v1/responses");
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer subscription-token");
		expect(JSON.parse(String(init?.body))).toMatchObject({ model: "shared-api-model" });
		return new Response(`data: ${response}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
	} });
	let credential: Credential | undefined = { type: "oauth", access: "subscription-token", refresh: "refresh-token", expires: Date.now() + 3_600_000 };
	const credentials: CredentialStore = {
		read: async () => credential, list: async () => [],
		modify: async (_provider, change) => { credential = await change(credential) ?? credential; return credential; },
		delete: async () => { credential = undefined; },
	};
	const getModels = () => withRequestDefaults(
		createObsidianModels({ transport, providers: config.providers, credentials }),
		provider => { const row = config.providers.find(item => item.id === provider); return row?.oauthFlow ? undefined : row?.apiKey; }, () => "none", () => 0,
	);
	const models = withNativeModelLookup(getModels, () => config);
	expect(models.getProvider("endpoint")?.auth.apiKey).toBeDefined();
	config.providers[0]!.oauthFlow = "xai";
	config.providers[0]!.protocol = "openai-responses";
	transport = "fetch";
	expect(models.getProvider("endpoint")?.auth.apiKey).toBeUndefined();
	expect(models.getModel("endpoint", "small")?.api).toBe("openai-responses");
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
	try {
		const root = await harness.root(context, { agent: { model: { provider: "endpoint", modelId: "small" } } });
		expect((await (await root.submit({ type: "input", content: "Use updated settings" }, context)).wait(context)).status).toBe("done");
		expect(fetchCalls).toBe(1);
	} finally { await harness.close(context); restore(); }
});
