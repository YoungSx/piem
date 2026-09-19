/**
 * Configuration shape for MCP servers, plus the degradation-not-throw
 * normalizer every persisted settings field goes through.
 *
 * A server is a Streamable HTTP endpoint and an optional bearer token. Only
 * remote servers are supported: stdio would mean launching a child process from
 * a renderer — off-limits on mobile, where this plugin is first-class.
 *
 * `token` follows the same lifecycle as provider API keys: plaintext in memory,
 * but on disk the field is `""` whenever {@link secretRef} names a keychain
 * entry — the token itself lives in the keychain and `data.json` holds only the
 * reference.
 */

import { isValidSecretId } from "../keychain";

/** One configured MCP server. */
export interface McpServerConfig {
	/** Stable identity across renames; generated once at creation. */
	id: string;
	/** Display name, also the source of the tool-name prefix. */
	name: string;
	/** Absolute http(s) URL of the MCP Streamable HTTP endpoint. */
	url: string;
	/** Optional bearer token sent as `Authorization: Bearer …`. */
	token: string;
	/**
	 * Id of the keychain entry this server's token is bound to, or `""` for
	 * inline tokens. Same exclusivity rule as a provider's: a set `secretRef`
	 * means the on-disk `token` is always `""`.
	 */
	secretRef: string;
	/** Disabled servers are skipped at connect time but kept in the list. */
	enabled: boolean;
}

/** Upper bound on configured servers — a guard against runaway pastes into data.json. */
export const MAX_MCP_SERVERS = 32;

/**
 * The bundled Exa web-search server, and the id that names it.
 *
 * Builtin-ness is *derived* from this id rather than stored as a flag: a row
 * with this id is undeletable and shows the builtin badge wherever it appears,
 * and nothing else in the config schema changes. Exa's endpoint accepts the
 * key as a plain bearer token, so the existing `token`/`secretRef` fields
 * carry the user's API key with no new plumbing.
 */
export const BUILTIN_MCP_SERVER_ID = "builtin-exa";

/** The bundled Exa server as it ships: keyless (shared rate-limited quota) until the user adds a key. */
export function builtinExaServer(): McpServerConfig {
	return {
		id: BUILTIN_MCP_SERVER_ID,
		name: "Exa",
		url: "https://mcp.exa.ai/mcp",
		token: "",
		secretRef: "",
		enabled: true,
	};
}

/**
 * Prepends the bundled Exa server unless an entry with its id already exists.
 *
 * Called on every settings load, so a hand-edited data.json cannot remove the
 * server for good — it reappears on the next load, remembering its `enabled`
 * and token. The cap guard keeps the prepend from pushing the list past
 * `MAX_MCP_SERVERS`, where the next normalize would evict a real user server
 * to make room.
 */
export function ensureBuiltinMcpServer(servers: McpServerConfig[]): McpServerConfig[] {
	if (servers.some((server) => server.id === BUILTIN_MCP_SERVER_ID) || servers.length >= MAX_MCP_SERVERS) {
		return servers;
	}
	return [builtinExaServer(), ...servers];
}

/** Characters a URL must carry for a server entry to be usable at all. */
function isHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * Turns a display name into the prefix used in agent-facing tool names.
 *
 * Tool names must survive JSON-schema identifier rules and stay stable across
 * reloads, so everything outside `a-z0-9` collapses to `_`, and an empty or
 * fully-symbol result falls back to `server` — the tool still works, the name
 * is just generic.
 */
export function slugifyServerName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return slug === "" ? "server" : slug;
}

/** Creates a server entry with a fresh id, filling the fields a modal leaves blank. */
export function createMcpServerConfig(partial: Partial<McpServerConfig> = {}): McpServerConfig | null {
	return normalizeMcpServer({
		id: generateMcpServerId(),
		...partial,
	});
}

/** Generates a stable id. Exported for tests; callers go through {@link createMcpServerConfig}. */
export function generateMcpServerId(): string {
	return `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Normalizes one entry; anything unusable (no id or no http(s) URL) is dropped. */
export function normalizeMcpServer(data: unknown): McpServerConfig | null {
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const raw = data as Record<string, unknown>;
	const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : null;
	if (id === null) {
		return null;
	}
	const url = typeof raw.url === "string" ? raw.url.trim() : "";
	if (!isHttpUrl(url)) {
		return null;
	}
	const name = typeof raw.name === "string" ? raw.name.trim() : "";
	const secretRef = typeof raw.secretRef === "string" ? raw.secretRef.trim() : "";
	return {
		id,
		name: name === "" ? url : name,
		url,
		token: typeof raw.token === "string" ? raw.token : "",
		// Same rule as providers: a string that cannot name an entry is hand-edit
		// junk and reads as "nothing bound", while a well-formed id naming nothing
		// stays — a dangling reference the panel reports, not a lost binding.
		secretRef: isValidSecretId(secretRef) ? secretRef : "",
		enabled: raw.enabled !== false,
	};
}

/**
 * Normalizes the whole `mcpServers` array.
 *
 * A malformed entry disappears rather than failing the whole load — a hand-edited
 * data.json must not brick the settings panel. The cap keeps a corrupted or
 * malicious file from ballooning memory; the first `MAX_MCP_SERVERS` valid
 * entries win, in insertion order.
 */
export function normalizeMcpServers(data: unknown): McpServerConfig[] {
	if (!Array.isArray(data)) {
		return [];
	}
	const servers: McpServerConfig[] = [];
	for (const entry of data) {
		const server = normalizeMcpServer(entry);
		if (server !== null) {
			servers.push(server);
			if (servers.length >= MAX_MCP_SERVERS) {
				break;
			}
		}
	}
	return servers;
}
