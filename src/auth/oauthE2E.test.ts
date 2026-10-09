import { normalizeContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "bun:test";
import type { Credential, CredentialStore, Model, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { emptyProviderConfig, type ProviderConfig, type WireProtocol, buildConfiguredModel } from "../modelConfig";
import { findProviderPreset, applyProviderPreset } from "../net/providerPresets";
import { installObsidianStub, requestUrlMock } from "../testUtils/obsidianStub";
import { installDom } from "../testUtils/dom";
import { createSignInSession } from "./signInSession";

installDom();
installObsidianStub();

const { createObsidianModels } = await import("../net/streamFn");
const { createFetchForTransport, toFetchFunction } = await import("../net/obsidianFetch");

/** Minimal OpenAI completions SSE turn payload. */
function sseBody(text: string): string {
	const chunk = (delta: object, finish: string | null) =>
		`data: ${JSON.stringify({ id: "c1", choices: [{ delta, finish_reason: finish }] })}\n\n`;
	const usage =
		'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n';
	return `${chunk({ role: "assistant", content: text }, null)}${chunk({}, "stop")}${usage}data: [DONE]\n\n`;
}

/** Minimal OpenAI completions SSE payload with tool call and stop. */
function sseToolCallBody(id: string, name: string, args: string): string {
	const chunk = (delta: object, finish: string | null) =>
		`data: ${JSON.stringify({ id: "c1", choices: [{ delta, finish_reason: finish }] })}\n\n`;
	const toolDelta = {
		role: "assistant",
		tool_calls: [
			{
				index: 0,
				id,
				type: "function",
				function: {
					name,
					arguments: args,
				},
			},
		],
	};
	return `${chunk(toolDelta, null)}${chunk({}, "tool_calls")}data: [DONE]\n\n`;
}

/** Minimal Anthropic messages SSE payload. */
function anthropicSseBody(text: string): string {
	return [
		`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", model: "claude-3-7-sonnet", role: "assistant", content: [], usage: { input_tokens: 3, output_tokens: 0 } } })}\n\n`,
		'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
		`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${text}"}}\n\n`,
		'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
		'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
		'event: message_stop\ndata: {"type":"message_stop"}\n\n',
	].join("");
}

/** Minimal OpenAI Responses SSE payload. */
function responsesSseBody(): string {
	const created = { type: "response.created", response: { id: "r1", status: "in_progress" } };
	const completed = {
		type: "response.completed",
		response: { id: "r1", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } },
	};
	return `data: ${JSON.stringify(created)}\n\ndata: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`;
}

/** In-memory credential store matching CredentialStore contract. */
function storeOver(entries: Map<string, Credential>): CredentialStore {
	return {
		read: async (id) => entries.get(id),
		list: async () => [...entries.entries()].map(([providerId, credential]) => ({ providerId, type: credential.type })),
		modify: async (id, fn) => {
			const next = await fn(entries.get(id));
			if (next === undefined) {
				entries.delete(id);
			} else {
				entries.set(id, next);
			}
			return next;
		},
		delete: async (id) => {
			entries.delete(id);
		},
	};
}

function mockInteraction(): ProviderAuthInteraction {
	const controller = new AbortController();
	return {
		signal: controller.signal,
		notify: () => {},
		prompt: async () => "",
	};
}

describe("End-to-End OAuth Integration: Preset -> Sign-in -> Credential -> Request Dispatch", () => {
	it("executes complete lifecycle for GitHub Copilot subscription", async () => {
		// Step 1: Pick preset & configure provider
		const preset = findProviderPreset("github-copilot");
		expect(preset).toBeDefined();
		const providerConfig = applyProviderPreset(
			{ ...emptyProviderConfig(), id: "provider-copilot" },
			preset!,
		);
		expect(providerConfig.oauthFlow).toBe("github-copilot");

		// Step 2: Simulate OAuth Device Code authorization
		const entries = new Map<string, Credential>();
		const credStore = storeOver(entries);

		const oauthReplies = [
			// Device code request
			{
				body: {
					device_code: "dc-gh-123",
					user_code: "GH-8888",
					verification_uri: "https://github.com/login/device",
				},
			},
			// Access token polling response
			{
				body: {
					access_token: "gho_initial_oauth_token",
					refresh_token: "",
					expires_in: 1800,
				},
			},
			// Copilot internal Bearer token exchange
			{
				body: {
					token: "ghu_copilot_internal_key;proxy-ep=proxy.individual.githubcopilot.com",
					expires_at: Math.floor(Date.now() / 1000) + 3600,
				},
			},
		];

		let replyIdx = 0;
		const scriptedFetch = async () => {
			const reply = oauthReplies[replyIdx++];
			if (!reply) throw new Error("Unexpected fetch call");
			return new Response(JSON.stringify(reply.body), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const session = createSignInSession({
			credentials: credStore,
			fetch: scriptedFetch as unknown as typeof fetch,
			canStore: () => true,
			sleep: async () => {},
		});

		const actions = session.actionsFor({ id: providerConfig.id, flowId: providerConfig.oauthFlow });
		expect(actions).toBeDefined();
		expect(await actions!.isSignedIn()).toBe(false);

		// Execute sign in
		await actions!.signIn(mockInteraction());

		// Step 3: Verify credentials stored safely
		expect(await actions!.isSignedIn()).toBe(true);
		const savedCred = entries.get(providerConfig.id);
		expect(savedCred?.type).toBe("oauth");
		if (savedCred?.type === "oauth") {
			expect(savedCred.access).toContain("ghu_copilot_internal_key");
		}

		// Step 4: Auth resolution and Model dispatch
		let capturedRequest: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | undefined;
		requestUrlMock.mockImplementation(async (params: unknown) => {
			const p = params as { url: string; headers: Record<string, string>; body: string };
			capturedRequest = {
				url: p.url,
				headers: p.headers ?? {},
				body: JSON.parse(p.body) as Record<string, unknown>,
			};
			return {
				status: 200,
				headers: { "content-type": "text/event-stream" },
				arrayBuffer: new TextEncoder().encode(sseBody("Hello Copilot response")).buffer as ArrayBuffer,
			};
		});

		const bundle = createObsidianModels({
			transport: "requestUrl",
			providers: [providerConfig],
			credentials: credStore,
		});

		const auth = await bundle.models.getAuth(providerConfig.id);
		expect(auth?.source).toBe("OAuth");
		expect(auth?.auth.apiKey).toBe("ghu_copilot_internal_key;proxy-ep=proxy.individual.githubcopilot.com");
		expect(auth?.auth.baseUrl).toBe("https://api.individual.githubcopilot.com");
		expect(auth?.auth.headers?.["Copilot-Integration-Id"]).toBe("vscode-chat");

		// Step 5: Send chat turn
		const model: Model<WireProtocol> = buildConfiguredModel(
			{
				id: "m-copilot",
				providerId: providerConfig.id,
				modelApiId: "gpt-4o",
				displayName: "GPT-4o (Copilot)",
				reasoning: false,
				supportsImages: false,
			},
			providerConfig,
		);

		const stream = bundle.models.streamSimple(
			model,
			normalizeContext({
				messages: [{ role: "user", content: [{ type: "text", text: "Hello from user" }], timestamp: Date.now() }],
			}),
			{
				fetch: toFetchFunction(createFetchForTransport("requestUrl")),
			},
		);

		const result = await stream.result();
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello Copilot response" }]);

		// Verify HTTP request headers & endpoint dispatched
		expect(capturedRequest).toBeDefined();
		expect(capturedRequest!.url).toContain("api.individual.githubcopilot.com");
		expect(capturedRequest!.headers["authorization"]).toBe("Bearer ghu_copilot_internal_key;proxy-ep=proxy.individual.githubcopilot.com");
		expect(capturedRequest!.headers["copilot-integration-id"]).toBe("vscode-chat");
		expect(capturedRequest!.headers["editor-version"]).toBe("vscode/1.107.0");
	});

	it("verifies GitHub Copilot tool calling and streaming termination", async () => {
		const preset = findProviderPreset("github-copilot");
		const providerConfig = applyProviderPreset(
			{ ...emptyProviderConfig(), id: "provider-copilot-tools" },
			preset!,
		);

		const entries = new Map<string, Credential>();
		entries.set(providerConfig.id, {
			type: "oauth",
			access: "ghu_copilot_internal_key;proxy-ep=proxy.individual.githubcopilot.com",
			refresh: "gho_token",
			expires: Date.now() + 3600 * 1000,
		});
		const credStore = storeOver(entries);

		let capturedBody: Record<string, unknown> | undefined;
		requestUrlMock.mockImplementation(async (params: unknown) => {
			const p = params as { url: string; headers: Record<string, string>; body: string };
			capturedBody = JSON.parse(p.body) as Record<string, unknown>;
			return {
				status: 200,
				headers: { "content-type": "text/event-stream" },
				arrayBuffer: new TextEncoder().encode(
					sseToolCallBody("call_search_1", "web_search", JSON.stringify({ query: "pi plugin" })),
				).buffer as ArrayBuffer,
			};
		});

		const bundle = createObsidianModels({
			transport: "requestUrl",
			providers: [providerConfig],
			credentials: credStore,
		});

		const model: Model<WireProtocol> = buildConfiguredModel(
			{
				id: "m-copilot-tools",
				providerId: providerConfig.id,
				modelApiId: "gpt-4o",
				displayName: "GPT-4o (Copilot)",
				reasoning: false,
				supportsImages: false,
			},
			providerConfig,
		);

		const toolDef = {
			name: "web_search",
			description: "Search the web",
			parameters: {
				type: "object" as const,
				properties: { query: { type: "string" } },
				required: ["query"],
			},
		};

		const stream = bundle.models.streamSimple(
			model,
			normalizeContext({
				messages: [{ role: "user", content: [{ type: "text", text: "search pi plugin" }], timestamp: Date.now() }],
				tools: [toolDef],
			}),
			{
				fetch: toFetchFunction(createFetchForTransport("requestUrl")),
			},
		);

		const result = await stream.result();
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([
			{
				type: "toolCall",
				id: "call_search_1",
				name: "web_search",
				arguments: { query: "pi plugin" },
			},
		]);
		expect(result.stopReason).toBe("toolUse");
		expect(capturedBody).toBeDefined();
		expect(capturedBody!.tools).toBeDefined();
	});

	it("executes complete lifecycle for Kimi For Coding subscription", async () => {
		const preset = findProviderPreset("kimi-coding");
		expect(preset).toBeDefined();
		const providerConfig = applyProviderPreset(
			{ ...emptyProviderConfig(), id: "provider-kimi" },
			preset!,
		);
		expect(providerConfig.oauthFlow).toBe("kimi-coding");

		const entries = new Map<string, Credential>();
		const credStore = storeOver(entries);

		const oauthReplies = [
			{
				body: {
					device_code: "dc-kimi-999",
					user_code: "KIMI-4321",
					verification_uri: "https://auth.kimi.com/device",
				},
			},
			{
				body: {
					access_token: "kimi_live_token",
					refresh_token: "kimi_ref_token",
					expires_in: 3600,
				},
			},
		];

		let replyIdx = 0;
		const scriptedFetch = async () => {
			const reply = oauthReplies[replyIdx++];
			if (!reply) throw new Error("Unexpected fetch call");
			return new Response(JSON.stringify(reply.body), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const session = createSignInSession({
			credentials: credStore,
			fetch: scriptedFetch as unknown as typeof fetch,
			canStore: () => true,
			sleep: async () => {},
		});

		const actions = session.actionsFor({ id: providerConfig.id, flowId: providerConfig.oauthFlow });
		expect(actions).toBeDefined();
		await actions!.signIn(mockInteraction());
		expect(await actions!.isSignedIn()).toBe(true);

		let capturedRequest: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | undefined;
		requestUrlMock.mockImplementation(async (params: unknown) => {
			const p = params as { url: string; headers: Record<string, string>; body: string };
			capturedRequest = {
				url: p.url,
				headers: p.headers ?? {},
				body: JSON.parse(p.body) as Record<string, unknown>,
			};
			return {
				status: 200,
				headers: { "content-type": "text/event-stream" },
				arrayBuffer: new TextEncoder().encode(anthropicSseBody("Hello Kimi")).buffer as ArrayBuffer,
			};
		});

		const bundle = createObsidianModels({
			transport: "requestUrl",
			providers: [providerConfig],
			credentials: credStore,
		});

		const auth = await bundle.models.getAuth(providerConfig.id);
		expect(auth?.source).toBe("OAuth");
		expect(auth?.auth.headers?.["Authorization"]).toBe("Bearer kimi_live_token");

		const model: Model<WireProtocol> = buildConfiguredModel(
			{
				id: "m-kimi",
				providerId: providerConfig.id,
				modelApiId: "k1",
				displayName: "Kimi Coding",
				reasoning: false,
				supportsImages: false,
			},
			providerConfig,
		);

		const stream = bundle.models.streamSimple(
			model,
			normalizeContext({
				messages: [{ role: "user", content: [{ type: "text", text: "Hello Kimi" }], timestamp: Date.now() }],
			}),
			{
				fetch: toFetchFunction(createFetchForTransport("requestUrl")),
			},
		);

		const result = await stream.result();
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello Kimi" }]);
		expect(capturedRequest).toBeDefined();
		expect(capturedRequest!.headers["authorization"]).toBe("Bearer kimi_live_token");
	});

	it("executes complete lifecycle for xAI subscription", async () => {
		const preset = findProviderPreset("xai-subscription");
		expect(preset).toBeDefined();
		const providerConfig = applyProviderPreset(
			{ ...emptyProviderConfig(), id: "provider-xai" },
			preset!,
		);
		expect(providerConfig.oauthFlow).toBe("xai");

		const entries = new Map<string, Credential>();
		const credStore = storeOver(entries);

		const oauthReplies = [
			{
				body: {
					device_code: "dc-xai-111",
					user_code: "XAI-1111",
					verification_uri: "https://x.ai/device",
				},
			},
			{
				body: {
					access_token: "xai_access_token_val",
					refresh_token: "xai_refresh_token_val",
					expires_in: 7200,
				},
			},
		];

		let replyIdx = 0;
		const scriptedFetch = async () => {
			const reply = oauthReplies[replyIdx++];
			if (!reply) throw new Error("Unexpected fetch call");
			return new Response(JSON.stringify(reply.body), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const session = createSignInSession({
			credentials: credStore,
			fetch: scriptedFetch as unknown as typeof fetch,
			canStore: () => true,
			sleep: async () => {},
		});

		const actions = session.actionsFor({ id: providerConfig.id, flowId: providerConfig.oauthFlow });
		await actions!.signIn(mockInteraction());
		expect(await actions!.isSignedIn()).toBe(true);

		let capturedRequest: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | undefined;
		requestUrlMock.mockImplementation(async (params: unknown) => {
			const p = params as { url: string; headers: Record<string, string>; body: string };
			capturedRequest = {
				url: p.url,
				headers: p.headers ?? {},
				body: JSON.parse(p.body) as Record<string, unknown>,
			};
			return {
				status: 200,
				headers: { "content-type": "text/event-stream" },
				arrayBuffer: new TextEncoder().encode(responsesSseBody()).buffer as ArrayBuffer,
			};
		});

		const bundle = createObsidianModels({
			transport: "requestUrl",
			providers: [providerConfig],
			credentials: credStore,
		});

		const auth = await bundle.models.getAuth(providerConfig.id);
		expect(auth?.source).toBe("OAuth");
		expect(auth?.auth.apiKey).toBe("xai_access_token_val");

		const model: Model<WireProtocol> = buildConfiguredModel(
			{
				id: "m-xai",
				providerId: providerConfig.id,
				modelApiId: "grok-beta",
				displayName: "Grok",
				reasoning: false,
				supportsImages: false,
			},
			providerConfig,
		);

		const stream = bundle.models.streamSimple(
			model,
			normalizeContext({
				messages: [{ role: "user", content: [{ type: "text", text: "Hello Grok" }], timestamp: Date.now() }],
			}),
			{
				fetch: toFetchFunction(createFetchForTransport("requestUrl")),
			},
		);

		const result = await stream.result();
		expect(result.errorMessage).toBeUndefined();
		expect(capturedRequest).toBeDefined();
		expect(capturedRequest!.headers["authorization"]).toBe("Bearer xai_access_token_val");
	});

	it("executes complete lifecycle for Anthropic (Claude Pro/Max) subscription", async () => {
		const preset = findProviderPreset("anthropic-subscription");
		expect(preset).toBeDefined();
		const providerConfig = applyProviderPreset(
			{ ...emptyProviderConfig(), id: "provider-claude" },
			preset!,
		);
		expect(providerConfig.oauthFlow).toBe("anthropic");

		const entries = new Map<string, Credential>();
		const credStore = storeOver(entries);

		// Anthropic manual code flow: PKCE code exchange response
		const oauthReplies = [
			{
				body: {
					access_token: "sk-ant-oat-live-token",
					refresh_token: "rt-claude-key",
					expires_in: 3600,
				},
			},
		];

		let replyIdx = 0;
		const scriptedFetch = async () => {
			const reply = oauthReplies[replyIdx++];
			if (!reply) throw new Error("Unexpected fetch call");
			return new Response(JSON.stringify(reply.body), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const session = createSignInSession({
			credentials: credStore,
			fetch: scriptedFetch as unknown as typeof fetch,
			canStore: () => true,
		});

		const actions = session.actionsFor({ id: providerConfig.id, flowId: providerConfig.oauthFlow });
		expect(actions).toBeDefined();
		expect(await actions!.isSignedIn()).toBe(false);

		let announcedUrl = "";
		const interaction: ProviderAuthInteraction = {
			signal: new AbortController().signal,
			notify: (event) => {
				if (event.type === "auth_url") announcedUrl = event.url;
			},
			prompt: async () => {
				const url = new URL(announcedUrl);
				const state = url.searchParams.get("state") ?? "";
				return `mock_auth_code#${state}`;
			},
		};

		await actions!.signIn(interaction);
		expect(await actions!.isSignedIn()).toBe(true);
		const savedCred = entries.get(providerConfig.id);
		expect(savedCred?.type).toBe("oauth");
		if (savedCred?.type === "oauth") {
			expect(savedCred.access).toBe("sk-ant-oat-live-token");
		}

		let capturedRequest: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | undefined;
		requestUrlMock.mockImplementation(async (params: unknown) => {
			const p = params as { url: string; headers: Record<string, string>; body: string };
			capturedRequest = {
				url: p.url,
				headers: p.headers ?? {},
				body: JSON.parse(p.body) as Record<string, unknown>,
			};
			return {
				status: 200,
				headers: { "content-type": "text/event-stream" },
				arrayBuffer: new TextEncoder().encode(anthropicSseBody("Hello Claude")).buffer as ArrayBuffer,
			};
		});

		const bundle = createObsidianModels({
			transport: "requestUrl",
			providers: [providerConfig],
			credentials: credStore,
		});

		const auth = await bundle.models.getAuth(providerConfig.id);
		expect(auth?.source).toBe("OAuth");
		expect(auth?.auth.apiKey).toBe("sk-ant-oat-live-token");

		const model: Model<WireProtocol> = buildConfiguredModel(
			{
				id: "m-claude",
				providerId: providerConfig.id,
				modelApiId: "claude-3-7-sonnet",
				displayName: "Claude 3.7 Sonnet",
				reasoning: false,
				supportsImages: false,
			},
			providerConfig,
		);

		const stream = bundle.models.streamSimple(
			model,
			normalizeContext({
				messages: [{ role: "user", content: [{ type: "text", text: "Hello Claude" }], timestamp: Date.now() }],
			}),
			{
				fetch: toFetchFunction(createFetchForTransport("requestUrl")),
			},
		);

		const result = await stream.result();
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello Claude" }]);
		expect(capturedRequest).toBeDefined();
		expect(capturedRequest!.headers["authorization"]).toBe("Bearer sk-ant-oat-live-token");
		expect(capturedRequest!.headers["user-agent"]).toContain("claude-cli");
	});

	it("executes complete lifecycle for Meta (Muse subscription) including key minting and refresh", async () => {
		const preset = findProviderPreset("meta");
		expect(preset).toBeDefined();
		const providerConfig = applyProviderPreset(
			{ ...emptyProviderConfig(), id: "provider-meta" },
			preset!,
		);
		expect(providerConfig.oauthFlow).toBe("meta");

		const entries = new Map<string, Credential>();
		const credStore = storeOver(entries);

		// Meta two-step flow:
		// 1. Device code request
		// 2. Token poll -> returns user identity token
		// 3. Key minting (api.meta.ai/muse-code/key) -> returns model API key
		const oauthReplies = [
			{
				body: {
					device_code: "dc-meta-123",
					user_code: "META-9999",
					verification_uri: "https://auth.meta.com/device",
				},
			},
			{
				body: {
					access_token: "meta_user_identity_token_abc",
					expires_in: 86400,
				},
			},
			{
				body: {
					api_key: "muse_minted_api_key_888",
				},
			},
		];

		let replyIdx = 0;
		const scriptedFetch = async () => {
			const reply = oauthReplies[replyIdx++];
			if (!reply) throw new Error("Unexpected fetch call in Meta test");
			return new Response(JSON.stringify(reply.body), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const session = createSignInSession({
			credentials: credStore,
			fetch: scriptedFetch as unknown as typeof fetch,
			canStore: () => true,
			sleep: async () => {},
		});

		const actions = session.actionsFor({ id: providerConfig.id, flowId: providerConfig.oauthFlow });
		expect(actions).toBeDefined();
		expect(await actions!.isSignedIn()).toBe(false);

		await actions!.signIn(mockInteraction());
		expect(await actions!.isSignedIn()).toBe(true);

		// Verify stored credential holds minted API key as access and identity token as refresh
		const savedCred = entries.get(providerConfig.id);
		expect(savedCred?.type).toBe("oauth");
		if (savedCred?.type === "oauth") {
			expect(savedCred.access).toBe("muse_minted_api_key_888");
			expect(savedCred.refresh).toBe("meta_user_identity_token_abc");
		}

		let capturedRequest: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | undefined;
		requestUrlMock.mockImplementation(async (params: unknown) => {
			const p = params as { url: string; headers: Record<string, string>; body: string };
			capturedRequest = {
				url: p.url,
				headers: p.headers ?? {},
				body: JSON.parse(p.body) as Record<string, unknown>,
			};
			return {
				status: 200,
				headers: { "content-type": "text/event-stream" },
				arrayBuffer: new TextEncoder().encode(responsesSseBody()).buffer as ArrayBuffer,
			};
		});

		const bundle = createObsidianModels({
			transport: "requestUrl",
			providers: [providerConfig],
			credentials: credStore,
		});

		const auth = await bundle.models.getAuth(providerConfig.id);
		expect(auth?.source).toBe("OAuth");
		expect(auth?.auth.apiKey).toBe("muse_minted_api_key_888");

		const model: Model<WireProtocol> = buildConfiguredModel(
			{
				id: "m-meta",
				providerId: providerConfig.id,
				modelApiId: "meta/llama-3.3-70b-instruct",
				displayName: "Llama 3.3 70B",
				reasoning: false,
				supportsImages: false,
			},
			providerConfig,
		);

		const stream = bundle.models.streamSimple(
			model,
			normalizeContext({
				messages: [{ role: "user", content: [{ type: "text", text: "Hello Meta" }], timestamp: Date.now() }],
			}),
			{
				fetch: toFetchFunction(createFetchForTransport("requestUrl")),
			},
		);

		const result = await stream.result();
		expect(result.errorMessage).toBeUndefined();
		expect(capturedRequest).toBeDefined();
		expect(capturedRequest!.headers["authorization"]).toBe("Bearer muse_minted_api_key_888");
	});

	it("executes complete lifecycle for OpenRouter subscription using official out-of-band flow", async () => {
		const preset = findProviderPreset("openrouter-subscription");
		expect(preset).toBeDefined();
		const providerConfig = applyProviderPreset(
			{ ...emptyProviderConfig(), id: "provider-openrouter" },
			preset!,
		);
		expect(providerConfig.oauthFlow).toBe("openrouter");

		const entries = new Map<string, Credential>();
		const credStore = storeOver(entries);

		// OpenRouter out-of-band PKCE exchange: posts code to /api/v1/auth/keys
		let exchangePostedBody: Record<string, unknown> | undefined;
		const scriptedFetch = async (input: unknown, init?: RequestInit) => {
			exchangePostedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			return new Response(JSON.stringify({ key: "sk-or-v1-permanent-user-key-999" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const session = createSignInSession({
			credentials: credStore,
			fetch: scriptedFetch as unknown as typeof fetch,
			canStore: () => true,
		});

		const actions = session.actionsFor({ id: providerConfig.id, flowId: providerConfig.oauthFlow });
		expect(actions).toBeDefined();
		expect(await actions!.isSignedIn()).toBe(false);

		let announcedUrl = "";
		let promptDetails: unknown;
		const interaction: ProviderAuthInteraction = {
			signal: new AbortController().signal,
			notify: (event) => {
				if (event.type === "auth_url") announcedUrl = event.url;
			},
			prompt: async (prompt) => {
				promptDetails = prompt;
				return "or-code-displayed-on-screen-123";
			},
		};

		await actions!.signIn(interaction);
		expect(await actions!.isSignedIn()).toBe(true);

		// Verify authorize URL is strictly out-of-band (no localhost or callback_url)
		const authUrl = new URL(announcedUrl);
		expect(authUrl.origin + authUrl.pathname).toBe("https://openrouter.ai/auth");
		expect(authUrl.searchParams.has("callback_url")).toBe(false);
		expect(authUrl.searchParams.has("code_challenge")).toBe(true);
		expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");

		// Verify prompt guided user to paste code shown on screen
		expect(promptDetails).toMatchObject({
			type: "manual_code",
			placeholder: "Paste authorization code here",
		});

		// Verify exchange payload sent to OpenRouter
		expect(exchangePostedBody).toEqual({
			code: "or-code-displayed-on-screen-123",
			code_verifier: expect.any(String),
			code_challenge_method: "S256",
		});

		const savedCred = entries.get(providerConfig.id);
		expect(savedCred?.type).toBe("oauth");
		if (savedCred?.type === "oauth") {
			expect(savedCred.access).toBe("sk-or-v1-permanent-user-key-999");
			expect(savedCred.expires).toBe(Number.MAX_SAFE_INTEGER);
		}

		let capturedRequest: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | undefined;
		requestUrlMock.mockImplementation(async (params: unknown) => {
			const p = params as { url: string; headers: Record<string, string>; body: string };
			capturedRequest = {
				url: p.url,
				headers: p.headers ?? {},
				body: JSON.parse(p.body) as Record<string, unknown>,
			};
			return {
				status: 200,
				headers: { "content-type": "text/event-stream" },
				arrayBuffer: new TextEncoder().encode(sseBody("Hello OpenRouter response")).buffer as ArrayBuffer,
			};
		});

		const bundle = createObsidianModels({
			transport: "requestUrl",
			providers: [providerConfig],
			credentials: credStore,
		});

		const auth = await bundle.models.getAuth(providerConfig.id);
		expect(auth?.source).toBe("OAuth");
		expect(auth?.auth.apiKey).toBe("sk-or-v1-permanent-user-key-999");

		const model: Model<WireProtocol> = buildConfiguredModel(
			{
				id: "m-openrouter",
				providerId: providerConfig.id,
				modelApiId: "meta-llama/llama-3.3-70b-instruct",
				displayName: "Llama 3.3 70B (OpenRouter)",
				reasoning: false,
				supportsImages: false,
			},
			providerConfig,
		);

		const stream = bundle.models.streamSimple(
			model,
			normalizeContext({
				messages: [{ role: "user", content: [{ type: "text", text: "Hello OpenRouter" }], timestamp: Date.now() }],
			}),
			{
				fetch: toFetchFunction(createFetchForTransport("requestUrl")),
			},
		);

		const result = await stream.result();
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello OpenRouter response" }]);
		expect(capturedRequest).toBeDefined();
		expect(capturedRequest!.headers["authorization"]).toBe("Bearer sk-or-v1-permanent-user-key-999");
	});
});
