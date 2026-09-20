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
 * - Task list items (open `- [ ]` and completed `- [x]` checkboxes).
 * - Code blocks and dominant topic characteristics.
 * - Temporal context (morning, afternoon, evening, and today's daily journal).
 * - Long-horizon session recall (whether earlier chats discussed this note).
 */

import type { App } from "obsidian";
import { hasAnyBacklink, toLinkReferences } from "../vault/links";

/** Time of day segment for cadence-aware suggestions. */
export type TimeOfDay = "morning" | "afternoon" | "evening";

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
	/** Count of open / uncompleted task items (- [ ]). Defaults to 0. */
	todoCount?: number;
	/** Count of completed task items (- [x]). Defaults to 0. */
	doneTodoCount?: number;
	/** Whether the note contains code blocks. Defaults to false. */
	hasCode?: boolean;
	/** Whether this daily journal note matches today's date. Defaults to false. */
	isToday?: boolean;
	/** Time segment when probed. */
	timeOfDay?: TimeOfDay;
	/** Dominant detected topic characteristic. */
	dominantTopic?: "code" | "tasks" | "reading" | "daily" | null;
	/** Whether an earlier conversation touched this note. Defaults to false. */
	hasPriorSession?: boolean;
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

/** Computes the time of day segment from a given Date. */
export function getTimeOfDay(now: Date = new Date()): TimeOfDay {
	const hour = now.getHours();
	if (hour >= 5 && hour < 12) {
		return "morning";
	}
	if (hour >= 12 && hour < 18) {
		return "afternoon";
	}
	return "evening";
}

/** Checks whether a path represents today's daily journal note. */
export function isTodayNotePath(path: string, now: Date = new Date()): boolean {
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	const formats = [`${y}-${m}-${d}`, `${y}_${m}_${d}`, `${y}.${m}.${d}`, `${y}${m}${d}`];
	return formats.some((fmt) => path.includes(fmt));
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
	if ((facts.todoCount ?? 0) > 0) {
		lines.push(`Note tasks: Contains ${facts.todoCount} uncompleted task(s) (- [ ]).`);
	}
	if (facts.hasCode) {
		lines.push("Note content: Contains code blocks or technical scripts.");
	}
	if (facts.isDailyNote && facts.isToday && facts.timeOfDay) {
		lines.push(`Temporal context: Today's daily note (working in ${facts.timeOfDay}).`);
	}
	if (facts.hasPriorSession) {
		lines.push("Session history: This note was previously referenced in an earlier conversation.");
	}
	return lines;
}

/** Builds a deterministic string representation of note facts for the suggestion cache key. */
export function noteFactsKeyPart(facts: NoteFacts | null): string {
	if (!facts) {
		return "";
	}
	return [
		facts.isDailyNote ? (facts.isToday ? "today-daily" : "daily") : facts.isPeriodicNote ? "periodic" : "note",
		facts.isEmpty ? "empty" : "has-content",
		facts.isOrphan ? "orphan" : `bl:${facts.backlinkCount}`,
		`unres:${facts.unresolvedLinkCount}`,
		`todos:${(facts.todoCount ?? 0) > 0 ? facts.todoCount : 0}`,
		`code:${facts.hasCode ? "1" : "0"}`,
		`tod:${facts.timeOfDay ?? ""}`,
		`prior:${facts.hasPriorSession ? "1" : "0"}`,
	].join("|");
}

export interface ProbeNoteFactsOptions {
	now?: Date;
	hasPriorSession?: boolean;
}

/**
 * Reads the active note's structural facts from Obsidian's in-memory index.
 *
 * Never throws: if anything is unexpected, returns null so suggestions fall back safely.
 */
export function probeNoteFacts(
	app: App,
	activePath: string | null,
	options?: ProbeNoteFactsOptions,
): NoteFacts | null {
	if (!activePath) {
		return null;
	}
	try {
		const now = options?.now ?? new Date();
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

		const cache = file !== null && typeof app.metadataCache?.getFileCache === "function"
			? app.metadataCache.getFileCache(file)
			: null;

		let todoCount = 0;
		let doneTodoCount = 0;
		if (cache?.listItems) {
			for (const item of cache.listItems) {
				if (item.task === " ") {
					todoCount++;
				} else if (item.task !== undefined) {
					doneTodoCount++;
				}
			}
		}

		const hasCode = cache?.sections ? cache.sections.some((s) => s.type === "code") : false;
		const timeOfDay = getTimeOfDay(now);
		const isToday = isDaily ? isTodayNotePath(activePath, now) : false;
		const hasPriorSession = options?.hasPriorSession ?? false;

		let dominantTopic: "code" | "tasks" | "reading" | "daily" | null = null;
		if (isDaily || isPeriodic) {
			dominantTopic = "daily";
		} else if (todoCount >= 2) {
			dominantTopic = "tasks";
		} else if (hasCode) {
			dominantTopic = "code";
		} else if (cache) {
			const tagList: string[] = [];
			if (cache.tags) {
				for (const t of cache.tags) {
					tagList.push(t.tag.toLowerCase());
				}
			}
			const rawTags: unknown = cache.frontmatter?.tags;
			if (Array.isArray(rawTags)) {
				for (const t of rawTags) {
					if (typeof t === "string") tagList.push(t.toLowerCase());
				}
			} else if (typeof rawTags === "string") {
				tagList.push(rawTags.toLowerCase());
			}
			const rawType: unknown = cache.frontmatter?.type;
			const fmType = typeof rawType === "string" ? rawType.toLowerCase() : "";
			if (
				tagList.some((t) => t.includes("reading") || t.includes("book") || t.includes("paper") || t.includes("research")) ||
				fmType.includes("book") ||
				fmType.includes("paper")
			) {
				dominantTopic = "reading";
			}
		}

		return {
			path: activePath,
			isDailyNote: isDaily,
			isPeriodicNote: isPeriodic,
			isEmpty,
			isOrphan,
			backlinkCount,
			unresolvedLinkCount,
			todoCount,
			doneTodoCount,
			hasCode,
			isToday,
			timeOfDay,
			dominantTopic,
			hasPriorSession,
		};
	} catch {
		return null;
	}
}
