import { beforeEach, describe, expect, it, mock } from "bun:test";
import { installObsidianStub, requestUrlMock } from "../testUtils/obsidianStub";
import { stubWindowFetch } from "../testUtils/windowStub";

installObsidianStub();

// Dynamic imports so the mocked module wins over any cached real one.
const { createWebFetchTool } = await import("./webFetchTools");

/** A keychain backed by a plain map, matching the read-only view resolution uses. */
function fakeKeychain(
	entries: Record<string, string>,
): import("../keychain").Keychain {
	return {
		available: true,
		encrypted: true,
		read: (id) => entries[id] ?? "",
		list: () => Object.keys(entries),
	};
}

// requestUrlMock is shared across the whole run, so its call count accumulates
// between tests. Reset before each so an assertion sees only this test's calls.
beforeEach(() => {
	requestUrlMock.mockClear();
});

/** Shapes a stub `requestUrl` response the way Obsidian's real one does. */
function requestUrlResponse(
	body: string,
	status = 200,
	headers?: Record<string, string>,
): unknown {
	return {
		status,
		statusText: "",
		headers: headers ?? { "content-type": "text/plain" },
		arrayBuffer: new TextEncoder().encode(body).buffer,
	};
}

/** Pulls the text content out of a tool result the way the chat panel does. */
function textOf(result: {
	content: Array<{ type: string; text?: string }>;
}): string {
	const entry = result.content[0];
	return entry?.type === "text" ? (entry.text ?? "") : "";
}

describe("web_fetch", () => {
	it("performs a GET and returns the status line followed by the body", async () => {
		requestUrlMock.mockImplementation(async () =>
			requestUrlResponse("hello world", 200),
		);

		const tool = createWebFetchTool();
		const result = await tool.execute("call", { url: "https://example.com" });

		expect(textOf(result)).toBe("HTTP 200 \nhello world");
		expect(result.details).toMatchObject({
			url: "https://example.com",
			method: "GET",
			status: 200,
			truncated: false,
		});
	});

	it("passes method, headers, and body through to the request", async () => {
		let captured: unknown;
		requestUrlMock.mockImplementation(async (params: unknown) => {
			captured = params;
			return requestUrlResponse("{}", 201);
		});

		const tool = createWebFetchTool();
		await tool.execute("call", {
			url: "https://api.example.com",
			method: "post",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer s3cret",
			},
			body: '{"q":"pi"}',
		});

		// Method is upper-cased so the model's lowercase "post" still reaches the
		// server as POST, matching how every other tool normalizes free-form input.
		expect(captured).toMatchObject({
			url: "https://api.example.com",
			method: "POST",
			body: '{"q":"pi"}',
			throw: false,
		});
		// `requestUrl` receives a header map, not a Headers object; the auth header
		// the model placed must survive the trip to the transport.
		expect(
			(captured as { headers: Record<string, string> }).headers["authorization"],
		).toBe("Bearer s3cret");
	});

	it("surfaces a non-2xx body rather than throwing", async () => {
		requestUrlMock.mockImplementation(async () =>
			requestUrlResponse("not found", 404),
		);

		const tool = createWebFetchTool();
		const result = await tool.execute("call", {
			url: "https://example.com/missing",
		});

		// The status line leads so the model reads 404 as the server's verdict, not
		// an unexplained "not found" string dropped into context.
		expect(textOf(result)).toBe("HTTP 404 \nnot found");
		expect(result.details).toMatchObject({ status: 404 });
	});

	it("rejects when the signal is already aborted before the request", async () => {
		const controller = new AbortController();
		controller.abort();

		requestUrlMock.mockImplementation(async () =>
			requestUrlResponse("late", 200),
		);

		const tool = createWebFetchTool();
		const error = await tool
			.execute("call", { url: "https://example.com" }, controller.signal)
			.then(
				() => null,
				(reason: unknown) => reason,
			);

		// The pre-flight throwIfAborted fires before requestUrl is touched, so a
		// stop press that lands first means no request leaves the vault at all.
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Operation aborted");
		expect(requestUrlMock).toHaveBeenCalledTimes(0);
	});

	it("flags the detail and hands over the Range escape hatch when the body exceeds the truncation budget", async () => {
		// A body well past the default byte cap so truncation is certain, and the
		// truncated flag in details flips — the content itself is capped by the
		// shared budget every tool result honours. The notice must teach the
		// recovery move (page with Range) and surface the server's own size when
		// it can, so the model knows what remains rather than that it ended.
		const oversized = "x".repeat(300_000);
		requestUrlMock.mockImplementation(async () =>
			requestUrlResponse(oversized, 200, {
				"content-type": "text/plain",
				"content-length": String(oversized.length),
			}),
		);

		const tool = createWebFetchTool();
		const result = await tool.execute("call", { url: "https://example.com/big" });

		expect(result.details).toMatchObject({ truncated: true });
		const text = textOf(result);
		expect(text).toContain("[Output truncated");
		expect(text).toContain("Full body: 300000 bytes.");
		expect(text).toContain(
			"Re-request with a 'Range: bytes=65536-' header to read further.",
		);
	});
});

