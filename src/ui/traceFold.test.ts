import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { getT } from "../i18n";
import {
	blockIsVisible,
	describeTraceFold,
	planTraceFolds,
	traceFoldSlot,
	type TraceFoldGroup,
	type TraceFoldPlan,
	type TraceFoldTally,
} from "./traceFold";
import { planToolPairs } from "./toolPair";

const en = getT("en");
const zh = getT("zh-cn");

describe("planTraceFolds", () => {
	it("folds a run of calls and their results into one group anchored at the first call", () => {
		const plan = plan_([
			user("what links here?"),
			assistant(text("Let me look."), call("grep")),
			result("grep"),
			assistant(call("read")),
			result("read"),
			assistant(text("Two notes link here.")),
		]);

		const groups = heads(plan);
		expect(groups).toHaveLength(1);
		// The call and its result are never in the same message, so a run that did
		// not cross the boundary could never fold the common case.
		expect(rowKeys(groups[0]!)).toEqual(["1:1", "2:result", "3:0", "4:result"]);
		expect(tallies(groups[0]!)).toEqual(["read=1", "search=1"]);
		// The summary draws where the first call stood; every later row draws nothing.
		expect(traceFoldSlot(plan, 1, 1)?.head).toBe(true);
		expect(traceFoldSlot(plan, 2, null)?.head).toBe(false);
		expect(traceFoldSlot(plan, 3, 0)?.head).toBe(false);
	});

	it("leaves a lone call alone, because its own row already says more", () => {
		// "Read a note — Daily/2026-08-27.md" beats "read a note" behind a click.
		const plan = plan_([assistant(call("read")), result("read")]);

		expect(heads(plan)).toHaveLength(0);
		expect(traceFoldSlot(plan, 0, 0)).toBeNull();
	});

	it("breaks a run at prose, so a fold never spans something the model said", () => {
		const plan = plan_([
			assistant(call("read")),
			result("read"),
			assistant(text("Found it. Now the links."), call("grep")),
			result("grep"),
			assistant(call("read")),
			result("read"),
		]);

		// One call before the sentence, two after it.
		const groups = heads(plan);
		expect(groups).toHaveLength(1);
		expect(rowKeys(groups[0]!)).toEqual(["2:1", "3:result", "4:0", "5:result"]);
	});

	it("breaks a run at a thought, which is the model reasoning between the calls", () => {
		const plan = plan_([
			assistant(call("read")),
			result("read"),
			assistant(thinking("that note is stale"), call("read")),
			result("read"),
		]);

		expect(heads(plan)).toHaveLength(0);
	});

	it("keeps a failure out of the fold and breaks the run around it", () => {
		// A result row leads with its error message. Folding one would put the only
		// account of a failed call behind a disclosure the reader has no reason to open.
		const plan = plan_([
			assistant(call("read"), call("read"), call("read")),
			result("read"),
			result("read", { isError: true, content: [{ type: "text", text: "File not found." }] }),
			result("read"),
		]);

		const groups = heads(plan);
		expect(groups).toHaveLength(1);
		expect(rowKeys(groups[0]!)).toEqual(["0:0", "0:1", "0:2", "1:result"]);
		expect(traceFoldSlot(plan, 2, null)).toBeNull();
		// The tail after the failure is a single result with no calls behind it.
		expect(traceFoldSlot(plan, 3, null)).toBeNull();
	});

	it("keeps the answered question out of the fold, since the decision was the reader's", () => {
		const plan = plan_([
			assistant(call("read"), call("read")),
			result("read"),
			result("ask_user"),
			result("read"),
		]);

		const groups = heads(plan);
		expect(groups).toHaveLength(1);
		expect(rowKeys(groups[0]!)).toEqual(["0:0", "0:1", "1:result"]);
		expect(traceFoldSlot(plan, 2, null)).toBeNull();
	});

	it("lets a suppressed question call pass through a run without splitting it", () => {
		// The call draws nothing in the default tier — the question card and the
		// receipt carry it — so breaking the run there would leave two folds with an
		// invisible seam between them.
		const plan = plan_([
			assistant(call("read")),
			result("read"),
			assistant(call("ask_user")),
			assistant(call("read")),
			result("read"),
		]);

		const groups = heads(plan);
		expect(groups).toHaveLength(1);
		expect(rowKeys(groups[0]!)).toEqual(["0:0", "1:result", "3:0", "4:result"]);
		expect(traceFoldSlot(plan, 2, 0)).toBeNull();
	});

	it("splits the run at a question call once agent details make it a visible row", () => {
		const messages = [
			assistant(call("read")),
			result("read"),
			assistant(call("ask_user")),
			assistant(call("read")),
			result("read"),
		];

		expect(heads(plan_(messages, { showAgentDetails: true }))).toHaveLength(0);
	});

	it("folds the calls still out along with the settled ones, in one run", () => {
		// A running call used to be exempt, addressed at the streaming message's last
		// block. That could only ever cover one call: a turn issuing eight left seven
		// of them folded and reported as finished, which is the case the exemption
		// existed to prevent. The fold breathes while it holds one — one animation for
		// however many are behind it — so the exemption is gone and every call in the
		// run is in the run.
		const messages = [
			assistant(call("grep")),
			result("grep"),
			assistant(call("spawn_subagent"), call("spawn_subagent"), call("wait_subagent")),
		];
		const plan = plan_(messages);

		const groups = heads(plan);
		expect(groups).toHaveLength(1);
		expect(rowKeys(groups[0]!)).toEqual(["0:0", "1:result", "2:0", "2:1", "2:2"]);
	});

	it("names the categories in a fixed order, not the order the calls arrived in", () => {
		// A line whose shape shifts with the traffic reads differently every turn,
		// and the vault change is the part worth meeting first either way.
		const plan = plan_([assistant(call("grep"), call("grep"), call("edit"))]);

		expect(tallies(heads(plan)[0]!)).toEqual(["write=1", "search=2"]);
	});

	it("folds a run that never settled, so an interrupted turn reads like any other", () => {
		const plan = plan_([assistant(call("read"), call("read"), call("grep"))]);

		expect(rowKeys(heads(plan)[0]!)).toEqual(["0:0", "0:1", "0:2"]);
	});

	it("ignores the empty text block a provider can open before its first token", () => {
		const plan = plan_([assistant(call("read")), result("read"), assistant(text("  "), call("read")), result("read")]);

		expect(heads(plan)).toHaveLength(1);
	});

	it("folds nothing in the two modes chosen to open machine traffic", () => {
		const messages = [assistant(call("read"), call("grep")), result("read"), result("grep")];

		for (const mode of ["highValue", "expanded"] as const) {
			expect(heads(plan_(messages, { mode }))).toHaveLength(0);
		}
	});

	it("starts a fresh run after the user's own turn", () => {
		const plan = plan_([
			assistant(call("read")),
			result("read"),
			user("and the other one?"),
			assistant(call("read")),
			result("read"),
		]);

		expect(heads(plan)).toHaveLength(0);
	});

	it("breaks a run at harness output, which is a row of its own", () => {
		const plan = plan_([
			assistant(call("read")),
			result("read"),
			{ role: "custom", content: "context trimmed", timestamp: 0 } as AgentMessage,
			assistant(call("read")),
			result("read"),
		]);

		expect(heads(plan)).toHaveLength(0);
	});
});

