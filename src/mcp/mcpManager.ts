import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult, ContentBlock, FetchLike, Tool as McpTool } from "@modelcontextprotocol/client";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import { createFetchForTransport, type NetworkTransport } from "../net/obsidianFetch";
import { throwIfAborted } from "../tools/toolResult";
import { truncateToolOutput } from "../vault/truncate";
import { toAgentToolResult } from "./mcpContent";
import { slugifyServerName, type McpServerConfig } from "./mcpConfig";

/**
 * The bridge between configured MCP servers and pi's tool list.
 *
 * Everything protocol-shaped lives in the official `@modelcontextprotocol/client`
 * SDK; this module only decides *when* to connect, *what* the tools look like to
 * the model, and *how failures surface*. No JSON-RPC, no SSE parsing — the SDK
 * owns both, which is the whole point of choosing it.
 *
 * Three deliberate degradations, each disclosed rather than hidden:
 *
 * 1. **GET stream disabled, and mounting pinned to the buffered transport.**
 *    Streamable HTTP servers may hold a GET SSE stream open for
 *    server→client notifications, but mounting always rides `requestUrl`, under
 *    which nothing is readable until the response completes — a stream meant to
 *    stay open would never resolve at all. The fetch handed to the transport
 *    short-circuits that GET with the 405 the SDK already reads as "no server
 *    stream, carry on", and tool calls (POST) are unaffected. Cost, on every
 *    transport: no server push and no `tools/list_changed`, so the list
 *    refreshes when settings are saved.
 *
 *    The pin buys reach: a handshake is a few one-shot POSTs that streaming
 *    buys nothing for, while the buffered stack reaches servers that send no
 *    CORS headers — the ones a bare `fetch` cannot mount at all. Tool calls
 *    invert it and follow the user's transport at call time; see
 *    {@link McpManager.openMountedClient}.
 * 2. **No OAuth flow.** A static bearer token covers the servers a personal
 *    vault realistically talks to; OAuth providers can be added behind the same
 *    `authProvider` seam later.
 * 3. **Remote-only.** No stdio transport — it spawns child processes, which a
 *    mobile-first plugin cannot offer.
 */

/**
 * Connect + initial tools/list must finish inside this, or the server is marked
 * unreachable.
 *
 * Ours to choose, unlike a tool call: connecting happens on plugin load, on
 * every settings save and from the panel's retry button, with no model in the
 * loop to ask and a user waiting on the settings panel to repaint. A server
 * that cannot say hello in fifteen seconds is reported as down and retried on
 * the next connect.
 */
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Default wait on one tool call, when the model does not say what it wants.
 *
 * Not a policy ceiling: the model may raise it per call via `timeoutMs`, the same
 * dial `wait_subagent` exposes. But unlike pi's `timeoutMs?`, the MCP SDK has no
 * "no limit" — omitting `timeout` silently takes its own 60s default (`Protocol`
 * arms a `setTimeout` unconditionally), and `setTimeout` fires immediately past
 * the 32-bit range, so "forever" is not expressible even by asking for a huge
 * number. Some number is therefore unavoidable here; this one is a starting
 * point the model can move, not a limit it cannot.
 */
const CALL_TIMEOUT_DEFAULT_MS = 120_000;

/**
 * The dial the model turns to buy a slow tool more time.
 *
 * Merged into every MCP tool's own schema rather than wrapped around it: the
 * schema belongs to the server, and a parameter named for what it does is how
 * the model learns the knob exists at all. `mcp` prefixes the name so it cannot
 * collide with a server's own field, and it is stripped before the arguments go
 * out on the wire.
 */
const TIMEOUT_PARAM = "mcpTimeoutMs";

/**
 * Who we say we are in the MCP handshake.
 *
 * The version is passed in from the plugin manifest rather than written here:
 * a literal in this file is a second place the release version lives, and it
 * silently stopped tracking the real one — it sat at "1.0.0" while the plugin
 * shipped past it, because nothing reads this string back. `scripts/check-version.mjs`
 * now fails on a hardcoded version anywhere under `src/`, so the only way to
 * satisfy both it and the protocol is to take the value from the manifest.
 */
function mcpClientInfo(version: string): { name: string; version: string } {
	return { name: "piem", version };
}

/** How a server's last connection attempt ended, for the settings panel. */
export type McpServerStatus = "ok" | "error" | "disabled" | "untested";

