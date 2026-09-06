import { describe, expect, it } from "bun:test";
import type { Model, Api } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type Context, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { DEFAULT_TURN_MAX_DELAY_MS, withTurnRetry } from "./streamRetry";

/*
 * The wrapper's contract, pinned at the edges that matter:
 *
 * - A failure before the first content event is replayed invisibly — the
 *   reader must see exactly one message slot, never a broken draft followed by
 *   the repair.
 * - Content already on the record ends the replay question: a released attempt
 *   is never retried, whatever pi's classifier would say.
 * - A stop the reader pressed is a user's answer, not a failure to repair.
 *
 * All waits run at millisecond scale: the point of each test is the routing
 * decision, not the backoff arithmetic, and a fixture that really sleeps
 * DEFAULT_TURN_MAX_DELAY_MS would idle the suite.
 */

const MODEL: Model<Api> = {
	id: "test-model",
	api: "openai-completions",
	provider: "test",
	contextWindow: 128_000,
	maxTokens: 4_096,
} as unknown as Model<Api>;

const CONTEXT: Context = { messages: [] };

/** The zero-usage shell the wrapper and fixtures alike build failed messages from. */
function baseMessage(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		timestamp: Date.now(),
		stopReason: "stop",
		...overrides,
	};
}

/**
 * A scripted stream: pushes its events, then terminates per the protocol — a
 * `done` or `error` *event* carrying the final message, with `end` sealing the
 * stream. `end` alone sets the result but yields no event, which is exactly the
 * truncated shape the wrapper's "ended without a terminal event" guard exists
 * for, so fixtures must not skip it.
 */
function scriptedStream(events: AssistantMessageEvent[], terminal: AssistantMessage): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	for (const event of events) {
		stream.push(event);
	}
	if (terminal.stopReason === "error" || terminal.stopReason === "aborted") {
		stream.push({ type: "error", reason: terminal.stopReason, error: terminal } as unknown as AssistantMessageEvent);
	} else {
		stream.push({ type: "done", reason: terminal.stopReason, message: terminal } as unknown as AssistantMessageEvent);
	}
	stream.end(terminal);
	return stream;
}

/** A single visible delta, the smallest event that claims the transcript slot. */
function textDelta(text: string): AssistantMessageEvent {
	return { type: "text_delta", delta: text, partial: baseMessage({ content: [{ type: "text", text }] }) } as unknown as AssistantMessageEvent;
}

/** A failure the provider reported without ever streaming content. */
function silentFailure(error: string): AssistantMessage {
	return baseMessage({ stopReason: "error", errorMessage: error });
}

/** A StreamFn that answers each call with the next entry, or the last forever. */
function scriptedStreamFn(responses: Array<AssistantMessageEventStream | Error>): StreamFn & { calls: number } {
	let calls = 0;
	const fn = (() => {
		const response = responses[Math.min(calls, responses.length - 1)];
		calls += 1;
		if (response instanceof Error) {
			throw response;
		}
		return response;
	}) as unknown as StreamFn & { calls: number };
	Object.defineProperty(fn, "calls", { get: () => calls });
	return fn;
}

/** Consumes a wrapped stream to its result message. */
async function readResult(stream: AssistantMessageEventStream | Promise<AssistantMessageEventStream>): Promise<AssistantMessage> {
	// A StreamFn may hand back a promise; the caller awaits it before iterating.
	for await (const _event of await stream) {
		// Draining drives the loop; the result message is what matters.
	}
	return await (await stream).result();
}

/** Millisecond policy so backoff waits never idle the suite. */
const FAST_POLICY = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 };

