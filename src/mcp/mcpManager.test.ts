import { afterAll, describe, expect, it, vi } from "bun:test";
import { installObsidianStub } from "../testUtils/obsidianStub";
import { stubWindowTimers } from "../testUtils/windowStub";
import type { McpServerConfig } from "./mcpConfig";

// The manager transitively imports obsidianFetch, which imports Obsidian's
// API. The stub registers first; the real imports stay dynamic so the mock is
// in place when the module graph evaluates.
installObsidianStub();

// The manager arms `window.setTimeout` in its connect timeout wrapper. These
// tests run without a DOM, so the platform timers go on `window` directly —
// without this, a solo run of this file red-outs on the first `window.setTimeout`
// and only passes because some other file installed one first.
const restoreWindowTimers = stubWindowTimers();

afterAll(() => {
	restoreWindowTimers();
});

const { createMcpServerConfig } = await import("./mcpConfig");
const { createNoGetStreamFetch, McpManager } = await import("./mcpManager");
import { spyLogger } from "../testUtils/logSpy";
import type { LoggerLike } from "../logging/Logger";

/** Test fixtures always carry a usable URL; the null branch is mcpConfig.test.ts's job. */
function serverFixture(partial: Parameters<typeof createMcpServerConfig>[0]): McpServerConfig {
	return createMcpServerConfig(partial)!;
}

/**
 * Builds the two responses a Streamable HTTP handshake needs: the initialize
 * result (with a session id the transport will echo) and the 202 for the
 * `notifications/initialized` POST.
 */
function handshakeResponses(sessionId: string): Response[] {
	return [
		new Response(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 0,
				result: {
					protocolVersion: "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: "stub", version: "0.0.1" },
				},
			}),
			{ status: 200, headers: { "content-type": "application/json", "mcp-session-id": sessionId } },
		),
		new Response(null, { status: 202 }),
	];
}

/**
 * A fetch double that serves a scripted response per POST, in order, and the
 * 405 "no server stream" answer for GETs (mirroring what the production shim
 * injects, so the tests exercise the same shape of traffic).
 */
function scriptedFetch(script: Response[]) {
	const calls: { url: string; init: RequestInit | undefined }[] = [];
	let next = 0;
	const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
		calls.push({ url: String(url), init });
		if ((init?.method ?? "GET").toUpperCase() === "GET") {
			return new Response(null, { status: 405 });
		}
		const response = script[Math.min(next, script.length - 1)]!;
		next++;
		return response;
	};
	return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

/**
 * Stands in for the manifest version the plugin injects.
 *
 * Deliberately not the real one: the point of taking it from the manifest is
 * that no source file pins it, so a test that hardcoded today's version would
 * re-create the drift the injection removed.
 */
const STUB_PLUGIN_VERSION = "9.9.9-test";

/** The fetch shape the test doubles actually implement, before the SDK's `preconnect` typing noise. */
type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

function makeManager(
	servers: McpServerConfig[],
	fetchFactory: (transport: "requestUrl" | "fetch") => FetchLike,
	transport: "requestUrl" | "fetch" = "requestUrl",
	logger?: LoggerLike,
): InstanceType<typeof McpManager> {
	return new McpManager(
		() => servers,
		() => transport,
		STUB_PLUGIN_VERSION,
		fetchFactory,
		logger,
	);
}

/**
 * Serves a complete handshake and records the method of every request that
 * actually reached the transport.
 *
 * Unlike {@link scriptedFetch} this one does not pretend to be the production
 * shim — it answers GET with the 405 a stream-less server would send, but it
 * records the call first. That is what lets a test tell "the wrapper answered
 * the probe" from "the probe went out and the server declined".
 */
function handshakeRecorder(): { methods: string[]; fetch: FetchLike } {
	const methods: string[] = [];
	const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
		const method = (init?.method ?? "GET").toUpperCase();
		methods.push(method);
		if (method === "GET") {
			return new Response(null, { status: 405 });
		}
		const body = typeof init?.body === "string" ? init.body : "";
		if (body.includes('"method":"initialize"')) {
			return handshakeResponses("session-stream")[0]!;
		}
		if (body.includes("notifications/initialized")) {
			return new Response(null, { status: 202 });
		}
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { methods, fetch };
}

