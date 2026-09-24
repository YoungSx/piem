/**
 * host.ts — binds a workflow run to piem's subagent machinery.
 *
 * `runtime.ts` knows nothing about sessions, models, or the vault: its only
 * seam is the injected {@link WorkflowHost}. This is the other half of that
 * seam, and it stays just as ignorant — it is handed a {@link WorkflowChildRunner}
 * (which the service builds from its subagent context) and does three things the
 * runtime cannot: turn a spawn request into a child run, map a failure to the
 * `{ok:false}` the script sees as `null`, and keep an abort handle per agent so
 * a panel stop or an unawaited-launch cleanup reaches the right child.
 *
 * Upstream's host also ran `gate` commands and git worktrees; neither exists
 * here (no shell, no git CLI), so `runGate` and `isolation` are absent and the
 * worker rejects those options at the call that used them.
 */

import type {
	WorkflowHost,
	WorkflowSpawnRequest,
	WorkflowSpawnResult,
} from "./runtime";

/**
 * One child the workflow asked for, in the runner's own vocabulary.
 *
 * Deliberately not `WorkflowSpawnRequest`: that carries the runtime's
 * `wf-agent-N` handle, the progress index, and the compiled schema object, none
 * of which the runner needs. The runner needs what decides the run.
 */
export interface WorkflowChildRequest {
	prompt: string;
	label: string;
	agentType: string;
	/** Model id the script named, or undefined to inherit the conversation's. */
	model?: string;
	/** Reasoning effort, already validated against the thinking levels worker-side. */
	effort?: string;
	/** The raw JSON Schema the answer must match, when the script asked for one. */
	schema?: Record<string, unknown>;
}

/** What a child run comes back with. `ok:false` becomes the script's `null`. */
export interface WorkflowChildOutcome {
	ok: boolean;
	/** The child's report, present when ok. The runtime checks it against the schema. */
	text?: string;
	error?: string;
	/** The child's own id, for a future inspector and for `resume`. */
	recordId?: string;
	modelName?: string;
	modelId?: string;
	thinking?: string;
	/** Output tokens, for `budget.spent()`. */
	outputTokens?: number;
	/** Lifetime total tokens, for the row. */
	tokens?: number;
	toolCalls?: number;
}

/**
 * What the host needs from piem to run one child. The service implements this
 * over its subagent context; keeping it an interface is what lets the runtime's
 * tests inject a stub and stay free of sessions and models.
 */
export interface WorkflowChildRunner {
	spawn(request: WorkflowChildRequest, signal: AbortSignal): Promise<WorkflowChildOutcome>;
	/**
	 * Continue a child that already ran, by the `recordId` its spawn reported.
	 *
	 * Optional: a runner without it makes the host decline `agent({ resume })`
	 * rather than quietly starting a fresh child with none of the context the
	 * script is counting on.
	 */
	resume?(recordId: string, prompt: string, signal: AbortSignal): Promise<WorkflowChildOutcome>;
}

/** Turn a child outcome into the runtime's result shape, reporting the model as it goes. */
function toResult(
	outcome: WorkflowChildOutcome,
	onResolved: WorkflowSpawnRequest["onResolved"],
): WorkflowSpawnResult {
	// The child's session exists by now, so this is the effective model, not the
	// requested one — reported before the result so the row updates in place.
	onResolved?.({
		...(outcome.recordId !== undefined ? { recordId: outcome.recordId } : {}),
		...(outcome.modelName !== undefined ? { modelName: outcome.modelName } : {}),
		...(outcome.modelId !== undefined ? { modelId: outcome.modelId } : {}),
		...(outcome.thinking !== undefined ? { thinking: outcome.thinking } : {}),
	});
	if (!outcome.ok) {
		return { ok: false, ...(outcome.error !== undefined ? { error: outcome.error } : {}) };
	}
	return {
		ok: true,
		...(outcome.text !== undefined ? { text: outcome.text } : {}),
		...(outcome.outputTokens !== undefined ? { outputTokens: outcome.outputTokens } : {}),
		...(outcome.tokens !== undefined ? { tokens: outcome.tokens } : {}),
		...(outcome.toolCalls !== undefined ? { toolCalls: outcome.toolCalls } : {}),
	};
}

/**
 * Build a {@link WorkflowHost} over a runner.
 *
 * The controller map is the whole reason spawn and abort are one object: a
 * `wf-agent-N` handle means nothing to the runner, so the host keeps the
 * `AbortController` that reaches its child and fires it when the runtime asks.
 * `recordId` is mapped alongside so a `resume` — which the runtime addresses by
 * the same `wf-agent-N` handle — finds the child the runner knows.
 */
export function createWorkflowHost(runner: WorkflowChildRunner): WorkflowHost {
	const controllers = new Map<string, AbortController>();
	const recordIds = new Map<string, string>();

	const host: WorkflowHost = {
		async spawnAgent(request: WorkflowSpawnRequest): Promise<WorkflowSpawnResult> {
			const controller = new AbortController();
			controllers.set(request.agentId, controller);
			try {
				const outcome = await runner.spawn(
					{
						prompt: request.prompt,
						label: request.label,
						agentType: request.agentType,
						...(request.model !== undefined ? { model: request.model } : {}),
						...(request.effort !== undefined ? { effort: request.effort } : {}),
						...(request.schema !== undefined ? { schema: request.schema.schema } : {}),
					},
					controller.signal,
				);
				if (outcome.recordId !== undefined) recordIds.set(request.agentId, outcome.recordId);
				// Wrapped, not passed bare: a method reference off `request` trips the
				// unbound-method lint, and the arrow reads the property at call time.
				return toResult(outcome, (info) => request.onResolved?.(info));
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			} finally {
				controllers.delete(request.agentId);
			}
		},
		abortAgent(agentId: string): void {
			controllers.get(agentId)?.abort();
		},
	};

	if (runner.resume) {
		const resume = runner.resume.bind(runner);
		host.resumeAgent = async (agentId, prompt, onResolved) => {
			const recordId = recordIds.get(agentId);
			if (recordId === undefined) {
				return { ok: false, error: `Cannot resume ${agentId}: it has no completed run in this workflow.` };
			}
			const controller = new AbortController();
			controllers.set(agentId, controller);
			try {
				const outcome = await resume(recordId, prompt, controller.signal);
				if (outcome.recordId !== undefined) recordIds.set(agentId, outcome.recordId);
				return toResult(outcome, onResolved);
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			} finally {
				controllers.delete(agentId);
			}
		};
	}

	return host;
}
