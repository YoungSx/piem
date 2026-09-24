/**
 * summary.ts — render a finished workflow run as text for the tool result.
 *
 * The model gets its structured `value` in the tool details; this is the prose
 * beside it — status, how many agents ran (and how many replayed), a per-phase
 * done/failed tally, and any `log()` lines. Kept out of the tool file because it
 * is the one piece a future card renderer would share.
 */

import type { WorkflowAgentEntry, WorkflowEntry } from "./progress";
import type { WorkflowRunResult } from "./runtime";

const isAgent = (entry: WorkflowEntry): entry is WorkflowAgentEntry => entry.type === "workflow_agent";

/** One line per phase: "Phase — 3 done, 1 failed". Ungrouped agents fall under "Agents". */
function phaseTally(progress: readonly WorkflowEntry[]): string[] {
	const groups = new Map<string, { done: number; failed: number }>();
	// Last write wins per index, matching how the log is rendered: an agent
	// re-emitted from start→done must count once, in its final state.
	const latest = new Map<number, WorkflowAgentEntry>();
	for (const entry of progress) {
		if (isAgent(entry)) latest.set(entry.index, entry);
	}
	for (const agent of latest.values()) {
		const title = agent.phaseTitle ?? "Agents";
		const group = groups.get(title) ?? { done: 0, failed: 0 };
		if (agent.state === "error") group.failed++;
		else if (agent.state === "done") group.done++;
		groups.set(title, group);
	}
	const lines: string[] = [];
	for (const [title, group] of groups) {
		const parts = [`${group.done} done`];
		if (group.failed > 0) parts.push(`${group.failed} failed`);
		lines.push(`  ${title} — ${parts.join(", ")}`);
	}
	return lines;
}

export function summarizeRun(result: WorkflowRunResult, runId: string): string {
	const lines: string[] = [];
	lines.push(`Workflow "${result.meta.name}" ${result.status}.`);
	lines.push(
		`Run id: ${runId}${result.replayedCount > 0 ? ` (${result.replayedCount} of ${result.agentCount} agents replayed from journal)` : ` (${result.agentCount} agents)`}`,
	);

	const tally = phaseTally(result.progress);
	if (tally.length > 0) {
		lines.push("Phases:");
		lines.push(...tally);
	}

	const logs = result.progress
		.filter((entry): entry is Extract<WorkflowEntry, { type: "workflow_log" }> => entry.type === "workflow_log")
		.map((entry) => entry.message);
	if (logs.length > 0) {
		lines.push("Log:");
		for (const message of logs) lines.push(`  ${message}`);
	}

	if (result.status === "failed" && result.error !== undefined) {
		lines.push(`Error: ${result.error}`);
	}

	if (result.value !== undefined) {
		lines.push("Returned value:");
		lines.push(JSON.stringify(result.value, null, 2));
	} else if (result.status === "completed") {
		lines.push("The script returned nothing; read the agents' work from the vault or their reports.");
	}

	return lines.join("\n");
}