/** Per-server view the settings panel renders. */
export interface McpServerState {
	id: string;
	name: string;
	url: string;
	enabled: boolean;
	status: McpServerStatus;
	toolCount: number;
	/** Last error message, when status is "error". */
	error?: string;
}

/** Internal per-server cache entry. */
interface McpServerEntry {
	client: Client | null;
	/** Flattened tool list from `tools/list` (the SDK walks all pages). */
	tools: McpTool[];
	status: McpServerStatus;
	error?: string;
	/** The url+token this entry was connected with, for skip-if-unchanged. */
	connection?: { url: string; token: string };
}

/** Converts a JSON Schema object into the TypeBox type pi's tool signatures use. */
function asTypeBoxSchema(inputSchema: unknown): TSchema {
	// TypeBox schemas *are* JSON Schema: MCP servers publish ordinary
	// `{"type": "object", …}` documents, and pi serializes `parameters` back out
	// as JSON Schema for the model. The cast is structural, not a lie.
	return inputSchema as TSchema;
}

/**
 * The server's schema with the timeout dial added as one more property.
 *
 * Shallow-copied rather than mutated: `entry.tools` is the cached listing, and
 * writing into it would leave the injected property behind on a reconnect that
 * reuses the same objects.
 *
 * A server that already publishes this name keeps its own, and `injected` is how
 * the call site learns that: the field is then the server's real argument, so
 * stripping it before the call would silently drop it — the corruption the name
 * collision was supposed to avoid.
 */
function withTimeoutParam(inputSchema: unknown): { schema: TSchema; injected: boolean } {
	const schema = asTypeBoxSchema(inputSchema) as TSchema & { properties?: Record<string, unknown> };
	if (schema?.properties?.[TIMEOUT_PARAM] !== undefined) {
		return { schema, injected: false };
	}
	return {
		injected: true,
		schema: {
			...schema,
			properties: {
				...schema.properties,
				[TIMEOUT_PARAM]: {
					type: "number",
					description: `How long to wait for this call, in milliseconds. Default ${Math.round(CALL_TIMEOUT_DEFAULT_MS / 1000)}s; raise it for a call you expect to be slow.`,
				},
			},
		},
	};
}

/** Splits the injected dial back out, so the server only sees its own arguments. */
function takeTimeout(params: Record<string, unknown>, injected: boolean): { timeoutMs: number; args: Record<string, unknown> } {
	if (!injected) {
		return { timeoutMs: CALL_TIMEOUT_DEFAULT_MS, args: params };
	}
	const { [TIMEOUT_PARAM]: requested, ...args } = params;
	// A model may pass a string, a negative, or NaN. Anything that is not a
	// usable positive number falls back rather than arming a timer that fires at
	// once — an instant timeout would read to the model as a broken server.
	const timeoutMs = typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? requested : CALL_TIMEOUT_DEFAULT_MS;
	return { timeoutMs, args };
}

/** Sanitizes an MCP tool name for embedding in a pi tool name. */
function sanitizeToolName(name: string): string {
	const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	return slug === "" ? "tool" : slug;
}

/** Picks a tool name that does not collide with the ones already claimed. */
function uniqueToolName(base: string, taken: ReadonlySet<string>): string {
	if (!taken.has(base)) {
		return base;
	}
	for (let n = 2; ; n++) {
		const candidate = `${base}_${n}`;
		if (!taken.has(candidate)) {
			return candidate;
		}
	}
}

/**
 * Wraps a fetch so the transport's GET SSE probe always gets the 405 answer
 * that means "no server stream".
 *
 * The wrapper exists because the mounting transport — `requestUrl`, always —
 * exposes no incremental read, so a GET the server intends to hold open
 * resolves when the server finally closes it, or never; a 405 is the one status
 * the SDK already reads as "this server has no GET stream", which makes it the
 * honest answer to give on behalf of a channel that cannot carry one. Since
 * mounting is pinned to that channel, the wrapper is always on.
 *
 * Tool calls (POST) pass through untouched — they are the one MCP request
 * category that still follows the user's transport, and they never carried the
 * held stream. Throwing never enters the picture.
 */
export function createNoGetStreamFetch(baseFetch: FetchLike): FetchLike {
	return async (url, init) => {
		if ((init?.method ?? "GET").toUpperCase() === "GET") {
			return new Response(null, { status: 405 });
		}
		return baseFetch(url, init);
	};
}

