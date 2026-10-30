import { afterAll, describe, expect, it } from "bun:test";
import type { FetchFn } from "../net/obsidianFetch";
import { spyLogger } from "../testUtils/logSpy";
import { stubWindowTimers } from "../testUtils/windowStub";
import { MAX_MCP_SERVERS, type McpServerConfig } from "./mcpConfig";
import {
	BUNDLED_BUILTIN_MCP_CATALOG,
	MAX_BUILTIN_MCP_CATALOG_BYTES,
	builtinServerRow,
	decideBuiltinMcpCatalogUpdate,
	ensureBuiltinMcpServers,
	fetchBuiltinMcpCatalog,
	loadBuiltinMcpState,
	normalizeBuiltinMcpCatalog,
	refreshBuiltinMcpCatalog,
	type BuiltinMcpCatalog,
	type BuiltinMcpCatalogUpdate,
	type BuiltinMcpState,
} from "./builtinMcpCatalog";

// The refresh arms `window.setTimeout` for its timeout; these tests run without a DOM.
const restoreWindowTimers = stubWindowTimers();
afterAll(() => restoreWindowTimers());

const HOME = "https://mcp.example.com/mcp";
const MOVED = "https://moved.example.com/mcp";

function catalog(revision: number, servers: Array<[id: string, url: string]> = [["builtin-search", HOME]]): BuiltinMcpCatalog {
	return { schemaVersion: 1, revision, servers: servers.map(([id, url]) => ({ id, name: id, url })) };
}

function row(id: string, url: string, extra: Partial<McpServerConfig> = {}): McpServerConfig {
	return { id, name: id, url, token: "", secretRef: "", enabled: true, ...extra };
}

const bundledRows = (): McpServerConfig[] => BUNDLED_BUILTIN_MCP_CATALOG.servers.map(builtinServerRow);
const respond = (body: unknown, init: ResponseInit = {}): Response => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, ...init });

describe("normalizeBuiltinMcpCatalog", () => {
	it("accepts the bundled resource", () => {
		expect(BUNDLED_BUILTIN_MCP_CATALOG.servers.length).toBeGreaterThan(0);
		expect(normalizeBuiltinMcpCatalog(structuredClone(BUNDLED_BUILTIN_MCP_CATALOG))).toEqual(BUNDLED_BUILTIN_MCP_CATALOG);
	});

	it("rejects the whole catalog for one unsafe entry instead of skipping it", () => {
		// A skipped entry would read as that server's retirement, deleting what the user stored in it.
		const good = { id: "builtin-good", name: "Good", url: HOME };
		for (const bad of [
			{ id: "builtin-plain", name: "Plain", url: "http://mcp.example.com/mcp" },
			{ id: "builtin-creds", name: "Creds", url: "https://user:pass@mcp.example.com/mcp" },
			{ id: "user-server", name: "Not ours", url: HOME },
			{ id: "builtin-good", name: "Duplicate", url: MOVED },
			{ id: "builtin-blank", name: "  ", url: HOME },
		]) {
			expect(normalizeBuiltinMcpCatalog({ schemaVersion: 1, revision: 2, servers: [good, bad] })).toBeNull();
		}
	});

	it("rejects an unknown schema and a revision that cannot be ordered", () => {
		expect(normalizeBuiltinMcpCatalog({ ...catalog(2), schemaVersion: 2 })).toBeNull();
		for (const revision of [-1, 1.5, "2"]) {
			expect(normalizeBuiltinMcpCatalog({ ...catalog(2), revision })).toBeNull();
		}
	});
});

