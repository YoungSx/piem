import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { getT } from "../i18n";
import { continueAfterFailureQuickAction, distillSkillQuickAction, emptyScreenQuickActions, lastReplyFailed } from "./quickActionSuggestions";

const t = getT("en");

/** A minimal assistant turn; `lastReplyFailed` reads only role and stopReason. */
function assistant(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai",
		provider: "deepseek",
		model: "test-model",
		usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: 0,
	};
}

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

describe("emptyScreenQuickActions", () => {
	it("suggests note-centred prompts when an active note is in context", () => {
		const actions = emptyScreenQuickActions(true, t);
		expect(actions.map((action) => action.id)).toEqual(["summarizeNote", "improveNote", "brainstorm"]);
		// The prompt is what a tap sends, and it must name the note rather than
		// assuming the model already knows what "it" means.
		expect(actions[0]?.prompt).toContain("note");
	});

	it("suggests daily note-centred prompts for daily or periodic notes", () => {
		const dailyFacts = {
			path: "2026-09-18.md",
			isDailyNote: true,
			isPeriodicNote: true,
			isEmpty: false,
			isOrphan: false,
			backlinkCount: 2,
			unresolvedLinkCount: 0,
		};
		const actions = emptyScreenQuickActions(true, t, dailyFacts);
		expect(actions.map((action) => action.id)).toEqual(["todayTasks", "planDay", "reviewDay"]);
		expect(actions[0]?.prompt).toContain("list_tasks");
	});

	it("suggests scaffold-centred prompts for empty draft notes", () => {
		const emptyFacts = {
			path: "Draft.md",
			isDailyNote: false,
			isPeriodicNote: false,
			isEmpty: true,
			isOrphan: true,
			backlinkCount: 0,
			unresolvedLinkCount: 0,
		};
		const actions = emptyScreenQuickActions(true, t, emptyFacts);
		expect(actions.map((action) => action.id)).toEqual(["scaffoldOutline", "researchTopic", "brainstorm"]);
		expect(actions[0]?.prompt).toContain("outline");
	});

	it("suggests link-graph prompts for orphan notes with 0 backlinks", () => {
		const orphanFacts = {
			path: "Isolated.md",
			isDailyNote: false,
			isPeriodicNote: false,
			isEmpty: false,
			isOrphan: true,
			backlinkCount: 0,
			unresolvedLinkCount: 1,
		};
		const actions = emptyScreenQuickActions(true, t, orphanFacts);
		expect(actions.map((action) => action.id)).toEqual(["linkGraph", "findMentions", "summarizeNote"]);
		expect(actions[0]?.prompt).toContain("/link-graph");
	});

	it("suggests prior session recall when an active note was discussed previously", () => {
		const priorFacts = {
			path: "Arch.md",
			isDailyNote: false,
			isPeriodicNote: false,
			isEmpty: false,
			isOrphan: false,
			backlinkCount: 1,
			unresolvedLinkCount: 0,
			hasPriorSession: true,
		};
		const actions = emptyScreenQuickActions(true, t, priorFacts);
		expect(actions.map((action) => action.id)).toEqual(["recallSession", "summarizeNote", "improveNote"]);
	});

	it("suggests morning focus for today's daily note in the morning", () => {
		const morningDaily = {
			path: "2026-09-20.md",
			isDailyNote: true,
			isPeriodicNote: true,
			isEmpty: false,
			isOrphan: false,
			backlinkCount: 1,
			unresolvedLinkCount: 0,
			isToday: true,
			timeOfDay: "morning" as const,
		};
		const actions = emptyScreenQuickActions(true, t, morningDaily);
		expect(actions.map((action) => action.id)).toEqual(["morningFocus", "todayTasks", "planDay"]);
	});

	it("suggests evening reflection and inbox sinking for today's daily note in the evening", () => {
		const eveningDaily = {
			path: "2026-09-20.md",
			isDailyNote: true,
			isPeriodicNote: true,
			isEmpty: false,
			isOrphan: false,
			backlinkCount: 1,
			unresolvedLinkCount: 0,
			isToday: true,
			timeOfDay: "evening" as const,
			todoCount: 2,
		};
		const actions = emptyScreenQuickActions(true, t, eveningDaily);
		expect(actions.map((action) => action.id)).toEqual(["reviewDay", "sinkInbox", "extractTodos"]);
	});

	it("suggests task extraction when note has uncompleted tasks", () => {
		const taskFacts = {
			path: "Sprint.md",
			isDailyNote: false,
			isPeriodicNote: false,
			isEmpty: false,
			isOrphan: false,
			backlinkCount: 2,
			unresolvedLinkCount: 0,
			todoCount: 4,
		};
		const actions = emptyScreenQuickActions(true, t, taskFacts);
		expect(actions.map((action) => action.id)).toEqual(["extractTodos", "summarizeNote", "improveNote"]);
	});

	it("suggests code review and explanation for technical code notes", () => {
		const codeFacts = {
			path: "Algorithm.md",
			isDailyNote: false,
			isPeriodicNote: false,
			isEmpty: false,
			isOrphan: false,
			backlinkCount: 1,
			unresolvedLinkCount: 0,
			hasCode: true,
		};
		const actions = emptyScreenQuickActions(true, t, codeFacts);
		expect(actions.map((action) => action.id)).toEqual(["reviewCode", "explainCode", "improveNote"]);
	});

	it("suggests insight distillation for reading / research notes", () => {
		const readingFacts = {
			path: "BookReview.md",
			isDailyNote: false,
			isPeriodicNote: false,
			isEmpty: false,
			isOrphan: false,
			backlinkCount: 2,
			unresolvedLinkCount: 0,
			dominantTopic: "reading" as const,
		};
		const actions = emptyScreenQuickActions(true, t, readingFacts);
		expect(actions.map((action) => action.id)).toEqual(["distillNotes", "summarizeNote", "brainstorm"]);
	});

	it("prioritizes staged scout actions above static heuristics", () => {
		const scoutFacts = {
			path: "Architecture.md",
			isDailyNote: false,
			isPeriodicNote: false,
			isEmpty: false,
			isOrphan: false,
			backlinkCount: 3,
			unresolvedLinkCount: 0,
			stagedScoutAction: {
				label: "Verify Quantization",
				prompt: "Evaluate throughput under Q4 quantization.",
			},
		};
		const actions = emptyScreenQuickActions(true, t, scoutFacts);
		expect(actions[0]?.id).toBe("scoutStagedAction");
		expect(actions[0]?.label).toBe("Verify Quantization");
		expect(actions[0]?.prompt).toBe("Evaluate throughput under Q4 quantization.");
	});

	it("prioritizes unresolved promises when present", () => {
		const promiseFacts = {
			path: "Plan.md",
			isDailyNote: false,
			isPeriodicNote: false,
			isEmpty: false,
			isOrphan: false,
			backlinkCount: 1,
			unresolvedLinkCount: 0,
			unresolvedPromises: ["Check cache invalidation race condition"],
		};
		const actions = emptyScreenQuickActions(true, t, promiseFacts);
		expect(actions[0]?.id).toBe("resolvePromise");
		expect(actions[0]?.label).toBe(t.t("quickActions.empty.resolvePromise.label"));
		expect(actions[0]?.prompt).toContain("Check cache invalidation race condition");
	});

	it("prioritizes broken link fixes when present", () => {
		const fixFacts = {
			path: "Notes.md",
			isDailyNote: false,
			isPeriodicNote: false,
			isEmpty: false,
			isOrphan: false,
			backlinkCount: 1,
			unresolvedLinkCount: 1,
			brokenLinkFixes: [{ original: "ai-roadmap", target: "AI Roadmap" }],
		};
		const actions = emptyScreenQuickActions(true, t, fixFacts);
		expect(actions[0]?.id).toBe("fixBrokenLink");
		expect(actions[0]?.prompt).toContain("[[ai-roadmap]]");
		expect(actions[0]?.prompt).toContain("[[AI Roadmap]]");
	});

	it("suggests building a topic MOC when emergent topic is detected", () => {
		const mocFacts = {
			path: "Research.md",
			isDailyNote: false,
			isPeriodicNote: false,
			isEmpty: false,
			isOrphan: false,
			backlinkCount: 2,
			unresolvedLinkCount: 0,
			suggestedMocTopic: "distributed-systems",
		};
		const actions = emptyScreenQuickActions(true, t, mocFacts);
		expect(actions[0]?.id).toBe("buildMoc");
		expect(actions[0]?.prompt).toContain("#distributed-systems");
	});

	it("turns to the vault as a whole when nothing is open", () => {
		const actions = emptyScreenQuickActions(false, t);
		expect(actions.map((action) => action.id)).toEqual(["draftNote", "mapVault", "capabilities"]);
		// The note-centred prompts must not leak into this branch: without an
		// active ref the model was not given a note, so the chip would lie.
		expect(actions.map((action) => action.id)).not.toContain("summarizeNote");
	});

	it("labels every action, since the label is the whole chip on screen", () => {
		for (const hasNote of [true, false]) {
			for (const action of emptyScreenQuickActions(hasNote, t)) {
				expect(action.label.length).toBeGreaterThan(0);
				expect(action.prompt.length).toBeGreaterThan(0);
			}
		}
	});
});

