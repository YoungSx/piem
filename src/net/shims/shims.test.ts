/**
 * Contract tests for the SDK shims (issue #92).
 *
 * Each assertion pins a behaviour pi-ai depends on, traced to the SDK or
 * pi-ai source it was audited against. The requests go against a local HTTP
 * server, so the wire shape — not a mock boundary — is what is under test.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import OpenAI from "./openaiSdk.js";
import Anthropic from "./anthropicSdk.js";
import { buildRequestUrl, mergeHeaders, sseData } from "./apiHttp.js";
import { stubWindowTimers } from "../../testUtils/windowStub";

// The shims run inside Obsidian, so they arm `window.setTimeout` (popout-window
// compatibility). These tests drive a real HTTP server rather than a DOM, so the
// timers are put on `window` directly instead of installing happy-dom.
const restoreWindowTimers = stubWindowTimers();

const servers: Server[] = [];
let requests: Array<{ url: string; headers: Record<string, string>; body: string }>;
let responder: (req: { url?: string; method?: string }, res: import("node:http").ServerResponse) => void;

const authFetch: typeof fetch = fetch.bind(globalThis);

async function start(): Promise<string> {
	requests = [];
	responder = () => {};
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => (body += chunk.toString()));
		req.on("end", () => {
			requests.push({ url: req.url ?? "", headers: req.headers as Record<string, string>, body });
			responder(req, res);
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}`;
}

function sse(events: string[]): (req: { url?: string }, res: import("node:http").ServerResponse) => void {
	return (_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		for (const event of events) res.write(event);
		res.end();
	};
}

/** Feeds a string to sseData as arbitrarily-split body chunks. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

afterAll(() => {
	for (const server of servers) {
		server.closeAllConnections();
		server.close();
	}
	restoreWindowTimers();
});

describe("apiHttp primitives", () => {
	it("joins base and path the way the SDKs do", () => {
		expect(buildRequestUrl("http://x/v1/", "/chat")).toBe("http://x/v1/chat");
		expect(buildRequestUrl("http://x/v1", "/chat")).toBe("http://x/v1/chat");
		expect(buildRequestUrl("http://x/v1/", "chat")).toBe("http://x/v1/chat");
	});

	it("merges headers case-insensitively, later wins, null deletes", () => {
		const merged = mergeHeaders(
			{ "Content-Type": "application/json", "X-Trace": "1" },
			undefined,
			{ "content-type": "text/plain", "X-Trace": null },
			{ "X-Trace": undefined as unknown as string },
		);
		expect(merged.get("content-type")).toBe("text/plain");
		expect(merged.get("x-trace")).toBeNull();
	});

	it("decodes SSE across arbitrary chunk splits", async () => {
		const payload = 'event: a\ndata: {"n":1}\ndata: {"n":2}\n\n';
		// One byte per chunk: every state transition the parser can hit.
		const events: Array<{ event: string; data: string }> = [];
		for await (const event of sseData(streamOf(payload.split("")))) events.push(event);
		expect(events).toEqual([{ event: "a", data: '{"n":1}\n{"n":2}' }]);
	});

	it("tolerates CRLF endings and ignores comments, id and retry fields", async () => {
		const payload = ": keep-alive\r\nid: 7\r\nretry: 100\r\nevent: b\r\ndata: x\r\n\r\n";
		const events: Array<{ event: string; data: string }> = [];
		for await (const event of sseData(streamOf([payload]))) events.push(event);
		expect(events).toEqual([{ event: "b", data: "x" }]);
	});
});

describe("anthropic shim", () => {
	it("sends the load-bearing headers and body pi-ai relies on", async () => {
		const base = await start();
		responder = sse([]);
		const client = new Anthropic({
			apiKey: "k-test",
			baseURL: base,
			fetch: authFetch,
			defaultHeaders: { "user-agent": "pi/1" },
		});
		const response = await client
			.messages.create({ model: "claude-x", stream: true, messages: [] }, { timeout: 5_000 })
			.asResponse();
		expect(response.status).toBe(200);
		const req = requests[0]!;
		expect(req.url).toBe("/v1/messages");
		expect(req.headers["anthropic-version"]).toBe("2023-06-01");
		expect(req.headers["x-api-key"]).toBe("k-test");
		expect(req.headers["content-type"]).toBe("application/json");
		expect(req.headers["user-agent"]).toBe("pi/1");
		expect(JSON.parse(req.body)).toEqual({ model: "claude-x", stream: true, messages: [] });
	});

	it("uses bearer auth when authToken carries the credential", async () => {
		const base = await start();
		responder = sse([]);
		const client = new Anthropic({ authToken: "tok", baseURL: base, fetch: authFetch });
		await client.messages.create({}, {}).asResponse();
		expect(requests[0]!.headers["authorization"]).toBe("Bearer tok");
		expect(requests[0]!.headers["x-api-key"]).toBeUndefined();
	});

	it("throws the SDK's no-credentials error up front", () => {
		expect(
			() => new Anthropic({ baseURL: "http://127.0.0.1:9", fetch: authFetch }),
		).toThrow(/Could not resolve authentication method/);
	});

	it("parses the SSE body pi-ai feeds its own decoder with", async () => {
		const base = await start();
		responder = sse([
			'event: message_start\ndata: {"type":"message_start","message":{"id":"m1"}}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		]);
		const client = new Anthropic({ apiKey: "k", baseURL: base, fetch: authFetch });
		const response = await client.messages.create({}, {}).asResponse();
		const text = await response.text();
		expect(text).toContain('"type":"message_start"');
		expect(text).toContain('"type":"message_stop"');
	});

	it("surfaces 4xx/5xx with the retry contract fields", async () => {
		const base = await start();
		responder = (_req, res) => {
			res.writeHead(429, {
				"content-type": "application/json",
				"retry-after": "3",
				"x-should-retry": "true",
			});
			res.end(JSON.stringify({ error: { message: "slow down" } }));
		};
		const client = new Anthropic({ apiKey: "k", baseURL: base, fetch: authFetch });
		const error: Error & { status?: number; headers?: Headers; error?: unknown } = await client
			.messages.create({}, {})
			.asResponse()
			.then(
				() => {
					throw new Error("expected rejection");
				},
				(e: unknown) => e as Error & { status?: number; headers?: Headers; error?: unknown },
			);
		expect(error).toBeInstanceOf(Error);
		expect("status" in error).toBe(true);
		expect("headers" in error).toBe(true);
		expect(error.status).toBe(429);
		expect(error.headers).toBeInstanceOf(Headers);
		// provider-retry.js reads these off the Headers object to time the retry.
		expect(error.headers?.get("retry-after")).toBe("3");
		expect(error.headers?.get("x-should-retry")).toBe("true");
		// The reason is lifted out of the body and into the message, so the parsed
		// body is withheld: handing pi both makes it print the JSON instead of the
		// sentence on two of the three protocols. See `ErrorBodyDescription.body`.
		expect(error.message).toBe("429 slow down");
		expect(error.error).toBeUndefined();
	});

	it("hands pi the parsed body when our message cannot speak for it", async () => {
		const base = await start();
		responder = (_req, res) => {
			res.writeHead(400, { "content-type": "application/json" });
			// Neither `error.message` nor `message`: there is no reason to lift, so
			// the message repeats the body and `error.error` stays what the SDKs
			// expose — pi's own inference is correct on this shape.
			res.end(JSON.stringify({ detail: "malformed request" }));
		};
		const client = new Anthropic({ apiKey: "k", baseURL: base, fetch: authFetch });
		const error: Error & { error?: unknown } = await client
			.messages.create({}, {})
			.asResponse()
			.then(
				() => {
					throw new Error("expected rejection");
				},
				(e: unknown) => e as Error & { error?: unknown },
			);
		expect(error.message).toBe('400 {"detail":"malformed request"}');
		expect(error.error).toEqual({ detail: "malformed request" });
	});

	it("rejects a pre-aborted signal before reaching the wire", async () => {
		const base = await start();
		responder = sse(["data: {}\n\n"]);
		const controller = new AbortController();
		controller.abort();
		const client = new Anthropic({ apiKey: "k", baseURL: base, fetch: authFetch });
		const error = await client.messages
			.create({}, { signal: controller.signal })
			.asResponse()
			.then(
				() => {
					throw new Error("expected rejection");
				},
				(e: unknown) => e as Error,
			);
		expect(error.message).toMatch(/abort/i);
		expect(requests).toHaveLength(0);
	});

	it("cuts the stream when the caller aborts mid-body", async () => {
		const base = await start();
		responder = (_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
			// Hold the connection open: the rest never arrives on its own.
		};
		const controller = new AbortController();
		const client = new Anthropic({ apiKey: "k", baseURL: base, fetch: authFetch });
		const response = await client.messages.create({}, { signal: controller.signal }).asResponse();
		const reader = response.body!.getReader();
		const first = await reader.read();
		expect(first.done).toBe(false);
		controller.abort();
		// The bridge must still be attached after the headers arrived, or the
		// body would never see the abort and pi-ai would hang until EOF.
		const failure = await reader.read().then(
			() => null,
			(e: unknown) => e,
		);
		expect(failure).toBeInstanceOf(Error);
	});

	it("carries the transport-error contract on connection failure", async () => {
		// Port 9 (discard) is reserved; nothing listens there in the test env.
		const client = new Anthropic({ apiKey: "k", baseURL: "http://127.0.0.1:9", fetch: authFetch });
		const error: Error & { status?: number; headers?: Headers } = await client
			.messages.create({}, {})
			.asResponse()
			.then(
				() => {
					throw new Error("expected rejection");
				},
				(e: unknown) => e as Error & { status?: number; headers?: Headers },
			);
		// isProviderError probes with `in`: the keys must exist even when unknown,
		// and status === undefined is what marks transport failures retryable.
		expect("status" in error).toBe(true);
		expect("headers" in error).toBe(true);
		expect(error.status).toBeUndefined();
		expect(error.headers).toBeUndefined();
	});
});

describe("openai shim", () => {
	it("sends bearer auth and yields parsed SSE chunks ending at [DONE]", async () => {
		const base = await start();
		responder = sse([
			'data: {"id":"c1","choices":[{"delta":{"content":"hi"}}]}\n\n',
			'data: {"id":"c1","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
			"data: [DONE]\n\n",
		]);
		const client = new OpenAI({
			apiKey: "k-test",
			baseURL: `${base}/v1`,
			fetch: authFetch,
			defaultHeaders: { "user-agent": "pi/1" },
		});
		const { data, response } = await client.chat.completions
			.create({ model: "gpt-x", stream: true, messages: [] }, { timeout: 5_000 })
			.withResponse();
		expect(response.status).toBe(200);
		expect(response.headers).toBeInstanceOf(Headers);
		const chunks: Array<Record<string, unknown>> = [];
		for await (const chunk of data) chunks.push(chunk);
		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toEqual({ id: "c1", choices: [{ delta: { content: "hi" } }] });
		const req = requests[0]!;
		expect(req.url).toBe("/v1/chat/completions");
		expect(req.headers["authorization"]).toBe("Bearer k-test");
		expect(req.headers["user-agent"]).toBe("pi/1");
	});

	it("reaches /responses for the responses protocol", async () => {
		const base = await start();
		responder = sse(['data: {"type":"response.completed"}\n\n']);
		const client = new OpenAI({ apiKey: "k", baseURL: `${base}/v1`, fetch: authFetch });
		const { data } = await client.responses.create({}, {}).withResponse();
		const events: Array<Record<string, unknown>> = [];
		for await (const event of data) events.push(event);
		expect(requests[0]!.url).toBe("/v1/responses");
		expect(events).toEqual([{ type: "response.completed" }]);
	});

	it("allows header-based auth instead of an apiKey (Copilot path)", () => {
		expect(
			() => new OpenAI({ baseURL: "http://127.0.0.1:9", fetch: authFetch, defaultHeaders: { Authorization: "Bearer x" } }),
		).not.toThrow();
		expect(() => new OpenAI({ baseURL: "http://127.0.0.1:9", fetch: authFetch })).toThrow(/Missing credentials/);
	});

	it("lets a trickling stream outlive the timeout once headers arrived", async () => {
		const base = await start();
		responder = (_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write('data: {"n":1}\n\n');
			// The whole body takes far longer than the timeout below; the real
			// SDK only bounds the headers phase, and so must the shim.
			setTimeout(() => {
				res.write('data: {"n":2}\n\n');
				res.end("data: [DONE]\n\n");
			}, 400);
		};
		const client = new OpenAI({ apiKey: "k", baseURL: `${base}/v1`, fetch: authFetch });
		const { data } = await client.chat.completions
			.create({ model: "gpt-x", stream: true }, { timeout: 100 })
			.withResponse();
		const chunks: Array<Record<string, unknown>> = [];
		for await (const chunk of data) chunks.push(chunk);
		expect(chunks).toEqual([{ n: 1 }, { n: 2 }]);
	});

	it("aborts when the server never answers within the timeout", async () => {
		const base = await start();
		responder = () => {}; // headers never sent
		const client = new OpenAI({ apiKey: "k", baseURL: `${base}/v1`, fetch: authFetch });
		const error = await client.chat.completions
			.create({}, { timeout: 100 })
			.withResponse()
			.then(
				() => {
					throw new Error("expected rejection");
				},
				(e: unknown) => e as Error,
			);
		expect(error).toBeInstanceOf(Error);
		// Drop the held connection so the test server can shut down.
		servers[servers.length - 1]?.closeAllConnections();
	});
});
