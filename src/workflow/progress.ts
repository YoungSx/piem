/**
 * progress.ts — the append-only progress log entries a workflow run emits.
 *
 * Types only, ported from tintinweb/pi-subagents' `progress.ts` (which also
 * renders terminal UI off these entries). Piem v1 keeps the log as data — the
 * tool result summarizes it, and a future panel reads the same shapes.
 *
 * The log is append-only and last-write-wins per `index`: re-emitting an entry
 * with the same `index` replaces the previous one, which is how a running row
 * updates in place.
 */

export type WorkflowEntryState = "start" | "progress" | "done" | "error";

export type AttemptReason = "throttled" | "user-retry" | "stalled";

export interface WorkflowPhaseEntry {
	type: "workflow_phase";
	index: number;
	title: string;
}

export interface WorkflowLogEntry {
	type: "workflow_log";
	message: string;
}

export interface WorkflowAgentEntry {
	type: "workflow_agent";
	/** Stable identity. Re-emitting this index replaces the previous entry. */
	index: number;
	label: string;
	/**
	 * Absent when the agent ran before any `phase()` call. That is the signal —
	 * not a default of 0 — that turns the whole run into one "Agents" group.
	 */
	phaseIndex?: number;
	phaseTitle?: string;
	state: WorkflowEntryState;
	/** The run's own `wf-agent-N` handle; means nothing outside the runtime. */
	agentId?: string;
	agentType?: string;
	/**
	 * The child's own id in the subagent registry, once it has one.
	 *
	 * Distinct from {@link agentId}, the run's `wf-agent-N` handle that means
	 * nothing outside the runtime. This is what a future inspector opens a
	 * conversation on, reported the moment the host issues it.
	 */
	recordId?: string;
	/**
	 * Short model label for tight rows, e.g. `haiku 4.5`.
	 *
	 * Seeded from what the script asked for and then REPLACED by what the child
	 * actually ran on, once its session exists to report one — the same
	 * effective-not-requested rule every other subagent surface follows.
	 */
	model?: string;
	/** Canonical `provider/model-id`, for a surface with room for it. */
	modelId?: string;
	/** The level actually in effect, once the child's session reports one. */
	thinking?: string;
	/**
	 * What the call asked for, kept only when it did not get it — the host
	 * clamped the level. Rendered as `(asked max)` beside the effective value
	 * rather than silently replacing it.
	 */
	requestedThinking?: string;
	requestedModel?: string;
	error?: string;
	skipped?: boolean;
	/** True when the entry came back from the resume journal instead of running. */
	cached?: boolean;
	queuedAt?: number;
	startedAt?: number;
	lastProgressAt?: number;
	attempt?: number;
	lastAttemptReason?: AttemptReason;
	promptPreview?: string;
	resultPreview?: string;
	tokens?: number;
	toolCalls?: number;
	durationMs?: number;
}

export type WorkflowEntry = WorkflowPhaseEntry | WorkflowLogEntry | WorkflowAgentEntry;
