import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getT } from "../i18n";
import type { SubagentSnapshot } from "../subagent/inspectorModel";
import { configItems, formatDuration, incompleteNote, processSteps, reportBody, statusText, timingLine, usageItems } from "./inspectorCopy";

/**
 * Wording rules for the subagent monitor.
 *
 * The hard part of this panel is not its layout, it is what it says about a run
 * that did not finish cleanly — and every one of those sentences is a decision
 * that can regress silently. Split from the renderer for the same reason
 * `headerCopy.test.ts` is: these assertions need no DOM, so they can pin the
 * wording directly rather than through markup that may move.
 */

const t = getT("en");
const zh = getT("zh-cn");

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
	return {
		id: "subagent-1",
		role: "scout",
		task: "Sweep Projects/ for stale notes",
		depth: 1,
		ownerId: "chat-a",
		modelId: "deepseek-v4-pro",
		thinkingLevel: "off",
		status: "done",
		spawnedAt: 1_000,
		settledAt: 4_000,
		durationMs: 3_000,
		messages: [],
		...overrides,
	};
}

describe("duration reads at one unit", () => {
	it("floors a sub-second run to 0s rather than printing milliseconds", () => {
		// Milliseconds are the one unit here nobody has an intuition for, and a
		// run that fast is "instant", not "412".
		expect(formatDuration(412)).toBe("0s");
	});

	it("counts seconds under a minute and minutes under an hour", () => {
		expect(formatDuration(45_000)).toBe("45s");
		expect(formatDuration(3 * 60_000)).toBe("3m");
		expect(formatDuration(59 * 60_000)).toBe("59m");
	});

	it("drops the minutes from a whole-hour run instead of printing 1h0m", () => {
		expect(formatDuration(60 * 60_000)).toBe("1h");
		expect(formatDuration(95 * 60_000)).toBe("1h35m");
	});

	it("never reports a negative duration, since a clock can move backwards", () => {
		// `durationMs` is `now - spawnedAt`, and `now` comes from the caller: a
		// system clock adjustment between spawn and snapshot must not print "-3s".
		expect(formatDuration(-5_000)).toBe("0s");
	});

	it("words a running child's elapsed time in the same shape as a settled one", () => {
		// The status word beside it already says the run is not over, so a second
		// tense here would only repeat it.
		expect(timingLine(snapshot({ status: "running", durationMs: 120_000 }), t)).toBe("ran for 2m");
	});
});

describe("a partial report says so, and says whose decision it was", () => {
	it("stays silent for a run that finished on its own", () => {
		// The common case must carry no caveat the reader has to interpret.
		expect(incompleteNote(snapshot(), t)).toBeNull();
	});

	it("says the report is partial without inventing a cause", () => {
		// A run only ever stops because something stopped it, and `killedBy`
		// answers whose decision that was — so the caveat's own job is narrower:
		// warn that the text below is a fragment.
		const note = incompleteNote(snapshot({ status: "incomplete", incomplete: true }), t);

		expect(note).toContain("partial");
	});

	it("joins both facts when a kill produced the partial report", () => {
		// Two separate questions — "can I trust this?" and "whose decision was
		// that?" — and a reader hitting a partial report reads a sentence, not a
		// legend of two badges.
		const note = incompleteNote(snapshot({ status: "incomplete", incomplete: true, killedBy: "tool" }), t);

		expect(note).toContain("Stopped before it finished");
		expect(note).toContain("no longer needed");
	});

	it("attributes a teardown kill to the chat closing, not to a failure", () => {
		expect(incompleteNote(snapshot({ status: "incomplete", killedBy: "teardown" }), t)).toContain("the chat closed");
	});

	it("reports a kill even when the report survived whole", () => {
		// `killedBy` without `incomplete` is real: a child killed after its last
		// assistant message still settled cleanly, and the reader should know an
		// outside decision was involved.
		expect(incompleteNote(snapshot({ killedBy: "parent" }), t)).toBe("It stopped because the chat turn stopped.");
	});

	it("attributes a user kill to the reader themselves, not to Piem or the chat", () => {
		// The monitor panel's stop button is the one cause the reader caused, and
		// "you" is the honest word for it — Piem did not decide, and the chat did
		// not stop.
		expect(incompleteNote(snapshot({ killedBy: "user" }), t)).toContain("You stopped it");
	});
});

describe("the setup block reports what actually ran", () => {
	it("lists role, model, thinking and depth in that order", () => {
		const items = configItems(snapshot(), t);

		expect(items.map((item) => item.label)).toEqual(["Role", "Model", "Thinking", "Level"]);
		expect(items.map((item) => item.value)).toEqual(["scout", "deepseek-v4-pro", "off", "1"]);
	});

	it("marks the model and the thinking level as identifiers, and the role as prose", () => {
		// A model id is compared character by character, so it is set in monospace;
		// "scout" is a word. The renderer cannot tell which it was handed.
		const byLabel = new Map(configItems(snapshot(), t).map((item) => [item.label, item.isIdentifier ?? false]));

		expect(byLabel.get("Model")).toBe(true);
		expect(byLabel.get("Thinking")).toBe(true);
		expect(byLabel.get("Role")).toBe(false);
	});
});

