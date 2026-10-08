import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { formatElapsed } from "./chatStatus";

/**
 * How long a settled reply must have taken before the transcript spends a
 * stamp on it.
 *
 * A reply that lands in under five seconds tells the reader nothing they were
 * not already seeing — the answer simply arrived. The stamp exists for the
 * reply the reader starts to wonder about, the same reader question the status
 * bar's two-second gate answers while a run is still in flight; five seconds
 * is where that wondering survives the reply itself. Without the gate a fast
 * reply would print a fresh `0s` after every turn, and a transcript of quiet
 * stamps the reader never asked for is exactly the over-caring this panel
 * avoids.
 */
export const REPLY_DURATION_VISIBLE_AFTER_MS = 5000;

/**
 * Records a reply's generation duration when Pi has not already supplied it.
 *
 * Called from the service's `message_end` handler with `Date.now()`; the
 * delta against the message's own start time is the honest measurement. User
 * messages (steering prompts pi injects mid-run also emit `message_end`) are
 * passed through untouched — nobody asked us to grade the reader's typing
 * speed. Restamping is refused rather than recomputed: the first `message_end`
 * is the only settle a message gets, and a second stamp would mean a second
 * caller is guessing, not measuring.
 */
export function stampReplyEnd(message: AgentMessage, endedAt: number): void {
	if (message.role !== "assistant") {
		return;
	}
	if (message.durationMs !== undefined) {
		return;
	}
	message.durationMs = Math.max(0, endedAt - message.timestamp);
}

/** The recorded generation duration of a reply, or `null` when none was recorded. */
export function replyDurationMs(message: AgentMessage): number | null {
	if (message.role !== "assistant") {
		return null;
	}
	const durationMs = message.durationMs;
	return typeof durationMs === "number" && durationMs >= 0 ? durationMs : null;
}

/** Whether a reply's duration crosses the visibility gate. */
export function durationBadgeVisible(durationMs: number): boolean {
	return durationMs >= REPLY_DURATION_VISIBLE_AFTER_MS;
}

/**
 * The stamp's text: `8s` inside the minute, `m:ss` past it, `h:mm:ss` past the
 * hour.
 *
 * Two shapes, not one: `0:08` spends a leading zero to say "under a minute"
 * to nobody, while `8s` reads as a quantity and vanishes into the margin the
 * way a stamp should. Past the minute the clock shape takes over, reusing the
 * status bar's formatter so a reader who learned `1:24` while watching a run
 * meets the same shape when it settles.
 */
export function formatReplyDuration(ms: number): string {
	if (ms < 60_000) {
		return `${Math.floor(ms / 1000)}s`;
	}
	return formatElapsed(ms);
}

/** The wall-clock moment as `HH:MM:SS`, 24-hour, for the tooltip. */
export function formatClock(epochMs: number): string {
	const date = new Date(epochMs);
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	const ss = String(date.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

/**
 * Whether the reply at `index` is the run's last word — the one the stamp is
 * for.
 *
 * A run that uses tools is several provider calls: every call that ends in a
 * tool execution is followed by a `toolResult` entry in the transcript, and
 * only the call that actually answers is followed by anything else (the next
 * question, or nothing). Those intermediate calls keep their durations out of
 * sight: they are machine traffic the trace rows already narrate, and stamping
 * each one would turn a five-call run into five stamps the reader never
 * wanted. An end-of-transcript reply is final by definition — no `toolResult`
 * follows it either.
 */
export function isFinalReply(messages: readonly AgentMessage[], index: number): boolean {
	const message = messages[index];
	if (!message || message.role !== "assistant") {
		return false;
	}
	return messages[index + 1]?.role !== "toolResult";
}
