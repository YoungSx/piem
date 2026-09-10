import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import type { FetchFunction } from "@earendil-works/pi-ai";

/**
 * Obsidian-backed `fetch` implementations for pi-ai provider requests.
 *
 * Obsidian renders plugins in a page whose origin differs per platform —
 * `app://obsidian.md` on desktop, `capacitor://localhost` on iOS,
 * `http://localhost` on Android — and `window.fetch` is subject to CORS under
 * all three. `requestUrl` bypasses CORS entirely but has no incremental entry
 * point at all, so it cannot stream. See {@link createObsidianRequestUrlFetch}
 * for why that is structural rather than a gap in our usage.
 *
 * We expose both and let the caller choose:
 *
 * - {@link createObsidianRequestUrlFetch} — CORS-free, no streaming. Every SSE
 *   event becomes available at once, after the request completes.
 * - {@link createObsidianStreamingFetch} — native `fetch`, real streaming,
 *   subject to CORS.
 *
 * Why `fetch` is the non-default despite being the better experience. It is not
 * that providers refuse browser origins: a 2026-09-02 sweep found 24 of 27
 * model endpoints answering the preflight for our origins without special
 * pleading. The reasons are narrower and all four survive that finding:
 *
 * 1. **Undocumented, so no SLA.** Almost none of those providers document
 *    browser access, and OpenAI broke it twice in fifteen months (2025-10-15
 *    `/v1/chat/completions`, 2026-01-29 `/v1/responses`) — fixed both times as
 *    bugs, which is precisely the point: it is a bug either way it moves.
 * 2. **The gate is the request-header set, not the origin.** Gemini's
 *    `Access-Control-Allow-Headers` is a strict allowlist that 403s on any
 *    `x-stainless-*`; Moonshot silently drops every CORS header past six
 *    request headers. We stay under both by default (our SDK shim sends only
 *    accept + content-type + authorization), but a user's per-model `headers`
 *    can push us over.
 * 3. **Local and self-hosted endpoints need the user to opt in.** Ollama
 *    default-allows `app://*` but no pattern matching iOS's
 *    `capacitor://localhost`; LM Studio needs `--cors`; anything behind a
 *    self-hosted gateway is entirely the deployer's call.
 * 4. **Two providers hard-block.** Tencent Hunyuan answers OPTIONS with 404 on
 *    every path, and iFlytek Spark with a CORS-header-less 403.
 *
 * That is a shape worth defaulting away from, not one worth calling unreliable.
 *
 * Both return a {@link FetchFn} — an honest function signature, unlike
 * `typeof window.fetch`, whose type picks up bun-types' phantom `preconnect`
 * member and can therefore never be satisfied structurally by a wrapper.
 * pi-ai's `FetchFunction` accepts one via {@link toFetchFunction}.
 */

/** Header names that Obsidian's `requestUrl` sets itself; forwarding ours breaks the request. */
const STRIPPED_REQUEST_HEADERS = new Set(["host", "content-length", "connection"]);

/**
 * What our fetch factories actually produce: the call shape every consumer uses.
 *
 * Deliberately not `typeof window.fetch`. That type is polluted by bun-types
 * (pulled in ambient through `@types/bun`), which declares a `fetch.preconnect`
 * namespace on the global — so a wrapped closure, however faithful to the
 * runtime call, can never structurally match it, and the scanner then flags the
 * escaping assertion as unnecessary. Naming the shape ourselves keeps every
 * signature honest and leaves exactly one place that converts to pi-ai's type.
 */
export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function abortError(): DOMException {
	return new DOMException("The operation was aborted.", "AbortError");
}

function normalizeHeaders(init: RequestInit | undefined, input: RequestInfo | URL): Record<string, string> {
	const collected: Record<string, string> = {};

	const absorb = (headers: HeadersInit | undefined): void => {
		if (!headers) {
			return;
		}
		// `Headers` lowercases its keys; plain objects and tuple arrays keep theirs.
		if (typeof Headers !== "undefined" && headers instanceof Headers) {
			headers.forEach((value, key) => {
				collected[key] = value;
			});
			return;
		}
		if (Array.isArray(headers)) {
			for (const entry of headers) {
				const [key, value] = entry;
				if (key !== undefined && value !== undefined) {
					collected[key] = value;
				}
			}
			return;
		}
		for (const [key, value] of Object.entries(headers)) {
			collected[key] = String(value);
		}
	};

	if (typeof Request !== "undefined" && input instanceof Request) {
		absorb(input.headers);
	}
	absorb(init?.headers);

	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(collected)) {
		if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) {
			result[key] = value;
		}
	}
	return result;
}

function resolveUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	return input.url;
}

function resolveMethod(input: RequestInfo | URL, init: RequestInit | undefined): string {
	if (init?.method) {
		return init.method.toUpperCase();
	}
	if (typeof Request !== "undefined" && input instanceof Request) {
		return input.method.toUpperCase();
	}
	return "GET";
}

