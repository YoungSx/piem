import { describe, expect, it, mock, beforeEach } from "bun:test";
import { installObsidianStub, requestUrlMock } from "../testUtils/obsidianStub";
import { stubWindowFetch } from "../testUtils/windowStub";

/** The subset of Obsidian's `RequestUrlResponse` that these tests rely on. */
interface MockRequestUrlResponse {
	status: number;
	/** Optional so a test can model a response that carried no headers at all. */
	headers?: Record<string, string>;
	arrayBuffer: ArrayBuffer;
}

installObsidianStub();

function mockResponse(response: MockRequestUrlResponse): MockRequestUrlResponse {
	return response;
}

const { createObsidianRequestUrlFetch, createFetchForTransport } = await import("./obsidianFetch");

function textToArrayBuffer(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe("createObsidianRequestUrlFetch", () => {
	beforeEach(() => {
		requestUrlMock.mockReset();
		requestUrlMock.mockResolvedValue(mockResponse({
			status: 200,
			headers: { "content-type": "application/json" },
			arrayBuffer: textToArrayBuffer('{"ok":true}'),
		}));
	});

	it("forwards url, method, headers and string body", async () => {
		const obsidianFetch = createObsidianRequestUrlFetch();

		await obsidianFetch("https://api.example.com/v1/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer k" },
			body: '{"a":1}',
		});

		expect(requestUrlMock).toHaveBeenCalledTimes(1);
		const params = requestUrlMock.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(params.url).toBe("https://api.example.com/v1/chat");
		expect(params.method).toBe("POST");
		expect(params.body).toBe('{"a":1}');
		expect(params.throw).toBe(false);
		expect(params.headers).toMatchObject({
			"Content-Type": "application/json",
			Authorization: "Bearer k",
		});
	});

	it("returns a Response carrying the provider status and body", async () => {
		const obsidianFetch = createObsidianRequestUrlFetch();

		const response = await obsidianFetch("https://api.example.com/v1/chat", { method: "POST", body: "{}" });

		expect(response.status).toBe(200);
		expect(response.text()).resolves.toBe('{"ok":true}');
	});

	it("preserves non-2xx responses instead of throwing", async () => {
		requestUrlMock.mockResolvedValue(mockResponse({
			status: 429,
			headers: {},
			arrayBuffer: textToArrayBuffer('{"error":"rate limit"}'),
		}));
		const obsidianFetch = createObsidianRequestUrlFetch();

		const response = await obsidianFetch("https://api.example.com/v1/chat", { method: "POST", body: "{}" });

		expect(response.status).toBe(429);
		expect(response.text()).resolves.toContain("rate limit");
	});

	it("strips headers that requestUrl manages itself", async () => {
		const obsidianFetch = createObsidianRequestUrlFetch();

		await obsidianFetch("https://api.example.com/v1/chat", {
			method: "POST",
			headers: { Host: "evil", "content-length": "12", "X-Keep": "yes" },
			body: "{}",
		});

		const params = requestUrlMock.mock.calls[0]?.[0] as { headers: Record<string, string> };
		expect(params.headers["X-Keep"]).toBe("yes");
		expect(params.headers.Host).toBeUndefined();
		expect(params.headers["content-length"]).toBeUndefined();
	});

	it("accepts Headers instances", async () => {
		const obsidianFetch = createObsidianRequestUrlFetch();

		await obsidianFetch("https://api.example.com/v1/chat", {
			method: "POST",
			headers: new Headers({ "x-api-key": "secret" }),
			body: "{}",
		});

		const params = requestUrlMock.mock.calls[0]?.[0] as { headers: Record<string, string> };
		expect(params.headers["x-api-key"]).toBe("secret");
	});

	it("converts typed-array bodies to ArrayBuffer", async () => {
		const obsidianFetch = createObsidianRequestUrlFetch();
		const payload = new TextEncoder().encode("binary-ish");

		await obsidianFetch("https://api.example.com/v1/chat", { method: "POST", body: payload });

		const params = requestUrlMock.mock.calls[0]?.[0] as { body: ArrayBuffer };
		expect(params.body).toBeInstanceOf(ArrayBuffer);
		expect(new TextDecoder().decode(new Uint8Array(params.body))).toBe("binary-ish");
	});

	it("rejects immediately when the signal is already aborted", async () => {
		const obsidianFetch = createObsidianRequestUrlFetch();
		const controller = new AbortController();
		controller.abort();

		expect(
			obsidianFetch("https://api.example.com/v1/chat", { method: "POST", body: "{}", signal: controller.signal }),
		).rejects.toThrow(/aborted/i);
		expect(requestUrlMock).not.toHaveBeenCalled();
	});

	it("rejects when the signal aborts mid-flight", async () => {
		requestUrlMock.mockReturnValue(new Promise<never>(() => undefined));
		const obsidianFetch = createObsidianRequestUrlFetch();
		const controller = new AbortController();

		const pending = obsidianFetch("https://api.example.com/v1/chat", {
			method: "POST",
			body: "{}",
			signal: controller.signal,
		});
		controller.abort();

		expect(pending).rejects.toThrow(/aborted/i);
	});

	it("imposes no deadline of its own on a slow provider", async () => {
		// pi-ai leaves `timeoutMs` unset, so the transport must not invent an
		// expiry: from here a long reasoning pass is indistinguishable from a
		// stall, and cutting it off would end requests the provider layer chose
		// to leave unbounded. A wedged endpoint is the user's stop to press.
		let settle: ((response: unknown) => void) | undefined;
		requestUrlMock.mockReturnValue(
			new Promise((resolve) => {
				settle = resolve;
			}),
		);
		const obsidianFetch = createObsidianRequestUrlFetch();

		const pending = obsidianFetch("https://api.example.com/v1/chat", { method: "POST", body: "{}" });
		let settled = false;
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(settled).toBe(false);

		settle?.({ status: 200, headers: { "content-type": "text/plain" }, arrayBuffer: new TextEncoder().encode("late").buffer });
		expect((await pending).status).toBe(200);
	});

	it("makes no part of the response readable until the whole of it has arrived", async () => {
		// Why this transport cannot stream, expressed as behaviour rather than as
		// a claim about Obsidian's internals: while the request is in flight there
		// is no `Response` at all, so pi-ai's SSE parser has nothing to attach to
		// and the first event of a turn cannot surface before the last one.
		let settle: ((response: unknown) => void) | undefined;
		requestUrlMock.mockReturnValue(
			new Promise((resolve) => {
				settle = resolve;
			}),
		);
		const obsidianFetch = createObsidianRequestUrlFetch();
		const pending = obsidianFetch("https://api.example.com/v1/chat", { method: "POST", body: "{}" });

		let body: ReadableStream<Uint8Array> | null | undefined;
		void pending.then((response) => {
			body = response.body;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		// Not "the body read back empty" — there is no body object in existence to
		// read from, which is a stronger and more honest statement of the limit.
		expect(body).toBeUndefined();

		const sse = 'data: {"i":1}\n\ndata: {"i":2}\n\ndata: [DONE]\n\n';
		settle?.({ status: 200, headers: { "content-type": "text/event-stream" }, arrayBuffer: textToArrayBuffer(sse) });
		const response = await pending;

		// And then all of it, with no further trip to make: the same fact from the
		// other side. Deliberately not asserting how many chunks the read takes —
		// that varies by runtime (bun splits large buffers, undici does not) and
		// none of those reads waits on a network either way.
		const reader = response.body!.getReader();
		let seen = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			seen += new TextDecoder().decode(value);
		}
		expect(seen).toBe(sse);
		expect(requestUrlMock).toHaveBeenCalledTimes(1);
	});

	// The `Response` constructor is stricter than HTTP, and `requestUrl` hands
	// back whatever the wire carried. Everything below is a response a real
	// server can legitimately send that the unguarded constructor refused to
	// represent, taking the whole tool call down with a bare `TypeError`.
	describe("responses the Response constructor refuses verbatim", () => {
		it("keeps a 304 as a 304, with the body dropped rather than the status rewritten", async () => {
			// The empty buffer is the point: `requestUrl` returns `arrayBuffer`
			// unconditionally, and an empty ArrayBuffer still counts as a body, so
			// this is exactly the shape a cached re-request produces.
			requestUrlMock.mockResolvedValue(mockResponse({
				status: 304,
				headers: { etag: '"abc"' },
				arrayBuffer: textToArrayBuffer(""),
			}));
			const obsidianFetch = createObsidianRequestUrlFetch();

			const response = await obsidianFetch("https://example.com/page");

			expect(response.status).toBe(304);
			expect(response.body).toBeNull();
			expect(await response.text()).toBe("");
			expect(response.headers.get("etag")).toBe('"abc"');
		});

		it("drops the body on 304 even when bytes came with it", async () => {
			// Bun's `Response` tolerates a body here where Chromium and undici
			// throw, so asserting "it did not throw" would pass without the fix.
			// The null body is what proves the guard ran.
			requestUrlMock.mockResolvedValue(mockResponse({
				status: 304,
				headers: {},
				arrayBuffer: textToArrayBuffer("unexpected"),
			}));
			const obsidianFetch = createObsidianRequestUrlFetch();

			const response = await obsidianFetch("https://example.com/page");

			expect(response.status).toBe(304);
			expect(response.body).toBeNull();
			expect(await response.text()).toBe("");
		});

		it.each([204, 205])("keeps a null-body status %i intact", async (status) => {
			requestUrlMock.mockResolvedValue(mockResponse({
				status,
				headers: {},
				arrayBuffer: textToArrayBuffer(""),
			}));
			const obsidianFetch = createObsidianRequestUrlFetch();

			const response = await obsidianFetch("https://example.com/resource", { method: "DELETE" });

			expect(response.status).toBe(status);
			expect(response.body).toBeNull();
		});

		it("still carries the body for a status that allows one", async () => {
			// The guard must not overreach: 429 has a body worth reading, and an
			// over-broad null-body rule would swallow the provider's own error text.
			requestUrlMock.mockResolvedValue(mockResponse({
				status: 429,
				headers: {},
				arrayBuffer: textToArrayBuffer('{"error":"slow down"}'),
			}));
			const obsidianFetch = createObsidianRequestUrlFetch();

			const response = await obsidianFetch("https://example.com/api");

			expect(response.status).toBe(429);
			expect(await response.text()).toContain("slow down");
		});

		it.each([0, 100, 600, Number.NaN])("names the offending value when the status is %p", async (status) => {
			// No honest `Response` exists for these, so the transport fails — but
			// with the value in the message, rather than as an anonymous TypeError
			// from inside the constructor.
			requestUrlMock.mockResolvedValue(mockResponse({
				status,
				headers: {},
				arrayBuffer: textToArrayBuffer(""),
			}));
			const obsidianFetch = createObsidianRequestUrlFetch();

			expect(obsidianFetch("https://example.com/weird")).rejects.toThrow(
				new RegExp(`outside 200-599.*${status === 0 ? "0" : String(status)}`),
			);
		});
	});

	describe("headers the Headers constructor refuses", () => {
		it("skips a pseudo-header and keeps the rest of the response", async () => {
			// Real HTTP/2 origins emit `:status`. Building the map in one call meant
			// that single entry cost the caller the body, the status, and every
			// well-formed sibling along with it.
			requestUrlMock.mockResolvedValue(mockResponse({
				status: 200,
				headers: { ":status": "200", "content-type": "text/html", "x-ok": "1" },
				arrayBuffer: textToArrayBuffer("<html></html>"),
			}));
			const obsidianFetch = createObsidianRequestUrlFetch();

			const response = await obsidianFetch("https://example.com/page");

			expect(response.status).toBe(200);
			expect(await response.text()).toBe("<html></html>");
			expect(response.headers.get("content-type")).toBe("text/html");
			expect(response.headers.get("x-ok")).toBe("1");
		});

		it("skips a name containing a space", async () => {
			requestUrlMock.mockResolvedValue(mockResponse({
				status: 200,
				headers: { "bad name": "x", "x-good": "y" },
				arrayBuffer: textToArrayBuffer("body"),
			}));
			const obsidianFetch = createObsidianRequestUrlFetch();

			const response = await obsidianFetch("https://example.com/page");

			expect(await response.text()).toBe("body");
			expect(response.headers.get("x-good")).toBe("y");
		});

		it("skips a value containing a newline", async () => {
			requestUrlMock.mockResolvedValue(mockResponse({
				status: 200,
				headers: { "x-folded": "a\nb", "x-good": "y" },
				arrayBuffer: textToArrayBuffer("body"),
			}));
			const obsidianFetch = createObsidianRequestUrlFetch();

			const response = await obsidianFetch("https://example.com/page");

			expect(await response.text()).toBe("body");
			expect(response.headers.get("x-folded")).toBeNull();
			expect(response.headers.get("x-good")).toBe("y");
		});

		it("tolerates a response with no headers at all", async () => {
			requestUrlMock.mockResolvedValue({
				status: 200,
				arrayBuffer: textToArrayBuffer("body"),
			} as MockRequestUrlResponse);
			const obsidianFetch = createObsidianRequestUrlFetch();

			const response = await obsidianFetch("https://example.com/page");

			expect(response.status).toBe(200);
			expect(await response.text()).toBe("body");
		});
	});

	it("defaults to GET without a body", async () => {
		const obsidianFetch = createObsidianRequestUrlFetch();

		await obsidianFetch("https://api.example.com/v1/models");

		const params = requestUrlMock.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(params.method).toBe("GET");
		expect(params.body).toBeUndefined();
	});
});

