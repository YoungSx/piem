/**
 * Turns a Pi agent event into a log entry, or decides the event is not worth one.
 *
 * This sits between `handleAgentEvent` and the logger so the mapping — which
 * events are `info`, which are `debug`, which are dropped — can be tested
 * without an agent. It uses Pi's native event stream as the sole instrumentation
 * point: nothing here calls into business code, so new event types from a Pi
 * upgrade flow through the default branch instead of being missed.
 *
 * The one deliberate omission is `*_delta` events. Each one fires per token or
 * per thinking chunk, and at 2000 buffered records a single streaming response
 * would evict every other diagnostic — including the tool timings being streamed
 * right beside them. Structure (a text block started, a tool call began) still
 * logs; the per-character churn does not.
 */

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { LogLevel } from "../logging/logLevel";
import type { LogDetail, LogDetailValue } from "../logging/logRecord";
import { ASK_USER_TOOL, askUserOutcome } from "../ui/askUserRecord";
import { PRESENT_UI_TOOL, uiBlockOutcome } from "../ui/uiBlockRecord";

/** How many characters of a failed tool result to keep in the log detail. */
const MAX_TOOL_ERROR_CHARS = 200;

/** What `describeAgentEvent` hands back; `null` means "do not log this event". */
export interface AgentEventLogEntry {
	level: LogLevel;
	message: string;
	detail?: LogDetail;
}

/**
 * Flattens a failed tool result to its text content.
 *
 * Tool results are arbitrarily shaped, so everything is guarded: a result with
 * no text content, or one that is not the shape this expects at all, reduces to
 * undefined rather than throwing out of a log call.
 */
export function extractToolErrorText(result: unknown): string | undefined {
	if (result === null || typeof result !== "object") {
		return undefined;
	}
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) {
		return undefined;
	}
	const text = content
		.filter((block): block is { type: "text"; text: string } => {
			return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text";
		})
		.map((block) => block.text)
		.join("\n")
		.trim();
	if (!text) {
		return undefined;
	}
	return text.length > MAX_TOOL_ERROR_CHARS ? `${text.slice(0, MAX_TOOL_ERROR_CHARS)}…` : text;
}

/** Message role, guarded: an unexpected shape degrades to `unknown` in the detail. */
function roleOf(message: { role?: unknown } | undefined): LogDetailValue {
	const role = message?.role;
	return typeof role === "string" ? role : "unknown";
}

/**
 * Maps one agent event to its log entry.
 *
 * `durationMs` is only consulted for `tool_execution_end` and comes from the
 * caller's start-time bookkeeping; an absent value simply omits the field.
 */
export function describeAgentEvent(event: AgentEvent, durationMs?: number): AgentEventLogEntry | null {
	switch (event.type) {
		case "agent_start":
			return { level: "info", message: "Run started" };
		case "agent_end":
			return { level: "info", message: "Run finished", detail: { messages: event.messages.length } };
		case "turn_start":
			return { level: "debug", message: "Turn started" };
		case "turn_end":
			return { level: "debug", message: "Turn finished", detail: { toolResults: event.toolResults.length } };
		case "message_start":
			return { level: "debug", message: "Message started", detail: { role: roleOf(event.message) } };
		case "message_end":
			return { level: "debug", message: "Message finished", detail: { role: roleOf(event.message) } };
		case "message_update":
			// Only structure, never deltas: see the module note. A `partial` is the
			// message so far — the same object the panel re-renders — and would
			// duplicate the whole transcript into the log at every boundary.
			switch (event.assistantMessageEvent.type) {
				case "text_start":
				case "text_end":
					return { level: "debug", message: `Text ${event.assistantMessageEvent.type === "text_start" ? "started" : "finished"}` };
				case "thinking_start":
				case "thinking_end":
					return {
						level: "debug",
						message: `Thinking ${event.assistantMessageEvent.type === "thinking_start" ? "started" : "finished"}`,
					};
				case "toolcall_start":
				case "toolcall_end":
					return {
						level: "debug",
						message: `Tool call ${event.assistantMessageEvent.type === "toolcall_start" ? "started" : "finished"}`,
					};
				default:
					return null;
			}
		case "tool_execution_start":
			return {
				level: "info",
				message: `Tool started: ${event.toolName}`,
				detail: { tool: event.toolName, toolCallId: event.toolCallId },
			};
		case "tool_execution_update":
			return { level: "debug", message: `Tool progress: ${event.toolName}`, detail: { tool: event.toolName } };
		case "tool_execution_end": {
			const errorText = event.isError ? extractToolErrorText(event.result) : undefined;
			const detail: LogDetail = {
				tool: event.toolName,
				toolCallId: event.toolCallId,
				...(durationMs === undefined ? {} : { durationMs }),
				...(errorText === undefined ? {} : { error: errorText }),
			};

			/*
			 * A `present_ui` call ends when its view opens, so what is worth logging
			 * here is the delivery, not a user decision — the decision arrives later,
			 * on its own, and `uiBlockMessage` below records it. `mountMs` replaces
			 * the old `userWaitMs` for the same reason: nothing here waits on a person
			 * any more, and a number named for waiting would read as one.
			 */
			if (event.toolName === PRESENT_UI_TOOL && !event.isError) {
				const outcome = uiBlockOutcome((event.result as { details?: unknown })?.details);
				if (outcome) {
					detail.outcome = outcome.undelivered ? "undelivered" : "live";
					if (outcome.id) detail.uiId = outcome.id;
					detail.interactive = true;
				}
				const details = (event.result as { details?: Record<string, unknown> })?.details;
				if (typeof details?.mountMs === "number") {
					detail.mountMs = details.mountMs;
				}
			} else if (event.toolName === ASK_USER_TOOL && !event.isError) {
				const outcome = askUserOutcome((event.result as { details?: unknown })?.details);
				if (outcome) {
					detail.outcome = outcome.dismissed ? "dismissed" : "answered";
					detail.interactive = true;
				}
				const details = (event.result as { details?: Record<string, unknown> })?.details;
				if (typeof details?.userWaitMs === "number") {
					detail.userWaitMs = details.userWaitMs;
				}
			}

			/*
			 * A `present_ui` call that returns has not finished anything the reader
			 * would recognize as an outcome — it opened a view. "Tool finished" would
			 * read, in a log being scanned for why the agent stopped, as the
			 * interaction being over when it has not started.
			 */
			const message = event.isError
				? `Tool failed: ${event.toolName}`
				: detail.outcome === "dismissed"
					? "User question dismissed"
					: event.toolName === PRESENT_UI_TOOL && detail.outcome === "live"
						? "UI block opened"
						: event.toolName === PRESENT_UI_TOOL && detail.outcome === "undelivered"
							? "UI block closed before opening"
							: `Tool finished: ${event.toolName}`;

			return {
				// A failed tool is exactly what a warn threshold exists to surface;
				// everything else waits for the user to turn the level down.
				level: event.isError ? "warn" : "info",
				message,
				detail,
			};
		}
		default:
			// Pi grew an event type this mapping does not know. Log rather than
			// skip: a silent default is how a Pi upgrade loses diagnostics quietly.
			return { level: "debug", message: "Unknown agent event", detail: { type: String((event as { type?: unknown }).type) } };
	}
}