async function resolveBody(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
): Promise<string | ArrayBuffer | undefined> {
	const body = init?.body;

	if (body === undefined || body === null) {
		// A `Request` object can still carry a body even when `init` does not.
		if (typeof Request !== "undefined" && input instanceof Request && input.bodyUsed === false) {
			const text = await input.clone().text();
			return text.length > 0 ? text : undefined;
		}
		return undefined;
	}
	if (typeof body === "string") {
		return body;
	}
	if (body instanceof ArrayBuffer) {
		return body;
	}
	if (ArrayBuffer.isView(body)) {
		// `isView` does not exclude a SharedArrayBuffer backstop, so `body.buffer`
		// types as either — but `requestUrl` needs a plain ArrayBuffer, and a real
		// SAB body never reaches here (pi-ai sends strings and image buffers).
		if (!(body.buffer instanceof ArrayBuffer)) {
			throw new Error("Obsidian requestUrl transport does not support this request body type.");
		}
		return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
	}
	if (typeof Blob !== "undefined" && body instanceof Blob) {
		return await body.arrayBuffer();
	}
	if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
		return body.toString();
	}
	// ReadableStream / FormData are not used by pi-ai's JSON providers.
	throw new Error("Obsidian requestUrl transport does not support this request body type.");
}

/**
 * Statuses the `Response` constructor refuses to pair with a body.
 *
 * `requestUrl` hands back an `arrayBuffer` unconditionally, and an *empty*
 * `ArrayBuffer` still counts as a body — so forwarding it is precisely what
 * makes `new Response(buf, { status: 304 })` throw, even when the server sent
 * no bytes at all. The fetch spec requires a null body for these statuses, so
 * the buffer is dropped rather than the status rewritten: a 304 stays a 304.
 *
 * Worth knowing why 304 is not a hypothetical. Electron's `net` stack — which
 * is what `requestUrl` runs on — uses the session cache, so a URL fetched a
 * second time can legitimately come back as 304 Not Modified with an empty
 * body. Under the old code that response was unrepresentable and the transport
 * threw instead.
 */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Range the `Response` constructor accepts, per the fetch spec.
 *
 * Note this excludes 1xx: informational statuses are not constructible at all,
 * not even with a null body. Bun's runtime happens to allow 101, Chromium and
 * undici do not — so the check follows the spec rather than the test runner.
 */
const MIN_RESPONSE_STATUS = 200;
const MAX_RESPONSE_STATUS = 599;

/**
 * Copies `requestUrl`'s headers into a `Headers`, skipping ones it rejects.
 *
 * The header map comes off the wire, so its shape is the server's choice rather
 * than ours: real HTTP/2 origins emit the `:status` pseudo-header, and a
 * misconfigured one can emit a name containing a space or a value containing a
 * newline. Every such name makes the `Headers` constructor throw, and building
 * the whole map in one call means a single bad entry costs the caller the body,
 * the status, and every well-formed sibling with it.
 *
 * Appending one at a time trades that cliff for a dropped header. The dropped
 * ones are pseudo-headers and malformed junk — nothing a caller could have read
 * through the `Headers` API anyway, since `get(":status")` throws on the same
 * grounds as `append` did.
 */
function toResponseHeaders(raw: Record<string, string> | undefined): Headers {
	const headers = new Headers();
	if (!raw) {
		return headers;
	}
	for (const [name, value] of Object.entries(raw)) {
		try {
			headers.append(name, value);
		} catch {
			// Deliberately silent: see the doc comment. A rejected header is
			// unreadable through `Headers` regardless, so there is nothing the
			// caller could do with the knowledge that it was there.
		}
	}
	return headers;
}

/**
 * Turns a `requestUrl` result into a `Response` without letting the constructor
 * throw for reasons the caller cannot act on.
 *
 * The constructor is stricter than HTTP: it rejects a body on 204/205/304 and
 * refuses any status outside 200–599. Left unguarded it raises a bare
 * `TypeError` from inside the transport, which reaches the agent as "the tool
 * just failed" with nothing naming the cause.
 *
 * An out-of-range status is the one case that still fails, on purpose. There is
 * no honest `Response` for it — inventing a 502 would leave the caller unable to
 * tell a real upstream 502 from our substitute — so it throws, but with the
 * offending value in the message so a log line identifies it.
 */
function toResponse(response: RequestUrlResponse): Response {
	const status = response.status;
	if (!Number.isFinite(status) || status < MIN_RESPONSE_STATUS || status > MAX_RESPONSE_STATUS) {
		throw new Error(`Obsidian requestUrl returned an HTTP status outside 200-599: ${String(status)}.`);
	}
	const code = Math.trunc(status);
	return new Response(NULL_BODY_STATUSES.has(code) ? null : response.arrayBuffer, {
		status: code,
		headers: toResponseHeaders(response.headers),
	});
}

