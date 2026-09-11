import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { getT } from "../i18n";
import { continueAfterFailureQuickAction, emptyScreenQuickActions, lastReplyFailed } from "./quickActionSuggestions";

const t = getT("en");

/** A minimal assistant turn; `lastReplyFailed` reads only role and stopReason. */
function assistant(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai",
		provider: "deepseek",
		model: "test-model",
		usage: { input: 0, cacheRead: 0, output: 0, total: 0 },
		stopReason,
		timestamp: 0,
	} as AssistantMessage;
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
