import { Type, type TLiteral } from "typebox";
import type { AgentMessage, AgentTool, Skill, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type Model, type Models } from "@earendil-works/pi-ai";
import type { CompactionSettings } from "../agent/compactionSettings";
import { textResult, throwIfAborted } from "../tools/toolResult";
import type { SubagentModelChoice } from "./extension";
import { DEFAULT_SUBAGENT_ROLE_NAME, SUBAGENT_ROLES, findSubagentRole, type SubagentRole, type SubagentRoleName } from "./roles";
import { linkSignals, runSubagent, type LinkedSignals, type SubagentRunResult } from "./runner";
import type { SubagentRegistry } from "./registry";
import type { WaitPacing } from "./waitTool";

/**
 * How deep delegation may nest, counting levels that may spawn children.
 *
 * The parent (depth 0) and its subagent (depth 1) both get the spawn/wait
 * pair, so a child can hand off a subtask; a grandchild (depth 2) does not —
 * the tree is capped at parent → child → grandchild. The limit lives in this
 * module rather than in the service because it is delegation policy, and the
 * cap matters for the same reason Claude Code's nesting does: each level
 * replays the full tool set and system prompt, so unbounded trees burn tokens
 * silently. Enforced by construction — the depth-2 tool set simply never
 * contains the tools — not by prompt-begging.
 */
export const SUBAGENT_DEPTH_LIMIT = 2;

/**
 * How many subagents may be running at once, across the whole tree.
 *
 * This is the one place a *new* limit is warranted rather than a relaxed one:
 * nothing else stops a parent from fanning out until the provider starts
 * refusing requests, and a rate limit surfaces as an opaque per-child failure
 * that looks like the task went wrong rather than like the fan-out was too
 * wide. Claude Code caps concurrent subagents at 20 and Codex at 4; 20 is the
 * looser of the two and far above any plausible deliberate fan-out, so it
 * bounds the runaway case without touching normal use. Settled children do not
 * count — unlike Codex, a finished child holds nothing until it is collected.
 */
export const SUBAGENT_CONCURRENCY_LIMIT = 20;

/**
 * Everything the delegation tools reach for at execution time.
 *
 * Getters rather than captured values because the parent service re-resolves
 * its model and transport per request (see `ObsidianAgentService.resolveStreamFn`);
 * a subagent started after a settings change must ride the new wiring, not the
 * wiring that existed when the tools were built. The registry and child-tool
 * factory come from the extension so both tools and the depth policy live in
 * one place.
 */
export interface SubagentToolsContext {
	getModel: () => Model<string>;
	getStreamFn: () => StreamFn;
	getThinkingLevel: () => ThinkingLevel;
	/** Models a spawn may pick from; absent when the host offers no choice. */
	listModels?: () => readonly SubagentModelChoice[];
	resolveModel?: (choiceId: string) => Model<string> | undefined;
	/** Provider registry a child compacts through; absent means no compaction. */
	getModels?: () => Models | undefined;
	getCompactionSettings?: (contextWindow: number) => CompactionSettings | undefined;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/** Skills the subagent's prompt lists and its `read_skill` tool serves. */
	getSkills: () => readonly Skill[];
	registry: SubagentRegistry;
	/**
	 * Builds the tool set a spawned child runs with. The argument is the
	 * child's depth — the depth cap only holds if it travels with every spawn,
	 * so a depth-2 set must be buildable too (spawn/wait absent from it).
	 */
	/**
	 * The tool set one level deeper, bound to the conversation that owns the tree.
	 *
	 * The owner has to be passed rather than re-derived: a grandchild's tools run
	 * long after the host stopped being able to say which conversation is acting,
	 * so the id is captured here and travels down in a closure.
	 */
	createChildTools: (depth: number, ownerId: string) => AgentTool[];
	/**
	 * The conversation a top-level spawn belongs to, per the host. Absent when the
	 * host does not distinguish conversations; see {@link OWNER_UNKNOWN}.
	 */
	getOwnerId?: () => string | undefined;
	/**
	 * Wait-window bounds. Only tests set this; production waits take the
	 * Codex constants.
	 */
	waitPacing?: WaitPacing;
}

