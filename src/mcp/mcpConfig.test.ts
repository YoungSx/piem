import { describe, expect, it } from "bun:test";
import {
	type McpServerConfig,
	BUILTIN_MCP_SERVER_ID,
	builtinExaServer,
	createMcpServerConfig,
	normalizeMcpServer,
	normalizeMcpServers,
	slugifyServerName,
	MAX_MCP_SERVERS,
	ensureBuiltinMcpServer,
} from "./mcpConfig";

describe("slugifyServerName", () => {
	it("collapses punctuation and case into one identifier", () => {
		expect(slugifyServerName("GitHub API v2!")).toBe("github_api_v2");
	});

	it("falls back to a generic slug for symbol-only names", () => {
		expect(slugifyServerName("🎉___🎉")).toBe("server");
		expect(slugifyServerName("")).toBe("server");
	});

	it("trims leading and trailing underscores", () => {
		expect(slugifyServerName("--notes-db--")).toBe("notes_db");
	});
});

describe("normalizeMcpServer", () => {
	it("fills defaults and trims fields", () => {
		const server = normalizeMcpServer({ id: "a", name: "  Notes  ", url: " https://mcp.example.com ", token: " t " });
		expect(server).toEqual({ id: "a", name: "Notes", url: "https://mcp.example.com", token: " t ", secretRef: "", enabled: true });
	});

	it("passes a sealed token through untouched", () => {
		const sealed = "enc:v1:abcdef";
		const server = normalizeMcpServer({ id: "a", url: "https://m.example.com", token: sealed });
		expect(server?.token).toBe(sealed);
	});

	it("falls back to the URL as the name", () => {
		const server = normalizeMcpServer({ id: "a", url: "https://m.example.com" });
		expect(server?.name).toBe("https://m.example.com");
	});

	it("drops entries without an id", () => {
		expect(normalizeMcpServer({ url: "https://m.example.com" })).toBeNull();
		expect(normalizeMcpServer({ id: "", url: "https://m.example.com" })).toBeNull();
	});

	it("drops entries without a usable http(s) URL", () => {
		expect(normalizeMcpServer({ id: "a", url: "not a url" })).toBeNull();
		expect(normalizeMcpServer({ id: "a", url: "ftp://m.example.com" })).toBeNull();
		expect(normalizeMcpServer({ id: "a" })).toBeNull();
	});

	it("treats enabled as true unless explicitly false", () => {
		expect(normalizeMcpServer({ id: "a", url: "https://m.example.com" })?.enabled).toBe(true);
		expect(normalizeMcpServer({ id: "a", url: "https://m.example.com", enabled: false })?.enabled).toBe(false);
		expect(normalizeMcpServer({ id: "a", url: "https://m.example.com", enabled: "no" })?.enabled).toBe(true);
	});
});

describe("normalizeMcpServers", () => {
	it("returns an empty array for non-array input", () => {
		expect(normalizeMcpServers(undefined)).toEqual([]);
		expect(normalizeMcpServers({})).toEqual([]);
		expect(normalizeMcpServers("nope")).toEqual([]);
	});

	it("drops bad entries but keeps good ones in order", () => {
		const servers = normalizeMcpServers([
			{ id: "a", url: "https://a.example.com" },
			"garbage",
			{ id: "b", url: "nope" },
			{ id: "c", url: "https://c.example.com", enabled: false },
		]);
		expect(servers.map((s) => s.id)).toEqual(["a", "c"]);
	});

	it("caps the list so a corrupted file cannot balloon memory", () => {
		const many = Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, url: `https://s${i}.example.com` }));
		expect(normalizeMcpServers(many)).toHaveLength(32);
	});
});

describe("createMcpServerConfig", () => {
	it("generates a fresh id per call", () => {
		const a = createMcpServerConfig({ url: "https://m.example.com" });
		const b = createMcpServerConfig({ url: "https://m.example.com" });
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		expect(a!.id).not.toBe(b!.id);
		expect(a!.enabled).toBe(true);
	});

	it("keeps the id handed to it", () => {
		const server = createMcpServerConfig({ id: "fixed", url: "https://m.example.com" });
		expect(server!.id).toBe("fixed");
	});

	it("refuses an unusable URL instead of inventing a server", () => {
		expect(createMcpServerConfig({ url: "nope" })).toBeNull();
	});
});


describe("ensureBuiltinMcpServer", () => {
	const user = (): McpServerConfig => ({ id: "srv-1", name: "Hub", url: "https://x.example.com", token: "", secretRef: "", enabled: true });

	it("seeds the bundled Exa row first on every load", () => {
		const servers = ensureBuiltinMcpServer([]);
		expect(servers).toHaveLength(1);
		expect(servers[0]).toMatchObject({ id: BUILTIN_MCP_SERVER_ID, name: "Exa", url: "https://mcp.exa.ai/mcp", token: "", enabled: true });
	});

	it("leaves the stored builtin copy alone instead of resetting it", () => {
		const stored = { ...builtinExaServer(), enabled: false, token: "user-key" };
		expect(ensureBuiltinMcpServer([stored, user()])).toEqual([stored, user()]);
	});

	it("reappears when a hand-edited data.json removed it", () => {
		const servers = ensureBuiltinMcpServer([user()]);
		expect(servers[0]?.id).toBe(BUILTIN_MCP_SERVER_ID);
	});

	it("skips seeding at the cap, where prepending would evict a real server on the next normalize", () => {
		const many: McpServerConfig[] = Array.from({ length: MAX_MCP_SERVERS }, (_, i) => ({ id: `s${i}`, name: `s${i}`, url: `https://s${i}.example.com`, token: "", secretRef: "", enabled: true }));
		expect(ensureBuiltinMcpServer(many)).toHaveLength(MAX_MCP_SERVERS);
	});
});

describe("ensureBuiltinMcpServer", () => {
	const user = (): McpServerConfig => ({ id: "srv-1", name: "Hub", url: "https://x.example.com", token: "", secretRef: "", enabled: true });

	it("seeds the bundled Exa row first on every load", () => {
		const servers = ensureBuiltinMcpServer([]);
		expect(servers).toHaveLength(1);
		expect(servers[0]).toMatchObject({ id: BUILTIN_MCP_SERVER_ID, name: "Exa", url: "https://mcp.exa.ai/mcp", token: "", enabled: true });
	});

	it("leaves the stored builtin copy alone instead of resetting it", () => {
		const stored = { ...builtinExaServer(), enabled: false, token: "user-key" };
		expect(ensureBuiltinMcpServer([stored, user()])).toEqual([stored, user()]);
	});

	it("reappears when a hand-edited data.json removed it", () => {
		const servers = ensureBuiltinMcpServer([user()]);
		expect(servers[0]?.id).toBe(BUILTIN_MCP_SERVER_ID);
	});

	it("skips seeding at the cap, where prepending would evict a real server on the next normalize", () => {
		const many: McpServerConfig[] = Array.from({ length: MAX_MCP_SERVERS }, (_, i) => ({ id: `s${i}`, name: `s${i}`, url: `https://s${i}.example.com`, token: "", secretRef: "", enabled: true }));
		expect(ensureBuiltinMcpServer(many)).toHaveLength(MAX_MCP_SERVERS);
	});
});