describe("web_fetch keychain placeholders", () => {
	it("substitutes {{secret:id}} into headers before the request and keeps it out of details", async () => {
		let captured: unknown;
		requestUrlMock.mockImplementation(async (params: unknown) => {
			captured = params;
			return requestUrlResponse("{}", 200);
		});

		const tool = createWebFetchTool(fakeKeychain({ "my-token": "sk-live-xyz" }));
		const result = await tool.execute("call", {
			url: "https://api.example.com",
			headers: { authorization: "Bearer {{secret:my-token}}" },
		});

		// The cleartext reaches the transport...
		expect(
			(captured as { headers: Record<string, string> }).headers["authorization"],
		).toBe("Bearer sk-live-xyz");
		// ...but the recorded url in details is the pre-substitution one.
		expect(result.details).toMatchObject({
			url: "https://api.example.com",
			status: 200,
		});
	});

	it("substitutes into url and body as well", async () => {
		let captured: unknown;
		requestUrlMock.mockImplementation(async (params: unknown) => {
			captured = params;
			return requestUrlResponse("{}", 200);
		});

		const tool = createWebFetchTool(fakeKeychain({ key: "K", tok: "T" }));
		await tool.execute("call", {
			url: "https://api.example.com?key={{secret:key}}",
			method: "post",
			body: '{"t":"{{secret:tok}}"}',
		});

		expect(captured).toMatchObject({
			url: "https://api.example.com?key=K",
			body: '{"t":"T"}',
		});
	});

	it("fails the tool without sending when a placeholder names no entry", async () => {
		requestUrlMock.mockImplementation(async () =>
			requestUrlResponse("late", 200),
		);

		const tool = createWebFetchTool(fakeKeychain({}));
		const error = await tool
			.execute("call", {
				url: "https://api.example.com",
				headers: { authorization: "Bearer {{secret:missing}}" },
			})
			.then(
				() => null,
				(reason: unknown) => reason,
			);

		expect(error).toBeInstanceOf(Error);
		// The id is named back (it is a user label, not the secret) and nothing left
		// the vault.
		expect((error as Error).message).toContain("missing");
		expect(requestUrlMock).toHaveBeenCalledTimes(0);
	});

	it("sends placeholders verbatim when no keychain is wired", async () => {
		let captured: unknown;
		requestUrlMock.mockImplementation(async (params: unknown) => {
			captured = params;
			return requestUrlResponse("{}", 200);
		});

		// No keychain argument: substitution is off, the string passes through. This
		// is the test/no-secret-storage default.
		const tool = createWebFetchTool();
		await tool.execute("call", {
			url: "https://example.com",
			headers: { x: "{{secret:a}}" },
		});

		expect((captured as { headers: Record<string, string> }).headers["x"]).toBe(
			"{{secret:a}}",
		);
	});
});

describe("web_fetch transport pinning", () => {
	it("rides requestUrl even when a platform fetch is available", async () => {
		const fetchMock = mock((_input: unknown, _init?: unknown) =>
			Promise.resolve(
				new Response("streamed", {
					status: 200,
					headers: { "content-type": "text/plain" },
				}),
			),
		);
		// Stubbed on `window`, which is the path the fetch transport would take.
		const restore = stubWindowFetch(fetchMock);
		try {
			requestUrlMock.mockImplementation(async () =>
				requestUrlResponse("buffered", 200),
			);

			const tool = createWebFetchTool();
			const result = await tool.execute("call", { url: "https://example.com" });

			// The pin is the point: the model can ask for any URL, and ordinary hosts
			// send no CORS headers — on the `fetch` transport most of the web would be
			// unreachable from here, while streaming buys a one-gulp body nothing.
			// The user's networkTransport choice must not move this tool.
			expect(requestUrlMock).toHaveBeenCalledTimes(1);
			expect(fetchMock).toHaveBeenCalledTimes(0);
			expect(textOf(result)).toBe("HTTP 200 \nbuffered");
		} finally {
			restore();
		}
	});
});
