/**
 * The built-in MCP catalog: which project-maintained HTTP MCP servers every
 * vault ships with, and how that list follows the project between releases.
 *
 * The catalog seeds offline from `resources/builtin-mcp.json`, bundled into
 * `main.js`. Each load then fetches the same file from the default branch on
 * GitHub in the background; a validated copy is cached in `data.json`, so the
 * next start, offline or not, opens on the latest list it has seen. The
 * catalog carries ids, names and endpoints only: enable switches and
 * credentials stay local settings, and a row whose endpoint moves loses its
 * credentials rather than carrying them to the new host.
 *
 * Maintainer contract for the resource: a change merged to the default branch
 * reaches every client on its next start, without a release. Bump `revision`
 * with every edit — clients ignore a fetched catalog older than the one they
 * hold, which is what stops a stale CDN edge from moving rows back — and
 * remember that moving an endpoint clears every user's token for that row.
 */

import bundledCatalogJson from "../../resources/builtin-mcp.json";
import type { LoggerLike } from "../logging/Logger";
import type { FetchFn } from "../net/obsidianFetch";
import { BUILTIN_MCP_ID_PREFIX, isBuiltinMcpServerId, MAX_MCP_SERVERS, type McpServerConfig } from "./mcpConfig";

/** Where the catalog lives on the default branch; the path is public API once released. */
export const BUILTIN_MCP_CATALOG_URL = "https://raw.githubusercontent.com/YoungSx/piem/master/resources/builtin-mcp.json";
/**
 * Upper bound on a fetched catalog's body. `requestUrl` buffers the whole
 * response before it can be measured, so this bounds parsing and what lands in
 * `data.json`, not the download itself.
 */
export const MAX_BUILTIN_MCP_CATALOG_BYTES = 32 * 1024;
/** Upper bound on catalog entries, well inside {@link MAX_MCP_SERVERS}. */
export const MAX_BUILTIN_MCP_SERVERS = 16;
/** The background refresh gives up after this; the cached catalog stays. */
export const BUILTIN_MCP_CATALOG_TIMEOUT_MS = 15_000;

const CATALOG_ID = new RegExp(`^${BUILTIN_MCP_ID_PREFIX}[a-z0-9]+(?:-[a-z0-9]+)*$`);

/** One built-in server as the catalog describes it. */
export interface BuiltinMcpCatalogEntry {
	id: string;
	name: string;
	url: string;
}

/** A validated catalog snapshot. `revision` only ever grows; see the maintainer contract above. */
export interface BuiltinMcpCatalog {
	schemaVersion: 1;
	revision: number;
	servers: BuiltinMcpCatalogEntry[];
}

/** Remote data may name a host, but never downgrade to http or smuggle credentials in the URL. */
function isSecureEndpoint(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
	} catch {
		return false;
	}
}

/**
 * Validates a catalog, all or nothing.
 *
 * One bad entry rejects the whole snapshot rather than being skipped: a
 * dropped entry would read as that server's retirement, and retiring a row
 * deletes whatever the user stored in it.
 */
export function normalizeBuiltinMcpCatalog(data: unknown): BuiltinMcpCatalog | null {
	if (typeof data !== "object" || data === null) return null;
	const raw = data as Record<string, unknown>;
	const revision = raw.revision;
	if (raw.schemaVersion !== 1 || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) return null;
	if (!Array.isArray(raw.servers) || raw.servers.length > MAX_BUILTIN_MCP_SERVERS) return null;
	const servers: BuiltinMcpCatalogEntry[] = [];
	const ids = new Set<string>();
	for (const value of raw.servers as unknown[]) {
		if (typeof value !== "object" || value === null) return null;
		const entry = value as Record<string, unknown>;
		const id = typeof entry.id === "string" ? entry.id : "";
		const name = typeof entry.name === "string" ? entry.name.trim() : "";
		const url = typeof entry.url === "string" ? entry.url.trim() : "";
		if (!CATALOG_ID.test(id) || ids.has(id) || name === "" || name.length > 100) return null;
		if (url.length > 2048 || !isSecureEndpoint(url)) return null;
		ids.add(id);
		servers.push({ id, name, url });
	}
	return { schemaVersion: 1, revision, servers };
}

