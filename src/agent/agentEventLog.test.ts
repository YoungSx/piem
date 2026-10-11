import { describe, expect, it } from "bun:test";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { describeAgentEvent, extractToolErrorText } from "./agentEventLog";

/**
 * The log mapping over Pi's event stream.
 *
 * The properties under test are the ones a debugging user relies on: tool
 * lifecycle lands at `info` with durations, a failed tool escalates to `warn`
 * carrying the provider's error text, streaming deltas are dropped so one
 * response cannot evict every other diagnostic, and an event type this
 * revision of Pi did not have still produces a record instead of vanishing.
 */

describe("describeAgentEvent", () => {
	it("maps the run lifecycle to info with message counts", () => {
		expect(describeAgentEvent({ type: "agent_start" })).toEqual({ level: "info", message: "Run started" });
		const end: AgentEvent = { type: "agent_end", messages: [{ role: "assistant", content: [] }] as never };
		const entry = describeAgentEvent(end);
		expect(entry?.level).toBe("info");
		expect(entry?.detail).toEqual({ messages: 1 });
	});

	it("maps the turn and message lifecycle to debug", () => {
		expect(describeAgentEvent({ type: "turn_start" })?.level).toBe("debug");
		const turnEnd: AgentEvent = { type: "turn_end", message: { role: "assistant", content: [] } as never, toolResults: [] };
		expect(describeAgentEvent(turnEnd)?.detail).toEqual({ toolResults: 0 });
		const messageEnd: AgentEvent = { type: "message_end", message: { role: "user", content: [] } as never };
		expect(describeAgentEvent(messageEnd)).toEqual({
			level: "debug",
			message: "Message finished",
			detail: { role: "user" },
		});
	});

	it("drops per-token deltas but keeps streaming structure", () => {
		const delta = (type: string): AgentEvent =>
			({ type: "message_update", assistantMessageEvent: { type }, message: {} }) as unknown as AgentEvent;
		expect(describeAgentEvent(delta("text_delta"))).toBeNull();
		expect(describeAgentEvent(delta("thinking_delta"))).toBeNull();
		expect(describeAgentEvent(delta("toolcall_delta"))).toBeNull();
		expect(describeAgentEvent(delta("text_start"))?.message).toBe("Text started");
		expect(describeAgentEvent(delta("thinking_end"))?.message).toBe("Thinking finished");
		expect(describeAgentEvent(delta("toolcall_start"))?.message).toBe("Tool call started");
	});

	it("records tool timing at info", () => {
		const entry = describeAgentEvent(
			{ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: { content: [] }, isError: false } as never,
			42,
		);
		expect(entry).toEqual({
			level: "info",
			message: "Tool finished: read",
			detail: { tool: "read", toolCallId: "t1", durationMs: 42 },
		});
	});

	it("escalates a failed tool to warn with its error text", () => {
		const entry = describeAgentEvent({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "write",
			result: { content: [{ type: "text", text: "permission denied" }] },
			isError: true,
		} as never);
		expect(entry?.level).toBe("warn");
		expect(entry?.message).toBe("Tool failed: write");
		expect(entry?.detail).toEqual({ tool: "write", toolCallId: "t1", error: "permission denied" });
	});

	it("survives a malformed tool result", () => {
		const entry = describeAgentEvent({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "write",
			result: "total nonsense",
			isError: true,
		} as never);
		expect(entry?.level).toBe("warn");
		expect(entry?.detail).toEqual({ tool: "write", toolCallId: "t1" });
	});

	it("logs an unknown event type instead of silently skipping it", () => {
		const entry = describeAgentEvent({ type: "future_event" } as unknown as AgentEvent);
		expect(entry?.level).toBe("debug");
		expect(entry?.detail).toEqual({ type: "future_event" });
	});

	it("reports a present_ui call as the view opening, not as an outcome", () => {
		const entry = describeAgentEvent({
			type: "tool_execution_end",
			toolCallId: "call-ui",
			toolName: "present_ui",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { uiId: "ui-2", live: true, mountMs: 34 },
			},
			isError: false,
		} as never, 40);

		expect(entry).toEqual({
			level: "info",
			message: "UI block opened",
			detail: {
				tool: "present_ui",
				toolCallId: "call-ui",
				durationMs: 40,
				outcome: "live",
				uiId: "ui-2",
				interactive: true,
				mountMs: 34,
			},
		});
	});

	it("distinguishes a view that was closed before it opened", () => {
		const entry = describeAgentEvent({
			type: "tool_execution_end",
			toolCallId: "call-ui-2",
			toolName: "present_ui",
			result: {
				content: [{ type: "text", text: "never opened" }],
				details: { uiId: "ui-3", live: false, mountMs: 12 },
			},
			isError: false,
		} as never, 20);

		expect(entry).toEqual({
			level: "info",
			message: "UI block closed before opening",
			detail: {
				tool: "present_ui",
				toolCallId: "call-ui-2",
				durationMs: 20,
				outcome: "undelivered",
				uiId: "ui-3",
				interactive: true,
				mountMs: 12,
			},
		});
	});

	it("logs no payload keys for a present_ui call, because it carries none", () => {
		// What the user does arrives later and on its own. A `dataKeys` list here
		// would be describing a submission that has not happened.
		const entry = describeAgentEvent({
			type: "tool_execution_end",
			toolCallId: "call-ui-3",
			toolName: "present_ui",
			result: { content: [], details: { uiId: "ui-4", live: true } },
			isError: false,
		} as never, 5);

		expect(entry?.detail).not.toHaveProperty("dataKeys");
		expect(entry?.detail).not.toHaveProperty("action");
		expect(entry?.detail).not.toHaveProperty("userWaitMs");
	});

	it("enriches ask_user execution end with answered outcome and wait time", () => {
		const entry = describeAgentEvent({
			type: "tool_execution_end",
			toolCallId: "call-ask",
			toolName: "ask_user",
			result: {
				content: [{ type: "text", text: "answers" }],
				details: {
					dismissed: false,
					answers: [{ question: "q", header: "h", selected: ["a"] }],
					userWaitMs: 5000,
				},
			},
			isError: false,
		} as never, 5100);

		expect(entry).toEqual({
			level: "info",
			message: "Tool finished: ask_user",
			detail: {
				tool: "ask_user",
				toolCallId: "call-ask",
				durationMs: 5100,
				outcome: "answered",
				interactive: true,
				userWaitMs: 5000,
			},
		});
	});
});

describe("extractToolErrorText", () => {
	it("joins text blocks and truncates long ones", () => {
		expect(extractToolErrorText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
		expect(extractToolErrorText({ content: [{ type: "text", text: "x".repeat(500) }] })).toHaveLength(201);
	});

	it("returns undefined for non-text shapes", () => {
		expect(extractToolErrorText(undefined)).toBeUndefined();
		expect(extractToolErrorText(null)).toBeUndefined();
		expect(extractToolErrorText(7)).toBeUndefined();
		expect(extractToolErrorText({})).toBeUndefined();
		expect(extractToolErrorText({ content: [{ type: "image", data: "…" }] })).toBeUndefined();
		expect(extractToolErrorText({ content: [{ type: "text", text: "   " }] })).toBeUndefined();
	});
});
