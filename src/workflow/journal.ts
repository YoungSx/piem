/**
 * journal.ts — the record a workflow run leaves so a later run can skip work.
 *
 * Ported from tintinweb/pi-subagents' `journal.ts`. The replay is a *prefix*,
 * not a lookup table: each entry is keyed by both its position in the run and a
 * hash of everything that decides what that agent does, and a replay walks
 * positions in order, stopping at the first mismatch. Reusing later matches out
 * of order would be reusing a result produced under different upstream
 * conditions. A failed agent is journaled as a failure and never replayed as
 * one — resuming a run that died at agent 5 exists to retry agent 5.
 *
 * Deltas from upstream, both because piem has no `node:*`:
 *   - the key hashes with Web Crypto's async SHA-256 (the same `sha256Hex` the
 *     skill installer uses) instead of sync `node:crypto`, so `journalKey` is
 *     awaited once per call before the replay check;
 *   - the file half (`readJournal`/`appendJournal`) is dropped — the runtime
 *     takes journal entries in and appends out through its options, and the
 *     vault-backed storage lives with the tool, not in the engine.
 */

import { sha256Hex } from "../skills/skillHash";

/** One settled agent call, as replayed. */
export interface WorkflowJournalEntry {
	/** Position in the run — the same counter that names `wf-agent-N`. */
	index: number;
	/** Hash of the call's payload; a mismatch ends the replayable prefix. */
	key: string;
	/** Whether the agent succeeded. A failure ends the prefix on replay. */
	ok: boolean;
	/** The agent's answer, when it had one. */
	text?: string;
	/**
	 * Whether the call continued an earlier child (`agent({ resume })`).
	 *
	 * A replayed agent leaves no session behind in the run that replays it — the
	 * conversation belongs to the run that actually spawned it, and the host's
	 * id map is per-run — so a later `resume` would have nothing to continue.
	 * Recording it lets the next run decline to replay at all rather than fail
	 * partway through, which is why the flag is on the journal and not derived.
	 */
	resumed?: true;
}

/**
 * The fields that decide what an agent does.
 *
 * Deliberately not the whole payload: `phaseIndex` and `phaseTitle` move the
 * row around in the progress tree without changing a single token the agent
 * sees, so re-grouping phases should not throw away an hour of results.
 */
export interface JournalKeyInput {
	prompt: string;
	label?: string;
	model?: string;
	agentType?: string;
	effort?: string;
	isolation?: string;
	gate?: string;
	resume?: string;
	/** Serialized `agent({ schema })`, when the call asked for one. */
	schema?: string;
}

/** Stable hash of a call's payload. Field order is fixed here, not by the caller. */
export async function journalKey(input: JournalKeyInput): Promise<string> {
	const canonical = JSON.stringify([
		input.prompt,
		input.label ?? null,
		input.model ?? null,
		input.agentType ?? null,
		input.effort ?? null,
		input.isolation ?? null,
		input.gate ?? null,
		input.resume ?? null,
		// Appended only when present: adding a ninth slot unconditionally would
		// change the canonical form of every entry and invalidate every journal
		// already on disk. Conditional, a schema-less call keys exactly as it
		// always did, and adding or changing a schema still produces a new key.
		...(input.schema !== undefined ? [input.schema] : []),
	]);
	const hex = await sha256Hex(canonical);
	return hex.slice(0, 32);
}