const bundledCatalog = normalizeBuiltinMcpCatalog(bundledCatalogJson);
if (bundledCatalog === null) {
	// Fails the test run, not a user's vault: an edit that breaks the resource
	// must never ship as a release with no built-in servers.
	throw new Error("resources/builtin-mcp.json is not a valid built-in MCP catalog.");
}
/** The catalog this build ships with — the offline seed. */
export const BUNDLED_BUILTIN_MCP_CATALOG: BuiltinMcpCatalog = bundledCatalog;

/** A catalog entry as a fresh settings row: enabled and keyless, like a new vault starts. */
export function builtinServerRow(entry: BuiltinMcpCatalogEntry): McpServerConfig {
	return { ...entry, token: "", secretRef: "", enabled: true };
}

/**
 * Reconciles stored rows with a catalog: built-ins first in catalog order,
 * then the user's own servers in theirs.
 *
 * A built-in the catalog still lists keeps its enable switch and credentials
 * and takes the catalog's name and URL; one whose URL changed keeps the
 * switch but drops its credentials, so a token entered for one host never
 * reaches another. A built-in the catalog no longer lists is removed with
 * whatever it held. At the `MAX_MCP_SERVERS` cap the built-ins give way, never
 * a user's server — the next normalize would otherwise evict one.
 */
export function ensureBuiltinMcpServers(servers: McpServerConfig[], catalog: BuiltinMcpCatalog): McpServerConfig[] {
	const stored = new Map(servers.map((server) => [server.id, server]));
	const builtins = catalog.servers.map((entry) => {
		const existing = stored.get(entry.id);
		if (!existing) return builtinServerRow(entry);
		const moved = existing.url !== entry.url;
		return { ...existing, name: entry.name, url: entry.url, ...(moved ? { token: "", secretRef: "" } : {}) };
	});
	const userServers = servers.filter((server) => !isBuiltinMcpServerId(server.id));
	return [...builtins.slice(0, Math.max(0, MAX_MCP_SERVERS - userServers.length)), ...userServers];
}

/** True when every stored built-in already sits where `catalog` would put it. */
function agreesWith(servers: McpServerConfig[], catalog: BuiltinMcpCatalog): boolean {
	const urls = new Map(catalog.servers.map((entry) => [entry.id, entry.url]));
	return servers.every((server) => !isBuiltinMcpServerId(server.id) || urls.get(server.id) === server.url);
}

/** The settings fields the catalog owns, read and written together. */
export interface BuiltinMcpState {
	servers: McpServerConfig[];
	/** The catalog the rows were last reconciled against; absent while that is unknown. */
	catalog?: BuiltinMcpCatalog;
	/** Validator for {@link catalog}, kept only alongside the catalog it describes. */
	etag?: string;
}

/**
 * Decides, at load, which catalog the stored rows are measured against.
 *
 * A cached catalog at least as new as the bundled one wins — it is the last
 * fetch — and a newer bundled one, the release outranking an older fetch,
 * takes over. The careful case is a cache that is missing or unreadable:
 * releases from before the catalog rebuild settings without it, so a vault
 * synced through one can hold rows a newer catalog already moved, and
 * reconciling them with the bundled copy would move them back and strip the
 * key the user entered at the new endpoint. The bundled catalog is adopted
 * only when the rows already agree with it; otherwise they stay as they are
 * until the next fetch settles them.
 */
export function loadBuiltinMcpState(servers: McpServerConfig[], cachedCatalog: unknown, cachedEtag: unknown): BuiltinMcpState {
	const cached = normalizeBuiltinMcpCatalog(cachedCatalog);
	if (cached && cached.revision >= BUNDLED_BUILTIN_MCP_CATALOG.revision) {
		const etag = typeof cachedEtag === "string" && cachedEtag !== "" ? cachedEtag : undefined;
		return { servers: ensureBuiltinMcpServers(servers, cached), catalog: cached, ...(etag ? { etag } : {}) };
	}
	if (cached || agreesWith(servers, BUNDLED_BUILTIN_MCP_CATALOG)) {
		return { servers: ensureBuiltinMcpServers(servers, BUNDLED_BUILTIN_MCP_CATALOG), catalog: BUNDLED_BUILTIN_MCP_CATALOG };
	}
	return { servers };
}