/**
 * `fetch` backed by Obsidian's `requestUrl`.
 *
 * Bypasses CORS, so it works on desktop and mobile for every provider. The
 * tradeoff is that nothing is observable until the request completes: pi-ai's
 * SSE parser can only start once the whole body is in memory, so every event of
 * a turn becomes available at the same instant and tokens appear all at once.
 *
 * Note this is *not* "the body arrives as one chunk" — a `Response` built from
 * an `ArrayBuffer` may well be read in several chunks (bun splits 200 KiB into
 * two). Every one of those reads resolves from memory without waiting on the
 * network, which is the part that matters and the part that cannot be improved
 * from here.
 *
 * The absence of streaming is structural, not a gap in this usage. Obsidian's
 * whole network surface is `request` and `requestUrl`; `RequestUrlParam` has no
 * signal, no progress callback and no stream flag, and the three promise
 * properties on `RequestUrlResponsePromise` that look like they might be
 * incremental are not. Obsidian's own `obsidian-importer` re-implements the API
 * for the browser by awaiting `arrayBuffer()` in full and then exposing those
 * three as views onto that single settled promise — first-party code saying, in
 * a comment, that both forms mean the same buffered value. The one recorded
 * attempt to squeeze progressive delivery out of it anyway (Range headers
 * against a never-ending stream, supernote-obsidian-plugin #210) is written up
 * as a dead end. Two plugins that appear to stream through `requestUrl` are
 * replaying a completed body on a timer.
 *
 * No deadline of its own. pi-ai treats `timeoutMs` as opt-in and leaves it
 * unset, so a transport that invented one would cut off requests the provider
 * layer deliberately left unbounded — a long reasoning pass reads exactly like
 * a stall from down here. A wedged endpoint is ended by the user pressing stop,
 * which the race below turns into a real rejection.
 */
export function createObsidianRequestUrlFetch(options?: {
	/**
	 * Observes actual network completion, which may outlive an aborted fetch.
	 * The handle carries no response and resolves on success or failure so an
	 * owner can retain its concurrency slot without changing fetch rejection.
	 */
	onRequest?: (settled: Promise<void>) => void;
}): FetchFn {
	const obsidianFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = resolveUrl(input);
		const method = resolveMethod(input, init);
		const headers = normalizeHeaders(init, input);
		const body = await resolveBody(input, init);

		const signal = init?.signal ?? (typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined);
		if (signal?.aborted) {
			throw abortError();
		}

		const params: RequestUrlParam = {
			url,
			method,
			headers,
			// Surface non-2xx responses as `Response` objects so pi-ai's own error
			// handling reports the provider's message instead of a thrown string.
			throw: false,
		};
		if (body !== undefined) {
			params.body = body;
		}

		const requestPromise = requestUrl(params);
		options?.onRequest?.(requestPromise.then(() => undefined, () => undefined));

		// `requestUrl` ignores signals and keeps its promise pending, so abort has
		// to reject the wait rather than merely flag it — otherwise pressing stop
		// leaves the turn hanging. The listener is removed in the `finally`; an
		// un-removed one lives as long as the caller's controller, which for the
		// agent is the whole turn.
		if (!signal) {
			return toResponse(await requestPromise);
		}
		let onAbort: (() => void) | undefined;
		try {
			const aborted = new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(abortError());
				signal.addEventListener("abort", onAbort, { once: true });
			});
			return toResponse(await Promise.race([requestPromise, aborted]));
		} finally {
			if (onAbort) {
				signal.removeEventListener("abort", onAbort);
			}
		}
	};

	return obsidianFetch;
}

/**
 * `fetch` using the platform implementation, preserving real streaming.
 *
 * Subject to CORS on every platform — including mobile, whose two origins are
 * waved through by the same endpoints that wave through the desktop one, so
 * this is not the desktop-only path it is sometimes taken for. What it cannot
 * reach is the four cases enumerated at the top of this file: an endpoint that
 * blocks preflight outright, one whose allowlist rejects the user's extra
 * per-model headers, a local server with CORS left off, and anything behind a
 * gateway configured by someone else.
 */
export function createObsidianStreamingFetch(): FetchFn {
	return (input: RequestInfo | URL, init?: RequestInit) => window.fetch(input, init);
}

/** Transport strategy for provider HTTP requests. */
export type NetworkTransport = "requestUrl" | "fetch";

/** Resolves the configured transport to a concrete `fetch` implementation. */
export function createFetchForTransport(transport: NetworkTransport): FetchFn {
	return transport === "fetch" ? createObsidianStreamingFetch() : createObsidianRequestUrlFetch();
}

/**
 * Presents a {@link FetchFn} as pi-ai's `FetchFunction` (`typeof globalThis.fetch`).
 *
 * The one deliberate cast in the file. It is a real conversion, not a no-op:
 * pi-ai's type inherits bun-types' phantom `fetch.preconnect` member (see
 * {@link FetchFn}), which no callable can satisfy structurally. pi-ai itself
 * only ever invokes it as `fetch(input, init)`, so the runtime contract is
 * already met — this just names the boundary where the lie is absorbed, instead
 * of scattering it across call sites.
 */
export function toFetchFunction(fetch: FetchFn): FetchFunction {
	return fetch as FetchFunction;
}
