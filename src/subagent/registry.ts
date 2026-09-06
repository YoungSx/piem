import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { addUsageTotals, EMPTY_USAGE_TOTALS, type UsageTotals } from "../agent/usage";
import type { SubagentRole } from "./roles";
import { SubagentRunError, type SubagentRunResult } from "./runner";

/**
 * The wiring one errand needs: how to stop it, how to unhook it, how to start it.
 *
 * Shared by {@link SubagentRegistry.spawn} and {@link SubagentRegistry.resume}
 * because a child's first errand and its third are the same thing from in here —
 * the caller links the signals and owns the run, the registry only records what
 * became of it.
 */
export interface SubagentRunHandle {
	/** Fires kill the run: the parent run's abort and `disposeAll` both land here. */
	abort: () => void;
	/** Unhooks the parent-signal listener; must run even when the run is never aborted. */
	dispose: () => void;
	/** Performs the run, with the caller's signal already attached. */
	start: () => Promise<SubagentRunResult>;
}

/** A short lowercase token; no easily-confused glyphs (i/l/o, 0/1). */
function randomSuffix(length: number): string {
	const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
	const bytes = new Uint8Array(length);
	// Web crypto, not node's: the plugin bundles for mobile too, where the Node
	// module either is absent or shimmed into a silent undefined.
	crypto.getRandomValues(bytes);
	let out = "";
	for (const byte of bytes) {
		// `byte % alphabet.length` cannot exceed the alphabet, but noUncheckedIndexed
		// makes the index read possibly-undefined, so `!` closes that.
		out += alphabet[byte % alphabet.length]!;
	}
	return out;
}

