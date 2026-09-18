/**
 * Probes lightweight structural and semantic facts about the active note.
 *
 * Used to shape proactive quick actions on an empty screen and enrich the
 * suggestion prompt with note facts without reading the note body.
 *
 * Reads only in-memory metadata and file stats (zero disk I/O, zero token cost):
 * - Daily / periodic note detection (e.g. 2026-09-18.md, 2026-W38.md).
 * - Empty / draft note detection (size === 0).
 * - Link graph hygiene (orphan note with 0 backlinks, unresolved links).
 */

import type { App } from "obsidian";
import { hasAnyBacklink, toLinkReferences } from "../vault/links";

/** The structural facts probed about an active note. */
export interface NoteFacts {
	/** Full vault path of the note. */
	path: string;
	/** Whether the filename or path represents a daily journal note (e.g. 2026-09-18.md). */
	isDailyNote: boolean;
	/** Whether the filename or path represents a periodic note (daily or weekly e.g. 2026-W38.md). */
	isPeriodicNote: boolean;
	/** Whether the note is empty (stat size === 0). */
	isEmpty: boolean;
	/** Whether the note has zero incoming backlinks from other resolved notes. */
	isOrphan: boolean;
	/**
	 * Incoming backlink indicator: 0 when orphan, 1 when at least one backlink
	 * exists. Not the exact count — exact counting requires a full-vault scan
	 * inappropriate for the render path this probe runs in.
	 */
	backlinkCount: number;
	/** Count of broken / unresolved links inside this note pointing to missing targets. */
	unresolvedLinkCount: number;
}

/** Matches standard daily note naming formats: YYYY-MM-DD, YYYY_MM_DD, YYYY.MM.DD, or YYYYMMDD. */
export const DAILY_NOTE_REGEX = /(?:^|\/)(?:\d{4}[-_.]\d{2}[-_.]\d{2}|\d{8})(?:\.md)?$/i;

/** Matches weekly periodic note naming formats: YYYY-[W]ww, YYYY_[W]ww, or YYYY[W]ww. */
export const WEEKLY_NOTE_REGEX = /(?:^|\/)(?:\d{4}[-_.]?[Ww]\d{1,2})(?:\.md)?$/i;

/** Checks whether a path indicates a daily journal note. */
export function isDailyNotePath(path: string): boolean {
	return DAILY_NOTE_REGEX.test(path);
}

/** Checks whether a path indicates a periodic note (daily or weekly). */
export function isPeriodicNotePath(path: string): boolean {
	return DAILY_NOTE_REGEX.test(path) || WEEKLY_NOTE_REGEX.test(path);
}

/**
 * Renders concise note facts as lines for the suggestion prompt's `<subject>` block.
 *
 * Negative facts or standard states are omitted so tokens are only spent on actionable news.
 */
export function renderNoteFactLines(facts: NoteFacts): string[] {
	const lines: string[] = [];
	if (facts.isDailyNote) {
		lines.push("Note type: Daily journal note.");
	} else if (facts.isPeriodicNote) {
		lines.push("Note type: Periodic note.");
	}
	if (facts.isEmpty) {
		lines.push("Note state: Blank / empty draft.");
	}
	if (facts.isOrphan) {
		lines.push("Note graph: Isolated note with 0 backlinks.");
	}
	if (facts.unresolvedLinkCount > 0) {
		lines.push(`Note graph: Contains ${facts.unresolvedLinkCount} unresolved link(s).`);
	}
	return lines;
}

/** Builds a deterministic string representation of note facts for the suggestion cache key. */
export function noteFactsKeyPart(facts: NoteFacts | null): string {
	if (!facts) {
		return "";
	}
	return [
		facts.isDailyNote ? "daily" : facts.isPeriodicNote ? "periodic" : "note",
		facts.isEmpty ? "empty" : "has-content",
		facts.isOrphan ? "orphan" : `bl:${facts.backlinkCount}`,
		`unres:${facts.unresolvedLinkCount}`,
	].join("|");
}

/**
 * Reads the active note's structural facts from Obsidian's in-memory index.
 *
 * Never throws: if anything is unexpected, returns null so suggestions fall back safely.
 */
export function probeNoteFacts(app: App, activePath: string | null): NoteFacts | null {
	if (!activePath) {
		return null;
	}
	try {
		const file = app.vault.getFileByPath(activePath);
		const isDaily = isDailyNotePath(activePath);
		const isPeriodic = isPeriodicNotePath(activePath);
		const isEmpty = file !== null ? file.stat.size === 0 : false;
		// Early-exit check: only the orphan/connected distinction matters for
		// suggestions, so avoid the full-vault scan + sort + allocation that
		// collectBacklinks pays for.
		const isOrphan = file !== null ? !hasAnyBacklink(app, file) : true;
		const backlinkCount = isOrphan ? 0 : 1;
		const unresolvedMap = app.metadataCache.unresolvedLinks?.[activePath];
		const unresolvedLinkCount = unresolvedMap ? toLinkReferences(unresolvedMap).length : 0;

		return {
			path: activePath,
			isDailyNote: isDaily,
			isPeriodicNote: isPeriodic,
			isEmpty,
			isOrphan,
			backlinkCount,
			unresolvedLinkCount,
		};
	} catch {
		return null;
	}
}