export type BuiltinMcpCatalogFetchResult =
	| { status: "not-modified"; etag?: string }
	| { status: "updated"; catalog: BuiltinMcpCatalog; etag?: string };

/** What a fetch changed: the new state, and whether any server row differs from before. */
export interface BuiltinMcpCatalogUpdate {
	state: BuiltinMcpState;
	serversChanged: boolean;
}

/**
 * Decides what a fetch result changes, or `null` for nothing.
 *
 * Only a catalog *older* than the cached one is ignored — that is a stale CDN
 * edge, and following it would move rows backwards. Anything else that
 * differs is applied, including an edit published without a revision bump:
 * ignoring it would leave every client on the old content until the next
 * release, with nothing anywhere saying so.
 */
export function decideBuiltinMcpCatalogUpdate(state: BuiltinMcpState, result: BuiltinMcpCatalogFetchResult): BuiltinMcpCatalogUpdate | null {
	if (result.status === "not-modified") {
		if (!state.catalog || result.etag === undefined || result.etag === state.etag) return null;
		return { state: { ...state, etag: result.etag }, serversChanged: false };
	}
	const { catalog, etag } = result;
	if (state.catalog && catalog.revision < state.catalog.revision) return null;
	if (state.catalog && JSON.stringify(catalog) === JSON.stringify(state.catalog)) {
		return etag === state.etag ? null : { state: { ...state, etag }, serversChanged: false };
	}
	const servers = ensureBuiltinMcpServers(state.servers, catalog);
	return { state: { servers, catalog, etag }, serversChanged: JSON.stringify(servers) !== JSON.stringify(state.servers) };
}

/** Fetches one validated catalog snapshot; applying it is {@link decideBuiltinMcpCatalogUpdate}'s job. */
export async function fetchBuiltinMcpCatalog(options: { fetch: FetchFn; etag?: string; signal?: AbortSignal }): Promise<BuiltinMcpCatalogFetchResult> {
	const headers: Record<string, string> = { accept: "application/json" };
	if (options.etag) headers["if-none-match"] = options.etag;
	const response = await options.fetch(BUILTIN_MCP_CATALOG_URL, { method: "GET", headers, signal: options.signal });
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

/**
 * One background refresh: fetch, decide, and hand any change to `persist`.
 *
 * Never throws — a failed refresh leaves the current catalog in place, and the
 * reason goes to the log. Aborting `signal` (the plugin unloading) ends the
 * refresh silently, because unloading is not a failure. The timeout is one,
 * and says so; the two are told apart by which signal fired.
 */
export async function refreshBuiltinMcpCatalog(options: {
	fetch: FetchFn;
	read(): BuiltinMcpState;
	persist(update: BuiltinMcpCatalogUpdate): Promise<void>;
	logger: LoggerLike;
	signal: AbortSignal;
	timeoutMs?: number;
}): Promise<void> {
	const { signal, logger } = options;
	if (signal.aborted) return;
	const request = new AbortController();
	const forwardAbort = (): void => request.abort(signal.reason);
	signal.addEventListener("abort", forwardAbort, { once: true });
	const timer = window.setTimeout(
		() => request.abort(new Error("Built-in MCP catalog refresh timed out.")),
		options.timeoutMs ?? BUILTIN_MCP_CATALOG_TIMEOUT_MS,
	);
	let fetched = false;
	try {
		const result = await fetchBuiltinMcpCatalog({ fetch: options.fetch, etag: options.read().etag, signal: request.signal });
		fetched = true;
		window.clearTimeout(timer);
		if (signal.aborted) return;
		// Read again: a row the user toggled while the request was out must survive the apply.
		const update = decideBuiltinMcpCatalogUpdate(options.read(), result);
		if (update) await options.persist(update);
	} catch (error) {
		if (signal.aborted) return;
		// The transport rejects a timed-out request with a bare abort; name it from the signal that fired.
		const reason: unknown = !fetched && request.signal.aborted ? request.signal.reason : error;
		logger.warn("Built-in MCP catalog refresh failed", () => ({ error: reason instanceof Error ? reason.message : String(reason) }));
	} finally {
		window.clearTimeout(timer);
		signal.removeEventListener("abort", forwardAbort);
	}
}