/** Rejects after `ms` if `promise` has not settled, so one dead server cannot hang plugin load. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: number | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = window.setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
	});
	return Promise.race([
		promise.finally(() => {
			if (timer !== undefined) {
				window.clearTimeout(timer);
			}
		}),
		timeout,
	]);
}

/** Resolves the URL prefix used in error messages, without leaking the full endpoint into logs. */
function serverLabel(server: McpServerConfig): string {
	return `"${server.name}"`;
}

/**
 * Owns one SDK `Client` per enabled server and derives pi tools from them.
 *
 * Lifecycle: the plugin fires one {@link connect} at load so the cache is warm
 * before anything asks — the agent service and the settings panel both read
 * from it — and the same call repeats on every configuration change (settings
 * save, the panel's retry button, which skips the servers already mounted).
 * Connection is lazy per server and cached: a server that failed to connect is
 * retried on the next {@link connect}, never silently between turns — an MCP
 * tool appearing or disappearing mid-conversation would look like the model
 * hallucinating.
 */
export class McpManager {
	/** Server configs as last connected; the source of truth lives in settings. */
	private readonly servers: () => McpServerConfig[];
	private readonly transport: () => NetworkTransport;
	private readonly entries = new Map<string, McpServerEntry>();

	/**
	 * One slot per server whose handshake is in flight, so two callers racing on
	 * the same server queue behind each other instead of double-mounting: both
	 * would see no usable entry, both open a client, and the entry the loser
	 * lands would strand the winner's client unclosed. The plugin's load warmup
	 * versus the panel's first open is an ordinary race, not an exotic one.
	 */
	private readonly connecting = new Map<string, Promise<void>>();

	/**
	 * Raised by dispose and cleared by the next connect. A handshake still in
	 * flight when the plugin unloads must not land afterwards: its `entries.set`
	 * would resurrect a live client that nothing will ever close, so the gate
	 * turns that landing into a no-op. Not a one-way latch — the tests re-drive
	 * a disposed manager, and an explicit connect says "someone is asking for
	 * connections again".
	 */
	private disposed = false;

	/**
	 * `pluginVersion` is the manifest's version, reported to every server in the
	 * handshake. Passed in rather than read here so this module keeps knowing
	 * nothing about Obsidian, and so the release version has exactly one home.
	 *
	 * `fetchFactory` exists for tests: which transport answers a request is
	 * runtime state, but a test has no network to ride, so it injects a fetch
	 * double here — asked per request category (`requestUrl` for mounting, the
	 * user's choice for tool calls) — and the manager cannot tell the difference.
	 */
	constructor(
		servers: () => McpServerConfig[],
		transport: () => NetworkTransport,
		private readonly pluginVersion: string,
		private readonly fetchFactory: (transport: NetworkTransport) => FetchLike = (t) => createFetchForTransport(t),
	) {
		this.servers = servers;
		this.transport = transport;
	}

	/**
	 * Connects to every enabled server in parallel and lists their tools.
	 *
	 * Failures are per-server and recorded, never thrown: one dead endpoint
	 * must not stop the other servers' tools from loading, and the settings
	 * panel reports the error where the user can act on it.
	 */
	async connect(): Promise<void> {
		// An explicit connect reopens the gate dispose closed: only the landing
		// of a handshake that was already in flight during the dispose is
		// dropped — a manager that survives a dispose must keep working.
		this.disposed = false;
		const enabled = this.servers().filter((server) => server.enabled);
		this.forgetDisabled(enabled);
		await Promise.all(enabled.map((server) => this.connectServer(server)));
	}

	/** The pi tools for every connected server, ready to merge into `agent.state.tools`. */
	buildAgentTools(): AgentTool[] {
		const tools: AgentTool[] = [];
		const takenNames = new Set<string>();
		for (const server of this.servers()) {
			const entry = this.entries.get(server.id);
			if (entry?.status !== "ok" || entry.client === null) {
				continue;
			}
			const slug = slugifyServerName(server.name);
			for (const mcpTool of entry.tools) {
				// The `mcp_` prefix makes the origin visible in every transcript: a
				// reader can tell vault tools from remote ones without checking config.
				const name = uniqueToolName(`mcp_${slug}_${sanitizeToolName(mcpTool.name)}`, takenNames);
				takenNames.add(name);
				tools.push(this.buildTool(server, entry.client, mcpTool, name));
			}
		}
		return tools;
	}