describe("blockIsVisible", () => {
	it("hides the question call the transcript draws as a card, unless the payload is on show", () => {
		expect(blockIsVisible(call("ask_user"), false)).toBe(false);
		expect(blockIsVisible(call("ask_user"), true)).toBe(true);
		expect(blockIsVisible(call("read"), false)).toBe(true);
	});

	it("treats a blank text block as nothing on screen, and any thought as something", () => {
		expect(blockIsVisible(text(""), false)).toBe(false);
		expect(blockIsVisible(text("\n\t "), false)).toBe(false);
		expect(blockIsVisible(text("a word"), false)).toBe(true);
		expect(blockIsVisible(thinking(""), false)).toBe(true);
	});
});

describe("describeTraceFold", () => {
	it("names one category in sentence case, singular and plural apart", () => {
		expect(describeTraceFold(tally({ read: 1 }), en)).toBe("Read a note");
		expect(describeTraceFold(tally({ read: 4 }), en)).toBe("Read 4 notes");
	});

	it("joins the final pair with the conjunction the language chose", () => {
		expect(describeTraceFold(tally({ write: 1, read: 3 }), en)).toBe("Changed a note and read 3 notes");
		expect(describeTraceFold(tally({ write: 1, read: 3 }), zh)).toBe("改动了 1 条笔记并读取了 3 条笔记");
	});

	it("lists three with the separator and keeps the conjunction for the last", () => {
		expect(describeTraceFold(tally({ write: 2, read: 1, search: 5 }), en)).toBe("Changed 2 notes, read a note and ran 5 searches");
	});

	it("says which tools were the other ones only when something else is named", () => {
		// Alone, "used 2 other tools" is other than what? Alongside a named
		// category, "used 2 tools" invites the reader to wonder whether the notes
		// next to it were somehow not tools.
		expect(describeTraceFold(tally({ other: 2 }), en)).toBe("Used 2 tools");
		expect(describeTraceFold(tally({ read: 1, other: 2 }), en)).toBe("Read a note and used 2 other tools");
		expect(describeTraceFold(tally({ read: 1, other: 1 }), en)).toBe("Read a note and used another tool");
	});

});

/** Builds a plan for `messages`, in the all-collapsed mode unless a test says otherwise. */
function plan_(messages: readonly AgentMessage[], options: Partial<Parameters<typeof planTraceFolds>[1]> = {}): TraceFoldPlan {
	return planTraceFolds(messages, { mode: "collapsed", showAgentDetails: false, ...options });
}