/** One spawned subagent's bookkeeping, from spawn to settlement. */
export interface SubagentEntry extends SubagentRunHandle {
	id: string;
	/**
	 * What this child runs as, held as the resolved thing rather than its name.
	 *
	 * A later errand has to run as the same child — same role appendix, same
	 * model, same clamped level — so the record keeps what it would need to start
	 * again, not a label to look up. The model matters most: a transcript is
	 * written against one model's history format, and continuing it on another is
	 * how thinking-block signatures and provider-specific history stop being
	 * valid. The wiring a re-task *does* re-read is the host's — transport, keys,
	 * skills, the vault tool set — because a settings change should reach it.
	 */
	role: SubagentRole;
	model: Model<string>;
	thinkingLevel: ThinkingLevel;
	/** The child's outcome; rejecting entries carry the named failure. */
	promise: Promise<SubagentRunResult>;
	/** Set once settled so a later wait can return the stored outcome. */
	settled: boolean;
	result?: SubagentRunResult;
	error?: Error;
	/**
	 * The child's context as its last run left it — the process record the panel
	 * reads, and the history another errand would continue from.
	 *
	 * Kept on the entry rather than read off `result` because a failed run has no
	 * result and its transcript is the most useful thing it produced: a run that
	 * died to a network fault mid-sweep still holds everything it had learned. The
	 * failure path carries it out through {@link SubagentRunError}, so both
	 * outcomes land here and the panel never has to word a failure as "nothing
	 * happened". Empty until the first settlement.
	 */
	transcript: readonly AgentMessage[];
	/**
	 * Why this child was cut short, when something cut it short.
	 *
	 * Recorded at the moment the kill is ordered rather than derived afterwards:
	 * once the run unwinds, a parent-stop, a teardown, an explicit `kill_subagent`
	 * and a monitor-panel stop are indistinguishable from the aborted signal
	 * alone, and the parent needs to know which one it was to word its own next
	 * move. With no deadline on a run, this is the only account of why a child
	 * stopped early.
	 */
	killedBy?: "parent" | "teardown" | "tool" | "user";
	/**
	 * Whether the reader has put this run away.
	 *
	 * Reader-side and reader-side only: no tool reads it, so archiving cannot
	 * change what the parent can collect, enumerate, stop, or re-task. That is the
	 * whole reason it is a flag here rather than a removal from the map — a panel
	 * control that could destroy an uncollected report would be a tidy-up button
	 * that loses work.
	 *
	 * It lives on the entry rather than in the panel's own state because the panel
	 * unmounts: React state would resurrect every archived row the next time the
	 * sidebar was opened, which is not what "archived" means in any application.
	 * Session memory all the same — the registry dies with the service.
	 */
	archived?: true;
	/**
	 * The run that owns this child: the one a bare wait or list covers.
	 *
	 * The spawning run at first, and then whichever run hands it its next errand —
	 * ownership follows the work, so a child re-tasked in a later turn is collected
	 * by that turn rather than by the one that has already ended.
	 */
	parentSignal: AbortSignal | undefined;
	/**
	 * Which conversation this child was spawned on behalf of, as an opaque id the
	 * host chose — the plugin passes a chat session's path, this module never
	 * interprets it.
	 *
	 * Coarser than {@link parentSignal} and load-bearing in a different place: a
	 * signal identifies one *run*, so it cannot answer "did an earlier turn of
	 * this same conversation spawn anything" — the question every id-less lookup
	 * falls back to. Before this existed that fallback reached across every
	 * conversation the process had open, which let one chat be told about, and
	 * then collect, another chat's child. Every grandchild carries its root
	 * conversation's id, so a whole tree belongs to the chat that started it.
	 */
	ownerId: string;
	/** The task the spawn was given, verbatim — what the inspector shows first. */
	task: string;
	/**
	 * Later errands, in the order they were given, when there have been any.
	 *
	 * Kept beside `task` rather than replacing it: the row's title is what the
	 * reader remembers asking for, and a title that changed under them when the
	 * parent followed up would lose them the run they were looking for.
	 */
	followUps: string[];
	/** The caller's standing framing, when it passed one. */
	instructions?: string;
	/** Tree level: 0 is the chat panel itself, so a direct child is always 1. */
	depth: number;
	/**
	 * What this child has spent across every errand it has been given.
	 *
	 * Accumulated rather than read off `result`, which holds one errand's numbers
	 * and is replaced by the next: a child on its third errand would otherwise
	 * report the third one's tokens as its whole cost. Only settled errands
	 * contribute — a failed run reports nothing to add, the same gap a single
	 * failed run has always had.
	 */
	spent: { turns: number; usage: UsageTotals };
	/** When the spawn call ran — the child's own age, whatever it has done since. */
	spawnedAt: number;
	/**
	 * When the current errand started, which is what its duration is measured from.
	 *
	 * Equal to `spawnedAt` until a follow-up, and reset by each one: "ran for 40m"
	 * on a child that answered in three seconds and then sat waiting for its next
	 * instruction would answer a question nobody asked.
	 */
	startedAt: number;
	/** When the current errand settled, so the inspector can show duration. */
	settledAt?: number;
}

/**
 * Where one child stands, in the vocabulary the wait tool already reports.
 *
 * Lives on the registry rather than in the control tools so every reader of an
 * entry — the `list_subagents` tool and the UI inspector alike — derives the
 * same status from the same fields and the two cannot drift.
 */
export function statusOf(entry: SubagentEntry): "running" | "done" | "incomplete" | "failed" {
	if (!entry.settled) {
		return "running";
	}
	if (entry.error) {
		return "failed";
	}
	return entry.result?.incomplete ? "incomplete" : "done";
}
/**
 * The live bookkeeping for one extension instance: every subagent spawned
 * through its tools.
 *
 * Entries outlive settlement on purpose — the parent may only get around to
 * waiting long after the child finished — and die with the service, so the
 * map needs no pruning. A wait never crosses runs: each entry remembers the
 * signal of the run that spawned it, and wait compares against its own.
 */
export class SubagentRegistry {
	private entries = new Map<string, SubagentEntry>();
	/**
	 * Change listeners, notified on spawn and settlement.
	 *
	 * For the UI inspector: it renders from snapshots and must not poll, so the
	 * registry — the one place every state transition already lands — is where
	 * the "something changed" signal comes from. Listeners receive no payload;
	 * a change means the snapshot should be rebuilt, not that a particular
	 * entry moved.
	 */
	private listeners = new Set<() => void>();

