/**
 * Why an assistant turn stopped before it finished saying something.
 *
 * Free of React and DOM imports so the rules and the wording can be unit-tested
 * without a renderer; `MessageList.tsx` owns the markup.
 *
 * The transcript has to distinguish "this reply is over" from "this reply ran
 * out", because the two look identical on screen: both end mid-thought with no
 * punctuation. Only one of them used to be reported. A user who pressed stop got
 * "You stopped this reply."; a reply the provider truncated at its output-token
 * limit got nothing at all, so the panel presented a half sentence as if the
 * model had chosen to end there.
 *
 * Both are the same fact from the reader's side — the words are incomplete — so
 * they resolve through one function rather than through a second `if` bolted
 * beside the first. That is what keeps the next reason pi adds (`stopReason` has
 * seven members) from being a third silent case.
 *
 * A provider failure was that third silent case for as long as this module
 * excluded `error` on the grounds that it "already reaches the user through the
 * banner". It did not, durably: pi clears `state.errorMessage` the moment the
 * next run departs, so the banner's copy of a timeout survives exactly until
 * the next turn — while `errorMessage` sits on the assistant message itself and
 * round-trips to the session log through `appendMessage`'s deep clone. The
 * reason was in the data and the view threw it away. It is the third kind now
 * (#239), which also means the transcript reports a failed *turn* the same way
 * it already reports a failed tool call and the subagent panel a failed child.
 *
 * The fourth kind is not in pi's data at all. A mid-run send now interrupts the
 * reply instead of waiting a turn for it (issue #289), and pi records that the
 * only way it can — as `stopReason: "aborted"`, indistinguishable from the stop
 * button. So the service stamps {@link markReplySteered} on the turn it cut,
 * and this module reads it: two causes, two sentences, because "You stopped
 * this reply." under a reply the reader did not stop is the same class of lie
 * this module exists to remove.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Translator } from "../i18n";
import type { IconName } from "obsidian";
import { describeProviderFailure } from "./providerFailure";

/** A reply that ended early, and why. `null` means it ended normally. */
export interface ReplyCutoff {
	/** Which cause, so the caller can pick copy and an icon without re-deriving it. */
	kind: "stopped" | "steered" | "truncated" | "failed";
	/** Line shown under the message. */
	notice: string;
	/**
	 * Same fact for a screen reader, appended to the spoken text.
	 *
	 * Lower case and phrased to continue a sentence: it is read as the tail of
	 * the reply ("…and then — you stopped this reply."), not as its own
	 * announcement.
	 */
	spoken: string;
	icon: IconName;
	/**
	 * The provider's untouched words. Present only on `failed`, and always
	 * present there, empty string included: the classified sentence is a guess
	 * made from wording, and the raw text is what makes that guess safe to make.
	 * Whether an empty string earns a disclosure is the renderer's call — the
	 * failed pill renders flat when there is nothing behind it, the same rule the
	 * tool-call rows follow.
	 */
	raw?: string;
}

/**
 * An assistant turn this plugin cut short to make room for a queued message.
 *
 * Carried on the message rather than in the runtime for the same reason
 * `durationMs` is (see `replyDuration.ts`): the fact belongs to that one turn,
 * has to survive a reload, and rides into the session JSONL because
 * `appendMessage` serializes the whole object. A log written before this existed
 * simply reads back without the field, and reads as a plain stop — which is
 * what it was.
 */
interface SteeredAssistantMessage extends AssistantMessage {
	steeredAway?: boolean;
}

/**
 * Marks the turn a mid-run send interrupted.
 *
 * Called from the service's `message_end` handler, which is the first moment the
 * finalized message object exists — pi replaces the partial once per delta and
 * finalizes into a *different* object, so nothing stamped earlier would survive.
 * Refuses anything but an aborted assistant turn: the flag that drives this is
 * per-run, and a run whose last turn ended some other way (the reply landed
 * before the interrupt did) has nothing to mark.
 */
export function markReplySteered(message: AgentMessage): void {
	if (message.role !== "assistant" || message.stopReason !== "aborted") {
		return;
	}
	(message as SteeredAssistantMessage).steeredAway = true;
}

/**
 * Classifies how an assistant turn ended.
 *
 * `aborted` is the user pressing stop — unless the turn carries
 * {@link markReplySteered}, in which case their own next message is what ended
 * it.
 *
 * `length` is the provider hitting the output-token ceiling — pi treats it as
 * significant enough to fail every tool call in the message (`agent-loop.js`,
 * `failToolCallsFromTruncatedMessage`, whose comment notes that truncated
 * arguments can still parse), so the text beside those calls is no more
 * trustworthy and the reader has to be told.
 *
 * `error` is a provider failure — a timeout, a refusal, a dropped connection.
 * pi leaves the partial message in place with the provider's text on
 * `errorMessage`, so this reads that field rather than the panel's volatile
 * copy of it. Two shapes reach here: a stream that produced words and then died
 * (the transcript keeps a half sentence that would otherwise look finished —
 * exactly the defect this module was written to eliminate) and one that
 * produced none (an assistant turn with no prose, which without a notice is a
 * silent gap in the log).
 *
 * Every other reason — `stop`, `toolUse`, `deferred`, `pending` — returns
 * `null`: a normal end needs no notice.
 */
export function describeReplyCutoff(message: AssistantMessage, t: Translator): ReplyCutoff | null {
	if (message.stopReason === "aborted") {
		if ((message as SteeredAssistantMessage).steeredAway === true) {
			return {
				kind: "steered",
				notice: t.t("chat.replySteered"),
				spoken: t.t("chat.replySteeredSpoken"),
				// A turn, not a halt: the conversation carried on immediately below
				// this line, which is the one thing `circle-slash` would deny.
				icon: "corner-down-right",
			};
		}
		return {
			kind: "stopped",
			notice: t.t("chat.youStopped"),
			spoken: t.t("chat.youStoppedSpoken"),
			icon: "circle-slash",
		};
	}
	if (message.stopReason === "length") {
		return {
			kind: "truncated",
			notice: t.t("chat.replyTruncated"),
			spoken: t.t("chat.replyTruncatedSpoken"),
			icon: "scissors",
		};
	}
	if (message.stopReason === "error") {
		/*
		 * `describeProviderFailure` also reports whether a retry could work, and
		 * that deliberately stops here: the transcript's regenerate control stays
		 * available on a failed turn either way. Gating a control on a family
		 * inferred from provider wording would be the mistake this codebase avoids
		 * everywhere else — and the reader has the better information anyway, since
		 * after fixing a key in settings "ask again" is exactly what they want and a
		 * hidden button would mean retyping the question. The guidance lives in the
		 * sentence, which is where a soft signal belongs.
		 */
		const failure = describeProviderFailure(message.errorMessage ?? "", t);
		return {
			kind: "failed",
			notice: failure.line,
			spoken: failure.spoken,
			// The glyph the transcript already uses for a failed tool call, so one
			// vocabulary covers both failures a turn can contain.
			icon: "alert-triangle",
			// Kept even when the provider said nothing: an empty raw text is the
			// honest report that there was nothing to disclose, and dropping the
			// field would read as "the panel is holding something back".
			raw: message.errorMessage ?? "",
		};
	}
	return null;
}
