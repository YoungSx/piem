/**
 * Silent Scout: in-app background intelligence and proactive context prefetching.
 *
 * Runs non-blocking agent intelligence while the user works inside Obsidian:
 * 1. Synchronous local structural audit (promises, broken links, MOC opportunities)
 * 2. Debounced model-side perception, staged ahead of time so the chip row is
 *    already specific by the time the user looks at it
 *
 * Nothing here writes to a note or interrupts the user: a perception is a
 * staged suggestion, and the tap that acts on it is an ordinary turn.
 *
 * Two gates bound what a perception costs, both per note:
 *
 * - **Content hash.** A note whose text has not changed since the last
 *   perception is not perceived again, so re-focusing a note cannot bill the
 *   same look twice.
 * - **Cooldown.** A note is perceived at most once per {@link SCOUT_COOLDOWN_MS}
 *   however much its text moves. The hash gate alone cannot bound a writing
 *   session: every keystroke changes the hash, so without a rate limit the
 *   meter runs against the user's provider quota as they type.
 *
 * Both are checked when a run is *dispatched*, not when it is scheduled: a
 * debounce that keeps resetting under a fast-switching user must not spend the
 * cooldown of the run that eventually fires.
 */

import type { App, TFile } from "obsidian";
import type { BrokenLinkFix } from "./vaultGardener";
import { detectEmergentMoc, findBrokenLinkFixes, findUnresolvedPromises } from "./vaultGardener";
import type { ScoutFinding, ScoutPerceptionRequest } from "./scoutPerception";

/**
 * One staged suggestion: the chip's text and the turn it sends.
 *
 * Named for the finding rather than the chip because that is what it is — the
 * chip is one rendering of it, and the label names the concrete defect the
 * model saw rather than a category of action.
 */
export type StagedScoutAction = ScoutFinding;

export interface ScoutInsight {
	notePath: string;
	timestamp: number;
	/** The text this audit describes; the perception gate compares against it. */
	contentHash: string;
	unresolvedPromises: string[];
	brokenLinkFixes: BrokenLinkFix[];
	suggestedMocTopic: string | null;
	/** What the last perception reported, most serious first. Empty when it found nothing. */
	findings: ScoutFinding[];
}

/** The model-side perception, injected so the scout owns the gates and the caller owns the transport. */
export interface PrefetchRunner {
	(request: ScoutPerceptionRequest, signal: AbortSignal): Promise<ScoutFinding[] | null>;
}

/** Per-call knobs. Both default; tests shrink them rather than waiting. */
export interface ScoutTiming {
	debounceMs?: number;
	cooldownMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 1_500;

/** Shortest note worth a model call. Below this there is nothing to perceive. */
const MIN_CONTENT_CHARS = 20;

/**
 * How long one note is left alone after a perception is dispatched.
 *
 * Ten minutes is a writing session, not a timer: long enough that the user's
 * own typing cannot bill them repeatedly, short enough that a note rewritten in
 * the evening is perceived again before the day is out. Measured from dispatch
 * so a provider failing slowly cannot be hammered by a retry loop.
 */
export const SCOUT_COOLDOWN_MS = 10 * 60 * 1_000;

export class SilentScout {
	private readonly insights = new Map<string, ScoutInsight>();
	/** Last dispatch time per note — the cooldown, kept apart from the audit record. */
	private readonly dispatchedAt = new Map<string, number>();
	/** The text the last successful perception saw; a failed one never pins it. */
	private readonly perceivedHash = new Map<string, string>();
	private debounceTimer: number | null = null;
	private activeAbortController: AbortController | null = null;

	constructor(
		private readonly app: App,
		private readonly runPrefetch?: PrefetchRunner,
	) {}