	/** Subscribes to spawn/settle changes; the return value unsubscribes. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emitChange(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	/**
	 * Random, not counted. The counter was process-wide, so the first child a
	 * conversation ever spawned could read `subagent-7` — a number telling the
	 * model it had already spawned six, and inviting it to wait on ids that
	 * were never its own. A short suffix keeps the id copyable (a wait and a
	 * kill both take it back) and legible in transcripts, without any ordinal
	 * meaning to misread.
	 */
	nextId(): string {
		let id = "";
		do {
			id = `subagent-${randomSuffix(6)}`;
		} while (this.entries.has(id));
		return id;
	}

	/**
	 * Starts one child on its first errand and records it.
	 *
	 * `start` receives nothing and runs the child with the caller's linked signal
	 * already attached, so the runner owns every detail of the run; the registry
	 * only observes the outcome.
	 */
	spawn(
		spec: SubagentRunHandle & {
			id: string;
			/** The signal of the run that called spawn — the identity an id-less wait scopes by. */
			parentSignal: AbortSignal | undefined;
			/** The conversation this child answers to; see {@link SubagentEntry.ownerId}. */
			ownerId: string;
			/** What the child runs as, resolved: role appendix, model, clamped level. */
			role: SubagentRole;
			model: Model<string>;
			thinkingLevel: ThinkingLevel;
			/** The spawn's own metadata, recorded verbatim for the inspector. */
			task: string;
			instructions?: string;
			depth: number;
		},
	): SubagentEntry {
		const now = Date.now();
		// The promise placeholder is assigned by `attachRun` below, before the
		// function returns and before any caller could read it — the cast only
		// bridges the two statements.
		const entry: SubagentEntry = {
			id: spec.id,
			role: spec.role,
			model: spec.model,
			thinkingLevel: spec.thinkingLevel,
			abort: spec.abort,
			dispose: spec.dispose,
			start: spec.start,
			promise: null as unknown as Promise<SubagentRunResult>,
			settled: false,
			transcript: [],
			parentSignal: spec.parentSignal,
			ownerId: spec.ownerId,
			task: spec.task,
			followUps: [],
			instructions: spec.instructions,
			depth: spec.depth,
			spent: { turns: 0, usage: EMPTY_USAGE_TOTALS },
			spawnedAt: now,
			startedAt: now,
		};
		this.attachRun(entry);
		this.entries.set(spec.id, entry);
		this.emitChange();
		return entry;
	}

