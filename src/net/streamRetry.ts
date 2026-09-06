import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	isRetryableAssistantError,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type RetryCallbacks,
	type SimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai";
import { resolveRetrySettings, type ResolvedRetrySettings } from "./retrySettings";

/**
 * The turn-level retry layer, wrapped around a {@link StreamFn}.
 *
 * pi-ai already ships two retry primitives, and this is neither of them:
 *
 * - The *request* layer (`StreamOptions.maxRetries`, wired in `./streamFn`)
 *   re-issues a request whose response failed or whose headers say so. A
 *   stream the provider broke mid-flight is finished work from its point of
 *   view — the turn still ends in an error.
 * - `retryAssistantCall` retries whole calls, but it works on a promise of one
 *   message; a streaming turn has already been visible to the reader by the
 *   time it fails.
 *
 * This wrapper retries the *stream*: it calls the inner stream function again
 * and, when the failed attempt never became visible to the reader, the retry
 * leaves no trace in the panel.
 *
 * "Never became visible" is the precondition that makes replaying safe, not a
 * nicety. pi's agent loop pushes the partial message onto the transcript as
 * soon as it reads the `start` event, so a transcript slot a failed attempt
 * had claimed would sit there across every retry — a broken message, with the
 * repaired one appended after it. The wrapper therefore holds an attempt's
 * early events and releases nothing until its first content event. An attempt
 * that fails before that point has emitted nothing, so replaying it is free.
 * An attempt that *did* surface content and then failed streams the failure
 * through as-is: the failed message is the honest end of that turn, and
 * whether to send the turn again is the reader's call — the banner already
 * renders the failure wording.
 *
 * Failure classification defers to pi's own table
 * ({@link isRetryableAssistantError}); copying the pattern list would let the
 * two drift. The one addition is confined to wording this environment
 * produces that pi's CLI never sees.
 */

/**
 * Transport failures identified by wording, beyond pi's own table.
 *
 * The plugin's `fetch` transport rejects with the browser's own wording, and
 * none of it matches pi's pattern list — Chromium says "Failed to fetch" (pi
 * knows only "fetch failed"), Safari and iOS say "Load failed". Nothing else
 * needs adding: HTTP statuses arrive inside messages pi already matches, and
 * DNS failures carry ENOTFOUND, which pi matches verbatim.
 */
const TRANSPORT_RETRYABLE_PATTERN = /failed to fetch|load failed/i;

/** Ceiling on any one backoff wait, in milliseconds. */
export const DEFAULT_TURN_MAX_DELAY_MS = 30_000;

/** Fully-resolved settings the turn wrapper acts on, plus the single-wait ceiling. */
export interface TurnRetryPolicy extends ResolvedRetrySettings {
	/** Ceiling on any one backoff wait, in milliseconds. */
	maxDelayMs?: number;
}

/** Options for {@link withTurnRetry}; both optional, so the wrapper works standalone too. */
export interface TurnRetryOptions {
	/**
	 * Overrides the live-resolved settings; how tests pin behaviour.
	 *
	 * Function form is how the plugin passes its settings reader: the wrapper
	 * is built once per agent, and a budget lowered in the panel has to reach
	 * the next turn — the same per-call read every other request default
	 * follows. Resolved per call, not captured at construction.
	 */
	policy?: TurnRetryPolicy | (() => TurnRetryPolicy);
	/** Retry lifecycle callbacks, routed per session runtime. */
	callbacks?: RetryCallbacks;
}

/** Resolves the caller's policy slot into one policy object, per call. */
function resolvePolicySlot(policy: TurnRetryOptions["policy"]): TurnRetryPolicy {
	if (typeof policy === "function") {
		return policy();
	}
	return policy ?? {
		...resolveRetrySettings(undefined),
		maxDelayMs: DEFAULT_TURN_MAX_DELAY_MS,
	};
}

/**
 * Wraps a stream function so invisible failures in a turn get a fresh attempt.
 *
 * Options live per runtime rather than baked into one closure: each session
 * routes its own callbacks, so a retry notice lands on the chat that asked
 * and never on the other sessions sharing the service.
 */
export function withTurnRetry(inner: StreamFn, options: TurnRetryOptions = {}): StreamFn {
	return (model, context, streamOptions) => {
		// Read live like every other request default: a budget changed in the
		// panel reaches the next turn without a reload.
		const policy = resolvePolicySlot(options.policy);
		const output = createAssistantMessageEventStream();
		// The attempt loop is deliberately not awaited: a StreamFn hands back a
		// stream the caller iterates, and stalling the call for a backoff sleep
		// would freeze pi's loop exactly when this layer exists to keep it
		// moving. The loop feeds `output` on its own schedule.
		void driveTurn(inner, model, context, streamOptions, policy, options.callbacks ?? {}, output);
		return output;
	};
}