	/** Per-server states for the settings panel, in config order. */
	getServerStates(): McpServerState[] {
		return this.servers().map((server) => {
			const entry = this.entries.get(server.id);
			return {
				id: server.id,
				name: server.name,
				url: server.url,
				enabled: server.enabled,
				status: server.enabled ? entry?.status ?? "untested" : "disabled",
				toolCount: entry?.status === "ok" ? entry.tools.length : 0,
				error: entry?.error,
			};
		});
	}

	/**
	 * Probes one candidate configuration without touching the cache.
	 *
	 * Used by the settings modal's Test button: the draft may differ from what is
	 * saved, and a probe that reported against the saved copy would lie. The
	 * client is closed before returning — nothing lingers between the click and
	 * the save.
	 */
	async testServer(server: McpServerConfig): Promise<number> {
		const { client, tools } = await this.openMountedClient(server);
		await this.closeClient(client);
		return tools.length;
	}

	/** Closes every client. Idempotent; safe at plugin unload. */
	async dispose(): Promise<void> {
		this.disposed = true;
		const closers = [...this.entries.values()].map((entry) => this.closeClient(entry.client));
		this.entries.clear();
		await Promise.allSettled(closers);
	}

	private async connectServer(server: McpServerConfig): Promise<void> {
		// Serialize per server: see `connecting`. The later caller waits for the
		// earlier handshake, then runs its own pass — where the idempotency check
		// sees the fresh entry and no-ops, or a changed config re-mounts cleanly.
		const previous = this.connecting.get(server.id) ?? Promise.resolve();
		const attempt = previous.then(() => this.mountServer(server));
		this.connecting.set(server.id, attempt);
		try {
			await attempt;
		} finally {
			// Clear the slot only if it still holds this attempt; a queued call
			// has already replaced it, and removing that one would desync the chain.
			if (this.connecting.get(server.id) === attempt) {
				this.connecting.delete(server.id);
			}
		}
	}

	private async mountServer(server: McpServerConfig): Promise<void> {
		if (this.disposed) {
			return;
		}
		// `connect` runs on every settings save (it is how refreshed tools reach
		// the agent), so an already-mounted server with the same url+token is
		// left alone — name edits need no reconnect either, since tool names are
		// derived from the live config in `buildAgentTools`. Transport is not in
		// the key: the mount is pinned regardless of the setting, and tool calls
		// re-read it per call, so a switch needs no re-handshake (see
		// {@link openMountedClient}). A failed server is always retried; that is
		// the only path a temporarily down endpoint recovers on.
		const existing = this.entries.get(server.id);
		if (
			existing?.status === "ok" &&
			existing.connection?.url === server.url &&
			existing.connection?.token === server.token
		) {
			return;
		}
		try {
			const { client, tools } = await this.openMountedClient(server);
			// The handshake finished after unload: nothing may keep the client
			// alive, and no entry may resurrect after `dispose` emptied the map.
			if (this.disposed) {
				await this.closeClient(client);
				return;
			}
			this.entries.set(server.id, {
				client,
				tools,
				status: "ok",
				connection: { url: server.url, token: server.token },
			});
			if (existing && existing.client !== client) {
				await this.closeClient(existing.client);
			}
		} catch (error) {
			// A failed mount leaves no client of its own worth keeping: the caller
			// closed it, and only a previous entry's client survives here so
			// dispose still closes it. The server is marked failed either way.
			// After dispose there is nothing to mark — the map is gone for good.
			if (this.disposed) {
				return;
			}
			this.entries.set(server.id, {
				client: existing?.client ?? null,
				tools: [],
				status: "error",
				error: error instanceof Error ? error.message : String(error),
				connection: { url: server.url, token: server.token },
			});
		}
	}