/**
 * One fetch double behind two logs, chosen by which transport the manager asked
 * for. Serves a full handshake, a tool list, and a tool call on either side, so
 * a test can read off exactly which transport saw which request. A POST is
 * logged as its JSON-RPC method when it is a `tools/call` — the one request
 * whose transport is the whole point of the split.
 */
function splitFactory() {
	const seen = { mount: [] as string[], call: [] as string[] };
	const factory = (transport: "requestUrl" | "fetch"): FetchLike =>
		async (url: string | URL, init?: RequestInit): Promise<Response> => {
			const method = (init?.method ?? "GET").toUpperCase();
			const body = typeof init?.body === "string" ? init.body : "";
			const label = body.includes('"method":"tools/call"') ? "tools/call" : method;
			(transport === "requestUrl" ? seen.mount : seen.call).push(label);
			if (method === "GET") {
				return new Response(null, { status: 405 });
			}
			if (body.includes('"method":"initialize"')) {
				return handshakeResponses("session-split")[0]!;
			}
			if (body.includes("notifications/initialized")) {
				return new Response(null, { status: 202 });
			}
			if (body.includes('"method":"tools/list"')) {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						result: { tools: [{ name: "finish", inputSchema: { type: "object" } }] },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(
				JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "done" }] } }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};
	return { seen, factory };
}

describe("createNoGetStreamFetch", () => {
	it("answers GET with the 405 the SDK reads as 'no server stream'", async () => {
		const inner = vi.fn(async () => new Response("should not be reached"));
		const wrapped = createNoGetStreamFetch(inner);
		const response = await wrapped("https://m.example.com", { method: "GET" });
		expect(response.status).toBe(405);
		expect(inner).not.toHaveBeenCalled();
	});

	it("answers an undefined method (the fetch default GET) the same way", async () => {
		const wrapped = createNoGetStreamFetch(async () => new Response("x"));
		expect((await wrapped("https://m.example.com")).status).toBe(405);
	});

	it("passes every other method through to the chosen transport", async () => {
		const inner = vi.fn(async () => new Response("{}", { status: 200 }));
		const wrapped = createNoGetStreamFetch(inner);
		await wrapped("https://m.example.com", { method: "POST", body: "{}" });
		expect(inner).toHaveBeenCalledTimes(1);
	});
});