describe("withTurnRetry", () => {
	it("passes a clean turn through untouched", async () => {
		const good = scriptedStream([{ type: "start", partial: baseMessage({}) } as AssistantMessageEvent], baseMessage({ content: [{ type: "text", text: "hello" }] }));
		const inner = scriptedStreamFn([good]);
		const innerSpy = inner;

		const result = await readResult(withTurnRetry(inner, { policy: FAST_POLICY })(MODEL, CONTEXT));

		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		// One call, no more: a healthy turn earns no second request.
		expect(callCount(innerSpy)).toBe(1);
	});

	it("replays an invisible failure and lands the repaired reply in the same slot", async () => {
		const failed = scriptedStream(
			[{ type: "start", partial: baseMessage({}) } as AssistantMessageEvent],
			silentFailure("HTTP 503 Service Unavailable"),
		);
		const repaired = scriptedStream([{ type: "start", partial: baseMessage({}) } as AssistantMessageEvent], baseMessage({ content: [{ type: "text", text: "recovered" }] }));
		const inner = scriptedStreamFn([failed, repaired]);

		const result = await readResult(withTurnRetry(inner, { policy: FAST_POLICY })(MODEL, CONTEXT));

		expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(callCount(inner)).toBe(2);
	});

	it("retries a bare transport rejection with no start event at all", async () => {
		// The Obsidian transport rejects with the browser's own wording; no
		// events were ever pushed, so replaying is free by construction.
		const thrown = new Error("Failed to fetch");
		const ok = scriptedStream([], baseMessage({ content: [{ type: "text", text: "late reply" }] }));
		const inner = scriptedStreamFn([thrown, ok]);

		const result = await readResult(withTurnRetry(inner, { policy: FAST_POLICY })(MODEL, CONTEXT));

		expect(result.content).toEqual([{ type: "text", text: "late reply" }]);
	});

	it("does not retry an error pi would not classify as transient", async () => {
		const rejected = scriptedStream([{ type: "start", partial: baseMessage({}) } as AssistantMessageEvent], silentFailure("Invalid API key"));
		const inner = scriptedStreamFn([rejected]);

		const result = await readResult(withTurnRetry(inner, { policy: FAST_POLICY })(MODEL, CONTEXT));

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Invalid API key");
		expect(callCount(inner)).toBe(1);
	});

	it("never replays an attempt that already streamed content", async () => {
		// Content the reader saw cannot be withdrawn: replaying would duplicate
		// everything shown. The failure streams through as the turn's honest end.
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: baseMessage({}) } as AssistantMessageEvent,
			textDelta("partial answer"),
			{ type: "error", reason: "error", error: silentFailure("HTTP 503 Service Unavailable") } as unknown as AssistantMessageEvent,
		];
		const broken = scriptedStream(events, silentFailure("HTTP 503 Service Unavailable"));
		const inner = scriptedStreamFn([broken]);

		const result = await readResult(withTurnRetry(inner, { policy: FAST_POLICY })(MODEL, CONTEXT));

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("HTTP 503 Service Unavailable");
		expect(callCount(inner)).toBe(1);
	});

	it("stops at the configured attempt budget", async () => {
		const failure = silentFailure("HTTP 503 Service Unavailable");
		const inner = scriptedStreamFn([scriptedStream([], failure)]);

		const result = await readResult(withTurnRetry(inner, { policy: FAST_POLICY })(MODEL, CONTEXT));

		// Initial call + 2 retries, then the failure is the answer.
		expect(callCount(inner)).toBe(3);
		expect(result.stopReason).toBe("error");
	});

	it("counts retries from 1 in the callbacks, matching pi's own loop", async () => {
		const failure = silentFailure("HTTP 503 Service Unavailable");
		const inner = scriptedStreamFn([scriptedStream([], failure), scriptedStream([], failure), scriptedStream([], baseMessage({ content: [] }))]);

		const scheduled: number[] = [];
		let finished = 0;
		const result = await readResult(
			withTurnRetry(inner, {
				policy: FAST_POLICY,
				callbacks: {
					onRetryScheduled: (attempt) => {
						scheduled.push(attempt);
					},
					onRetryFinished: () => {
						finished += 1;
					},
				},
			})(MODEL, CONTEXT),
		);

		expect(scheduled).toEqual([1, 2]);
		expect(finished).toBe(1);
		expect(result.stopReason).not.toBe("error");
	});

	it("keeps callbacks silent for a turn that never retried", async () => {
		const good = scriptedStream([], baseMessage({ content: [{ type: "text", text: "fine" }] }));
		let touched = false;
		await readResult(
			withTurnRetry(scriptedStreamFn([good]), {
				policy: FAST_POLICY,
				callbacks: {
					onRetryScheduled: () => {
						touched = true;
					},
					onRetryFinished: () => {
						touched = true;
					},
				},
			})(MODEL, CONTEXT),
		);

		expect(touched).toBe(false);
	});

	it("treats a stop pressed during the backoff as an abort, not a failure", async () => {
		const failure = silentFailure("HTTP 503 Service Unavailable");
		// A policy whose wait is long enough to be interrupted mid-sleep.
		const inner = scriptedStreamFn([scriptedStream([], failure)]);
		const controller = new AbortController();
		const options: SimpleStreamOptions = { signal: controller.signal };
		let finishedWith: { success: boolean; attempt: number } | undefined;

		const output = withTurnRetry(inner, {
			policy: { maxRetries: 2, baseDelayMs: 5_000, maxDelayMs: 5_000 },
			callbacks: {
				onRetryScheduled: async () => {
					// The reader presses stop while the wrapper waits.
					controller.abort();
				},
				onRetryFinished: (success, attempt) => {
					finishedWith = { success, attempt };
				},
			},
		})(MODEL, CONTEXT, options);

		const result = await readResult(output);

		expect(result.stopReason).toBe("aborted");
		expect(finishedWith?.success).toBe(false);
		// The wait happened once; the aborted wait is not retried further.
		expect(callCount(inner)).toBe(1);
	});

	it("caps each backoff wait at the ceiling", async () => {
		const failure = silentFailure("HTTP 503 Service Unavailable");
		const inner = scriptedStreamFn([scriptedStream([], failure), scriptedStream([], failure), scriptedStream([], baseMessage({ content: [] }))]);
		const waits: number[] = [];
		const ceiling = 10;

		await readResult(
			withTurnRetry(inner, {
				policy: { maxRetries: 2, baseDelayMs: 1_000, maxDelayMs: ceiling },
				callbacks: {
					onRetryScheduled: (_attempt, _max, delayMs) => {
						waits.push(delayMs);
					},
				},
			})(MODEL, CONTEXT),
		);

		// Exponential growth would read 1000 and 2000; the ceiling holds both to
		// the cap instead.
		expect(waits).toEqual([ceiling, ceiling]);
	});

	it("reads the policy per call, so a tightened budget reaches the next turn", async () => {
		let maxRetries = 2;
		const failure = silentFailure("HTTP 503 Service Unavailable");
		const inner = scriptedStreamFn([scriptedStream([], failure)]);
		const wrapper = withTurnRetry(inner, { policy: () => ({ maxRetries, baseDelayMs: 1 }) });

		await readResult(wrapper(MODEL, CONTEXT));
		expect(callCount(inner)).toBe(3);

		maxRetries = 0;
		await readResult(wrapper(MODEL, CONTEXT));
		// The second turn follows the lowered budget: no retry at all.
		expect(callCount(inner)).toBe(4);
	});

	it("passes the model, context and options through to the inner stream function", async () => {
		const good = scriptedStream([], baseMessage({ content: [] }));
		let seen: { model?: Model<Api>; context?: Context; options?: SimpleStreamOptions } = {};
		let calls = 0;
		const inner = Object.defineProperty(
			((model: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions) => {
				seen = { model, context, options: streamOptions };
				calls += 1;
				return good;
			}) as StreamFn & { calls: number },
			"calls",
			{ get: () => calls },
		);
		const options: SimpleStreamOptions = { apiKey: "k" };

		await readResult(withTurnRetry(inner, { policy: FAST_POLICY })(MODEL, CONTEXT, options));

		expect(seen.model).toBe(MODEL);
		expect(seen.context).toBe(CONTEXT);
		expect(seen.options).toBe(options);
		expect(inner.calls).toBe(1);
	});

	it("defaults to the plugin's settings when no policy is given", async () => {
		// No policy slot: the wrapper still functions, reading the module's own
		// defaults — the ceiling is the one value a test can pin without slowing
		// anything down, because callbacks report it before the wait starts.
		const failure = silentFailure("HTTP 503 Service Unavailable");
		const inner = scriptedStreamFn([scriptedStream([], failure)]);
		const waits: number[] = [];

		await readResult(
			withTurnRetry(inner, {
				callbacks: {
					onRetryScheduled: (_attempt, _max, delayMs) => {
						waits.push(delayMs);
					},
				},
			})(MODEL, CONTEXT),
		);

		expect(waits[0]).toBe(DEFAULT_RETRY_BASE_DELAY);
		expect(waits[0]).toBeLessThanOrEqual(DEFAULT_TURN_MAX_DELAY_MS);
	});
});

/** Calls the inner stream function actually received, via the scripted spy. */
function callCount(fn: StreamFn): number {
	return (fn as StreamFn & { calls: number }).calls;
}

/** The module default the no-policy test reads back through its callback. */
const DEFAULT_RETRY_BASE_DELAY = 1_000;
