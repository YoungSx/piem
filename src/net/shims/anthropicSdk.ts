/**
 * Minimal stand-in for `@anthropic-ai/sdk`, aliased over the real package at
 * bundle time (esbuild.config.mjs). Issue #92.
 *
 * Satisfies exactly what pi-ai's anthropic-messages.js touches, as audited:
 *   - new Anthropic({ apiKey, authToken, baseURL, dangerouslyAllowBrowser, fetch, defaultHeaders })
 *   - client.beta.messages.create(params, { signal, timeout, maxRetries }).asResponse()
 *     — the only call site, and the only member of the client that pi-ai reads.
 *
 * Load-bearing SDK behaviour reproduced:
 *   - `anthropic-version: 2023-06-01`: the API rejects requests without it and
 *     pi-ai never sets it itself.
 *   - apiKey → `x-api-key`, authToken → `Authorization: Bearer`; both may be
 *     present (pi-ai nulls the unused one, so either is fine).
 *   - falsy baseURL falls back to the public API host, matching client.js.
 *   - non-2xx → error carrying `status` and a real `Headers` object (see
 *     apiHttp.ts for the contract).
 *
 * Deliberately NOT reproduced: SSE parsing. pi-ai reads the raw response body
 * itself (iterateSseMessages) — that is why this shim can be this small.
 */
import {
	ApiError,
	assertOkResponse,
	abortError,
	buildRequestUrl,
	mergeHeaders,
	transportError,
	wireAbort,
} from "./apiHttp.js";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_BASE_URL = "https://api.anthropic.com";

export interface AnthropicClientOptions {
	apiKey?: string | null;
	authToken?: string | null;
	baseURL?: string;
	/** Accepted and ignored: the shim never refuses to run in a browser. */
	dangerouslyAllowBrowser?: boolean;
	fetch: typeof fetch;
	defaultHeaders?: Record<string, string>;
}

export interface AnthropicRequestOptions {
	signal?: AbortSignal;
	timeout?: number;
	/** pi-ai always passes 0 and retries itself; the value is honoured by being ignored. */
	maxRetries?: number;
	headers?: Record<string, string>;
}

export class Anthropic {
	private readonly apiKey: string | null;
	private readonly authToken: string | null;
	private readonly baseURL: string;
	private readonly fetchImpl: typeof fetch;
	private readonly defaultHeaders: Record<string, string>;

	readonly messages = {
		create: (body: Record<string, unknown>, options: AnthropicRequestOptions = {}) =>
			this.post("/v1/messages", body, options),
	};

	readonly beta = {
		messages: {
			create: (params: Record<string, unknown>, options: AnthropicRequestOptions = {}) => {
				// The SDK's beta resource moves these fields out of the JSON body.
				// Request headers override generated headers, including mixed casing.
				const { betas, user_profile_id, workspace_id, ...body } = params;
				if (betas != null && (!Array.isArray(betas) || !betas.every((value: unknown) => typeof value === "string"))) throw new TypeError("betas must be an array of strings");
				if (user_profile_id != null && typeof user_profile_id !== "string") throw new TypeError("user_profile_id must be a string");
				if (workspace_id != null && typeof workspace_id !== "string") throw new TypeError("workspace_id must be a string");
				const headers = mergeHeaders({
					...(betas != null ? { "anthropic-beta": betas.join(",") } : {}),
					...(user_profile_id != null ? { "anthropic-user-profile-id": user_profile_id } : {}),
					...(workspace_id != null ? { "anthropic-workspace-id": workspace_id } : {}),
				}, options.headers);
				const requestHeaders: Record<string, string> = {};
				headers.forEach((value, name) => { requestHeaders[name] = value; });
				return this.post("/v1/messages?beta=true", body, { ...options, headers: requestHeaders });
			},
		},
	};

	constructor(options: AnthropicClientOptions) {
		this.apiKey = typeof options.apiKey === "string" ? options.apiKey : null;
		this.authToken = typeof options.authToken === "string" ? options.authToken : null;
		this.baseURL = options.baseURL || DEFAULT_BASE_URL;
		this.fetchImpl = options.fetch;
		this.defaultHeaders = options.defaultHeaders ?? {};
		// client.js validateHeaders: without any auth the SDK refuses up front.
		// Caller-supplied headers (e.g. an explicit Authorization) count as auth.
		if (this.apiKey === null && this.authToken === null && !hasAuthHeader(this.defaultHeaders)) {
			throw new Error("Could not resolve authentication method. Expected either apiKey or authToken to be set.");
		}
	}

	private async send(
		path: string,
		body: Record<string, unknown>,
		options: AnthropicRequestOptions,
	): Promise<Response> {
		if (options.signal?.aborted) throw abortError();
		const { signal, cleanup } = wireAbort(options.signal, options.timeout);
		const headers = mergeHeaders(
			{
				accept: "application/json",
				"content-type": "application/json",
				"anthropic-version": ANTHROPIC_VERSION,
			},
			this.apiKey !== null ? { "x-api-key": this.apiKey } : undefined,
			this.authToken !== null ? { authorization: `Bearer ${this.authToken}` } : undefined,
			this.defaultHeaders,
			options.headers,
		);
		try {
			const response = await this.fetchImpl.call(undefined, buildRequestUrl(this.baseURL, path), {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal,
			});
			await assertOkResponse(response);
			return response;
		} catch (cause) {
			throw transportError(cause);
		} finally {
			cleanup();
		}
	}

	/**
	 * Stands in for the SDK's APIPromise: pi-ai chains `.asResponse()` on the
	 * create() return value immediately, so the request starts eagerly and the
	 * caller awaits the raw Response through this handle.
	 */
	private post(path: string, body: Record<string, unknown>, options: AnthropicRequestOptions): {
		asResponse: () => Promise<Response>;
	} {
		const response = this.send(path, body, options);
		return {
			asResponse: () => response,
		};
	}
}

function hasAuthHeader(headers: Record<string, string>): boolean {
	return Object.keys(headers).some((name) => {
		const key = name.toLowerCase();
		return key === "authorization" || key === "x-api-key";
	});
}

export { ApiError };
export default Anthropic;