describe("createFetchForTransport", () => {
	it("returns the requestUrl transport by default", async () => {
		requestUrlMock.mockReset();
		requestUrlMock.mockResolvedValue(mockResponse({ status: 200, headers: {}, arrayBuffer: textToArrayBuffer("{}") }));

		const fetchImpl = createFetchForTransport("requestUrl");
		await fetchImpl("https://api.example.com/v1/models");

		expect(requestUrlMock).toHaveBeenCalledTimes(1);
	});

	it("returns a native fetch wrapper for the fetch transport", async () => {
		requestUrlMock.mockReset();
		const nativeFetch = mock<() => Promise<Response>>();
		nativeFetch.mockResolvedValue(new Response("{}", { status: 200 }));
		// Stubbed on `window`, which is the path the wrapper takes.
		const restore = stubWindowFetch(nativeFetch);

		try {
			const fetchImpl = createFetchForTransport("fetch");
			await fetchImpl("https://api.example.com/v1/models");
			expect(nativeFetch).toHaveBeenCalledTimes(1);
			expect(requestUrlMock).not.toHaveBeenCalled();
		} finally {
			restore();
		}
	});

	it("falls back to requestUrl when the platform fetch rejects", async () => {
		requestUrlMock.mockReset();
		requestUrlMock.mockResolvedValue(mockResponse({ status: 200, headers: {}, arrayBuffer: textToArrayBuffer("{}") }));
		// The four blocked shapes at the top of obsidianFetch.ts all reject before
		// any headers arrive; a plain TypeError models all of them.
		const nativeFetch = mock<() => Promise<Response>>();
		nativeFetch.mockRejectedValue(new TypeError("Failed to fetch"));
		const restore = stubWindowFetch(nativeFetch);

		try {
			const fetchImpl = createFetchForTransport("fetch");
			const response = await fetchImpl("https://api.example.com/v1/models");
			expect(response.status).toBe(200);
			expect(nativeFetch).toHaveBeenCalledTimes(1);
			expect(requestUrlMock).toHaveBeenCalledTimes(1);
		} finally {
			restore();
		}
	});

	it("does not fall back when the request was aborted", async () => {
		requestUrlMock.mockReset();
		const nativeFetch = mock<() => Promise<Response>>();
		nativeFetch.mockRejectedValue(new DOMException("The operation was aborted.", "AbortError"));
		const restore = stubWindowFetch(nativeFetch);

		try {
			const controller = new AbortController();
			const fetchImpl = createFetchForTransport("fetch");
			await expect(fetchImpl("https://api.example.com/v1/models", { signal: controller.signal }))
				.rejects.toThrow();
			expect(requestUrlMock).not.toHaveBeenCalled();
		} finally {
			restore();
		}
	});

	it("does not fall back on a real HTTP error status", async () => {
		requestUrlMock.mockReset();
		const nativeFetch = mock<() => Promise<Response>>();
		nativeFetch.mockResolvedValue(new Response('{"error":"nope"}', { status: 401 }));
		const restore = stubWindowFetch(nativeFetch);

		try {
			const fetchImpl = createFetchForTransport("fetch");
			const response = await fetchImpl("https://api.example.com/v1/models");
			expect(response.status).toBe(401);
			expect(requestUrlMock).not.toHaveBeenCalled();
		} finally {
			restore();
		}
	});
});
