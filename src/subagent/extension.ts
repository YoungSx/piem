import type { AgentTool, Skill, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { CompactionSettings } from "../agent/compactionSettings";
import { createFollowUpSubagentTool, createKillSubagentTool, createListSubagentsTool } from "./controlTools";
import { SubagentRegistry } from "./registry";
import { SUBAGENT_DEPTH_LIMIT, createSpawnSubagentTool, type SubagentToolsContext } from "./spawnTool";
import { createWaitSubagentTool, type WaitPacing } from "./waitTool";

/**
 * What the subagent extension borrows from its host — the Obsidian plugin —
 * at execution time.
 *
 * This interface is the whole dependency seam: the extension never imports
 * anything Obsidian-touching. Vault tools arrive as a factory, and model,
 * transport, keys, and skills arrive as lazy getters so a spawn started after
 * a settings change rides the live wiring, not the wiring that existed when
 * the extension was built.
 */
/** One model a spawn may pick, as the host describes it. */
export interface SubagentModelChoice {
	/** Opaque id the spawn parameter carries and {@link SubagentHost.resolveModel} reads. */
	id: string;
	/** What to call it in the tool description, so the model can choose by name. */
	label: string;
}

export interface SubagentHost {
	/** The vault tool set a subagent runs with, before the extension adds delegation. */
	createVaultTools(): AgentTool[];
	getModel(): Model<string>;
	getStreamFn(): StreamFn;
	getThinkingLevel(): ThinkingLevel;
	/**
	 * The models a spawn may pick from, and the resolver for one it picked.
	 *
	 * Both cross the seam rather than being computed here because the join they
	 * need is over the user's two settings lists, which the extension cannot
	 * see. Optional so a host with nothing configured — or a test — simply does
	 * not offer the choice, and the parameter disappears from the schema rather
	 * than advertising an empty set.
	 */
	listModels?: () => readonly SubagentModelChoice[];
	resolveModel?: (choiceId: string) => Model<string> | undefined;
	/**
	 * The provider registry a child compacts through, with the host's API key and
	 * transport already baked in.
	 *
	 * A getter rather than a captured value for the same reason the others are:
	 * the host rebuilds this whenever a provider registration would differ, and a
	 * child holding a stale one fails on a provider it should have known. Absent
	 * means children run without compaction — the behavior before this existed.
	 */
	getModels?: () => Models;
	/** The user's resolved compaction settings for a child's context window. */
	getCompactionSettings?: (contextWindow: number) => CompactionSettings;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	getSkills(): readonly Skill[];
	/**
	 * Which conversation a spawn started at the top level belongs to.
	 *
	 * Opaque here by design — the host knows it is a chat session, this module
	 * only groups by it. Read synchronously inside a spawn's execute, which is
	 * what lets a host answer "the conversation whose tool is running right now"
	 * rather than "the one on screen"; the two differ the moment a background
	 * chat delegates. Deeper levels never call it: the id travels down the tree
	 * in a closure instead, because by then the host's notion of "right now" has
	 * long since moved on.
	 *
	 * Optional so a host that never opens two conversations — or a test — keeps
	 * every child under one anonymous owner, which is how this behaved before
	 * ownership was recorded at all.
	 */
	getOwnerId?: () => string | undefined;
	/**
	 * The external tools — MCP servers today — mounted on the host's settings
	 * right now, read at the moment a child is built.
	 *
	 * Synchronous and cache-backed by design: the host connects servers when a
	 * conversation is built or reconfigured, and a child reads what is already
	 * mounted rather than re-handshaking, so a spawn is never held hostage to a
	 * dead endpoint's connect timeout. A server that went down between then and
	 * now simply contributes nothing — "currently mounted", not "was mounted
	 * once". Optional so a host with nothing configured — or a test — hands out
	 * none, and children look exactly as they did before this existed.
	 */
	getExternalTools?: () => readonly AgentTool[];
}

/**
 * The subagent extension's single entry point.
 *
 * The plugin wires one call to this at construction and touches nothing else:
 * `createTools` assembles the parent's tool set (vault tools plus the delegation
 * five: spawn, wait, list, kill, follow up), the extension owns every policy the
 * delegation involves — depth cap, concurrency cap, wait pacing, the registry,
 * child-kill bookkeeping — and `disposeAll` is the teardown hook for service
 * destruction and plugin unload.
 *
 * Dependency contract for everything in `src/subagent/`: pi packages, this
 * module, and five pure shared helpers (`../tools/toolResult`,
 * `../vault/truncate`, `../agent/usage`, `../agent/skillLoader`, and the
 * compaction pair `../agent/compaction` + `../agent/compactionSettings`).
 * Each imports nothing but pi. Anything vault-touching enters only through
 * {@link SubagentHost} — including the `Models` instance a child compacts
 * through, which is a pi type wrapping an Obsidian transport the host bakes in.
 */
/**
 * @param options Test seam: shrinks the wait window to milliseconds so a
 * window-closing test takes 10ms, not Codex's 10s floor. Production omits it
 * and waits take the Codex constants.
 */
export function createSubagentExtension(
	host: SubagentHost,
	options?: { waitPacing?: WaitPacing },
): {
	createTools(): AgentTool[];
	disposeAll(): void;
	/**
	 * The registry behind the tools, for read-only observers.
	 *
	 * The UI inspector renders from registry entries and subscribes to its
	 * spawn/settle events; handing it the same instance the tools write is what
	 * keeps one source of truth. The registry's own class documents that entries
	 * are live bookkeeping, so observers must copy what they render.
	 */
	registry: SubagentRegistry;
} {
	const registry = new SubagentRegistry();

	// The registry is per-service and the tools are built once, so the context
	// is shared by both delegation tools at every depth.
	const context: SubagentToolsContext = {
		// Arrow wrappers, not bare method references: the host's getters are
		// plain objects here, but handing an unbound `this` to a future host
		// method would silently re-scope it.
		getModel: () => host.getModel(),
		getStreamFn: () => host.getStreamFn(),
		getThinkingLevel: () => host.getThinkingLevel(),
		listModels: host.listModels ? () => host.listModels?.() ?? [] : undefined,
		resolveModel: host.resolveModel ? (choiceId) => host.resolveModel?.(choiceId) : undefined,
		getModels: host.getModels ? () => host.getModels?.() : undefined,
		getCompactionSettings: host.getCompactionSettings ? (window) => host.getCompactionSettings?.(window) : undefined,
		getApiKey: host.getApiKey ? (provider) => host.getApiKey?.(provider) : undefined,
		getSkills: () => host.getSkills(),
		getOwnerId: host.getOwnerId ? () => host.getOwnerId?.() : undefined,
		registry,
		createChildTools: (childDepth: number, ownerId: string) => buildTools(childDepth, ownerId),
		waitPacing: options?.waitPacing,
	};

	/**
	 * @param ownerId The conversation this level's tools answer to, or undefined
	 * at the top level, where each tool asks the host instead. A child level is
	 * always given one, because the host can no longer name it by the time a
	 * grandchild's tool runs.
	 */
	function buildTools(depth: number, ownerId?: string): AgentTool[] {
		const tools = host.createVaultTools();
		if (depth < SUBAGENT_DEPTH_LIMIT) {
			// The five travel together: a level that may spawn must also be able to
			// collect, enumerate, stop, and re-task what it spawned. Handing out spawn
			// alone is what leaves a parent unable to manage its own fan-out — and
			// handing out the first four leaves it unable to do anything with a child
			// that stopped except start another from nothing. All five take the same
			// owner scope, so what a level may collect is exactly what it may see,
			// what it may stop, and what it may re-task.
			tools.push(
				createSpawnSubagentTool(context, depth, ownerId),
				createWaitSubagentTool(context, ownerId),
				createListSubagentsTool(context, ownerId),
				createKillSubagentTool(context, ownerId),
				createFollowUpSubagentTool(context, ownerId),
			);
		}
		// External tools join every set, at every depth — the delegation cap bounds
		// how far the tree may grow, not what a leaf may call. Same order the parent
		// assembles its own list in: vault tools, delegation, external last.
		tools.push(...(host.getExternalTools?.() ?? []));
		return tools;
	}

	return {
		createTools: () => buildTools(0),
		disposeAll: () => registry.disposeAll(),
		registry,
	};
}
