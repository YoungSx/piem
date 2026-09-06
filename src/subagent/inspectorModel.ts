import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UsageTotals } from "../agent/usage";
import { statusOf, type SubagentEntry, type SubagentRegistry } from "./registry";

/**
 * One subagent as the inspector renders it.
 *
 * A plain copy, not the live entry: entries keep running promises and abort
 * handles on them, and a React tree holding either would hold a kill switch
 * and a subscription channel it never asked for. Everything here is data.
 */
export interface SubagentSnapshot {
	id: string;
	role: string;
	/** The task the spawn was given, verbatim. */
	task: string;
	/**
	 * Later errands the parent handed this child, in order, when there were any.
	 *
	 * Absent for the common single-errand run, so the detail page's task block
	 * stays one paragraph unless there is genuinely a history to read.
	 */
	followUps?: readonly string[];
	instructions?: string;
	/** Tree level: 1 is a direct child of the chat panel. */
	depth: number;
	/**
	 * The conversation that ordered this run — see `SubagentEntry.ownerId`.
	 *
	 * Opaque to the inspector too: it groups and filters by it, and the label a
	 * reader sees is resolved by the UI, which is the only layer that can turn a
	 * session path into a conversation's name.
	 */
	ownerId: string;
	/** The model the child actually runs on, post-resolution. */
	modelId: string;
	thinkingLevel: string;
	status: ReturnType<typeof statusOf>;
	/** Who ordered the kill, when one was ordered. */
	killedBy?: SubagentEntry["killedBy"];
	/**
	 * Whether the reader has put this run away.
	 *
	 * The list moves an archived run into its own closed section rather than
	 * dropping it: the panel is the only window onto a record that dies with the
	 * session, so a control that hid a report irrecoverably would be a delete
	 * button wearing the word "archive".
	 */
	archived?: true;
	spawnedAt: number;
	settledAt?: number;
	/**
	 * How long the current errand took, or has been taking.
	 *
	 * Derived at snapshot time from `now`, passed in by the caller, so a render
	 * is deterministic and a test can pin the clock. A running child's duration
	 * grows until the next snapshot — the inspector re-snapshots on registry
	 * events, and only a timerless "still running" is honest between them. Measured
	 * from the errand's own start, not the child's birth: a child that answered in
	 * three seconds and was re-tasked an hour later did not run for an hour.
	 */
	durationMs: number;
	/** The final report text; present whenever a result was produced. */
	report?: string;
	/** Set when the report is partial; `killedBy` says whose decision that was. */
	incomplete?: true;
	/** The named failure, when the run threw. */
	errorMessage?: string;
	/**
	 * Assistant turns and billed tokens across every errand, or absent when
	 * nothing has settled yet.
	 *
	 * Cumulative, because the row is a child rather than a run: reporting the last
	 * errand's tokens as the child's cost would under-read it once by every errand
	 * before. Absent rather than zero while there is nothing measured, which is how
	 * `usageItems` tells "no data" from "measured nothing".
	 */
	turns?: number;
	usage?: UsageTotals;
	/**
	 * The child's context as its last run left it.
	 *
	 * Present for a failed run too: the failure carries the transcript out with it,
	 * so a run that died to a network fault shows every step it had taken rather
	 * than reading as though nothing happened. Empty only for a run that ended
	 * before its first turn, which the detail page words as "nothing recorded".
	 */
	messages: readonly AgentMessage[];
}