	/**
	 * Audits the note locally, then stages a perception when the gates allow.
	 *
	 * Returns whether the note's text changed since the last audit — the
	 * caller's signal that the panel has new facts worth rendering. Re-rendering
	 * on every focus event would rebuild the snapshot for a note nobody touched.
	 */
	observe(
		file: TFile,
		content: string,
		tags: readonly string[],
		onInsightReady?: (insight: ScoutInsight) => void,
		timing?: ScoutTiming,
	): boolean {
		if (this.debounceTimer !== null) {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}

		const contentHash = hashContent(content);
		const changed = this.insights.get(file.path)?.contentHash !== contentHash;
		if (changed) {
			this.inspectNoteLocal(file, content, tags);
		}

		if (!this.runPrefetch || content.trim().length < MIN_CONTENT_CHARS) {
			return changed;
		}
		// Gate 1: text the last perception already saw is not worth paying for again.
		if (this.perceivedHash.get(file.path) === contentHash) {
			return changed;
		}
		// Gate 2 is deliberately *not* consulted here — see the class header.
		const cooldownMs = timing?.cooldownMs ?? SCOUT_COOLDOWN_MS;
		const debounceMs = timing?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
		this.debounceTimer = window.setTimeout(() => {
			this.debounceTimer = null;
			const dispatched = this.dispatchedAt.get(file.path);
			if (dispatched !== undefined && Date.now() - dispatched < cooldownMs) {
				return;
			}
			void this.executePrefetch(file, content, tags, onInsightReady);
		}, debounceMs);
		return changed;
	}

	/**
	 * Synchronously computes or returns cached structural scout facts for a note.
	 */
	inspectNoteLocal(file: TFile, content: string, tags: readonly string[]): ScoutInsight {
		const existing = this.insights.get(file.path);
		const updated: ScoutInsight = {
			notePath: file.path,
			timestamp: Date.now(),
			contentHash: hashContent(content),
			unresolvedPromises: findUnresolvedPromises(content),
			brokenLinkFixes: findBrokenLinkFixes(this.app, file),
			suggestedMocTopic: detectEmergentMoc(this.app, file, [...tags]),
			findings: existing?.findings ?? [],
		};

		this.insights.set(file.path, updated);
		return updated;
	}

	/**
	 * Returns the latest scout insight for the specified note path.
	 */
	getInsight(notePath: string): ScoutInsight | undefined {
		return this.insights.get(notePath);
	}

	/**
	 * Sets or updates a scout insight directly (e.g. for testing or external events).
	 */
	setInsight(notePath: string, insight: ScoutInsight): void {
		this.insights.set(notePath, insight);
	}

	private async executePrefetch(
		file: TFile,
		content: string,
		tags: readonly string[],
		onInsightReady?: (insight: ScoutInsight) => void,
	): Promise<void> {
		this.activeAbortController?.abort();
		const controller = new AbortController();
		this.activeAbortController = controller;
		// The cooldown starts at dispatch: it bounds how often the user's provider
		// is asked, and asking is the thing being bounded.
		this.dispatchedAt.set(file.path, Date.now());

		const audited = this.insights.get(file.path);
		const request: ScoutPerceptionRequest = {
			notePath: file.path,
			content,
			tags: [...tags],
			unresolvedPromises: audited?.unresolvedPromises ?? [],
			brokenLinkFixes: audited?.brokenLinkFixes ?? [],
			suggestedMocTopic: audited?.suggestedMocTopic ?? null,
		};

		try {
			const findings = await this.runPrefetch!(request, controller.signal);
			if (findings === null || controller.signal.aborted) return;

			const auditedHash = hashContent(content);
			this.perceivedHash.set(file.path, auditedHash);
			const current = this.insights.get(file.path);
			// The note moved on while the model was thinking: this perception
			// describes text that no longer exists. The next audit asks again.
			if (!current || current.contentHash !== auditedHash) return;

			const next: ScoutInsight = { ...current, findings, timestamp: Date.now() };
			this.insights.set(file.path, next);
			onInsightReady?.(next);
		} catch {
			// Silent scout never interrupts the user or throws
		} finally {
			if (this.activeAbortController === controller) {
				this.activeAbortController = null;
			}
		}
	}

	dispose(): void {
		if (this.debounceTimer !== null) {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		this.activeAbortController?.abort();
		this.activeAbortController = null;
		this.insights.clear();
		this.dispatchedAt.clear();
		this.perceivedHash.clear();
	}
}

/**
 * FNV-1a over the note's text, as hex.
 *
 * The gate asks "is this the same text I looked at", and the text is already in
 * hand — one pass over a string that was just read off Obsidian's own cache. A
 * stat-based check would ask the vault a question the caller can already answer
 * and could still be fooled by a touch that changed no bytes.
 *
 * ponytail: 32 bits wide. A collision skips one perception, and a perception is
 * an advisory chip — never a write — so the failure mode is a stale suggestion,
 * not something the user has to undo. Widen it if the scout ever gates anything
 * destructive on this.
 */
export function hashContent(content: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < content.length; index += 1) {
		hash ^= content.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}