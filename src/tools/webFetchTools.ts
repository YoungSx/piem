import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { createObsidianRequestUrlFetch } from "../net/obsidianFetch";
import { throwIfAborted } from "./toolResult";
import { truncateToolOutputDetailed } from "../vault/truncate";
import type { Keychain } from "../keychain";
import {
	resolveRequestSecrets,
	SECRET_PLACEHOLDER_SYNTAX,
} from "./secretPlaceholders";

/**
 * Agent-facing HTTP request tool.
 *
 * The vault tools (read/write/edit/grep/…) never leave the vault. This is the
 * one that does, so it earns every guardrail AGENTS.md asks of a network call:
 * disclosed in its own description, output capped, and moving every byte
 * through the one transport layer — no second, hidden channel.
 *
 * The transport is pinned to `requestUrl`, deliberately not the user's
 * `networkTransport` setting. That setting buys streaming for model requests —
 * tokens appearing as they arrive — and this tool reads its response in one
 * gulp, so `fetch`'s streaming buys nothing here. What `fetch` would add is
 * CORS: the model can ask for any URL, and ordinary web pages send no CORS
 * headers, so on the `fetch` transport most of the web would be unreachable
 * from this tool. Skill imports and the models.dev catalog make the same call.
 *
 * The body is returned as text and capped by {@link truncateToolOutputDetailed},
 * the same byte budget every other tool result honours — a multi-megabyte
 * endpoint cannot fill the model's context window through this tool any more
 * than a large note can through read. What the cap cannot bound is the
 * *download*: `requestUrl` buffers the entire body before anything is
 * observable, so the model is taught — in the description, and again wherever a
 * truncation lands — to page large resources with HTTP Range headers instead of
 * gulping them whole. A server that ignores Range takes the one-gulp hit; that
 * is the transport's structural price, disclosed rather than defended.
 *
 * The `signal` from the agent loop is forwarded so a stop press aborts an
 * in-flight request. `requestUrl` has no native cancellation; the race in
 * {@link createObsidianRequestUrlFetch} rejects on abort, which is what makes
 * stop actually stop.
 */
const WebFetchParameters = Type.Object({
	url: Type.String({
		description: "Absolute HTTP or HTTPS URL to request.",
	}),
	method: Type.Optional(
		Type.String({
			description: "HTTP method. Defaults to GET.",
		}),
	),
	headers: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Request headers keyed by name.",
		}),
	),
	body: Type.Optional(
		Type.String({
			description: "Request body for POST/PUT/PATCH. Sent verbatim.",
		}),
	),
});

/**
 * @param keychain Read-only keychain used to resolve `{{secret:id}}`
 * placeholders in the url, headers, and body before the request leaves the
 * vault. Omitted (the default in tests) leaves placeholders verbatim — no
 * substitution happens and nothing is read from any store.
 */
export function createWebFetchTool(
	keychain?: Keychain,
): AgentTool<typeof WebFetchParameters> {
	const fetchFn = createObsidianRequestUrlFetch();
	return {
		name: "web_fetch",
		label: "Fetch a URL",
		// Outbound, and not assumed idempotent: `method` can be POST/PUT/PATCH, so
		// a server-visible side effect is possible and the call stays sequential.
		executionMode: "sequential",
		// The description is the disclosure AGENTS.md requires: it names the one
		// thing every other tool avoids — data leaving the vault — so the model
		// treats an outbound request as a deliberate act, and a reader auditing the
		// transcript sees it stated where the call is made.
		description:
			"Make an HTTP request to an external URL and return the response body as text. " +
			"This sends data to a server outside the vault and Obsidian. " +
			"Use it only when a task genuinely needs information that is not in the vault. " +
			"To authenticate a request with a credential from Obsidian's keychain, write " +
			`the placeholder ${SECRET_PLACEHOLDER_SYNTAX} in the url, a header value, or the body ` +
			"(e.g. an 'Authorization' header of 'Bearer {{secret:my-api-token}}'); the entry id is " +
			"the label the user gave it in Obsidian's keychain settings. The value is substituted in " +
			"just before the request is sent and never appears in this conversation, so you never see " +
			"the credential itself — use the placeholder, do not ask for the value. " +
			"Only the first 50KB of the body is shown; for anything large or of unknown size, " +
			"pass a Range header (e.g. 'Range: bytes=0-65535') to fetch a window at a time — " +
			"a 206 response means the server honours ranges, and 'Content-Range: bytes 0-65535/TOTAL' " +
			"tells you how much remains to page through. Without Range, a large body is fully " +
			"downloaded before the visible cap is applied, which wastes memory on multi-megabyte endpoints.",
		parameters: WebFetchParameters,
		execute: async (_toolCallId, params, signal) => {
			throwIfAborted(signal);
			const method = (params.method ?? "GET").toUpperCase();
			// Substitute keychain placeholders at the boundary: the model authored
			// with `{{secret:id}}`, the transcript kept the placeholder, and the
			// cleartext exists only in the arguments handed to the transport below.
			// An unknown id fails the tool with the id named back — the id is a
			// user-chosen label, not the secret — rather than sending a request that
			// silently drops the credential and 401s for a reason the model cannot see.
			const request = keychain
				? resolveRequestSecrets(
						{ url: params.url, headers: params.headers, body: params.body },
						keychain,
					)
				: {
						resolved: { url: params.url, headers: params.headers, body: params.body },
						unknownIds: [],
					};
			if (request.unknownIds.length > 0) {
				throw new Error(
					`No keychain entry named: ${request.unknownIds.join(", ")}. ` +
						"Check the entry id in Obsidian's keychain settings, or ask the user to create it. " +
						"The request was not sent.",
				);
			}
			const response = await fetchFn(request.resolved.url, {
				method,
				headers: request.resolved.headers,
				body: request.resolved.body,
				signal,
			});
			throwIfAborted(signal);
			// Read as text regardless of content type: the model cannot render a
			// binary body, and a charset mismatch surfaces as mojibake the model can
			// still reason around — whereas a thrown decode error would hide the
			// response behind a failure that tells it nothing.
			const text = await response.text();
			throwIfAborted(signal);
			// The status line leads so a non-2xx body is read as the server's own
			// explanation rather than an unexplained blob of error text.
			let output = `HTTP ${response.status} ${response.statusText}\n${text}`;
			// Truncate once and derive the flag from the structured result, rather
			// than routing through textResult — which would encode the body a second
			// time to ask the same question.
			const capped = truncateToolOutputDetailed(output);
			// When the cap bites, hand over the escape hatch instead of leaving the
			// model to conclude the page simply ended. Content-Length is best-effort:
			// chunked responses omit it, and the header map may have dropped it on a
			// malformed sibling entry.
			if (capped.truncated) {
				const total = response.headers.get("content-length");
				const sizing = total ? ` Full body: ${total} bytes.` : "";
				output = `${capped.text}\n[Body truncated at 50KB.${sizing} Re-request with a 'Range: bytes=65536-' header to read further.]`;
			}
			const result: AgentToolResult<Record<string, unknown>> = {
				content: [{ type: "text", text: output }],
				details: {
					// The pre-substitution url, so the transcript's record of where the
					// request went keeps the placeholder rather than a resolved secret in
					// a query string.
					url: params.url,
					method,
					status: response.status,
					truncated: capped.truncated,
				},
			};
			return result;
		},
	};
}