describe("ensureBuiltinMcpServers", () => {
	it("keeps a built-in's switch and credentials while its endpoint stays, taking the catalog's name", () => {
		const stored = row("builtin-search", HOME, { name: "Old name", token: "key", secretRef: "kc-1", enabled: false });
		expect(ensureBuiltinMcpServers([stored, row("custom", MOVED)], catalog(2))).toEqual([
			{ ...stored, name: "builtin-search" },
			row("custom", MOVED),
		]);
	});

	it("drops credentials when the catalog moves an endpoint, keeping the switch", () => {
		const stored = row("builtin-search", MOVED, { token: "key", secretRef: "kc-1", enabled: false });
		expect(ensureBuiltinMcpServers([stored], catalog(2))).toEqual([row("builtin-search", HOME, { enabled: false })]);
	});

	it("seeds new built-ins enabled and removes retired ones, leaving user rows alone", () => {
		const servers = ensureBuiltinMcpServers(
			[row("builtin-retired", MOVED, { token: "gone" }), row("custom", MOVED)],
			catalog(2, [["builtin-search", HOME], ["builtin-new", MOVED]]),
		);
		expect(servers).toEqual([row("builtin-search", HOME), row("builtin-new", MOVED), row("custom", MOVED)]);
	});

	it("never evicts a user's server to make room for a built-in", () => {
		const users = Array.from({ length: MAX_MCP_SERVERS }, (_, i) => row(`user-${i}`, `https://u${i}.example.com/mcp`));
		expect(ensureBuiltinMcpServers(users, catalog(2))).toEqual(users);
	});
});

describe("loadBuiltinMcpState", () => {
	it("seeds a fresh vault from the bundled catalog", () => {
		expect(loadBuiltinMcpState([], undefined, undefined)).toEqual({ servers: bundledRows(), catalog: BUNDLED_BUILTIN_MCP_CATALOG });
	});

	it("keeps a cache at least as new as the bundled catalog, with its validator", () => {
		const cached = catalog(BUNDLED_BUILTIN_MCP_CATALOG.revision + 1, [["builtin-search", MOVED]]);
		expect(loadBuiltinMcpState([row("builtin-search", MOVED, { token: "key" })], cached, '"v9"')).toEqual({
			servers: [row("builtin-search", MOVED, { token: "key" })],
			catalog: cached,
			etag: '"v9"',
		});
	});

	it("lets a newer bundled catalog outrank an older cache, dropping the cache's validator", () => {
		const older = { ...BUNDLED_BUILTIN_MCP_CATALOG, revision: BUNDLED_BUILTIN_MCP_CATALOG.revision - 1, servers: [] };
		expect(loadBuiltinMcpState([], older, '"old"')).toEqual({ servers: bundledRows(), catalog: BUNDLED_BUILTIN_MCP_CATALOG });
	});

	it("leaves rows alone when the cache is missing and they disagree with the bundled catalog", () => {
		// A release from before the catalog rewrites data.json without it; these rows may
		// already sit where a newer catalog put them, so measuring them against the
		// bundled copy would move them back and strip the key the user entered there.
		const bundledId = BUNDLED_BUILTIN_MCP_CATALOG.servers[0]!.id;
		const moved = [row(bundledId, MOVED, { token: "user-key" })];
		expect(loadBuiltinMcpState(moved, undefined, '"stale"')).toEqual({ servers: moved });
		expect(loadBuiltinMcpState(moved, { schemaVersion: 99 }, '"stale"')).toEqual({ servers: moved });
	});

	it("adopts the bundled catalog when the rows already agree with it", () => {
		const first = BUNDLED_BUILTIN_MCP_CATALOG.servers[0]!;
		const stored = { ...builtinServerRow(first), token: "user-key", enabled: false };
		const state = loadBuiltinMcpState([stored], undefined, undefined);
		expect(state.catalog).toBe(BUNDLED_BUILTIN_MCP_CATALOG);
		expect(state.servers).toEqual([stored, ...bundledRows().slice(1)]);
	});
});

