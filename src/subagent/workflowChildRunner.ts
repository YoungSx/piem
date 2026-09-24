/**
 * workflowChildRunner.ts — runs one workflow child over the subagent context.
 *
 * A workflow's {@link WorkflowHost} needs to turn a spawn request into a running
 * child and hand back its report. Everything that takes to do — resolve the
 * model the script named, clamp the effort, build the leaf tool set, run the
 * child, total its tokens — is exactly what the subagent context already knows
 * how to do, so this adapts that context to the {@link WorkflowChildRunner}
 * shape rather than duplicating any of it.
 *
 * Workflow children are leaves: they run at {@link SUBAGENT_DEPTH_LIMIT}, so
 * their tool set has the vault and MCP tools but not spawn/wait — the workflow
 * script is the orchestrator, and a child that could fan out again would grow a
 * tree the runtime's caps do not see.
 */

import { clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { UsageTotals } from "../agent/usage";
import type { WorkflowChildOutcome, WorkflowChildRequest, WorkflowChildRunner } from "../workflow/host";
import { DEFAULT_SUBAGENT_ROLE_NAME, findSubagentRole } from "./roles";
import { OWNER_UNKNOWN, SUBAGENT_DEPTH_LIMIT, startChildRun, type SubagentToolsContext } from "./spawnTool";
import { SubagentRunError } from "./runner";

/** Effort levels the worker validates to (minimal..max); a guard here is belt-and-braces. */
const EFFORT_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** Output tokens ≈ total minus billed prompt input and cache. Display/budget only. */
function outputTokens(usage: UsageTotals): number {
	const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	return Math.max(0, usage.tokens - prompt);
}

/** Append the answer contract to the prompt: this host has no forced tool, so the ask carries it. */
function withSchema(prompt: string, schema: Record<string, unknown> | undefined): string {
	if (schema === undefined) return prompt;
	return `${prompt}\n\nReply with ONLY a JSON object matching this schema — no prose, no code fences:\n${JSON.stringify(schema)}`;
}

interface ResumeRecord {
	messages: readonly AgentMessage[];
	role: ReturnType<typeof findSubagentRole>;
	model: Model<string>;
	thinkingLevel: ThinkingLevel;
}

/**
 * Build a {@link WorkflowChildRunner} over the subagent context.
 *
 * `newId` is injected (the service passes the registry's id minter or a UUID)
 * so a child's `recordId` is stable and a test can make it deterministic.
 */
export function createWorkflowChildRunner(
	context: SubagentToolsContext,
	newId: () => string,
): WorkflowChildRunner {
	// recordId → what a resume needs to continue: the transcript and the model
	// and level it ran under (a resumed child keeps both). Session-lived, like
	// the registry's own transcripts.
	const resumable = new Map<string, ResumeRecord>();

	function resolveModel(request: WorkflowChildRequest) {
		if (request.model === undefined) return context.getModel();
		const model = context.resolveModel?.(request.model);
		if (!model) {
			throw new Error(`Unknown model: ${request.model}. Configure it, or omit model to inherit the conversation's.`);
		}
		return model;
	}

	function resolveLevel(model: ReturnType<typeof context.getModel>, effort: string | undefined): ThinkingLevel {
		if (effort === undefined) return clampThinkingLevel(model, context.getThinkingLevel());
		const level = EFFORT_LEVELS.includes(effort as ThinkingLevel) ? (effort as ThinkingLevel) : context.getThinkingLevel();
		return clampThinkingLevel(model, level);
	}

	async function run(
		task: string,
		role: ReturnType<typeof findSubagentRole>,
		model: ReturnType<typeof context.getModel>,
		thinkingLevel: ThinkingLevel,
		initialMessages: readonly AgentMessage[] | undefined,
		signal: AbortSignal,
	): Promise<WorkflowChildOutcome> {
		const recordId = newId();
		const ownerId = context.getOwnerId?.() ?? OWNER_UNKNOWN;
		if (!role) throw new Error("The general subagent role is missing.");
		try {
			const result = await startChildRun(context, {
				id: recordId,
				task,
				role,
				model,
				thinkingLevel,
				depth: SUBAGENT_DEPTH_LIMIT,
				ownerId,
				...(initialMessages !== undefined ? { initialMessages } : {}),
				signal,
			});
			resumable.set(recordId, { messages: result.messages, role, model, thinkingLevel });
			return {
				ok: true,
				text: result.text,
				recordId,
				modelName: model.name ?? model.id,
				modelId: `${model.provider}/${model.id}`,
				thinking: thinkingLevel,
				outputTokens: outputTokens(result.usage),
				tokens: result.usage.tokens,
				toolCalls: result.turns,
			};
		} catch (error) {
			// The child's transcript survives a failure, so a later resume can still
			// continue from where it broke (the follow-up-after-interruption case).
			if (error instanceof SubagentRunError) {
				resumable.set(recordId, { messages: error.messages, role, model, thinkingLevel });
			}
			return { ok: false, error: error instanceof Error ? error.message : String(error), recordId };
		}
	}

	return {
		spawn(request, signal) {
			const model = resolveModel(request);
			const thinkingLevel = resolveLevel(model, request.effort);
			// agentType maps to a subagent role when it names one; anything else
			// (including the "general-purpose" default the worker sends) is general.
			const role = findSubagentRole(request.agentType) ?? findSubagentRole(DEFAULT_SUBAGENT_ROLE_NAME);
			return run(withSchema(request.prompt, request.schema), role, model, thinkingLevel, undefined, signal);
		},
		resume(recordId, prompt, signal) {
			const prior = resumable.get(recordId);
			if (prior === undefined) {
				return Promise.resolve({ ok: false, error: `No transcript to resume for ${recordId}.` });
			}
			return run(prompt, prior.role, prior.model, prior.thinkingLevel, prior.messages, signal);
		},
	};
}