describe("distillSkillQuickAction", () => {
	it("offers the distill-skill prompt chip", () => {
		const action = distillSkillQuickAction(t);
		expect(action.id).toBe("distillSkill");
		expect(action.prompt).toContain("/distill-skill");
		expect(action.label.length).toBeGreaterThan(0);
	});
});

describe("continueAfterFailureQuickAction", () => {
	it("offers exactly one chip, and its prompt is a real message", () => {
		const actions = continueAfterFailureQuickAction(t);
		// One chip, not a row: the failure already said what happened, so the only
		// thing left to offer is the way forward.
		expect(actions).toHaveLength(1);
		// The prompt is a visible user message by contract, not a hidden
		// mechanism — it must read as words a user could have typed.
		expect(actions[0]?.prompt.length).toBeGreaterThan(0);
		expect(actions[0]?.label.length).toBeGreaterThan(0);
	});
});

describe("lastReplyFailed", () => {
	it("reads the failure off the reply that settled the run", () => {
		expect(lastReplyFailed([user("hello"), assistant("error")])).toBe(true);
	});

	it("does not treat a user stop as a failure to offer recovery for", () => {
		expect(lastReplyFailed([user("hello"), assistant("aborted")])).toBe(false);
	});

	it("sees through the toolResult a tool-using run parks on", () => {
		const messages: AgentMessage[] = [user("hello"), assistant("toolUse")];
		expect(lastReplyFailed(messages)).toBe(false);
	});

	it("stops at the newest question, not an older exchange's reply", () => {
		// The failed reply behind a user turn belongs to an earlier exchange —
		// its failure was offered its chip when that exchange settled.
		expect(lastReplyFailed([user("hello"), assistant("error"), user("and then?")])).toBe(false);
	});

	it("reads an empty transcript as no failure", () => {
		expect(lastReplyFailed([])).toBe(false);
	});
});