describe("decideBuiltinMcpCatalogUpdate", () => {
	const v2 = catalog(2);
	const state: BuiltinMcpState = { servers: [row("builtin-search", HOME, { token: "key" })], catalog: v2, etag: '"v2"' };

	it("ignores a catalog older than the cached one — a stale CDN edge", () => {
		expect(decideBuiltinMcpCatalogUpdate(state, { status: "updated", catalog: catalog(1, [["builtin-search", MOVED]]), etag: '"v1"' })).toBeNull();
	});

	it("applies an edit published without a revision bump", () => {
		const edited = catalog(2, [["builtin-search", MOVED]]);
		expect(decideBuiltinMcpCatalogUpdate(state, { status: "updated", catalog: edited, etag: '"v2b"' })).toEqual({
			state: { servers: [row("builtin-search", MOVED)], catalog: edited, etag: '"v2b"' },
			serversChanged: true,
		});
	});

	it("records only the validator when the content is unchanged", () => {
		expect(decideBuiltinMcpCatalogUpdate(state, { status: "updated", catalog: catalog(2), etag: '"v2-rehash"' })).toEqual({
			state: { ...state, etag: '"v2-rehash"' },
			serversChanged: false,
		});
		expect(decideBuiltinMcpCatalogUpdate(state, { status: "updated", catalog: catalog(2), etag: '"v2"' })).toBeNull();
	});

	it("says rows did not change when a new revision leaves every row where it was", () => {
		// The flag decides whether a live agent is reconfigured; a bump alone must not.
		expect(decideBuiltinMcpCatalogUpdate(state, { status: "updated", catalog: catalog(3), etag: '"v3"' })).toEqual({
			state: { servers: state.servers, catalog: catalog(3), etag: '"v3"' },
			serversChanged: false,
		});
	});

	it("changes nothing on 304 unless the validator rotated", () => {
		expect(decideBuiltinMcpCatalogUpdate(state, { status: "not-modified", etag: '"v2"' })).toBeNull();
		expect(decideBuiltinMcpCatalogUpdate(state, { status: "not-modified", etag: '"v2-new"' })).toEqual({ state: { ...state, etag: '"v2-new"' }, serversChanged: false });
	});

	it("reconciles rows whose catalog was unknown, keeping a key already at the fetched endpoint", () => {
		const fetched = catalog(2, [["builtin-search", MOVED], ["builtin-new", HOME]]);
		const unknown: BuiltinMcpState = { servers: [row("builtin-search", MOVED, { token: "user-key" })] };
		expect(decideBuiltinMcpCatalogUpdate(unknown, { status: "updated", catalog: fetched, etag: '"v2"' })).toEqual({
			state: { servers: [row("builtin-search", MOVED, { token: "user-key" }), row("builtin-new", HOME)], catalog: fetched, etag: '"v2"' },
			serversChanged: true,
		});
	});
});

describe("fetchBuiltinMcpCatalog", () => {
	it("asks conditionally and returns a validated snapshot with its validator", async () => {
		let init: RequestInit | undefined;
		const fetch: FetchFn = async (_input, requestInit) => {
			init = requestInit;
			return respond(catalog(2), { headers: { etag: '"v2"' } });
		};
		expect(await fetchBuiltinMcpCatalog({ fetch, etag: '"v1"' })).toEqual({ status: "updated", catalog: catalog(2), etag: '"v2"' });
		expect(init?.method).toBe("GET");
		expect(new Headers(init?.headers).get("if-none-match")).toBe('"v1"');
	});

	it("reports 304 as not modified, keeping the validator it sent", async () => {
		const fetch: FetchFn = async () => new Response(null, { status: 304 });
		expect(await fetchBuiltinMcpCatalog({ fetch, etag: '"v1"' })).toEqual({ status: "not-modified", etag: '"v1"' });
	});

	it("rejects an error status, a non-JSON body and a catalog that fails validation", async () => {
		await expect(fetchBuiltinMcpCatalog({ fetch: async () => new Response("", { status: 404 }) })).rejects.toThrow("answered 404");
		await expect(fetchBuiltinMcpCatalog({ fetch: async () => respond("{nope") })).rejects.toThrow("not valid JSON");
		await expect(fetchBuiltinMcpCatalog({ fetch: async () => respond({ ...catalog(2), schemaVersion: 2 }) })).rejects.toThrow("failed validation");
	});

	it("rejects an oversized body even when the catalog in it is valid", async () => {
		const body = JSON.stringify(catalog(2)).padEnd(MAX_BUILTIN_MCP_CATALOG_BYTES + 1, " ");
		expect(normalizeBuiltinMcpCatalog(JSON.parse(body))).not.toBeNull();
		await expect(fetchBuiltinMcpCatalog({ fetch: async () => respond(body) })).rejects.toThrow("too large");
	});
});

