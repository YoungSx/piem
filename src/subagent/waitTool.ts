import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { textResult, throwIfAborted, type TextResultBudget } from "../tools/toolResult";
import { sliceTextByLines, truncateToolOutputDetailed } from "../vault/truncate";
import type { SubagentEntry } from "./registry";
import { resolveOwnerId, type SubagentToolsContext } from "./spawnTool";

/**
 * Wait pacing. The default and the floor are Codex's; the ceiling is gone.
 *
 * How long to wait is the model's own call — it is the one that knows whether it
 * asked for a two-file grep or a whole-vault sweep, and a run has no deadline of
 * its own for a wait to have to fit inside. A ceiling here could only ever
 * override that judgement with a number picked in the dark.
 *
 * The floor stays, and it is not a cap in disguise: a sub-second wait is a busy
 * loop that bills a turn per poll, so the ten seconds buy the model nothing it
 * wanted and cost it nothing it can use.
 */
export const WAIT_DEFAULT_MS = 30_000;
export const WAIT_MIN_MS = 10_000;

/**
 * How much of a report the model may see per wait.
 *
 * A subagent report is the one tool result whose whole point is its own length,
 * and pi's default 2000-line cap — right for a file read, where the first
 * screenful is what the model wanted — cuts a vault sweep long before the byte
 * budget bites. Lines are left uncapped and the byte budget alone governs, so
 * the cap tracks what the provider actually charges for. `offset` pages past it.
 */
const REPORT_BUDGET: TextResultBudget = { maxLines: Number.POSITIVE_INFINITY };

export interface WaitPacing {
	defaultMs: number;
	minMs: number;
}

const DEFAULT_PACING: WaitPacing = { defaultMs: WAIT_DEFAULT_MS, minMs: WAIT_MIN_MS };

/** A wait window plus whether the caller's request survived the clamp. */
export interface ClampedWait {
	value: number;
	clamped: boolean;
}

/**
 * Raises a caller-supplied wait to the floor, and otherwise takes it as given.
 *
 * Waiting is the parent's own pacing knob, so a wild value is a nudged dial, not
 * an attack: undefined takes the default and anything under the floor lands on
 * it. Long values pass through untouched — the model is the one that knows what
 * it asked for. The result says whether the dial moved, which is the part worth
 * copying from Codex's `wait.rs`: a model whose 50ms request silently became 10s
 * otherwise reads the delay as a slow child. Bounds are injectable so tests can
 * shrink the floor to milliseconds.
 */
export function clampWait(timeoutMs: number | undefined, pacing: WaitPacing = DEFAULT_PACING): ClampedWait {
	if (timeoutMs === undefined) {
		return { value: pacing.defaultMs, clamped: false };
	}
	// NaN fails every comparison, so it would slip through a bare `<` guard and
	// arm a `setTimeout` that fires immediately — a busy loop, which is the one
	// thing the floor exists to prevent.
	const value = Number.isFinite(timeoutMs) ? Math.max(pacing.minMs, timeoutMs) : pacing.defaultMs;
	return { value, clamped: value !== timeoutMs };
}

/** The clamped window alone, for callers that do not report the clamp. */
export function clampWaitTimeoutMs(timeoutMs: number | undefined, pacing: WaitPacing = DEFAULT_PACING): number {
	return clampWait(timeoutMs, pacing).value;
}

const WaitParameters = Type.Object({
	subagentId: Type.Optional(
		Type.String({
			description:
				"Which spawned subagent to wait for. Omit it to wait for every subagent this conversation spawned at once.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description:
				"How long to wait before reporting progress, in milliseconds. Default 30s, floor 10s, no ceiling — set it to what the task is worth, and a long wait costs one turn instead of many polls.",
		}),
	),
	offset: Type.Optional(
		Type.Number({
			description:
				"One-indexed line to resume a truncated report from. Use it with subagentId after a result says it was truncated, to page through the rest.",
		}),
	),
});