/**
 * The attempt loop: consume, judge, replay.
 *
 * Attempts count from the initial call, so `attempt` is 0 for the first try
 * and 1..maxRetries for the retries — the same counting pi's own retry loop
 * reports in its callbacks.
 *
 * Callback contract, matched to pi's convention: `onRetryScheduled` before
 * each backoff sleep, `onRetryAttemptStart` after it, and `onRetryFinished`
 * once at the end — but only when a retry was actually scheduled. A turn that
 * ended on the first attempt saw no retry, so nobody observing the callbacks
 * should hear about one.
 */
async function driveTurn(
	inner: StreamFn,
	model: Model<Api>,
	context: Context,
	streamOptions: SimpleStreamOptions | undefined,
	policy: TurnRetryPolicy,
	callbacks: RetryCallbacks,
	output: AssistantMessageEventStream,
): Promise<void> {
	const maxRetries = policy.maxRetries;
	const maxDelay = policy.maxDelayMs ?? DEFAULT_TURN_MAX_DELAY_MS;
	const signal = streamOptions?.signal;
	// The failure the current schedule follows; set before the loop continues,
	// read by the scheduled callback and the abort-during-sleep report.
	let lastError = "unknown error";
	for (let attempt = 0; ; attempt++) {
		if (attempt > 0) {
			const delayMs = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), maxDelay);
			await callbacks.onRetryScheduled?.(attempt, maxRetries, delayMs, lastError);
			await sleepInterruptible(delayMs, signal);
			if (signal?.aborted) {
				// A stop pressed during the wait is a user interruption, not a
				// failure; the message shape matches pi's own abort normalization
				// (`stopReason: "aborted"`, no error text) so the panel treats it
				// the same way it treats any interrupted turn.
				await callbacks.onRetryFinished?.(false, attempt, lastError);
				output.end(synthesizeMessage(model, "aborted", undefined));
				return;
			}
			await callbacks.onRetryAttemptStart?.();
		}

		// The call itself can reject — a transport that fails before the
		// provider says anything never produces a stream to consume, so the
		// rejection is folded into the same shell a failed message takes.
		let response: AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
		try {
			response = inner(model, context, streamOptions);
		} catch (error) {
			const message = messageFromThrowable(model, error);
			const outcome: AttemptOutcome = {
				released: false,
				failed: message.stopReason === "error",
				aborted: message.stopReason === "aborted",
				retryable: message.stopReason === "error" && !signal?.aborted && isRetryable(message),
				message,
			};
			if (outcome.failed && !outcome.aborted && outcome.retryable && attempt < maxRetries) {
				lastError = message.errorMessage ?? "unknown error";
				continue;
			}
			if (attempt > 0) {
				await callbacks.onRetryFinished?.(false, attempt, message.errorMessage);
			}
			output.end(message);
			return;
		}
		const outcome = await consumeAttempt(response, model, signal, output);

		if (!outcome.released && outcome.failed && !outcome.aborted && outcome.retryable && attempt < maxRetries) {
			lastError = outcome.message.errorMessage ?? "unknown error";
			continue;
		}
		// The turn ends here — success, abort, unreplayable failure, or retries
		// exhausted. Report once, and only if a retry was ever scheduled.
		if (attempt > 0) {
			await callbacks.onRetryFinished?.(!outcome.failed, attempt, outcome.failed ? (outcome.message.errorMessage ?? lastError) : undefined);
		}
		if (!outcome.released) {
			// Nothing was ever forwarded, so pi's loop saw no events; ending the
			// stream with the message routes it through the loop's fallback,
			// which records it as the turn's result.
			output.end(outcome.message);
		}
		return;
	}
}

/** One attempt's outcome, decided once its stream is fully consumed. */
interface AttemptOutcome {
	/** Whether any content had already streamed out when the attempt ended. */
	released: boolean;
	/** Whether the attempt ended in failure (as opposed to success or abort). */
	failed: boolean;
	/** Whether the failure was a stop the reader pressed — never retried. */
	aborted: boolean;
	/** Whether the failure looks transient enough to deserve another attempt. */
	retryable: boolean;
	/** The attempt's terminal message: the provider's, or a synthesized shell. */
	message: AssistantMessage;
}

/**
 * Reads one attempt to its terminal state, forwarding only what shows on
 * screen.
 *
 * The `start` event — and every structural event — stays held until content
 * arrives, because releasing `start` alone would claim the transcript slot
 * this layer exists to keep unclaimed. Once released, everything streams
 * through unchanged, terminal events included: from that point the wrapper is
 * transparent, and the outcome only informs the callbacks.
 */