	/**
	 * Opens a client whose handshake is guaranteed mounted, with the tool list
	 * the mount served.
	 *
	 * One client, one fetch, two dispatch rules — MCP has no way to tell a
	 * mounting POST from a tool-call POST after the fact, so the fetch decides
	 * per request: while `mounted` is false (connect, `tools/list`, the Test
	 * probe) everything rides the buffered `requestUrl` stack, which reaches
	 * CORS-less servers and resolves without a held stream; once the handshake
	 * lands, `mounted` flips and every later POST — the actual tool calls —
	 * re-reads `this.transport()` at call time, so a settings switch takes
	 * effect without a reconnect.
	 *
	 * The flip waits for a *successful* list on purpose: a mount that failed its
	 * first list is closed by the caller and never gets to send anything on the
	 * user's transport. The GET probe is suppressed on both sides of the flip
	 * (see {@link createNoGetStreamFetch}) — server push was already gone under
	 * the buffered transport, and a call-time re-handshake on the user's
	 * transport has no use for a held stream either.
	 *
	 * Public to tests through {@link testServer}; the returned client is
	 * expected to be closed by the caller.
	 */
	private async openMountedClient(server: McpServerConfig): Promise<{ client: Client; tools: McpTool[] }> {
		let mounted = false;
		// Per-request dispatch, in one line: GET never leaves; POSTs ride
		// `requestUrl` until the mount lands, then the user's transport — read
		// at call time, so a settings switch applies to the very next call.
		const dispatch: FetchLike = (url, init) =>
			createNoGetStreamFetch(this.fetchFactory(mounted ? this.transport() : "requestUrl"))(url, init);
		const transport = new StreamableHTTPClientTransport(new URL(server.url), {
			fetch: dispatch,
			requestInit: server.token === "" ? undefined : { headers: { Authorization: `Bearer ${server.token}` } },
		});
		const client = new Client(mcpClientInfo(this.pluginVersion));
		await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `Connecting to ${serverLabel(server)}`);
		const { tools } = await withTimeout(
			client.listTools(),
			CONNECT_TIMEOUT_MS,
			`Listing tools from ${serverLabel(server)}`,
		);
		mounted = true;
		return { client, tools };
	}

	private async closeClient(client: Client | null): Promise<void> {
		if (client === null) {
			return;
		}
		try {
			await client.close();
		} catch {
			// A half-open transport may refuse to close; nothing actionable remains.
		}
	}

	private forgetDisabled(enabled: readonly McpServerConfig[]): void {
		const enabledIds = new Set(enabled.map((server) => server.id));
		for (const [id, entry] of this.entries) {
			if (!enabledIds.has(id)) {
				this.entries.delete(id);
				void this.closeClient(entry.client);
			}
		}
	}

	private buildTool(server: McpServerConfig, client: Client, mcpTool: McpTool, name: string): AgentTool {
		const dial = withTimeoutParam(mcpTool.inputSchema);
		const origin = `${serverLabel(server)} MCP server`;
		const disclosure =
			`[MCP tool from ${origin}: ${server.url}] ` +
			"Calling it sends the arguments to that server outside the vault and Obsidian.";
		return {
			name,
			label: mcpTool.name,
			// A remote tool's read/write nature is declared by its server, not
			// visible from here, so it is never assumed idempotent: pin sequential
			// rather than let it join a concurrent batch by default.
			executionMode: "sequential",
			description: `${mcpTool.description ?? ""}\n\n${disclosure}`.trim(),
			parameters: dial.schema,
			execute: async (_toolCallId, params, signal): Promise<AgentToolResult<Record<string, unknown>>> => {
				throwIfAborted(signal);
				const { timeoutMs, args } = takeTimeout(params as Record<string, unknown>, dial.injected);
				const result = await withTimeout(
					// The SDK's own timeout (60s default) would fire first and misleadingly;
					// hand it the same budget and let withTimeout be the single clock.
					client.callTool({ name: mcpTool.name, arguments: args }, { signal, timeout: timeoutMs }),
					timeoutMs,
					`Calling ${mcpTool.name}`,
				);
				throwIfAborted(signal);
				// MCP reports tool-level failure as a result, but pi's contract is
				// throw-on-failure — the agent turns the throw into an error tool
				// result the next request can see, the same path web_fetch's
				// failures take.
				if (result.isError === true) {
					const firstText = (result.content as ContentBlock[] | undefined)?.find(
						(block): block is { type: "text"; text: string } => block.type === "text",
					);
					throw new Error(firstText?.text ?? `MCP tool ${mcpTool.name} failed`);
				}
				const mapped = toAgentToolResult(result);
				const first = mapped.content[0] as TextContent | undefined;
				if (first?.type === "text") {
					first.text = truncateToolOutput(first.text);
				}
				return mapped;
			},
		};
	}
}

/** Narrow re-export so callers can name the result type without touching the SDK. */
export type { CallToolResult };