	/**
	 * Hands a settled child another errand, keeping its id and its memory.
	 *
	 * The same entry, re-armed: one id, one row in the panel, one growing
	 * transcript. A new id per errand would make the parent track a chain and the
	 * reader read the same child three times.
	 *
	 * Scoped by id within the calling conversation, not by the calling run's
	 * signal the way `kill` is. A follow-up's ordinary shape is "spawn, collect,
	 * report to the user, then re-task on what the user said next", and those are
	 * two runs with two signals — so signal scoping would refuse exactly the case
	 * this exists for. `wait_subagent` already collects across turns by id, for
	 * the same reason. What the id scope does not cross is a conversation: an id
	 * belonging to another chat is refused as not-found, the same answer a
	 * mistyped id gets, because the caller has no use for the difference and the
	 * other chat has no consent to give.
	 * Ownership of the child does move: the run handing over the new errand
	 * becomes the one a bare wait or list covers, and it stays in the
	 * conversation it was spawned into.
	 *
	 * A child the user stopped from the panel is not re-armed. That kill is the
	 * user's circuit breaker, and a tool that could undo it would make the breaker
	 * advisory — the parent is told to spawn something fresh instead, which leaves
	 * the decision where the user put it.
	 */
	resume(spec: {
		id: string;
		/** The conversation the caller belongs to; a child of another is not found. */
		ownerId: string;
		/** The signal of the run handing over the errand; it becomes the entry's owner. */
		parentSignal: AbortSignal | undefined;
		/** The new errand, recorded on the entry as well as sent to the child. */
		task: string;
		/** Builds the run, reading what the child runs as off the validated entry. */
		startRun: (child: Readonly<SubagentEntry>) => SubagentRunHandle;
	}): "resumed" | "not-found" | "still-running" | "user-stopped" {
		const entry = this.entries.get(spec.id);
		// A stranger's id and a missing one get the same answer: the caller cannot
		// act on the difference, and telling it which ids exist elsewhere would
		// turn the not-found guidance into a directory of other chats' children.
		if (!entry || entry.ownerId !== spec.ownerId) {
			return "not-found";
		}
		if (!entry.settled) {
			return "still-running";
		}
		if (entry.killedBy === "user") {
			return "user-stopped";
		}
		const handle = spec.startRun(entry);
		entry.followUps.push(spec.task);
		entry.parentSignal = spec.parentSignal;
		entry.abort = handle.abort;
		entry.dispose = handle.dispose;
		entry.start = handle.start;
		// Everything the last errand settled with goes, because it describes that
		// errand and not this one: a stale `result` would render as this run's
		// report and a stale `killedBy` as this run's caveat. `transcript` and
		// `spent` are the two that carry over — they are the child's, not a run's.
		entry.settled = false;
		entry.result = undefined;
		entry.error = undefined;
		entry.settledAt = undefined;
		entry.killedBy = undefined;
		// A run that is working again cannot stay in the panel's closed section:
		// hiding a live child is the one thing the panel exists not to do.
		entry.archived = undefined;
		entry.startedAt = Date.now();
		this.attachRun(entry);
		this.emitChange();
		return "resumed";
	}

	/**
	 * Runs the entry's `start` and folds the outcome back into the entry.
	 *
	 * One place for the settlement bookkeeping, so a first errand and a later one
	 * cannot record it differently — which is the failure mode a second copy of
	 * these two handlers would eventually be.
	 */
	private attachRun(entry: SubagentEntry): void {
		entry.promise = entry.start().then(
			(result) => {
				entry.settled = true;
				entry.result = result;
				entry.transcript = result.messages;
				entry.spent = {
					turns: entry.spent.turns + result.turns,
					usage: addUsageTotals(entry.spent.usage, result.usage),
				};
				entry.settledAt = Date.now();
				entry.dispose();
				this.emitChange();
				return result;
			},
			(error) => {
				entry.settled = true;
				entry.error = error instanceof Error ? error : new Error(String(error));
				// Only a runner failure knows the transcript; anything else that
				// rejected got no further than assembling the run, so what the entry
				// already holds is still the truest record of this child.
				if (error instanceof SubagentRunError) {
					entry.transcript = error.messages;
				}
				entry.settledAt = Date.now();
				entry.dispose();
				this.emitChange();
				throw entry.error;
			},
		);
		// A failure is data for the wait tool, not an exception for the caller —
		// spawn returned long ago. This bare handler keeps the rejecting promise
		// out of the unhandled-rejection lane until something inspects the entry.
		entry.promise.catch(() => undefined);
	}

	get(id: string): SubagentEntry | undefined {
		return this.entries.get(id);
	}

	/**
	 * Kills one live child on the parent's orders.
	 *
	 * Returns what happened rather than throwing, because every outcome here is
	 * something the model should read and move on from: an id it mistyped, a
	 * child that had already finished, a sibling belonging to another run. The
	 * kill itself is the same `abort` that teardown and parent-stop use, so a
	 * killed child unwinds down one well-tested path.
	 *
	 * `killedBy` records who ordered the kill — the `kill_subagent` tool by
	 * default, the monitor panel's stop buttons otherwise — so the wait tool can
	 * tell the parent whose decision the cut-short report answers to.
	 */
	kill(
		id: string,
		ownerSignal: AbortSignal | undefined,
		killedBy: "tool" | "user" = "tool",
	): "killed" | "already-settled" | "not-found" | "not-yours" {
		const entry = this.entries.get(id);
		if (!entry) {
			return "not-found";
		}
		// Scoped the same way an id-less wait is: a child may kill what it
		// spawned, never a sibling or its own parent's other work. A hostless
		// caller (no signal) is the test/CLI case and owns everything — which is
		// also the monitor panel's case: it sits outside every run and answers to
		// the user, not to a signal.
		if (ownerSignal !== undefined && entry.parentSignal !== ownerSignal) {
			return "not-yours";
		}
		if (entry.settled) {
			return "already-settled";
		}
		entry.killedBy = killedBy;
		entry.abort();
		return "killed";
	}

