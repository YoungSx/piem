import { describe, expect, it } from "bun:test";
import type { App, TFile } from "obsidian";
import {
	DAILY_NOTE_REGEX,
	isDailyNotePath,
	isPeriodicNotePath,
	noteFactsKeyPart,
	probeNoteFacts,
	renderNoteFactLines,
	WEEKLY_NOTE_REGEX,
	type NoteFacts,
} from "./noteFacts";

describe("noteFacts patterns", () => {
	it("identifies standard daily note paths", () => {
		expect(isDailyNotePath("2026-09-18.md")).toBe(true);
		expect(isDailyNotePath("Daily/2026-09-18.md")).toBe(true);
		expect(isDailyNotePath("Journal/2026/09/2026-09-18.md")).toBe(true);
		expect(isDailyNotePath("20260918.md")).toBe(true);
		expect(isDailyNotePath("2026.09.18.md")).toBe(true);
		expect(isDailyNotePath("2026_09_18.md")).toBe(true);
		expect(isDailyNotePath("notes/todo.md")).toBe(false);
		expect(isDailyNotePath("Project 2026.md")).toBe(false);
	});

	it("identifies periodic weekly note paths", () => {
		expect(isPeriodicNotePath("2026-W38.md")).toBe(true);
		expect(isPeriodicNotePath("Weekly/2026-W05.md")).toBe(true);
		expect(isPeriodicNotePath("2026_W1.md")).toBe(true);
		expect(isPeriodicNotePath("2026-09-18.md")).toBe(true); // Daily is also periodic
		expect(isPeriodicNotePath("RandomNote.md")).toBe(false);
	});
});

describe("renderNoteFactLines", () => {
	it("renders daily note, empty note, and orphan note fact lines", () => {
		const facts: NoteFacts = {
			path: "2026-09-18.md",
			isDailyNote: true,
			isPeriodicNote: true,
			isEmpty: true,
			isOrphan: true,
			backlinkCount: 0,
			unresolvedLinkCount: 2,
		};
		const lines = renderNoteFactLines(facts);
		expect(lines).toContain("Note type: Daily journal note.");
		expect(lines).toContain("Note state: Blank / empty draft.");
		expect(lines).toContain("Note graph: Isolated note with 0 backlinks.");
		expect(lines).toContain("Note graph: Contains 2 unresolved link(s).");
	});

	it("omits normal populated connected note facts", () => {
		const facts: NoteFacts = {
			path: "Project.md",
			isDailyNote: false,
			isPeriodicNote: false,
			isEmpty: false,
			isOrphan: false,
			backlinkCount: 5,
			unresolvedLinkCount: 0,
		};
		const lines = renderNoteFactLines(facts);
		expect(lines).toEqual([]);
	});
});

describe("noteFactsKeyPart", () => {
	it("returns empty string for null facts", () => {
		expect(noteFactsKeyPart(null)).toBe("");
	});

	it("produces deterministic keys reflecting note state changes", () => {
		const dailyEmpty: NoteFacts = {
			path: "2026-09-18.md",
			isDailyNote: true,
			isPeriodicNote: true,
			isEmpty: true,
			isOrphan: true,
			backlinkCount: 0,
			unresolvedLinkCount: 0,
		};
		const dailyFilled: NoteFacts = {
			...dailyEmpty,
			isEmpty: false,
			isOrphan: false,
			backlinkCount: 3,
		};
		expect(noteFactsKeyPart(dailyEmpty)).not.toBe(noteFactsKeyPart(dailyFilled));
		expect(noteFactsKeyPart(dailyEmpty)).toContain("daily");
		expect(noteFactsKeyPart(dailyEmpty)).toContain("empty");
		expect(noteFactsKeyPart(dailyEmpty)).toContain("orphan");
	});
});

describe("probeNoteFacts", () => {
	it("returns null when no active note is present", () => {
		const app = {} as App;
		expect(probeNoteFacts(app, null)).toBeNull();
	});

	it("probes file stat, backlinks, and unresolved links accurately", () => {
		const mockFile = { path: "2026-09-18.md", stat: { size: 0 } } as TFile;
		const app = {
			vault: {
				getFileByPath: (path: string) => (path === "2026-09-18.md" ? mockFile : null),
			},
			metadataCache: {
				resolvedLinks: {},
				unresolvedLinks: {
					"2026-09-18.md": { MissingTarget: 1 },
				},
			},
		} as unknown as App;

		const facts = probeNoteFacts(app, "2026-09-18.md");
		expect(facts).not.toBeNull();
		expect(facts?.isDailyNote).toBe(true);
		expect(facts?.isEmpty).toBe(true);
		expect(facts?.isOrphan).toBe(true);
		expect(facts?.backlinkCount).toBe(0);
		expect(facts?.unresolvedLinkCount).toBe(1);
	});

	it("identifies connected notes when backlinks exist", () => {
		const mockFile = { path: "Topic.md", stat: { size: 500 } } as TFile;
		const app = {
			vault: {
				getFileByPath: (path: string) => (path === "Topic.md" ? mockFile : null),
			},
			metadataCache: {
				resolvedLinks: {
					"Index.md": { "Topic.md": 2 },
				},
				unresolvedLinks: {},
			},
		} as unknown as App;

		const facts = probeNoteFacts(app, "Topic.md");
		expect(facts).not.toBeNull();
		expect(facts?.isEmpty).toBe(false);
		expect(facts?.isOrphan).toBe(false);
		expect(facts?.backlinkCount).toBe(1);
	});
});