describe("usage totals are absent rather than zero", () => {
	it("says nothing about a run that has produced no result yet", () => {
		// A row of zeros would read as a measurement. There is nothing to measure.
		expect(usageItems(snapshot({ status: "running", turns: undefined, usage: undefined }), true, t)).toEqual([]);
	});

	it("omits tokens until a request has reported usage", () => {
		// `requests: 0` is "no data", which is a different fact from "0 tokens".
		expect(usageItems(snapshot({ turns: 2, usage: { tokens: 0, cost: 0, requests: 0 } }), true, t)).toEqual(["2 turn(s)"]);
	});

	it("keeps spend behind the agent-details tier, like the context popover", () => {
		const usage = { tokens: 12_400, cost: 0.42, requests: 3 };

		expect(usageItems(snapshot({ turns: 4, usage }), false, t)).toEqual(["4 turn(s)", "12.4k tokens"]);
		expect(usageItems(snapshot({ turns: 4, usage }), true, t)).toEqual(["4 turn(s)", "12.4k tokens", "$0.42"]);
	});
});

describe("the report slot never pretends", () => {
	it("hands back the child's own text as a report", () => {
		expect(reportBody(snapshot({ report: "## Findings\n\nThree stale notes." }), t)).toEqual({
			kind: "report",
			text: "## Findings\n\nThree stale notes.",
		});
	});

	it("promises a report only while the run is still going", () => {
		expect(reportBody(snapshot({ status: "running", report: undefined }), t)).toEqual({
			kind: "note",
			text: "Still working. Its report lands here when it finishes.",
		});
	});

	it("marks a failure's missing report as a note, not as Markdown the child wrote", () => {
		// The distinction is load-bearing: running a substitute sentence through
		// the Markdown pipeline would be a lie about where the words came from.
		expect(reportBody(snapshot({ status: "failed", report: undefined }), t).kind).toBe("note");
	});

	it("treats a whitespace-only report as no report at all", () => {
		expect(reportBody(snapshot({ report: "   \n  " }), t).kind).toBe("note");
	});

	it("does not promise a report to a settled run that wrote none", () => {
		// The runner's empty-clean return. "Still working" would be the one wrong
		// answer here — it is not coming.
		expect(reportBody(snapshot({ status: "done", report: "" }), t).text).not.toContain("Still working");
	});
});

describe("the process record is a sequence, one line per step", () => {
	const messages: AgentMessage[] = [
		{ role: "user", content: "Sweep Projects/", timestamp: 1 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Start with the folder listing." },
				{ type: "text", text: "Listing the folder." },
				{ type: "toolCall", id: "c1", name: "ls", arguments: { path: "Projects" } },
			],
			usage: {},
			timestamp: 2,
		} as unknown as AgentMessage,
		{ role: "toolResult", toolCallId: "c1", toolName: "ls", content: [{ type: "text", text: "3 notes" }], isError: false, timestamp: 3 } as AgentMessage,
		{ role: "toolResult", toolCallId: "c2", toolName: "grep", content: [{ type: "text", text: "boom" }], isError: true, timestamp: 4 } as AgentMessage,
	];

	it("names each step in the reader's vocabulary, not the protocol's", () => {
		expect(processSteps(messages, t).map((step) => step.label)).toEqual([
			"Brief",
			"Thinking",
			"Reply",
			"Ran ls",
			"ls returned",
			"grep failed",
		]);
	});

	it("keeps thinking blocks, which are what explain a surprising tool call", () => {
		// Safe here in a way it is not in the live transcript: the run is over, so
		// there is no token stream to flood, and nothing here can be replied to.
		expect(processSteps(messages, t)[1]).toMatchObject({ label: "Thinking", text: "Start with the folder listing." });
	});

	it("marks a failed tool result so the row can carry it", () => {
		expect(processSteps(messages, t).at(-1)).toMatchObject({ label: "grep failed", isError: true });
	});

	it("leaves a tool call's own row textless, since its arguments are not the step", () => {
		expect(processSteps(messages, t)[3]).toMatchObject({ label: "Ran ls", text: "", clipped: false });
	});

	it("clips a long step and says it clipped", () => {
		const long = "x".repeat(400);
		const [step] = processSteps([{ role: "user", content: long, timestamp: 1 }], t);

		expect(step?.clipped).toBe(true);
		expect(step?.text.length).toBe(160);
	});

	it("reads a block-form user message, not only a plain string", () => {
		const blocks: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "From blocks" }], timestamp: 1 } as AgentMessage,
		];

		expect(processSteps(blocks, t)[0]?.text).toBe("From blocks");
	});

	it("skips harness roles a child never produces rather than showing an unnamed row", () => {
		const harness = [{ role: "compactionSummary", summary: "earlier work", timestamp: 1 }] as unknown as AgentMessage[];

		expect(processSteps(harness, t)).toEqual([]);
	});

	it("survives an image-only message instead of inventing text for it", () => {
		const images = [
			{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "" }], timestamp: 1 },
		] as unknown as AgentMessage[];

		expect(processSteps(images, t)[0]).toMatchObject({ text: "", clipped: false });
	});
});

describe("every sentence is translated, not only the labels", () => {
	it("names the four statuses in Chinese", () => {
		expect(["running", "done", "incomplete", "failed"].map((status) => statusText(status as SubagentSnapshot["status"], zh))).toEqual([
			"进行中",
			"已完成",
			"被中断",
			"失败",
		]);
	});

	it("translates the caveat a reader most needs to understand", () => {
		expect(incompleteNote(snapshot({ status: "incomplete", incomplete: true }), zh)).toContain("残稿");
	});

	it("translates the process record's step names", () => {
		const zhSteps = processSteps([{ role: "user", content: "扫一遍", timestamp: 1 }], zh);

		expect(zhSteps[0]?.label).toBe("指令");
	});
});