/** How one waited child renders in the tool result text. */
function describeEntry(entry: SubagentEntry): string {
	const who = `Subagent ${entry.id} (role: ${entry.role.name})`;
	if (!entry.settled) {
		return `${who} is still running.`;
	}
	if (entry.error) {
		// Named here because this line is where a parent meets a broken run, and the
		// cheap recovery is not obvious: the child kept its transcript, so picking it
		// up costs one instruction instead of the whole task again.
		return `${who} failed: ${entry.error.message}\nIt kept what it had learned — follow_up_subagent can pick it up from there instead of starting over.`;
	}
	const result = entry.result;
	if (result === undefined) {
		return `${who} settled without a result.`;
	}
	if (result.incomplete) {
		// The parent's next move depends entirely on knowing this is a fragment:
		// folded in as a finding, a half-finished sweep reads as a complete one.
		return `${who} ${killedNote(entry)}. Its work so far — INCOMPLETE, the task was NOT finished:\n${result.text}`;
	}
	if (!result.text) {
		// A clean run that had nothing to say. Distinguished from a failure on
		// purpose: "no matches" is an answer, and the parent must not retry it as
		// though the child had crashed.
		return `${who} finished with no report — it ran cleanly and produced no text.`;
	}
	return `${who} report:\n${result.text}`;
}

/** Why an aborted child stopped, in the words that fit who stopped it. */
function killedNote(entry: SubagentEntry): string {
	switch (entry.killedBy) {
		case "tool":
			return "was stopped by kill_subagent";
		case "teardown":
			return "was stopped when the session closed";
		case "user":
			// The user, not the parent, ordered this one — the parent must not own
			// a decision it did not make, nor retry what the user chose to end.
			return "was stopped by the user from the monitor panel";
		default:
			return "was stopped before it finished";
	}
}

/**
 * The `wait_subagent` tool: blocks until one or all spawned subagents settle,
 * or the wait window closes.
 *
 * This is the Codex wait_agent model — the child runs uncapped, and the
 * parent paces it by calling wait again; a window closing is "not done yet",
 * never a kill. The report text is the whole deliverable, so a single
 * settled child's text comes back as the content itself; several children
 * come back as one labeled digest.
 */
export function createWaitSubagentTool(context: SubagentToolsContext, inheritedOwnerId?: string): AgentTool<typeof WaitParameters> {
	return {
		name: "wait_subagent",
		label: "Wait for subagent",
		description:
			"Wait for a spawned subagent's report. Pass the id from spawn_subagent, or omit it to wait on every subagent this conversation spawned. If the wait returns 'still running', call wait again rather than spinning — the subagent keeps working between waits. If a report comes back truncated, wait again on that id with `offset` to read the rest.",
		parameters: WaitParameters,
		execute: async (_toolCallId, params, signal) => {
			throwIfAborted(signal);
			const ownerId = resolveOwnerId(context, inheritedOwnerId);
			// Spawned entries always carry a real signal (the linked controller's),
			// so an undefined one here can only come from a hostless caller — in
			// that case scoping degrades to this conversation's children, which
			// keeps the tool usable outside a run without reaching into another chat.
			const known = (s?: AbortSignal) => (s ? context.registry.forSignal(s) : context.registry.forOwner(ownerId));
			let targets: SubagentEntry[];
			if (params.subagentId !== undefined) {
				const entry = context.registry.get(params.subagentId);
				// An id belonging to another conversation is refused as unknown rather
				// than as forbidden. Collecting it would splice a chat the user never
				// asked about into this transcript and this session log, and the model
				// has no use for the difference: either way there is nothing here to
				// wait on. Ids are process-wide and sequential, so a model that lost
				// track of its own could otherwise reach a stranger's by guessing.
				if (!entry || entry.ownerId !== ownerId) {
					const ids = known(signal).map((e) => e.id);
					throw new Error(
						`Unknown subagent id: ${params.subagentId}` +
							(ids.length ? `. This conversation spawned: ${ids.join(", ")}` : ". Nothing has been spawned here."),
					);
				}
				targets = [entry];
			} else {
				targets = known(signal);
				if (targets.length === 0) {
					// Children of an earlier run are still collectable by id — the
					// registry ignores signals on lookup — so "nothing was spawned"
					// would be a lie whenever any entry exists at all. Only this
					// conversation's, for the reason the id branch above refuses others.
					const elsewhere = context.registry.forOwner(ownerId).map((e) => e.id);
					throw new Error(
						elsewhere.length
							? `No subagents spawned in this turn. Earlier turns spawned: ${elsewhere.join(", ")} — wait on one by id.`
							: "No subagents to wait for — spawn one first with spawn_subagent.",
					);
				}
			}

			// Named `waitWindow`, not `window`: the timer below has to be the global
			// `window.setTimeout` (popout-window compatibility), and a local called
			// `window` would shadow it into calling this object instead.
			const waitWindow = clampWait(params.timeoutMs, context.waitPacing);
			// Entries never reject here: each outcome — report, failure, or "the
			// window closed first" — is data for the parent, not a tool error.
			const settled = Promise.all(
				targets.map((entry) => entry.promise.then(
					() => undefined,
					() => undefined,
				)),
			);
			await Promise.race([settled, new Promise((resolve) => window.setTimeout(resolve, waitWindow.value))]);

			// A clamped request is reported whatever the outcome: the model needs it
			// to tell a slow child from its own rejected pacing.
			const pacing = waitWindow.clamped ? { requestedTimeoutMs: params.timeoutMs, effectiveTimeoutMs: waitWindow.value } : {};
			const anyRunning = targets.some((entry) => !entry.settled);
			if (anyRunning) {
				return textResult(
					targets.map(describeEntry).join("\n\n"),
					{ status: "running", subagentIds: targets.map((t) => t.id), ...pacing },
					REPORT_BUDGET,
				);
			}
			const details = targets.map((entry) => ({
				subagentId: entry.id,
				role: entry.role.name,
				status: entry.error ? ("failed" as const) : entry.result?.incomplete ? ("incomplete" as const) : ("done" as const),
				...(entry.result
					? {
						turns: entry.result.turns,
						usage: { tokens: entry.result.usage.tokens, cost: entry.result.usage.cost, requests: entry.result.usage.requests },
						...(entry.result.incomplete ? { incomplete: entry.result.incomplete } : {}),
					}
					: {}),
				...(entry.error ? { error: entry.error.message } : {}),
			}));
			// Paging is per-report, so it only applies to a single target — an offset
			// into a multi-child digest would slice across reports. A lone target
			// takes this path even without an offset, so a first read that gets cut
			// is told where to resume rather than left to infer it.
			const single = targets.length === 1 ? targets[0] : undefined;
			if (single?.result?.text) {
				// Partial work pages too: a salvaged sweep is often the longest text
				// in the tree, and capping it unreadably would undo the salvage.
				return pagedResult(single, params.offset ?? 1, { status: "settled", subagents: details, ...pacing });
			}
			return textResult(targets.map(describeEntry).join("\n\n"), { status: "settled", subagents: details, ...pacing }, REPORT_BUDGET);
		},
	};
}