/** Copies one entry for rendering. `now` anchors a running child's duration. */
function toSnapshot(entry: SubagentEntry, now: number): SubagentSnapshot {
	return {
		id: entry.id,
		role: entry.role.name,
		task: entry.task,
		followUps: entry.followUps.length > 0 ? [...entry.followUps] : undefined,
		instructions: entry.instructions,
		depth: entry.depth,
		ownerId: entry.ownerId,
		modelId: entry.model.id,
		thinkingLevel: entry.thinkingLevel,
		status: statusOf(entry),
		killedBy: entry.killedBy,
		archived: entry.archived,
		spawnedAt: entry.spawnedAt,
		settledAt: entry.settledAt,
		durationMs: (entry.settledAt ?? now) - entry.startedAt,
		report: entry.result?.text,
		incomplete: entry.result?.incomplete,
		errorMessage: entry.error?.message,
		// Nothing settled yet reads as no measurement rather than a measured zero,
		// which is what keeps a row of zeroes off a run that has not reported.
		turns: entry.spent.turns > 0 ? entry.spent.turns : undefined,
		usage: entry.spent.usage.requests > 0 ? entry.spent.usage : undefined,
		messages: entry.transcript,
	};
}

/**
 * Snapshots every subagent the registry holds, in spawn order.
 *
 * Every chat's, not one chat's: the registry is per-service, and the panel that
 * consumes this is a tab rather than part of a conversation. Narrowing is the
 * caller's job — {@link snapshotsForOwner} for a surface that lives inside one
 * chat, {@link groupByOwner} for one that shows them all.
 *
 * The registry never prunes — entries die with the service — so this is the
 * whole plugin session's history, which is what the inspector is for.
 */
export function snapshotSubagents(registry: SubagentRegistry, now: number): SubagentSnapshot[] {
	return registry.all().map((entry) => toSnapshot(entry, now));
}

/** One conversation's runs, as the panel groups them. */
export interface SubagentOwnerGroup {
	ownerId: string;
	snapshots: SubagentSnapshot[];
}

/**
 * The runs one conversation ordered, in spawn order.
 *
 * What the chat panel's entry icon renders: the icon lives inside a
 * conversation, so the count beside it has to be that conversation's or it
 * reports someone else's work as this chat's.
 */
export function snapshotsForOwner(snapshots: readonly SubagentSnapshot[], ownerId: string): SubagentSnapshot[] {
	return snapshots.filter((snapshot) => snapshot.ownerId === ownerId);
}

/**
 * Groups runs by the conversation that ordered them, focused conversation first.
 *
 * Focused first because a reader who opened the panel while looking at a chat is
 * almost always asking about that chat; the rest follow in the order they first
 * delegated, which keeps the whole panel a record read forward — the same reason
 * runs within a group stay oldest-first.
 *
 * A group is created only by a run belonging to it, so a conversation that never
 * delegated never appears — including the focused one, whose absence is itself
 * the honest answer to "what is this chat waiting on".
 */
export function groupByOwner(snapshots: readonly SubagentSnapshot[], focusedOwnerId?: string): SubagentOwnerGroup[] {
	const groups = new Map<string, SubagentSnapshot[]>();
	for (const snapshot of snapshots) {
		const existing = groups.get(snapshot.ownerId);
		if (existing) {
			existing.push(snapshot);
		} else {
			groups.set(snapshot.ownerId, [snapshot]);
		}
	}
	// Insertion order is first-spawn order, which `Map` preserves; the focused
	// conversation is then lifted out of it rather than sorted for.
	const ordered = [...groups.entries()].map(([ownerId, owned]) => ({ ownerId, snapshots: owned }));
	const focusedIndex = focusedOwnerId === undefined ? -1 : ordered.findIndex((group) => group.ownerId === focusedOwnerId);
	if (focusedIndex > 0) {
		const [focused] = ordered.splice(focusedIndex, 1);
		ordered.unshift(focused!);
	}
	return ordered;
}

/**
 * Whether any child is running — the entry icon's three-state switch.
 *
 * Computed from the snapshots rather than `liveCount()` so the icon, the badge
 * and the list all read one snapshot and cannot disagree mid-render.
 */
export function anyRunning(snapshots: readonly SubagentSnapshot[]): boolean {
	return snapshots.some((snapshot) => snapshot.status === "running");
}