/** What one child run needs beyond the host wiring the context already carries. */
export interface ChildRunSpec {
	task: string;
	/** What the child runs as, resolved: its role, its model, its clamped level. */
	role: SubagentRole;
	instructions?: string;
	model: Model<string>;
	thinkingLevel: ThinkingLevel;
	/** The child's own depth, so its tool set is one level below its parent's. */
	depth: number;
	/** Context to continue from; absent starts the child with an empty transcript. */
	initialMessages?: readonly AgentMessage[];
	/**
	 * The conversation the whole subtree answers to, threaded down so every
	 * descendant's tools scope to the chat that started the tree — not to
	 * whatever is on screen when a grandchild happens to spawn.
	 */
	ownerId: string;
	/** The child's linked signal — the run's kill switch. */
	signal: AbortSignal;
	/**
	 * Per-turn progress callback, routed to the registry by both callers.
	 *
	 * Lives on the spec rather than being read off the context so the caller
	 * binds it to the right entry id — the id exists here but not inside
	 * {@link startChildRun}, which stays spec-shaped and registry-blind.
	 */
	onProgress?: (messages: readonly AgentMessage[]) => void;
}

/**
 * Starts one child run against the host's wiring as it stands right now.
 *
 * Shared by the spawn and the follow-up because those two differ in exactly one
 * thing — whether the child starts empty or continues — and everything else here
 * is a seam that must not drift between them. What is read at this moment is the
 * host's: transport, key resolution, the skill listing, the compaction registry
 * and its thresholds, so a run started after a settings change rides the new
 * wiring. What a follow-up deliberately does *not* re-read arrives on the spec:
 * the role, the model and the level are the child's own, decided when it was
 * spawned and kept because a transcript belongs to the model that wrote it.
 */
export function startChildRun(context: SubagentToolsContext, spec: ChildRunSpec): Promise<SubagentRunResult> {
	return runSubagent({
		task: spec.task,
		role: spec.role,
		instructions: spec.instructions,
		tools: context.createChildTools(spec.depth, spec.ownerId),
		skills: context.getSkills(),
		model: spec.model,
		streamFn: context.getStreamFn(),
		thinkingLevel: spec.thinkingLevel,
		models: context.getModels?.(),
		compactionSettings: spec.model.contextWindow ? context.getCompactionSettings?.(spec.model.contextWindow) : undefined,
		getApiKey: context.getApiKey,
		initialMessages: spec.initialMessages,
		signal: spec.signal,
		onProgress: spec.onProgress,
	});
}

/**
 * Thinking levels a spawn may ask for.
 *
 * pi's own seven-member union, minus nothing: the clamp at spawn time reduces
 * whatever is asked for to what the child's model actually supports, so
 * advertising the full set costs nothing and hiding members would make the
 * parameter model-specific — which it cannot be, since the schema is built once
 * and the model is chosen per call.
 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * The spawn schema, built per tool construction because two of its members
 * depend on the user's settings.
 *
 * `model` is a literal union over ids only the host knows, so it cannot live at
 * module scope like `role` does. `Static` for a `TLiteral<string>` union is
 * plain `string` — honest, since a runtime-only list genuinely cannot narrow
 * further, while the schema still constrains the value to the enumerated ids.
 * When the host offers no models the member is omitted outright rather than
 * emitted empty: an empty `anyOf` is a parameter the model can only get wrong.
 */
function buildSpawnParameters(modelChoices: readonly SubagentModelChoice[]) {
	return Type.Object({
		task: Type.String({
			description:
				"The complete, self-contained task for the subagent. It cannot see this conversation, so include every path, quote, and constraint it needs.",
		}),
		role: Type.Optional(
			Type.Union(
				// `Union` computes its `Static` only from a tuple; `.map` alone widens
				// the members to an array and the parameter type collapses to never.
				// The variadic tail keeps the static type honest whatever the role
				// count grows to — a fixed-length cast would go stale on the next role.
				SUBAGENT_ROLES.map((role) => Type.Literal(role.name)) as [
					TLiteral<SubagentRoleName>,
					...TLiteral<SubagentRoleName>[],
				],
				{ description: "Worker profile to run the task under. Defaults to general." },
			),
		),
		instructions: Type.Optional(
			Type.String({
				description:
					"Standing framing for the whole run that is not the task itself — an output contract, a format, a constraint that holds every turn. Put the work in `task` and the framing here.",
			}),
		),
		...(modelChoices.length > 0
			? {
				model: Type.Optional(
					Type.Union(
						modelChoices.map((choice) => Type.Literal(choice.id)) as [TLiteral<string>, ...TLiteral<string>[]],
						{ description: "Which configured model to run this subagent on. Omit to inherit this conversation's model." },
					),
				),
			}
			: {}),
		thinkingLevel: Type.Optional(
			Type.Union(
				THINKING_LEVELS.map((level) => Type.Literal(level)) as [TLiteral<ThinkingLevel>, ...TLiteral<ThinkingLevel>[]],
				{
					description:
						"Reasoning effort for this subagent. Omit to inherit this conversation's. Reduced automatically to what the chosen model supports, which for a model without reasoning is off.",
				},
			),
		),
	});
}

