/**
 * workflowTool.ts — the model-facing `run_workflow` tool.
 *
 * Wraps {@link runWorkflow} in an `AgentTool`: it takes a script, runs it to
 * completion against a {@link WorkflowHost} the caller supplies, and returns a
 * text summary of the run (status, per-phase agent counts, the returned value).
 * The journal is kept in memory keyed by a run id so `resumeFromRunId` can skip
 * the unchanged prefix on a re-run within the session — the common
 * edit-and-rerun loop. Cross-restart resume is deferred.
 *
 * ponytail: in-memory journal, per-session. Persist to the vault if
 * cross-restart resume is ever asked for.
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { textResult } from "../tools/toolResult";
import type { WorkflowHost } from "./runtime";
import { runWorkflow, type WorkflowRunResult } from "./runtime";
import type { WorkflowJournalEntry } from "./journal";
import { buildWorkflowToolDescription } from "./toolDescription";
import { summarizeRun } from "./summary";

/** A place to stash journals between tool calls so `resumeFromRunId` has a prefix. */
export interface WorkflowJournalStore {
	read(runId: string): readonly WorkflowJournalEntry[] | undefined;
	create(runId: string): (entry: WorkflowJournalEntry) => void;
}

/** The default store: a `Map` that lives as long as the service does. */
export function createMemoryJournalStore(): WorkflowJournalStore {
	const journals = new Map<string, WorkflowJournalEntry[]>();
	return {
		read: (runId) => journals.get(runId),
		create: (runId) => {
			const entries: WorkflowJournalEntry[] = [];
			journals.set(runId, entries);
			return (entry) => { entries.push(entry); };
		},
	};
}

export interface WorkflowToolContext {
	host: WorkflowHost;
	store: WorkflowJournalStore;
	/** Generates a run id. Injected so a test can make it deterministic. */
	newRunId: () => string;
	/** Fired with each progress batch, for a live panel. Optional. */
	onProgress?: WorkflowRunResult extends never ? never : (runId: string, entries: unknown) => void;
	/** The agent roster string interpolated into the description's `{{typeList}}`. */
	agentTypes?: readonly string[];
}

const WorkflowParameters = Type.Object({
	script: Type.String({
		description:
			"The full workflow script, starting with `export const meta = { name, description }`. Plain JavaScript (not TypeScript): no type annotations. Use agent()/parallel()/pipeline()/phase()/log() and return a JSON-serializable value.",
		maxLength: 524_288,
	}),
	args: Type.Optional(
		Type.Unknown({
			description:
				"A JSON value exposed to the script as the global `args`. Pass arrays/objects as real JSON, not a JSON string.",
		}),
	),
	resumeFromRunId: Type.Optional(
		Type.String({
			description:
				"A run id from an earlier call in this session. Completed agent() calls with unchanged (prompt, opts) replay from the journal instantly; only edited or new calls re-run. Same script + same args = full cache hit.",
		}),
	),
});

export function createWorkflowTool(context: WorkflowToolContext): AgentTool {
	return {
		name: "run_workflow",
		label: "Run workflow",
		description: buildWorkflowToolDescription(context.agentTypes ?? []),
		parameters: WorkflowParameters,
		execute: async (_toolCallId, params, signal) => {
			const { script, args, resumeFromRunId } = params as {
				script: string;
				args?: unknown;
				resumeFromRunId?: string;
			};
			const runId = context.newRunId();
			const priorEntries = resumeFromRunId !== undefined ? context.store.read(resumeFromRunId) : undefined;
			if (resumeFromRunId !== undefined && priorEntries === undefined) {
				return textResult(
					`No workflow journal found for run id "${resumeFromRunId}" in this session. Run without resumeFromRunId to start fresh.`,
					{ runId, resumed: false },
				);
			}
			const append = context.store.create(runId);

			const result = await runWorkflow({
				script,
				...(args !== undefined ? { args } : {}),
				host: context.host,
				...(signal !== undefined ? { signal } : {}),
				journal: {
					...(priorEntries !== undefined ? { entries: priorEntries } : {}),
					append,
				},
			});

			const summary = summarizeRun(result, runId);
			return textResult(summary, {
				runId,
				status: result.status,
				agentCount: result.agentCount,
				replayedCount: result.replayedCount,
				...(result.value !== undefined ? { value: result.value } : {}),
				...(result.error !== undefined ? { error: result.error } : {}),
			});
		},
	};
}