async function consumeAttempt(
	response: AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
	model: Model<Api>,
	signal: AbortSignal | undefined,
	output: AssistantMessageEventStream,
): Promise<AttemptOutcome> {
	let heldStart: AssistantMessage | undefined;
	let released = false;
	// The accumulating message as of the last forwarded event; a released
	// attempt that ends without a terminal event rebuilds its ending from
	// this, so the content the reader already saw is not replaced by a shell.
	let lastPartial: AssistantMessage | undefined;

	const stream = await response;
	try {
		for await (const event of stream) {
			if (event.type === "start") {
				if (!released) {
					heldStart = event.partial;
				}
				continue;
			}
			if (event.type === "done" || event.type === "error") {
				// Terminal events are judged before any holding logic — the real
				// error message must reach the classifier even when the attempt
				// never released, or "is this transient?" would be decided on a
				// wording that was never seen. Forwarded too when released; the
				// stream is then complete and the outcome only informs callbacks.
				if (released) {
					output.push(event);
				}
				return outcome(event.type === "error" ? event.error : event.message);
			}
			if (!released && !isContent(event)) {
				// text/thinking/toolcall starts and empty ends before any delta:
				// invisible on screen, so held rather than forwarded.
				continue;
			}
			if (!released) {
				// The first visible content settles the held start so the
				// transcript can claim its slot; from here the attempt is
				// irrevocably on the record.
				output.push({ type: "start", partial: heldStart ?? event.partial });
				released = true;
			}
			output.push(event);
			lastPartial = event.partial;
		}
	} catch (error) {
		return endWithoutEvent(messageFromThrowable(model, error, lastPartial));
	}
	// The iterator dried up without a terminal event — a truncated stream.
	// The wording matches pi's own "ended without" class, so the same
	// classification applies to it as to any other transient failure.
	return endWithoutEvent(synthesizeMessage(model, "error", "stream ended without a terminal event", lastPartial));

	/**
	 * Seals an attempt whose end did not arrive as a forwarded terminal event.
	 *
	 * A released attempt in this state has streamed content but no ending: the
	 * output stream is completed here — pi's loop falls back to the stream
	 * result and records the message, content intact — because leaving the
	 * reader iterating a stream that never terminates hangs the panel.
	 */
	function endWithoutEvent(message: AssistantMessage): AttemptOutcome {
		if (released) {
			output.end(message);
		}
		return outcome(message);
	}

	/** Seals the outcome once the attempt's end is known. */
	function outcome(message: AssistantMessage): AttemptOutcome {
		const aborted = message.stopReason === "aborted" || signal?.aborted === true;
		const failed = message.stopReason === "error" && !aborted;
		return {
			released,
			failed,
			aborted,
			// A released attempt can never be retried — its content is already
			// on the record; replaying it would duplicate everything shown.
			retryable: !released && failed && !aborted && isRetryable(message),
			message,
		};
	}
}

/**
 * Whether an event shows content on screen.
 *
 * Deltas always do, and `toolcall_end` does even without a delta (a tool call
 * can arrive whole). A `text_end`/`thinking_end` whose content is empty is
 * invisible — the blank-text-block trap — so it is held like any other
 * structural event.
 */
function isContent(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
		case "toolcall_end":
			return true;
		case "text_end":
		case "thinking_end":
			return event.content.length > 0;
		default:
			return false;
	}
}

/**
 * Whether a failed message looks transient enough to replay.
 *
 * pi's own classifier first — it already knows the provider wordings, HTTP
 * statuses, and socket failures. The transport pattern adds only the
 * browser-worded rejections this environment produces.
 */
function isRetryable(message: AssistantMessage): boolean {
	if (isRetryableAssistantError(message)) {
		return true;
	}
	return message.errorMessage !== undefined && TRANSPORT_RETRYABLE_PATTERN.test(message.errorMessage);
}

/** A zero-usage shell, for failures that produced nothing measurable. */
const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * A message to represent a failure that never produced one — or to carry a
 * failure ending onto content that streamed without one.
 *
 * Attempts that throw, or end without a terminal event, have no
 * `AssistantMessage` to end the turn with — but pi's loop needs one to
 * record. For an attempt that already streamed content, `partial` is the
 * last forwarded event's message snapshot: the ending is laid on top of the
 * content the reader saw, so the recorded turn keeps its text. For an
 * unreleased attempt the shell is empty: no content, no cost, just the model
 * identity and an error message naming what happened.
 */
function synthesizeMessage(model: Model<Api>, stopReason: "aborted" | "error", errorMessage: string | undefined, partial?: AssistantMessage): AssistantMessage {
	const base = partial ?? {
		role: "assistant" as const,
		content: [] as AssistantMessage["content"],
		usage: EMPTY_USAGE,
	};
	return {
		...base,
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

/**
 * A failure that arrived as a thrown exception rather than an error event.
 *
 * The abort check comes before the message shape: a stop press mid-stream
 * surfaces as a thrown `AbortError` from the underlying fetch, and recording
 * that as a failed turn would contradict what the reader did.
 */
function messageFromThrowable(model: Model<Api>, error: unknown, partial?: AssistantMessage): AssistantMessage {
	if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
		return synthesizeMessage(model, "aborted", undefined, partial);
	}
	const text = error instanceof Error ? error.message : String(error);
	return synthesizeMessage(model, "error", text, partial);
}

/**
 * Interruptible sleep.
 *
 * A plain `setTimeout` leaves the loop waiting out a 30-second backoff after
 * the reader has pressed stop; listening for the abort resolves the wait the
 * moment it happens, and the loop checks the signal on wake.
 */
function sleepInterruptible(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = window.setTimeout(finish, ms);
		function finish() {
			window.clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		}
		signal?.addEventListener("abort", finish, { once: true });
	});
}