type SpawnParameters = ReturnType<typeof buildSpawnParameters>;

const ROLE_NAMES = SUBAGENT_ROLES.map((role) => role.name).join(", ");

/** The model menu as the tool description spells it out, so the model can pick by name. */
function describeModelChoices(choices: readonly SubagentModelChoice[]): string {
	if (choices.length === 0) {
		return "";
	}
	return ` Models you may run a subagent on, as label → id: ${choices.map((choice) => `${choice.label} → ${choice.id}`).join("; ")}. Omit model to inherit this conversation's; pick a cheaper one for broad mechanical work.`;
}

/**
 * The `spawn_subagent` tool: starts one in-process subagent and returns at once.
 *
 * The subagent runs on the same model and transport as the parent but an
 * isolated, in-memory transcript — nothing it does lands in the session log,
 * and its only output is the report a later {@link createWaitSubagentTool}
 * call collects. Nesting is capped by construction: the extension hands the
 * delegation tools only to sets at depth {@link SUBAGENT_DEPTH_LIMIT} allows,
 * and a grandchild's set never contains them, so the tree cannot grow past
 * that floor. Width is capped at runtime instead, by
 * {@link SUBAGENT_CONCURRENCY_LIMIT} — depth is a property of a tool set, but
 * how many children are alive is only knowable when a spawn is asked for.
 */
/**
 * The owner id every child gets when the host names no conversation.
 *
 * A single shared bucket rather than `undefined`, so ownership is one
 * non-nullable field and every lookup is the same equality test. A host without
 * conversations puts its whole tree here, which is exactly the one group it
 * should be.
 */
export const OWNER_UNKNOWN = "";

/**
 * Resolves the conversation a level's tools answer to.
 *
 * An inherited id wins outright: a child level was told who it belongs to at
 * build time, and asking the host again would answer with whatever conversation
 * happens to be acting now — a different one, whenever a background chat
 * delegated. Only the top level asks, and it asks inside the tool's synchronous
 * prologue, while the host can still name the runtime whose tool is running.
 */
export function resolveOwnerId(context: SubagentToolsContext, inherited: string | undefined): string {
	return inherited ?? context.getOwnerId?.() ?? OWNER_UNKNOWN;
}

/**
 * @param inheritedOwnerId The conversation this level belongs to, when a parent
 * level already resolved it. Undefined at the top level only.
 */