/** The groups a plan holds, in transcript order — one entry per fold, not per row. */
function heads(plan: TraceFoldPlan): TraceFoldGroup[] {
	return [...plan.slots.values()].filter((slot) => slot.head).map((slot) => slot.group);
}

/** A group's rows as `message:block` addresses, which is what makes the assertions readable. */
function rowKeys(group: TraceFoldGroup): string[] {
	return group.rows.map((row) => `${row.ref.message}:${row.ref.block ?? "result"}`);
}

function tallies(group: TraceFoldGroup): string[] {
	return group.tallies.map((entry) => `${entry.category}=${entry.count}`);
}

/** Tallies in the order given, so a test can pin the order the summary puts them in. */
function tally(counts: Partial<Record<TraceFoldTally["category"], number>>): TraceFoldTally[] {
	return Object.entries(counts).map(([category, count]) => ({ category, count } as TraceFoldTally));
}

function assistant(...content: AssistantMessage["content"]): AgentMessage {
	return { role: "assistant", content, timestamp: 0 } as AgentMessage;
}

function user(content: string): AgentMessage {
	return { role: "user", content, timestamp: 0 } as AgentMessage;
}

function result(toolName: string, overrides: Partial<ToolResultMessage> = {}): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: `${toolName}-1`,
		toolName,
		content: [{ type: "text", text: "done" }],
		isError: false,
		timestamp: 0,
		...overrides,
	} as AgentMessage;
}

function call(name: string): ToolCall {
	return { type: "toolCall", id: `${name}-1`, name, arguments: {} };
}

function text(value: string): AssistantMessage["content"][number] {
	return { type: "text", text: value };
}

function thinking(value: string): AssistantMessage["content"][number] {
	return { type: "thinking", thinking: value };
}

/**
 * What the planner does once it knows which result answered which call.
 *
 * These two rules exist because the renderer now draws an invocation as one row.
 * Before that, a call and its result were two rows and the planner treated them as
 * two; the fold rules were written against that shape, and one of them — a failure
 * is never folded — silently stopped holding when the call started carrying the
 * result.
 */
describe("planning a fold over paired rows", () => {
	/*
	 * A paired result is not a row at all: its call draws it. Counted as one, it
	 * inflates what the fold claims to have swallowed, and when it happens to open a
	 * run it becomes the run's *head* — the address the summary draws at — which is
	 * an address nothing occupies, so the entire run disappears from the transcript.
	 */
	it("treats a result its call will draw as no row at all", () => {
		const messages = [assistant(call("read"), call("grep")), result("read"), result("grep")];
		const pairs = planToolPairs(messages);
		const plan = planTraceFolds(messages, { mode: "collapsed", showAgentDetails: false, pairs });

		const group = traceFoldSlot(plan, 0, 0)?.group;
		expect(group?.rows.map((row) => row.kind)).toEqual(["call", "call"]);
		// Neither result has a slot of its own, so neither can head a run.
		expect(traceFoldSlot(plan, 1, null)).toBeNull();
		expect(traceFoldSlot(plan, 2, null)).toBeNull();
	});

	/*
	 * A failed result has always broken a run — a row the reader must not have to
	 * open to see cannot be folded away — and it did that from its own slot. Now the
	 * failure arrives on the call's row, so the break has to happen at the call:
	 * otherwise the run swallows the call, the call carries the failure inside, and
	 * the one row the rule exists to keep out is the one row hidden by it.
	 */
	it("breaks the run at a call whose result failed", () => {
		const messages = [assistant(call("read"), call("grep"), call("write")), result("read", { isError: true }), result("grep"), result("write")];
		const pairs = planToolPairs(messages);
		const plan = planTraceFolds(messages, { mode: "collapsed", showAgentDetails: false, pairs });

		// The failed call stands alone; the two that worked fold together.
		expect(traceFoldSlot(plan, 0, 0)).toBeNull();
		expect(traceFoldSlot(plan, 0, 1)?.head).toBe(true);
		expect(traceFoldSlot(plan, 0, 1)?.group.rows).toHaveLength(2);
	});

	/*
	 * The orphan is the one result still worth a row: nothing in the transcript
	 * claimed it, so nothing else will draw it. It keeps its slot, which is what lets
	 * it open a run the way any row does.
	 */
	it("keeps a result no call claimed", () => {
		const messages = [result("read", { toolCallId: "vanished" }), assistant(call("grep"), call("write"))];
		const pairs = planToolPairs(messages);
		const plan = planTraceFolds(messages, { mode: "collapsed", showAgentDetails: false, pairs });

		expect(traceFoldSlot(plan, 0, null)?.head).toBe(true);
		expect(traceFoldSlot(plan, 0, null)?.group.rows.map((row) => row.kind)).toEqual(["result", "call", "call"]);
	});
});