	/**
	 * Kills every live child on the user's orders, from the monitor panel.
	 *
	 * Not `disposeAll`: teardown also unwinds settled entries' listener hooks and
	 * speaks a different cause — this is one user action among live runs, so it
	 * touches only children still running and leaves settled entries exactly as
	 * the record keeps them. Returns how many were killed, which is what lets the
	 * button hide itself when there is nothing left to stop.
	 *
	 * @param ownerId Restricts the kill to one conversation's children. Omitted
	 * means every live child the process holds.
	 */
	killAllLive(killedBy: "user", ownerId?: string): number {
		let killed = 0;
		for (const entry of this.entries.values()) {
			if (entry.settled) {
				continue;
			}
			// Scoped when the caller names an owner, because the panel's stop button
			// must kill exactly the rows under it and no others. Unscoped is the
			// whole-panel button, whose rows really are all of them.
			if (ownerId !== undefined && entry.ownerId !== ownerId) {
				continue;
			}
			entry.killedBy = killedBy;
			entry.abort();
			killed += 1;
		}
		return killed;
	}

	/**
	 * Puts every finished run away, on the reader's orders, from the panel.
	 *
	 * Only settled entries: a running child is not something to tidy, and it would
	 * reappear as soon as it finished anyway. Returns how many moved, which is what
	 * lets the control hide itself once the list is clean. Already-archived entries
	 * are skipped rather than re-stamped, so pressing it twice is not two changes.
	 */
	archiveSettled(): number {
		let archived = 0;
		for (const entry of this.entries.values()) {
			if (!entry.settled || entry.archived) {
				continue;
			}
			entry.archived = true;
			archived += 1;
		}
		if (archived > 0) {
			this.emitChange();
		}
		return archived;
	}

	/**
	 * How many children are still running, across every run and depth.
	 *
	 * Counted live rather than tracked incrementally: entries settle from their
	 * own promise handlers, and a counter decremented there would drift the
	 * moment a path forgot to. The map is bounded by one plugin session's
	 * spawns, so the scan is cheap.
	 */
	liveCount(): number {
		let live = 0;
		for (const entry of this.entries.values()) {
			if (!entry.settled) {
				live += 1;
			}
		}
		return live;
	}

	/** Children of one run, in spawn order — what an id-less wait covers. */
	forSignal(signal: AbortSignal): SubagentEntry[] {
		return [...this.entries.values()].filter((entry) => entry.parentSignal === signal);
	}

	/**
	 * Children of one conversation, in spawn order, across every run and depth.
	 *
	 * The scope every "what exists besides this turn" answer is built from — in
	 * the tools that report ids to a model, and in the UI that lists runs to a
	 * reader. Both used {@link all} before ownership was recorded, and both were
	 * wrong in the same way for the same reason.
	 */
	forOwner(ownerId: string): SubagentEntry[] {
		return [...this.entries.values()].filter((entry) => entry.ownerId === ownerId);
	}

	/** Every entry regardless of run; only for hosts that run without signals. */
	all(): SubagentEntry[] {
		return [...this.entries.values()];
	}

	/** Kills every live child; called when the service or plugin tears down. */
	disposeAll(): void {
		for (const entry of this.entries.values()) {
			if (!entry.settled) {
				entry.killedBy = "teardown";
			}
			entry.abort();
			entry.dispose();
		}
	}
}
