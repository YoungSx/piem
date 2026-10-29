import { describe, expect, it } from "bun:test";
import { installObsidianStub } from "../testUtils/obsidianStub";
import type { FetchFn } from "../net/obsidianFetch";
import {
	DEFAULT_BUILTIN_MCP_CATALOG,
	ensureBuiltinMcpServers,
	MAX_MCP_SERVERS,
	type BuiltinMcpCatalog,
	type McpServerConfig,
} from "./mcpConfig";

installObsidianStub();

const { fetchBuiltinMcpCatalog } = await import("./builtinMcpCatalog");

function catalog(revision: number, url = "https://mcp.example.com/mcp"): BuiltinMcpCatalog {
	return { schemaVersion: 1, revision, servers: [{ id: "builtin-search", name: "Search", url }] };
}

function userServer(id: string): McpServerConfig {
	return { id, name: id, url: `https://${id}.example.com/mcp`, token: "", secretRef: "", enabled: true };
}

describe("builtin MCP catalog reconciliation", () => {
	it("preserves a built-in enable switch and token while its endpoint stays put", () => {
		const existing: McpServerConfig = {
			id: "builtin-search", name: "Old name", url: "https://mcp.example.com/mcp",
			token: "saved-token", secretRef: "", enabled: false,
		};
		expect(ensureBuiltinMcpServers([existing, userServer("custom")], catalog(2))).toEqual([
			{ ...existing, name: "Search" },
			userServer("custom"),
		]);
	});

	it("drops credentials when a catalog moves a built-in endpoint", () => {
		const existing: McpServerConfig = {
			id: "builtin-search", name: "Search", url: "https://old.example.com/mcp",
			token: "old-token", secretRef: "old-key", enabled: true,
		};
		expect(ensureBuiltinMcpServers([existing], catalog(2)).at(0)).toEqual({
			id: "builtin-search", name: "Search", url: "https://mcp.example.com/mcp",
			token: "", secretRef: "", enabled: true,
		});
	});

	it("removes retired built-ins without changing user servers", () => {
		const servers = ensureBuiltinMcpServers([
			{ id: "builtin-retired", name: "Retired", url: "https://retired.example.com", token: "", secretRef: "", enabled: false },
			userServer("custom"),
		], catalog(2));
		expect(servers.map((server) => server.id)).toEqual(["builtin-search", "custom"]);
	});

	it("keeps every user row when the local server cap is full", () => {
		const users = Array.from({ length: MAX_MCP_SERVERS }, (_, index) => userServer(`user-${index}`));
		expect(ensureBuiltinMcpServers(users, DEFAULT_BUILTIN_MCP_CATALOG)).toEqual(users);
	});
});

describe("fetchBuiltinMcpCatalog", () => {
	it("requests JSON conditionally and returns a validated snapshot", async () => {
		let request: RequestInit | undefined;
		const fetch: FetchFn = async (_input, init) => {
			request = init;
			return new Response(JSON.stringify(catalog(2)), { status: 200, headers: { etag: "\"rev-2\"" } });
		};
		const result = await fetchBuiltinMcpCatalog({ fetch, etag: "\"rev-1\"" });
		expect(request?.method).toBe("GET");
		expect(new Headers(request?.headers).get("if-none-match")).toBe("\"rev-1\"");
		expect(result).toEqual({ status: "updated", catalog: catalog(2), etag: "\"rev-2\"" });
	});

	it("keeps the cached entry on 304", async () => {
		const fetch: FetchFn = async () => new Response(null, { status: 304, headers: { etag: "\"rev-1\"" } });
		expect(await fetchBuiltinMcpCatalog({ fetch, etag: "\"rev-1\"" })).toEqual({ status: "not-modified", etag: "\"rev-1\"" });
	});

	it("rejects malformed, insecure, and oversized snapshots", async () => {
		const invalid = [
			JSON.stringify({ ...catalog(2), schemaVersion: 2 }),
			JSON.stringify(catalog(2, "http://mcp.example.com/mcp")),
			"x".repeat(33 * 1024),
		];
		for (const body of invalid) {
			const fetch: FetchFn = async () => new Response(body, { status: 200 });
			await expect(fetchBuiltinMcpCatalog({ fetch })).rejects.toThrow();
		}
	});
});
