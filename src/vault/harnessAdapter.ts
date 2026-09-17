import type { AgentHarnessTool, AgentHarnessToolInvocation, AgentHarnessToolUpdateCallback, ExecutionToolContext, ToolExecutionMode } from "@earendil-works/pi-agent-core";
import type { AgentTool, AgentToolUpdateCallback, AgentToolResult } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { VaultExecutionEnv } from "./VaultExecutionEnv";
import type { App } from "obsidian";

/**
 * Bridge between pi's two tool shapes, used to adapt the native harness
 * read/write/edit tools onto a vault-scoped {@link VaultExecutionEnv}.
 *
 * pi ships two execute contracts:
 * - {@link AgentTool} (what the low-level `Agent` runs): four parameters.
 * - {@link AgentHarnessTool} (what `createReadTool` / `createWriteTool` /
 *   `createEditTool` produce): six parameters — onUpdate is 3rd, context carries
 *   the turn's `{ env }`, plus invocation memo and chord Context.
 *
 * The low-level agent loop (`agent-loop.js`, `executePreparedToolCall`) always
 * calls `execute(id, args, signal, onUpdate)`; there is no hook to inject a
 * context. Closing over the environment is therefore the whole adaptation:
 * {@link adaptHarnessTool} binds a fixed context once (and optionally pins an
 * `executionMode`, which pi's native tools ship without) and hands back a plain
 * `AgentTool` the existing `Agent` can register unchanged.
 */

/** Static context or per-call resolver, mirroring pi's harness source shape. */
export type HarnessContextSource<TContext> = TContext | (() => TContext | Promise<TContext>);

export interface HarnessToolContextOptions<TContext> {
	/** Context passed as the fifth `execute` argument. Resolved lazily when a function. */
	context: HarnessContextSource<TContext>;
	/**
	 * Per-tool execution mark pinned onto the adapted tool, for the native
	 * read/write/edit tools pi ships without one. Load-bearing rather than
	 * decorative: the agent loop counts an omitted mark as "parallel", so an
	 * unpinned mutation tool would silently join concurrent batches.
	 */
	executionMode?: ToolExecutionMode;
}

/**
 * Wraps a 6-parameter harness tool as a 4-parameter {@link AgentTool}.
 *
 * Everything except `execute` is carried over verbatim (name, label,
 * description, parameters schema, `prepareArguments`, `executionMode`), so
 * schema validation and argument repair keep working under the low-level
 * agent exactly as they do under the harness.
 */
export function adaptHarnessTool<TContext extends object | undefined, TParameters extends TSchema = TSchema, TDetails = unknown>(
	tool: AgentHarnessTool<TContext, TParameters, TDetails>,
	options: HarnessToolContextOptions<TContext>,
): AgentTool<TParameters, TDetails> {
	const source: HarnessContextSource<TContext> = options.context;
	const resolveContext = async (): Promise<TContext> => {
		if (typeof source === "function") {
			return await (source as () => TContext | Promise<TContext>)();
		}
		return source;
	};
	return {
		...tool,
		executionMode: options.executionMode ?? tool.executionMode,
		execute: async (
			toolCallId: string,
			params,
			signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback<TDetails>,
		): Promise<AgentToolResult<TDetails>> => {
			const resolved = await resolveContext();
			const chordContext = signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
			const invocation: AgentHarnessToolInvocation = {
				invocationId: toolCallId,
				operationId: toolCallId,
				turnId: toolCallId,
				getMemo: async () => undefined,
				setMemo: async () => {},
			};
			const updateCallback: AgentHarnessToolUpdateCallback<TDetails> = onUpdate ?? (() => {});
			return await tool.execute(toolCallId, params, updateCallback, resolved, invocation, chordContext);
		},
	};
}

/**
 * Builds the `{ env }` context pi's execution tools read, bound to a vault.
 * Returns the environment too so callers can reuse one instance for several
 * tools — pi's file mutation queue keys its per-path locks off the env object
 * identity (`states.get(env)`), so sharing one instance across read/write/edit
 * is what actually serializes their mutations.
 */
export function createVaultHarnessContext(app: App): { env: VaultExecutionEnv } {
	return { env: new VaultExecutionEnv(app) };
}

/** Convenience: adapt all three native execution tools onto one vault env. */
export function createNativeFileTools(
	app: App,
	factories: {
		read: () => AgentHarnessTool<ExecutionToolContext>;
		write: () => AgentHarnessTool<ExecutionToolContext>;
		edit: () => AgentHarnessTool<ExecutionToolContext>;
	},
): AgentTool[] {
	const context = createVaultHarnessContext(app);
	return [
		adaptHarnessTool(factories.read(), { context }),
		adaptHarnessTool(factories.write(), { context }),
		adaptHarnessTool(factories.edit(), { context }),
	];
}
