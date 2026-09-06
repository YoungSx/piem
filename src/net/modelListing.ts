import type { ProviderConfig, WireProtocol } from "../modelConfig";
import type { FetchFn } from "./obsidianFetch";

/**
 * Asking an endpoint which models it serves, without naming one.
 *
 * Every wire protocol requires a model id in a chat request body, which is why
 * a provider used to be untestable until the user had configured a model under
 * it. All three protocols, however, expose a model *listing* endpoint on the
 * same base URL, and that endpoint needs no model id: it answers with the
 * server's own catalog. That makes it the one probe that can validate a base
 * URL, a protocol, and a credential while knowing nothing about models.
 *
 * This module deliberately speaks HTTP directly rather than going through
 * pi-ai. pi-ai's `Provider` surface is built around streaming a completion, so
 * there is no modelless call to borrow — the path suffix and auth headers below
 * duplicate knowledge the official SDKs hold. The duplication is one path
 * string and one or two headers per protocol, and it is the whole price of a
 * probe that costs no tokens.
 *
 * The caller supplies `fetch`, and it is required rather than defaulted: a
 * probe that silently skipped the user's chosen transport would be checked
 * against a different network path than a real turn, which on mobile or behind
 * CORS is the difference between a red verdict and a green one.
 */

/** Where each protocol's listing endpoint sits, relative to the provider's base URL. */
const LISTING_PATHS: Record<WireProtocol, string> = {
	"openai-completions": "models",
	"openai-responses": "models",
	"anthropic-messages": "v1/models",
};

/**
 * Version header the Anthropic SDK sends on every request.
 *
 * Pinned to the same value `@anthropic-ai/sdk` defaults to, so the probe is
 * accepted by a strict Anthropic-compatible server that rejects a request
 * carrying no version at all.
 */
const ANTHROPIC_VERSION = "2023-06-01";

/** What an endpoint said when asked which models it serves. */
export interface ModelListingResult {
	/** HTTP status the endpoint answered with. */
	status: number;
	/** Model ids it advertised, in the order returned. Empty when the body carried none. */
	modelIds: readonly string[];
	/** The server's own message for a non-2xx answer, when the body carried one. */
	message?: string;
}

/**
 * Resolves the listing URL the way each protocol's own SDK resolves a request
 * path: appended to the configured base URL, with a doubled slash collapsed.
 *
 * Matching the SDKs matters more than being lenient. A base URL that is wrong
 * for chat is then wrong for listing in exactly the same way, so the probe
 * reproduces the failure a real turn would hit instead of quietly repairing it.
 */
export function modelListingUrl(provider: ProviderConfig): string {
	const base = provider.baseUrl.trim().replace(/\/+$/, "");
	return `${base}/${LISTING_PATHS[provider.protocol]}`;
}

/**
 * A credential to send in place of the row's own key.
 *
 * Deliberately shaped like the two fields pi's resolved auth carries, without
 * importing its type: a subscription row keeps its token in the credential store,
 * not in `provider.apiKey`, and this is how the caller that resolved it hands it
 * down. Which of the two fields is filled is the flow's choice — xAI's token goes
 * where an api key would, Kimi's arrives as its own `Authorization` header.
 */
export interface ListingCredential {
	apiKey?: string;
	headers?: Record<string, string>;
}

/**
 * Auth headers this protocol's SDK would send.
 *
 * A blank key sends no credential header at all rather than an empty one: a
 * keyless local server is a legitimate configuration, and an empty bearer token
 * would turn its healthy 200 into a 401.
 *
 * A supplied {@link ListingCredential} replaces the row's key rather than
 * merging with it, and its own headers are applied last — a subscription row's
 * `provider.apiKey` is either empty or stale, so blending the two could send a
 * credential the row does not use.
 */
export function providerAuthHeaders(provider: ProviderConfig, credential?: ListingCredential): Record<string, string> {
	const headers: Record<string, string> = { accept: "application/json" };
	const apiKey = (credential ? credential.apiKey : provider.apiKey)?.trim();
	if (provider.protocol === "anthropic-messages") {
		headers["anthropic-version"] = ANTHROPIC_VERSION;
		if (apiKey) {
			headers["x-api-key"] = apiKey;
		}
	} else if (apiKey) {
		headers.authorization = `Bearer ${apiKey}`;
	}
	for (const [name, value] of Object.entries(credential?.headers ?? {})) {
		headers[name.toLowerCase()] = value;
	}
	return headers;
}

/**
 * Reads model ids out of a listing body.
 *
 * Forgiving by design, and never authoritative: OpenAI answers `{ data: [...] }`,
 * some gateways answer `{ models: [...] }`, and a few answer a bare array of
 * strings. A body this function cannot parse yields no ids, and the caller must
 * still treat the status as the verdict — a 200 whose shape is unfamiliar means
 * the endpoint and credential worked, which is what the probe set out to learn.
 */
function readModelIds(payload: unknown): string[] {
	const entries = Array.isArray(payload)
		? payload
		: payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).data)
			? ((payload as Record<string, unknown>).data as unknown[])
			: payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).models)
				? ((payload as Record<string, unknown>).models as unknown[])
				: [];
	const ids: string[] = [];
	for (const entry of entries) {
		if (typeof entry === "string" && entry.trim()) {
			ids.push(entry.trim());
			continue;
		}
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const record = entry as Record<string, unknown>;
		const id = typeof record.id === "string" ? record.id.trim() : typeof record.name === "string" ? record.name.trim() : "";
		if (id) {
			ids.push(id);
		}
	}
	return ids;
}

/**
 * Pulls the server's own wording out of an error envelope.
 *
 * `{ error: { message } }` covers both OpenAI and Anthropic, and a bare
 * `{ message }` covers gateways that flatten it. The server's phrasing is worth
 * relaying verbatim: it is what distinguishes a rejected key from a disabled
 * account or an exhausted quota.
 */
function readErrorMessage(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object") {
		return undefined;
	}
	const record = payload as Record<string, unknown>;
	const error = record.error;
	if (error && typeof error === "object") {
		const message = (error as Record<string, unknown>).message;
		if (typeof message === "string" && message.trim()) {
			return message.trim();
		}
	}
	if (typeof error === "string" && error.trim()) {
		return error.trim();
	}
	return typeof record.message === "string" && record.message.trim() ? record.message.trim() : undefined;
}

/**
 * Asks the provider which models it serves.
 *
 * Resolves for every answer the server gives, including a non-2xx one, because
 * the status is a finding rather than an accident: a 401 names the credential
 * and a 404 names an endpoint that does not implement listing. Only a failure
 * to get an answer at all — DNS, TLS, timeout, abort — throws, which lets the
 * caller reuse its existing error phrasing for those.
 */
export async function probeModelListing(
	provider: ProviderConfig,
	options: { fetch: FetchFn; signal?: AbortSignal; credential?: ListingCredential },
): Promise<ModelListingResult> {
	const response = await options.fetch(modelListingUrl(provider), {
		method: "GET",
		headers: providerAuthHeaders(provider, options.credential),
		signal: options.signal,
	});

	let payload: unknown;
	try {
		payload = JSON.parse(await response.text());
	} catch {
		payload = undefined;
	}

	const result: ModelListingResult = { status: response.status, modelIds: readModelIds(payload) };
	const message = readErrorMessage(payload);
	return message ? { ...result, message } : result;
}
