import { describe, expect, it } from "bun:test";
import type { App, TFile } from "obsidian";
import {
	DAILY_NOTE_REGEX,
	getTimeOfDay,
	isDailyNotePath,
	isPeriodicNotePath,
	isTodayNotePath,
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

	it("identifies today's daily note", () => {
		const simulatedToday = new Date("2026-09-20T10:00:00Z");
		expect(isTodayNotePath("2026-09-20.md", simulatedToday)).toBe(true);
		expect(isTodayNotePath("Journal/2026-09-20.md", simulatedToday)).toBe(true);
		expect(isTodayNotePath("2026-09-18.md", simulatedToday)).toBe(false);
	});

	it("computes time of day accurately", () => {
		expect(getTimeOfDay(new Date("2026-09-20T08:00:00"))).toBe("morning");
		expect(getTimeOfDay(new Date("2026-09-20T14:30:00"))).toBe("afternoon");
		expect(getTimeOfDay(new Date("2026-09-20T21:00:00"))).toBe("evening");
		expect(getTimeOfDay(new Date("2026-09-20T03:00:00"))).toBe("evening");
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

	it("renders tasks, code, temporal and prior-session lines when present", () => {
		const facts: NoteFacts = {
			path: "2026-09-20.md",
			isDailyNote: true,
			isPeriodicNote: true,
			isEmpty: false,
			isOrphan: false,
			backlinkCount: 1,
			unresolvedLinkCount: 0,
			todoCount: 3,
			hasCode: true,
			isToday: true,
			timeOfDay: "morning",
			hasPriorSession: true,
		};
		const lines = renderNoteFactLines(facts);
		expect(lines).toContain("Note tasks: Contains 3 uncompleted task(s) (- [ ]).");
		expect(lines).toContain("Note content: Contains code blocks or technical scripts.");
		expect(lines).toContain("Temporal context: Today's daily note (working in morning).");
		expect(lines).toContain("Session history: This note was previously referenced in an earlier conversation.");
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
			todoCount: 2,
			hasCode: true,
		};
		expect(noteFactsKeyPart(dailyEmpty)).not.toBe(noteFactsKeyPart(dailyFilled));
		expect(noteFactsKeyPart(dailyEmpty)).toContain("daily");
		expect(noteFactsKeyPart(dailyEmpty)).toContain("empty");
		expect(noteFactsKeyPart(dailyEmpty)).toContain("orphan");
		expect(noteFactsKeyPart(dailyFilled)).toContain("todos:2");
		expect(noteFactsKeyPart(dailyFilled)).toContain("code:1");
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
				getFileCache: () => null,
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
				getFileCache: () => null,
			},
		} as unknown as App;

		const facts = probeNoteFacts(app, "Topic.md");
		expect(facts).not.toBeNull();
		expect(facts?.isEmpty).toBe(false);
		expect(facts?.isOrphan).toBe(false);
		expect(facts?.backlinkCount).toBe(1);
	});

	it("probes tasks and code blocks from metadataCache", () => {
		const mockFile = { path: "Dev.md", stat: { size: 1024 } } as TFile;
		const app = {
			vault: {
				getFileByPath: (path: string) => (path === "Dev.md" ? mockFile : null),
			},
			metadataCache: {
				resolvedLinks: {},
				unresolvedLinks: {},
				getFileCache: () => ({
					listItems: [
						{ task: " " }, // incomplete
						{ task: " " }, // incomplete
						{ task: "x" }, // completed
						{ task: undefined }, // regular bullet
					],
					sections: [
						{ type: "paragraph" },
						{ type: "code" },
					],
					tags: [{ tag: "#project" }],
				}),
			},
		} as unknown as App;

		const facts = probeNoteFacts(app, "Dev.md", { hasPriorSession: true });
		expect(facts).not.toBeNull();
		expect(facts?.todoCount).toBe(2);
		expect(facts?.doneTodoCount).toBe(1);
		expect(facts?.hasCode).toBe(true);
		expect(facts?.dominantTopic).toBe("tasks");
		expect(facts?.hasPriorSession).toBe(true);
	});

	it("integrates scout insights into probed facts and rendered lines", () => {
		const mockFile = { path: "Proactive.md", basename: "Proactive", stat: { size: 500 } } as TFile;
		const app = {
			vault: {
				getFileByPath: (path: string) => (path === "Proactive.md" ? mockFile : null),
				getMarkdownFiles: () => [mockFile],
			},
			metadataCache: {
				resolvedLinks: {},
				unresolvedLinks: {},
				getFileCache: () => null,
			},
		} as unknown as App;

		const scoutInsight = {
			notePath: "Proactive.md",
			timestamp: Date.now(),
			contentHash: "abc123",
			unresolvedPromises: ["待验证移动端离线预取性能"],
			brokenLinkFixes: [{ original: "old-concept", target: "Old Concept" }],
			suggestedMocTopic: "mobile-agent",
			findings: [
				{ label: "基准测试", prompt: "运行移动端预取性能基准测试" },
				{ label: "断链修复", prompt: "修复旧概念链接" },
			],
		};

		const facts = probeNoteFacts(app, "Proactive.md", { scoutInsight });
		expect(facts).not.toBeNull();
		expect(facts?.unresolvedPromises).toEqual(["待验证移动端离线预取性能"]);
		expect(facts?.brokenLinkFixes).toEqual([{ original: "old-concept", target: "Old Concept" }]);
		expect(facts?.suggestedMocTopic).toBe("mobile-agent");
		// The chip is the first finding; the rest are ranked behind it.
		expect(facts?.scoutFinding?.label).toBe("基准测试");

		const lines = renderNoteFactLines(facts!);
		expect(lines).toContain("Scout found: 基准测试 -> 运行移动端预取性能基准测试");
		expect(lines).toContain("Unresolved promises: 待验证移动端离线预取性能");
		expect(lines).toContain("Broken link repair: [[old-concept]] -> [[Old Concept]]");
		expect(lines).toContain("Emergent topic cluster: Eligible for a MOC under #mobile-agent");

		const key = noteFactsKeyPart(facts);
		expect(key).toContain("scout:基准测试");
		expect(key).toContain("promises:1");
		expect(key).toContain("moc:mobile-agent");
	});
});
