/**
 * Named worker profiles a parent agent can delegate to.
 *
 * A role is a system-prompt appendix plus nothing else — no tool policy. That
 * deliberately mirrors how Claude Code shapes agents: tool access is inherited
 * whole, and read-only-ness lives in the role's instructions rather than in a
 * stripped tool set. The one structural boundary left is depth (see
 * `SUBAGENT_DEPTH_LIMIT` in `spawnTool.ts`), which no prompt can fake.
 */

/**
 * Stable identifiers the `spawn_subagent` tool's schema advertises.
 *
 * A literal union, not `string`: the schema builds `Type.Literal(role.name)`
 * from these, and a wide `string` there degrades the schema's `Static` to
 * `never` — the tool's own parameter type would reject the roles it names.
 */
export type SubagentRoleName = "general" | "scout" | "reviewer";

export interface SubagentRole {
	/** Stable identifier the `spawn_subagent` tool's schema advertises. */
	name: SubagentRoleName;
	/** One line shown to the parent model in the tool description. */
	description: string;
	/** Extra instructions appended after the subagent base prompt. */
	instructions: string;
}

export const SUBAGENT_ROLES: readonly SubagentRole[] = [
	{
		name: "general",
		description: "Default worker for any self-contained task.",
		instructions:
			"Work through the task end to end. Use tools when they help; skip them when the answer is already in the task.",
	},
	{
		name: "scout",
		description: "Research-oriented sweep across the vault; returns findings.",
		instructions:
			"Research first. Your deliverable is a report of findings, not edits — leave the vault unchanged unless the task explicitly asks for changes. Report what you found, where it lives, and what remains uncertain.",
	},
	{
		name: "reviewer",
		description: "Critique of notes or a plan; returns an assessment.",
		instructions:
			"Assess, do not fix: your deliverable is the assessment itself, not the fixed note. Name concrete strengths and problems, quote the note text you are judging, and end with a short prioritized list of what to change.",
	},
];

export const DEFAULT_SUBAGENT_ROLE_NAME = "general";

export function findSubagentRole(name: string): SubagentRole | undefined {
	return SUBAGENT_ROLES.find((role) => role.name === name);
}

/**
 * Base system prompt every subagent runs under, before the role appendix.
 *
 * The framing answers the two failure modes in-process subagents actually hit:
 * the model trying to address the user directly, and the model ending with a
 * question instead of a deliverable. A subagent has no channel back — its only
 * output is the report the parent reads as a tool result.
 */
const SUBAGENT_BASE_PROMPT = [
	"You are a subagent working inside the user's Obsidian vault on one delegated task.",
	"You cannot see the parent conversation and the user cannot see your process — your final message is the whole deliverable, read by the parent agent as a tool result.",
	"Therefore: never ask questions, never await input, never address the user. Finish the task and end with a complete, self-contained report.",
	"Structure the report so the parent can use it without re-reading the vault: the answer first, then the evidence (note paths, quotes, counts), then anything you could not determine.",
].join(" ");

/**
 * The child's system prompt: base framing, role appendix, then the caller's own.
 *
 * `instructions` is where a parent puts standing framing that is not the task —
 * an output contract, a house style, a constraint that holds for every turn.
 * Folding it into `task` instead is what the three shipped roles otherwise force,
 * and it reads worse to the model each turn: the task text is the thing to do,
 * and a persona buried in it competes with the work for attention. It lands last
 * so a parent can narrow the role it picked without being able to unsay the base
 * framing — a subagent that starts asking the user questions is broken whatever
 * the caller asked for.
 */
export function composeSubagentPrompt(role: SubagentRole, instructions?: string): string {
	const base = `${SUBAGENT_BASE_PROMPT}\n\nRole — ${role.name}: ${role.instructions}`;
	const extra = instructions?.trim();
	return extra ? `${base}\n\nAdditional instructions for this task: ${extra}` : base;
}
