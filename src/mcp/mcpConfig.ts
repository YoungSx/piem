/**
 * Configuration shape for MCP servers, plus the normalizers used at the
 * settings seam. Built-in entries are controlled by the project catalog,
 * while credentials and enable switches remain local settings.
 */

import builtinMcpCatalogJson from "../../resources/builtin-mcp.json";
import { isValidSecretId } from "../keychain";

export interface McpServerConfig {
	id: string;
	name: string;
	url: string;
	token: string;
	secretRef: string;
	enabled: boolean;
}

export const MAX_MCP_SERVERS = 32;
export const MAX_BUILTIN_MCP_SERVERS = 16;
export const MAX_BUILTIN_MCP_CATALOG_BYTES = 32 * 1024;
export const BUILTIN_MCP_CATALOG_URL = "https://raw.githubusercontent.com/YoungSx/piem/master/resources/builtin-mcp.json";

export interface BuiltinMcpCatalogEntry {
	id: string;
	name: string;
	url: string;
}

export interface BuiltinMcpCatalog {
	schemaVersion: 1;
	revision: number;
	servers: BuiltinMcpCatalogEntry[];
}

function isHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function isBuiltinId(value: string): boolean {
	return /^builtin-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

/** Catalog data is validated both at build time and when fetched from GitHub. */
export function normalizeBuiltinMcpCatalog(data: unknown): BuiltinMcpCatalog | null {
	if (typeof data !== "object" || data === null) return null;
	const raw = data as Record<string, unknown>;
	if (raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0 || !Array.isArray(raw.servers)) return null;
	if (raw.servers.length > MAX_BUILTIN_MCP_SERVERS) return null;
	const servers: BuiltinMcpCatalogEntry[] = [];
	const ids = new Set<string>();
	for (const value of raw.servers) {
		if (typeof value !== "object" || value === null) return null;
		const entry = value as Record<string, unknown>;
		const id = typeof entry.id === "string" ? entry.id : "";
		const name = typeof entry.name === "string" ? entry.name.trim() : "";
		const url = typeof entry.url === "string" ? entry.url.trim() : "";
		if (!isBuiltinId(id) || ids.has(id) || name === "" || name.length > 100 || url.length > 2048 || !isHttpUrl(url)) return null;
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return null;
		} catch {
			return null;
		}
		ids.add(id);
		servers.push({ id, name, url });
	}
	return { schemaVersion: 1, revision: raw.revision as number, servers };
}

const parsedBuiltinMcpCatalog = normalizeBuiltinMcpCatalog(builtinMcpCatalogJson);
if (parsedBuiltinMcpCatalog === null) {
	throw new Error("The bundled MCP catalog is invalid.");
}
export const DEFAULT_BUILTIN_MCP_CATALOG: BuiltinMcpCatalog = parsedBuiltinMcpCatalog;

export const BUILTIN_MCP_SERVER_ID = "builtin-exa";
export const BUILTIN_SEARXNG_SERVER_ID = "builtin-searxng";

export function isBuiltinMcpServerId(id: string): boolean {
	return id.startsWith("builtin-");
}

export function builtinExaServer(): McpServerConfig {
	return builtinServer(BUILTIN_MCP_SERVER_ID);
}

export function builtinSearxngServer(): McpServerConfig {
	return builtinServer(BUILTIN_SEARXNG_SERVER_ID);
}

function builtinServer(id: string): McpServerConfig {
	const entry = DEFAULT_BUILTIN_MCP_CATALOG.servers.find((server) => server.id === id);
	if (!entry) throw new Error(`Missing bundled MCP server: ${id}`);
	return { ...entry, token: "", secretRef: "", enabled: true };
}

/**
 * Merges catalog entries into local settings. Existing enable switches survive;
 * changing a URL drops credentials so they cannot reach the replacement host.
 */
export function ensureBuiltinMcpServers(servers: McpServerConfig[], catalog: BuiltinMcpCatalog = DEFAULT_BUILTIN_MCP_CATALOG): McpServerConfig[] {
	const local = new Map(servers.map((server) => [server.id, server]));
	const builtins: McpServerConfig[] = [];
	for (const entry of catalog.servers) {
		const existing = local.get(entry.id);
		const changed = existing !== undefined && existing.url !== entry.url;
		const server = existing
			? { ...existing, name: entry.name, url: entry.url, ...(changed ? { token: "", secretRef: "" } : {}) }
			: { ...entry, token: "", secretRef: "", enabled: true };
		builtins.push(server);
		local.delete(entry.id);
	}
	const userServers = Array.from(local.values()).filter((server) => !isBuiltinMcpServerId(server.id));
	return [...builtins.slice(0, Math.max(0, MAX_MCP_SERVERS - userServers.length)), ...userServers];
}

export function slugifyServerName(name: string): string {
	const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	return slug === "" ? "server" : slug;
}

export function createMcpServerConfig(partial: Partial<McpServerConfig> = {}): McpServerConfig | null {
	return normalizeMcpServer({ id: generateMcpServerId(), ...partial });
}

export function generateMcpServerId(): string {
	return `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeMcpServer(data: unknown): McpServerConfig | null {
	if (typeof data !== "object" || data === null) return null;
	const raw = data as Record<string, unknown>;
	const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : null;
	if (id === null) return null;
	const url = typeof raw.url === "string" ? raw.url.trim() : "";
	if (!isHttpUrl(url)) return null;
	const name = typeof raw.name === "string" ? raw.name.trim() : "";
	const secretRef = typeof raw.secretRef === "string" ? raw.secretRef.trim() : "";
	return {
		id,
		name: name === "" ? url : name,
		url,
		token: typeof raw.token === "string" ? raw.token : "",
		secretRef: isValidSecretId(secretRef) ? secretRef : "",
		enabled: raw.enabled !== false,
	};
}

export function normalizeMcpServers(data: unknown): McpServerConfig[] {
	if (!Array.isArray(data)) return [];
	const servers: McpServerConfig[] = [];
	for (const entry of data) {
		const server = normalizeMcpServer(entry);
		if (server !== null) servers.push(server);
		if (servers.length >= MAX_MCP_SERVERS) break;
	}
	return servers;
}