/**
 * One child's report resumed from a line, for reading past a truncation.
 *
 * The cap is applied to the report body alone and the header prepended after,
 * so `nextOffset` counts the report's own lines. Folding the header into the
 * capped text instead would shift every line number by one, and a model
 * resuming from a reported count would silently skip or repeat a line each page.
 */
function pagedResult(
	entry: SubagentEntry,
	offset: number,
	details: Record<string, unknown>,
): ReturnType<typeof textResult> {
	const result = entry.result;
	const slice = sliceTextByLines(result?.text ?? "", { offset });
	const capped = truncateToolOutputDetailed(slice.text, undefined, Number.POSITIVE_INFINITY);
	const shown = slice.startLine + capped.outputLines - 1;
	// The incompleteness warning leads every page, not just the last: a parent
	// that reads page one and stops must not have been told only "there is more",
	// or a half-finished sweep is folded in as a finding.
	const warning = result?.incomplete
		? `INCOMPLETE — the task was NOT finished; it ${killedNote(entry)}. What it wrote before stopping:\n`
		: "";
	const ending = result?.incomplete ? " (end of what it wrote)." : " (complete).";
	const header =
		`${warning}Subagent ${entry.id} (role: ${entry.role.name}) report, lines ${slice.startLine}-${shown} of ${slice.totalLines}` +
		// Naming the next offset outright is cheaper than asking the model to do
		// arithmetic on a truncation notice, and it cannot be off by one.
		(shown < slice.totalLines ? ` — call wait_subagent again with offset ${shown + 1} for the rest.` : ending);
	return {
		content: [{ type: "text", text: `${header}\n${capped.text}` }],
		details:
			shown < slice.totalLines
				? { ...details, truncated: true, totalLines: slice.totalLines, outputLines: capped.outputLines, nextOffset: shown + 1 }
				: details,
	};
}
