import { createFetchForTransport, type FetchFn } from "../net/obsidianFetch";
import {
	BUILTIN_MCP_CATALOG_URL,
	MAX_BUILTIN_MCP_CATALOG_BYTES,
	normalizeBuiltinMcpCatalog,
	type BuiltinMcpCatalog,
} from "./mcpConfig";

export type BuiltinMcpCatalogFetchResult =
	| { status: "not-modified"; etag?: string }
	| { status: "updated"; catalog: BuiltinMcpCatalog; etag?: string };

/** Fetches one validated catalog snapshot; callers decide how to persist/apply it. */
export async function fetchBuiltinMcpCatalog(options: {
	fetch?: FetchFn;
	etag?: string;
	signal?: AbortSignal;
} = {}): Promise<BuiltinMcpCatalogFetchResult> {
	const fetchImpl = options.fetch ?? createFetchForTransport("requestUrl");
	const headers: Record<string, string> = { accept: "application/json" };
	if (options.etag) headers["if-none-match"] = options.etag;
	const response = await fetchImpl(BUILTIN_MCP_CATALOG_URL, {
		method: "GET",
		headers,
		signal: options.signal,
	});
	const etag = response.headers.get("etag") ?? undefined;
	if (response.status === 304) return { status: "not-modified", etag: etag ?? options.etag };
	if (!response.ok) throw new Error(`Built-in MCP catalog answered ${response.status}.`);
	const text = await response.text();
	if (new TextEncoder().encode(text).byteLength > MAX_BUILTIN_MCP_CATALOG_BYTES) throw new Error("Built-in MCP catalog is too large.");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("Built-in MCP catalog is not valid JSON.");
	}
	const catalog = normalizeBuiltinMcpCatalog(parsed);
	if (catalog === null) throw new Error("Built-in MCP catalog failed validation.");
	return { status: "updated", catalog, etag };
}
