import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { pairedResult, planToolPairs, resultIsPaired } from "./toolPair";

describe("a call and the result that answered it", () => {
	it("pairs on the id the provider put on both", () => {
		const plan = planToolPairs([assistant(call("read", "c1")), result("read", "c1")]);

		const match = pairedResult(plan, 0, 0);
		expect(match).not.toBeNull();
		expect(match?.toolCallId).toBe("c1");
		expect(resultIsPaired(plan, 1)).toBe(true);
	});

	/*
	 * pi delivers batched tool calls inside one assistant message. Pairing works by
	 * id, not by sequence, so each call claims its own result no matter which
	 * returned first.
	 */
	it("pairs across the gap when a turn batches its calls", () => {
		const messages = [assistant(call("read", "c1"), call("write", "c2")), result("write", "c2"), result("read", "c1")];
		const plan = planToolPairs(messages);

		expect(pairedResult(plan, 0, 0)?.toolCallId).toBe("c1");
		expect(pairedResult(plan, 0, 1)?.toolCallId).toBe("c2");
		expect(resultIsPaired(plan, 1)).toBe(true);
		expect(resultIsPaired(plan, 2)).toBe(true);
	});

	/*
	 * While the tool is still running, its call has arrived but its result has
	 * not. The call must not claim anything, and the plan must stay valid while the
	 * transcript streams.
	 */
	it("leaves a call unpaired while the tool is still out", () => {
		const plan = planToolPairs([assistant(call("read", "c1"))]);

		expect(pairedResult(plan, 0, 0)).toBeNull();
		expect(resultIsPaired(plan, 0)).toBe(false);
	});

	/*
	 * An orphan result — a session file with a corrupted turn, a synthetic test
	 * fixture. Leaving it unpaired lets it render itself so the user can see it,
	 * rather than swallowing it because no call owns it.
	 */
	it("leaves a result unpaired when nothing in the transcript called it", () => {
		const plan = planToolPairs([result("read", "orphan")]);

		expect(resultIsPaired(plan, 0)).toBe(false);
	});

	/*
	 * Two calls on one id — a session file replayed from a build that numbered them
	 * differently, a provider that reuses ids across turns. The first claims the
	 * result and the second is left to draw itself: an unpaired call still says
	 * truthfully what it asked for, where a shared result would tell the reader an
	 * edit succeeded that never ran.
	 */
	it("gives a duplicated id to the first call only", () => {
		const messages = [assistant(call("read", "dup")), assistant(call("read", "dup")), result("read", "dup")];
		const plan = planToolPairs(messages);

		expect(pairedResult(plan, 0, 0)).not.toBeNull();
		expect(pairedResult(plan, 1, 0)).toBeNull();
	});

	/*
	 * Two results for one call, which nothing should emit but a hand-edited session
	 * file can hold. The first is paired; the second is not claimed, so it draws
	 * itself rather than disappearing.
	 */
	it("claims one result per call, leaving a second copy visible", () => {
		const plan = planToolPairs([assistant(call("read", "c1")), result("read", "c1"), result("read", "c1")]);

		expect(resultIsPaired(plan, 1)).toBe(true);
		expect(resultIsPaired(plan, 2)).toBe(false);
	});

	it("pairs nothing when the result carries no id to pair on", () => {
		const plan = planToolPairs([assistant(call("read", "")), result("read", "")]);

		expect(resultIsPaired(plan, 1)).toBe(false);
	});
});

describe("the question the reader answered", () => {
	/*
	 * `ask_user` is the one tool whose result is not machine traffic: its call row is
	 * suppressed and its result renders as a receipt of a decision the reader made.
	 * Pairing it would hand the receipt to a row that is not drawn, so the reader's
	 * own answer would vanish from the transcript.
	 */
	it("never pairs, so its receipt keeps its own row", () => {
		const plan = planToolPairs([assistant(call("ask_user", "c1")), result("ask_user", "c1")]);

		expect(pairedResult(plan, 0, 0)).toBeNull();
		expect(resultIsPaired(plan, 1)).toBe(false);
	});

	it("never pairs present_ui, so its receipt keeps its own row", () => {
		const plan = planToolPairs([assistant(call("present_ui", "p1")), result("present_ui", "p1")]);

		expect(pairedResult(plan, 0, 0)).toBeNull();
		expect(resultIsPaired(plan, 1)).toBe(false);
	});
});

function assistant(...content: AssistantMessage["content"]): AgentMessage {
	return { role: "assistant", content, timestamp: 0 } as AgentMessage;
}

function call(name: string, id: string): ToolCall {
	return { type: "toolCall", id, name, arguments: { path: `${name}.md` } };
}

function result(toolName: string, toolCallId: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 0,
	} as AgentMessage;
}