describe("refreshBuiltinMcpCatalog", () => {
	// What the requestUrl transport rejects with when its signal fires: a bare abort, no reason.
	const abortError = (): DOMException => new DOMException("The operation was aborted.", "AbortError");

	function harness(fetch: FetchFn, options: { controller?: AbortController; timeoutMs?: number } = {}) {
		const holder: { state: BuiltinMcpState } = { state: { servers: [row("builtin-search", HOME, { token: "key" })], catalog: catalog(2), etag: '"v2"' } };
		const { logger, records } = spyLogger();
		const persisted: BuiltinMcpCatalogUpdate[] = [];
		const run = refreshBuiltinMcpCatalog({
			fetch,
			read: () => holder.state,
			persist: async (update) => void persisted.push(update),
			logger,
			signal: (options.controller ?? new AbortController()).signal,
			timeoutMs: options.timeoutMs,
		});
		return { holder, records, persisted, run };
	}

	it("persists a newer catalog and says rows changed", async () => {
		const { persisted, records, run } = harness(async () => respond(catalog(3, [["builtin-search", MOVED]]), { headers: { etag: '"v3"' } }));
		await run;
		expect(persisted).toEqual([{ state: { servers: [row("builtin-search", MOVED)], catalog: catalog(3, [["builtin-search", MOVED]]), etag: '"v3"' }, serversChanged: true }]);
		expect(records).toEqual([]);
	});

	it("persists nothing on 304", async () => {
		const { persisted, run } = harness(async () => new Response(null, { status: 304, headers: { etag: '"v2"' } }));
		await run;
		expect(persisted).toEqual([]);
	});

	it("logs a hung request as a timeout instead of passing it off as an unload", async () => {
		const hung: FetchFn = (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(abortError())));
		const { persisted, records, run } = harness(hung, { timeoutMs: 5 });
		await run;
		expect(persisted).toEqual([]);
		expect(records).toEqual([{ level: "warn", message: "Built-in MCP catalog refresh failed", detail: { error: "Built-in MCP catalog refresh timed out." } }]);
	});

	it("logs a transport failure with its own message", async () => {
		const { records, run } = harness(async () => {
			throw new TypeError("net::ERR_NAME_NOT_RESOLVED");
		});
		await run;
		expect(records.map((record) => record.detail)).toEqual([{ error: "net::ERR_NAME_NOT_RESOLVED" }]);
	});

	it("ends silently when the owner aborts a request in flight", async () => {
		const controller = new AbortController();
		const hung: FetchFn = (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(abortError())));
		const { persisted, records, run } = harness(hung, { controller });
		controller.abort();
		await run;
		expect(persisted).toEqual([]);
		expect(records).toEqual([]);
	});

	it("ends silently when the owner aborts, even if a response lands afterwards", async () => {
		const controller = new AbortController();
		let release!: () => void;
		const late = new Promise<void>((resolve) => (release = resolve));
		const { persisted, records, run } = harness(async () => {
			await late;
			return respond(catalog(3, [["builtin-search", MOVED]]));
		}, { controller });
		controller.abort();
		release();
		await run;
		expect(persisted).toEqual([]);
		expect(records).toEqual([]);
	});

	it("never fetches for an owner that already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		let fetched = false;
		await harness(async () => {
			fetched = true;
			return respond(catalog(3));
		}, { controller }).run;
		expect(fetched).toBe(false);
	});

	it("applies against the rows as they are when the response lands", async () => {
		let release!: () => void;
		const late = new Promise<void>((resolve) => (release = resolve));
		const { holder, persisted, run } = harness(async () => {
			await late;
			return respond(catalog(3, [["builtin-search", MOVED]]));
		});
		holder.state = { ...holder.state, servers: [row("builtin-search", HOME, { token: "key", enabled: false })] };
		release();
		await run;
		expect(persisted[0]?.state.servers).toEqual([row("builtin-search", MOVED, { enabled: false })]);
	});
});