export function createSpawnSubagentTool(context: SubagentToolsContext, depth: number, inheritedOwnerId?: string): AgentTool<SpawnParameters> {
	// Read once per construction, not per call: the schema is fixed for this tool
	// instance, so a settings change reaches the next agent build rather than
	// desynchronizing the advertised ids from the ones this schema accepts.
	const modelChoices = context.listModels?.() ?? [];
	return {
		name: "spawn_subagent",
		label: "Spawn subagent",
		description: `Start one self-contained task on a subagent and return immediately with its id — do not wait for the result here; collect it with wait_subagent. The subagent runs with this vault's tools and the same mounted MCP tools you have, and reports back when done. Use it when a task is better worked in isolation — a broad vault sweep, a critique, a summary — or when the intermediate tool output would flood this conversation. Several spawns started together run in parallel (up to ${SUBAGENT_CONCURRENCY_LIMIT} at once); check on them with list_subagents, stop one you no longer need with kill_subagent, and give one that has already reported another instruction with follow_up_subagent instead of spawning a replacement. Roles: ${ROLE_NAMES}; narrow one further with the instructions parameter for standing framing that is not the task.${describeModelChoices(modelChoices)} The subagent cannot ask questions; its reply is its only output, so a good task leaves nothing unsaid. It may spawn one further level down, but no deeper.`,
		parameters: buildSpawnParameters(modelChoices),
		execute: async (_toolCallId, params, signal) => {
			throwIfAborted(signal);
			const role = findSubagentRole(params.role ?? DEFAULT_SUBAGENT_ROLE_NAME);
			if (!role) {
				// Unreachable for schema-valid calls; kept because a hand-rolled
				// payload through a shim deserves a named error, not `undefined` noise.
				throw new Error(`Unknown subagent role: ${params.role}. Valid roles: ${ROLE_NAMES}`);
			}
			const live = context.registry.liveCount();
			if (live >= SUBAGENT_CONCURRENCY_LIMIT) {
				// Named as a pacing problem rather than a fault, because that is what
				// it is and the recovery is obvious: collect something first.
				throw new Error(
					`${live} subagents are already running, which is the limit (${SUBAGENT_CONCURRENCY_LIMIT}). The limit covers every conversation in this vault, so some of those may not be yours — check with list_subagents. Collect one with wait_subagent or stop one with kill_subagent, then spawn again.`,
				);
			}
			// A model the schema advertised but the host can no longer resolve means
			// the user deleted it between agent builds. Naming it beats letting the
			// child silently run on the parent's model, which is a different answer
			// than the one the parent asked for.
			const requestedModelId = (params as { model?: string }).model;
			const model = requestedModelId === undefined ? context.getModel() : context.resolveModel?.(requestedModelId);
			if (!model) {
				throw new Error(
					`Unknown model: ${requestedModelId}. Valid ids: ${modelChoices.map((choice) => choice.id).join(", ") || "(none configured)"}`,
				);
			}
			// Clamped whenever a model was chosen, not only when a level was: the
			// inherited parent level is the unsafe input and the common case, since
			// it was clamped against the parent's model, not this one.
			const requestedLevel = (params as { thinkingLevel?: ThinkingLevel }).thinkingLevel ?? context.getThinkingLevel();
			const thinkingLevel = clampThinkingLevel(model, requestedLevel);
			const id = context.registry.nextId();
			// Resolved here, in the prologue, and then carried: everything below this
			// line is either synchronous or a closure the registry calls at once, so
			// this is the last moment the host can still be asked.
			const ownerId = resolveOwnerId(context, inheritedOwnerId);
			// The linked controller is the child's kill switch: it fires with the
			// parent run's signal (panel stop) and with disposeAll, and the runner
			// listens on it to abort the child `Agent`.
			const linked: LinkedSignals = linkSignals(signal);
			// One deeper than this tool's own set — the tree grows by exactly one
			// level per spawn, by construction.
			const childDepth = depth + 1;
			context.registry.spawn({
				id,
				// The wait scope is the run that called spawn, not the child's own
				// linked controller — the two signals are distinct by construction.
				parentSignal: signal,
				ownerId,
				abort: linked.abort,
				dispose: linked.dispose,
				// Verbatim for the inspector, and for any later errand: what it was
				// asked to do, and what it actually runs as (post-resolution,
				// post-clamp).
				task: params.task,
				instructions: params.instructions,
				depth: childDepth,
				role,
				model,
				thinkingLevel,
				start: () =>
					startChildRun(context, {
						task: params.task,
						role,
						instructions: params.instructions,
						model,
						thinkingLevel,
						depth: childDepth,
						// The whole subtree inherits this conversation: a grandchild belongs
						// to the chat that started the tree, not to whatever is on screen
						// when it happens to spawn.
						ownerId,
						signal: linked.signal,
						// The monitor panel's live process record: each turn lands in the
						// entry while the child works, not only after settlement. `id` is
						// in scope exactly here — the one place that knows both the run
						// and which entry it belongs to.
						onProgress: (messages) => context.registry.recordProgress(id, messages),
					}),
			});
			return textResult(`Subagent ${id} spawned (role: ${role.name}). Collect its report with wait_subagent.`, {
				subagentId: id,
				role: role.name,
				status: "running",
				// Reported because both can differ from what was asked for: an id the
				// user renamed, and a level the clamp reduced. A parent that requested
				// "max" on a non-reasoning model should see that it got "off".
				model: model.id,
				thinkingLevel,
			});
		},
	};
}