describe("McpManager", () => {
	it("marks an unreachable server as error and produces no tools", async () => {
		const bad = serverFixture({ name: "bad", url: "https://bad.example.com" });
		const failing = async (): Promise<Response> => {
			throw new TypeError("fetch failed");
		};
		const manager = makeManager([bad], () => failing);
		await manager.connect();

		const [state] = manager.getServerStates();
		expect(state?.status).toBe("error");
		expect(state?.error).toContain("fetch failed");
		expect(manager.buildAgentTools()).toEqual([]);
		await manager.dispose();
	});

	it("keeps disabled servers out of connection attempts and reports them disabled", async () => {
		const off = serverFixture({ name: "off", url: "https://off.example.com", enabled: false });
		const { fetch } = scriptedFetch([]);
		const manager = makeManager([off], () => fetch);
		await manager.connect();

		const [state] = manager.getServerStates();
		expect(state?.status).toBe("disabled");
		expect(state?.toolCount).toBe(0);
		expect(manager.buildAgentTools()).toEqual([]);
		await manager.dispose();
	});

	it("reports untested servers as untested before any connect", () => {
		const server = serverFixture({ name: "pending", url: "https://p.example.com" });
		const manager = makeManager([server], () => async () => new Response("{}"));
		expect(manager.getServerStates()[0]?.status).toBe("untested");
	});

	it("testServer completes a handshake, sends the bearer token, and returns the tool count", async () => {
		const server = serverFixture({
			name: "live",
			url: "https://live.example.com",
			token: "secret-token",
		});
		const manager = makeManager([server], () => async (url, init) => {
			if ((init?.method ?? "GET").toUpperCase() === "GET") {
				return new Response(null, { status: 405 });
			}
			const body = typeof init?.body === "string" ? init.body : "";
			if (body.includes('"method":"initialize"')) {
				return handshakeResponses("session-1")[0]!;
			}
			if (body.includes("notifications/initialized")) {
				return new Response(null, { status: 202 });
			}
			if (body.includes('"method":"tools/list"')) {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						result: { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32601, message: "unexpected" } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const count = await manager.testServer(server);
		expect(count).toBe(1);

		// The saved config stays untested: a probe must not poison the cache.
		expect(manager.getServerStates()[0]?.status).toBe("untested");
		await manager.dispose();
	});

	it("logs a passed test at info and a failed mount at warn", async () => {
		// The probe's verdict lives only in the panel row, and the startup
		// connect is fire-and-forget — the logger is the only trace either path
		// leaves outside a settings tab that may never be open.
		const spy = spyLogger();
		const server = serverFixture({ name: "live", url: "https://live.example.com", token: "" });
		const manager = makeManager(
			[server],
			() => async (url, init) => {
				if ((init?.method ?? "GET").toUpperCase() === "GET") {
					return new Response(null, { status: 405 });
				}
				const body = typeof init?.body === "string" ? init.body : "";
				if (body.includes('"method":"initialize"')) {
					return handshakeResponses("session-log-1")[0]!;
				}
				if (body.includes("notifications/initialized")) {
					return new Response(null, { status: 202 });
				}
				return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
			"requestUrl",
			spy.logger,
		);

		await manager.testServer(server);
		const pass = spy.records.find((record) => record.message.startsWith("MCP test passed"));
		expect(pass?.level).toBe("info");
		expect(pass?.detail).toEqual({ tools: 0, ms: expect.any(Number) });

		await manager.connect();
		const mount = spy.records.find((record) => record.message.startsWith("MCP server mounted"));
		expect(mount?.level).toBe("info");

		await manager.dispose();
	});

	it("warns when a mount fails, since the failing connect is fire-and-forget", async () => {
		const spy = spyLogger();
		const server = serverFixture({ name: "down", url: "https://down.example.com", token: "" });
		const manager = makeManager(
			[server],
			() => async () => {
				throw new Error("network unreachable");
			},
			"requestUrl",
			spy.logger,
		);

		// Per-server failures are recorded, never thrown — see the class contract.
		await manager.connect();
		const warn = spy.records.find((record) => record.message.startsWith("MCP server mount failed"));
		expect(warn?.level).toBe("warn");
		expect(warn?.detail).toEqual({ error: "network unreachable" });
		expect(manager.getServerStates()[0]?.status).toBe("error");

		await manager.dispose();
	});

	it("reports the injected plugin version as clientInfo in the handshake", async () => {
		// The version used to be a literal in mcpManager.ts and drifted: it said
		// 1.0.0 while the plugin shipped past it, and no assertion noticed because
		// nothing reads the handshake back. This reads it back.
		const server = serverFixture({ name: "live", url: "https://live.example.com", token: "" });
		let initializeBody = "";
		const manager = makeManager([server], () => async (url, init) => {
			if ((init?.method ?? "GET").toUpperCase() === "GET") {
				return new Response(null, { status: 405 });
			}
			const body = typeof init?.body === "string" ? init.body : "";
			if (body.includes('"method":"initialize"')) {
				initializeBody = body;
				return handshakeResponses("session-version")[0]!;
			}
			if (body.includes("notifications/initialized")) {
				return new Response(null, { status: 202 });
			}
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		await manager.testServer(server);
		const initialize = JSON.parse(initializeBody) as { params: { clientInfo: unknown } };
		expect(initialize.params.clientInfo).toEqual({ name: "piem", version: STUB_PLUGIN_VERSION });
		await manager.dispose();
	});

	it("connect caches tools and buildAgentTools prefixes them with the server slug", async () => {
		const server = serverFixture({ name: "GitHub", url: "https://gh.example.com", token: "t" });
		const seenAuth: string[] = [];
		const manager = makeManager([server], () => async (url, init) => {
			if ((init?.method ?? "GET").toUpperCase() === "GET") {
				return new Response(null, { status: 405 });
			}
			const headers = new Headers(init?.headers);
			seenAuth.push(headers.get("authorization") ?? "");
			const body = typeof init?.body === "string" ? init.body : "";
			if (body.includes('"method":"initialize"')) {
				return handshakeResponses("session-1")[0]!;
			}
			if (body.includes("notifications/initialized")) {
				return new Response(null, { status: 202 });
			}
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					result: {
						tools: [
							{ name: "create_issue", inputSchema: { type: "object" } },
							{ name: "list repos", inputSchema: { type: "object" } },
						],
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});

		await manager.connect();
		expect(seenAuth.every((auth) => auth === "Bearer t")).toBe(true);

		const tools = manager.buildAgentTools();
		expect(tools.map((tool) => tool.name)).toEqual(["mcp_github_create_issue", "mcp_github_list_repos"]);
		// Every description discloses the outbound destination.
		expect(tools.every((tool) => tool.description.includes("https://gh.example.com"))).toBe(true);

		const [state] = manager.getServerStates();
		expect(state?.status).toBe("ok");
		expect(state?.toolCount).toBe(2);
		await manager.dispose();
	});

	it("keeps the GET stream off the wire on every transport, since mounting is pinned", async () => {
		// The mount always rides the buffered transport, whose fetch cannot
		// resolve a held stream, so the wrapper short-circuits GET before it
		// leaves — on both dispatch rules, because it wraps both of them.
		for (const transport of ["requestUrl", "fetch"] as const) {
			const server = serverFixture({ name: transport, url: `https://${transport}.example.com` });
			const { methods, fetch } = handshakeRecorder();
			const manager = makeManager([server], () => fetch, transport);
			await manager.connect();

			expect(manager.getServerStates()[0]?.status).toBe("ok");
			// wrapper-answered, not server-declined: nothing GET-shaped was ever
			// handed to a transport that could not have resolved it.
			expect(methods).not.toContain("GET");
			await manager.dispose();
		}
	});

	it("offers the model a timeout dial on every tool, and keeps it off the wire", async () => {
		// The MCP SDK has no "no limit" — omitting `timeout` takes its own 60s
		// default — so the honest move is to hand the number to the model rather
		// than pick one for it. The dial rides the server's own schema, which is
		// how the model learns it exists; the server must never see it.
		const bodies: string[] = [];
		const server = serverFixture({ name: "slow", url: "https://slow.example.com" });
		const manager = makeManager([server], () => async (url, init) => {
			if ((init?.method ?? "GET").toUpperCase() === "GET") {
				return new Response(null, { status: 405 });
			}
			const body = typeof init?.body === "string" ? init.body : "";
			bodies.push(body);
			if (body.includes('"method":"initialize"')) {
				return handshakeResponses("session-1")[0]!;
			}
			if (body.includes("notifications/initialized")) {
				return new Response(null, { status: 202 });
			}
			if (body.includes('"method":"tools/list"')) {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						result: {
							tools: [{ name: "crawl", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(
				JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "swept" }] } }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});

		await manager.connect();
		const [tool] = manager.buildAgentTools();
		const properties = (tool!.parameters as { properties: Record<string, unknown> }).properties;
		expect(Object.keys(properties)).toEqual(["path", "mcpTimeoutMs"]);

		const result = await tool!.execute("call_1", { path: "/", mcpTimeoutMs: 600_000 }, undefined);
		expect((result.content[0] as { text: string }).text).toContain("swept");
		const callBody = bodies.find((body) => body.includes('"method":"tools/call"'))!;
		expect(callBody).toContain('"path":"/"');
		expect(callBody).not.toContain("mcpTimeoutMs");
		await manager.dispose();
	});

	it("leaves a server's own field of that name alone", async () => {
		// Shadowing a real parameter would corrupt the call, and the server's
		// schema is the authority on its own arguments.
		const bodies: string[] = [];
		const server = serverFixture({ name: "own", url: "https://own.example.com" });
		const manager = makeManager([server], () => async (url, init) => {
			if ((init?.method ?? "GET").toUpperCase() === "GET") {
				return new Response(null, { status: 405 });
			}
			const body = typeof init?.body === "string" ? init.body : "";
			bodies.push(body);
			if (body.includes('"method":"initialize"')) {
				return handshakeResponses("session-1")[0]!;
			}
			if (body.includes("notifications/initialized")) {
				return new Response(null, { status: 202 });
			}
			if (body.includes('"method":"tools/list"')) {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						result: {
							tools: [
								{
									name: "poll",
									inputSchema: { type: "object", properties: { mcpTimeoutMs: { type: "string", description: "theirs" } } },
								},
							],
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(
				JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "polled" }] } }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});

		await manager.connect();
		const [tool] = manager.buildAgentTools();
		const own = (tool!.parameters as { properties: Record<string, { description?: string }> }).properties.mcpTimeoutMs;
		expect(own?.description).toBe("theirs");

		// And it reaches the wire: a field the server declared is a real argument,
		// so stripping it would drop data rather than protect anything.
		await tool!.execute("call_1", { mcpTimeoutMs: "5m" }, undefined);
		const callBody = bodies.find((body) => body.includes('"method":"tools/call"'))!;
		expect(callBody).toContain('"mcpTimeoutMs":"5m"');
		await manager.dispose();
	});

	it("dispose closes every client so a reconnect starts fresh", async () => {
		const server = serverFixture({ name: "x", url: "https://x.example.com" });
		let postCount = 0;
		const manager = makeManager([server], () => async (url, init) => {
			if ((init?.method ?? "GET").toUpperCase() === "GET") {
				return new Response(null, { status: 405 });
			}
			postCount++;
			const body = typeof init?.body === "string" ? init.body : "";
			if (body.includes('"method":"initialize"')) {
				return handshakeResponses("session-1")[0]!;
			}
			if (body.includes("notifications/initialized")) {
				return new Response(null, { status: 202 });
			}
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		await manager.connect();
		const afterFirst = postCount;
		await manager.dispose();
		await manager.connect();
		// A disposed manager reconnects — the tool list did not silently vanish.
		expect(postCount).toBeGreaterThan(afterFirst);
		expect(manager.getServerStates()[0]?.status).toBe("ok");
		await manager.dispose();
	});

	it("skips the handshake when a connect finds the same url and token already live", async () => {
		// `connect` rides every settings save via refreshConfiguration; without
		// this skip, changing an unrelated setting would re-handshake every
		// server on each save.
		const server = serverFixture({ name: "x", url: "https://x.example.com", token: "t" });
		let postCount = 0;
		const make = (token: string) =>
			makeManager([{ ...server, token }], () => async (url, init) => {
				if ((init?.method ?? "GET").toUpperCase() === "GET") {
					return new Response(null, { status: 405 });
				}
				postCount++;
				const body = typeof init?.body === "string" ? init.body : "";
				if (body.includes('"method":"initialize"')) {
					return handshakeResponses("session-1")[0]!;
				}
				if (body.includes("notifications/initialized")) {
					return new Response(null, { status: 202 });
				}
				return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			});

		// Same config read twice — the manager's own servers() closure, as
		// saveSettings would deliver it.
		const manager = make("t");
		await manager.connect();
		const afterFirst = postCount;
		await manager.connect();
		expect(postCount).toBe(afterFirst);
		await manager.dispose();

		// A token change is a different connection and must re-handshake.
		postCount = 0;
		const rotated = make("t2");
		await rotated.connect();
		expect(postCount).toBe(afterFirst);
		await rotated.dispose();
	});

	it("skips the handshake when only the transport changed", async () => {
		// Mounting is pinned to one transport and tool calls re-read the setting
		// per call, so nothing transport-dependent remains at connect time — a
		// switch needs no re-handshake. The old rule (transport in the cache
		// key) described a client that rode the transport it was born on; that
		// client is gone.
		const server = serverFixture({ name: "x", url: "https://x.example.com", token: "t" });
		let postCount = 0;
		let currentTransport: "requestUrl" | "fetch" = "requestUrl";
		const manager = new McpManager(
			() => [server],
			() => currentTransport,
			STUB_PLUGIN_VERSION,
			() => async (url, init) => {
				if ((init?.method ?? "GET").toUpperCase() === "GET") {
					return new Response(null, { status: 405 });
				}
				postCount++;
				const body = typeof init?.body === "string" ? init.body : "";
				if (body.includes('"method":"initialize"')) {
					return handshakeResponses("session-1")[0]!;
				}
				if (body.includes("notifications/initialized")) {
					return new Response(null, { status: 202 });
				}
				return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		);

		await manager.connect();
		const afterFirst = postCount;

		// Same url+token, transport flipped: still the skip.
		currentTransport = "fetch";
		await manager.connect();
		expect(postCount).toBe(afterFirst);

		// And flipping back changes nothing either.
		currentTransport = "requestUrl";
		await manager.connect();
		expect(postCount).toBe(afterFirst);
		await manager.dispose();
	});

	it("mounts on the buffered transport and lets tool calls follow the setting", async () => {
		// The split, end to end: with the global setting on `fetch`, the
		// handshake is logged only on the mount side (the factory never saw
		// "fetch"), and a `tools/call` is logged only on the call side — the
		// mount side never serves one.
		const server = serverFixture({ name: "split", url: "https://sp.example.com" });
		const { seen, factory } = splitFactory();
		const manager = makeManager([server], factory, "fetch");

		await manager.connect();
		expect(seen.call).toEqual([]);
		expect(seen.mount).toContain("POST");
		expect(seen.mount).not.toContain("GET");

		const [tool] = manager.buildAgentTools();
		const result = await tool!.execute("call_1", {}, undefined);
		expect((result.content[0] as { text: string }).text).toBe("done");

		expect(seen.call).toEqual(["tools/call"]);
		expect(seen.mount).not.toContain("tools/call");
		await manager.dispose();
	});

	it("retries a failed server on the next connect and recovers", async () => {
		// A failed entry is always re-attempted; when the endpoint comes back,
		// nothing but another connect stands between the user and the tools.
		const server = serverFixture({ name: "x", url: "https://x.example.com" });
		let fail = true;
		const manager = makeManager([server], () => async (url, init) => {
			if ((init?.method ?? "GET").toUpperCase() === "GET") {
				return new Response(null, { status: 405 });
			}
			if (fail) {
				throw new TypeError("fetch failed");
			}
			const body = typeof init?.body === "string" ? init.body : "";
			if (body.includes('"method":"initialize"')) {
				return handshakeResponses("session-1")[0]!;
			}
			if (body.includes("notifications/initialized")) {
				return new Response(null, { status: 202 });
			}
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		await manager.connect();
		expect(manager.getServerStates()[0]?.status).toBe("error");

		fail = false;
		await manager.connect();
		expect(manager.getServerStates()[0]?.status).toBe("ok");
		await manager.dispose();
	});

	it("two concurrent connects to the same server share one handshake", async () => {
		// The load warmup versus the panel's first open. Without the per-server
		// chain, both calls would see no usable entry, both would mount, and the
		// entry the loser landed would strand the winner's client unclosed.
		const server = serverFixture({ name: "x", url: "https://x.example.com" });
		let posts = 0;
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const manager = makeManager([server], () => async (url, init) => {
			if ((init?.method ?? "GET").toUpperCase() === "GET") {
				return new Response(null, { status: 405 });
			}
			const body = typeof init?.body === "string" ? init.body : "";
			if (body.includes('"method":"initialize"')) {
				posts++;
				await gate;
				return handshakeResponses("session-1")[0]!;
			}
			if (body.includes("notifications/initialized")) {
				return new Response(null, { status: 202 });
			}
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const first = manager.connect();
		const second = manager.connect();
		release?.();
		await Promise.all([first, second]);
		expect(posts).toBe(1);
		expect(manager.getServerStates()[0]?.status).toBe("ok");
		await manager.dispose();
	});

	it("a handshake that lands after dispose leaves no entry behind", async () => {
		// Unload mid-handshake: dispose emptied the map while the mount was in
		// flight, and the late landing must not resurrect an entry whose client
		// nothing will ever close.
		const server = serverFixture({ name: "x", url: "https://x.example.com" });
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const manager = makeManager([server], () => async (url, init) => {
			if ((init?.method ?? "GET").toUpperCase() === "GET") {
				return new Response(null, { status: 405 });
			}
			const body = typeof init?.body === "string" ? init.body : "";
			if (body.includes('"method":"initialize"')) {
				await gate;
				return handshakeResponses("session-1")[0]!;
			}
			if (body.includes("notifications/initialized")) {
				return new Response(null, { status: 202 });
			}
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const connecting = manager.connect();
		await manager.dispose();
		release?.();
		await connecting;

		expect(manager.getServerStates()[0]?.status).toBe("untested");
		expect(manager.buildAgentTools()).toEqual([]);

		// Not a one-way latch: an explicit connect after dispose keeps working.
		await manager.connect();
		expect(manager.getServerStates()[0]?.status).toBe("ok");
		await manager.dispose();
	});
});
