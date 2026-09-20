/**
 * Silent Scout: in-app background intelligence and proactive context prefetching.
 *
 * Runs non-blocking agent intelligence while the user works inside Obsidian:
 * 1. Synchronous local structural audit (promises, broken links, MOC opportunities)
 * 2. Debounced asynchronous background prefetching (stages actionable insights ahead of time)
 */

import type { App, TFile } from "obsidian";
import type { BrokenLinkFix } from "./vaultGardener";
import { detectEmergentMoc, findBrokenLinkFixes, findUnresolvedPromises } from "./vaultGardener";

export interface StagedScoutAction {
	label: string;
	prompt: string;
	summary?: string;
}

export interface ScoutInsight {
	notePath: string;
	timestamp: number;
	unresolvedPromises: string[];
	brokenLinkFixes: BrokenLinkFix[];
	suggestedMocTopic: string | null;
	stagedAction?: StagedScoutAction;
}

export interface PrefetchRunner {
	(prompt: string, signal: AbortSignal): Promise<string | null>;
}

export class SilentScout {
	private readonly insights = new Map<string, ScoutInsight>();
	private debounceTimer: number | null = null;
	private activeAbortController: AbortController | null = null;

	constructor(
		private readonly app: App,
		private readonly runPrefetch?: PrefetchRunner,
	) {}

	/**
	 * Synchronously computes or returns cached structural scout facts for a note.
	 */
	inspectNoteLocal(file: TFile, content: string, tags: string[]): ScoutInsight {
		const existing = this.insights.get(file.path);
		const unresolvedPromises = findUnresolvedPromises(content);
		const brokenLinkFixes = findBrokenLinkFixes(this.app, file);
		const suggestedMocTopic = detectEmergentMoc(this.app, file, tags);

		const updated: ScoutInsight = {
			notePath: file.path,
			timestamp: Date.now(),
			unresolvedPromises,
			brokenLinkFixes,
			suggestedMocTopic,
			stagedAction: existing?.stagedAction,
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

	/**
	 * Schedules an in-app background prefetch for the active note.
	 * Debounced to avoid firing on rapid typing; runs non-blocking.
	 */
	scheduleBackgroundPrefetch(
		file: TFile,
		content: string,
		onInsightReady?: (insight: ScoutInsight) => void,
		debounceMs = 1500,
	): void {
		if (this.debounceTimer !== null) {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}

		if (!this.runPrefetch || !content || content.trim().length < 20) {
			return;
		}

		this.debounceTimer = window.setTimeout(() => {
			this.debounceTimer = null;
			void this.executePrefetch(file, content, onInsightReady);
		}, debounceMs);
	}

	private async executePrefetch(
		file: TFile,
		content: string,
		onInsightReady?: (insight: ScoutInsight) => void,
	): Promise<void> {
		this.activeAbortController?.abort();
		const controller = new AbortController();
		this.activeAbortController = controller;

		try {
			const sample = content.length > 2000 ? `${content.slice(0, 2000)}...` : content;
			const prompt = `Note Title: "${file.basename}"\nContent Excerpt:\n${sample}\n\nTask: Propose ONE immediate next step or hypothesis to verify for this note. Reply with ONLY a JSON object: {"label": "2-4 words action", "prompt": "1 sentence prompt under 25 words", "summary": "1 short rationale"}. No markdown, no prose.`;

			const rawReply = await this.runPrefetch!(prompt, controller.signal);
			if (controller.signal.aborted || !rawReply) return;

			const parsed = this.parseStagedAction(rawReply);
			if (parsed) {
				const current = this.insights.get(file.path) ?? {
					notePath: file.path,
					timestamp: Date.now(),
					unresolvedPromises: [],
					brokenLinkFixes: [],
					suggestedMocTopic: null,
				};
				const nextInsight: ScoutInsight = {
					...current,
					stagedAction: parsed,
					timestamp: Date.now(),
				};
				this.insights.set(file.path, nextInsight);
				onInsightReady?.(nextInsight);
			}
		} catch {
			// Silent scout never interrupts the user or throws
		} finally {
			if (this.activeAbortController === controller) {
				this.activeAbortController = null;
			}
		}
	}

	private parseStagedAction(raw: string): StagedScoutAction | null {
		try {
			const jsonMatch = raw.match(/\{[\s\S]*\}/);
			if (!jsonMatch) return null;
			const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
			if (typeof obj.label === "string" && typeof obj.prompt === "string") {
				return {
					label: obj.label.trim(),
					prompt: obj.prompt.trim(),
					summary: typeof obj.summary === "string" ? obj.summary.trim() : undefined,
				};
			}
		} catch {
			// Malformed model JSON silently ignored
		}
		return null;
	}

	dispose(): void {
		if (this.debounceTimer !== null) {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		this.activeAbortController?.abort();
		this.activeAbortController = null;
		this.insights.clear();
	}
}
