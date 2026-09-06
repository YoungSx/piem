import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Translator } from "../i18n";
import type { SendShortcut } from "./keyboard";

/** A run in flight, measured. */
export interface TurnProgress {
	/** Epoch ms when the turn was accepted; the clock the elapsed readout runs from. */
	startedAt: number;
	/**
	 * Steps the run has taken so far: tool calls finished in this turn plus the
	 * ones still executing. The transcript names each one as it happens; this is
	 * the count for a reader who wants to know how far along — or how far from
	 * done — a long run is without reading every row.
	 */
	steps: number;
}

/**
 * How long a run must go before the bar spends a row on timing it.
 *
 * A fast reply would flash the readout for a fraction of a second on its way
 * out — an appearance for its own sake. The readout exists for the run the
 * reader starts to wonder about, and that wondering begins after a couple of
 * seconds, not at the first frame.
 */
const TURN_VISIBLE_AFTER_MS = 2000;

/**
 * Elapsed time as `m:ss` — and `h:mm:ss` past the hour, so a run that long
 * keeps sorting by length rather than wrapping into a new shape.
 */
export function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
	return `${hours > 0 ? `${hours}:` : ""}${mm}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Counts the steps of the run now in flight.
 *
 * A step is a tool call; the transcript renders each one's result as it lands.
 * Everything since the last user turn belongs to this run — a rewind or a new
 * prompt resets the count by construction, since the counting stops at that
 * turn's own words — and the calls still executing ride in on
 * `runningTools`, because a running call has no result row yet.
 */
export function countRunSteps(messages: readonly AgentMessage[], runningTools: number): number {
	let steps = Math.max(0, runningTools);
	for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
		const message = messages[cursor];
		if (!message || message.role === "user") {
			break;
		}
		if (message.role === "toolResult") {
			steps += 1;
		}
	}
	return steps;
}

/**
 * The run's measurement as one line, or `null` while it is too young to show.
 *
 * `null` — rather than an empty segment — is what keeps a quick reply from
 * flashing a readout: the caller renders nothing, exactly as when idle.
 */
export function runProgressText(run: TurnProgress, now: number, t: Translator): string | null {
	const elapsed = now - run.startedAt;
	if (elapsed < TURN_VISIBLE_AFTER_MS) {
		return null;
	}
	const segments = [formatElapsed(elapsed)];
	if (run.steps > 0) {
		segments.push(t.t("chatStatus.turnSteps", { count: run.steps }));
	}
	return segments.join(" · ");
}

/**
 * Copy for the chat status bar and the Send button's chord hint.
 *
 * Free of React and DOM imports so the wording can be unit-tested without a
 * renderer; `ChatStatusBar.tsx` and `ChatComposer.tsx` own the markup.
 *
 * The status bar reports only what cannot be shown as part of the conversation
 * itself: opening, the resend window, and the run's measurement — elapsed time
 * and step count, which are not messages and so have no transcript home. A
 * turn's *state* is not here — the transcript shows that as a typing indicator
 * at the assistant's own position, the way a chat app names "the other side is
 * typing" rather than labelling a wait. Reporting it in two places said one
 * thing two ways and made the panel shout.
 *
 * Tidying used to be here too, and was the clearest case of the same mistake in
 * reverse: the wait was announced down here while its outcome appeared as a
 * divider up in the transcript, so neither surface carried the whole event. It is
 * one transcript row now — see `compactionRow.ts`.
 */

export interface ChatStatusInput {
	isInitializing: boolean;
	/**
	 * Whether a retry or edit-resend is between its guards and the replacement
	 * send. This is a real LLM request (the abandoned branch's summary) that the
	 * transcript does not narrate — nothing streams, so without a line here the
	 * wait reads as the panel having done nothing.
	 */
	isRewinding: boolean;
	/**
	 * The turn retry episode in flight, once it has crossed its grace period —
	 * `undefined` while nothing is being retried.
	 *
	 * The wait it names is one the transcript cannot narrate: during the backoff
	 * the stream has produced nothing, and after the retry lands the reply simply
	 * continues — no row ever says the connection broke. A held notice that
	 * outlives the backoff is the one trace of it.
	 */
	retry?: { attempt: number; maxAttempts: number };
}

/**
 * What the panel is doing, or `null` when it is idle.
 *
 * Null rather than an empty string, so the caller renders no bar at all instead
 * of an empty one: the status bar sits between the transcript and the composer,
 * and reserving a row for a line that is absent most of the time would push the
 * composer down for nothing.
 *
 * Opening stays because it has no place in the transcript: it is the panel
 * starting up before there is a conversation to put a row in. The rewind window
 * belongs here for the same reason — the branch summary it runs is silent, and
 * nothing in the transcript says the edit is being processed. A reply in flight
 * does have a place — the typing indicator at the assistant's position — so its
 * state is not duplicated here; its elapsed-and-steps readout
 * ({@link runProgressText}) is, because that is a measurement of the wait, not a
 * narration of it. Tidying has a place too, and took it: the transcript draws
 * the attempt and its outcome as one row.
 *
 * The idle slot used to carry the send chord. That hint now lives on the Send
 * button itself — see {@link sendShortcutLabel} — where it describes the control
 * it belongs to rather than sitting in a line beside it.
 */
export function chatStatusText(input: ChatStatusInput, t: Translator): string | null {
	if (input.isInitializing) {
		return t.t("chatStatus.opening");
	}
	if (input.isRewinding) {
		return t.t("chatStatus.resending");
	}
	if (input.retry) {
		return t.t("chatStatus.retrying", { attempt: input.retry.attempt, maxAttempts: input.retry.maxAttempts });
	}
	return null;
}

/**
 * The chord that sends, as keycaps.
 *
 * Platform-correct for the modifier: a macOS reader looking for Ctrl finds ⌘.
 * Under Enter-to-send only the bare key is shown even though the modifier chord
 * still works — the label teaches the shortest way to send, not the full grammar,
 * which `sendShortcutAria` carries for assistive technology.
 */
export function sendShortcutLabel(shortcut: SendShortcut, isMac: boolean, t: Translator): string {
	if (shortcut === "enter") {
		return t.t("sendShortcut.enter");
	}
	return isMac ? t.t("sendShortcut.modMac") : t.t("sendShortcut.modOther");
}

/**
 * Accessible name and tooltip for Send, e.g. "Send message · Ctrl+↵".
 *
 * The chord is part of the name rather than a separate `title`: a screen reader
 * user gets the shortcut from the control itself, and a sighted user hovering the
 * icon gets the same string.
 */
export function sendButtonTitle(shortcut: SendShortcut, isMac: boolean, t: Translator): string {
	return t.t("sendShortcut.buttonTitle", {
		action: t.t("chat.sendMessage"),
		chord: sendShortcutLabel(shortcut, isMac, t),
	});
}
