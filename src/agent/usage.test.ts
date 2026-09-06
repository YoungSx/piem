import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { formatCost, formatTokens, measureContextFill, sumUsage } from "./usage";
import { DEFAULT_COMPACTION_SETTINGS, type CompactionSettings } from "./compactionSettings";

describe("sumUsage", () => {
	it("reports no requests for a transcript without assistant turns", () => {
		expect(sumUsage([userMessage("hi")])).toEqual({ tokens: 0, cost: 0, requests: 0 });
	});

	it("adds tokens and cost across assistant turns", () => {
		const messages = [
			userMessage("first"),
			assistantMessage(usage({ input: 100, output: 20, totalTokens: 120, cost: 0.5 })),
			userMessage("second"),
			assistantMessage(usage({ input: 200, output: 30, totalTokens: 230, cost: 1.25 })),
		];

		// The `usage()` helper mirrors a non-caching provider, which reports the
		// cache fields as 0 rather than omitting them; only `reasoning` is absent.
		expect(sumUsage(messages)).toEqual({
			tokens: 350,
			cost: 1.75,
			requests: 2,
			input: 300,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});

	it("falls back to the token breakdown when a provider omits totalTokens", () => {
		const messages = [assistantMessage(usage({ input: 10, output: 5, cacheRead: 2, totalTokens: 0, cost: 0 }))];

		expect(sumUsage(messages).tokens).toBe(17);
	});

	it("includes compaction usage, which never appears in the transcript", () => {
		const messages = [assistantMessage(usage({ input: 10, output: 0, totalTokens: 10, cost: 0.1 }))];
		const compaction = usage({ input: 500, output: 100, totalTokens: 600, cost: 2 });

		expect(sumUsage(messages, [compaction])).toEqual({
			tokens: 610,
			cost: 2.1,
			requests: 2,
			input: 510,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});

	it("accumulates the breakdown fields across messages", () => {
		const messages = [
			assistantMessage(usage({ input: 100, output: 20, cacheRead: 900, totalTokens: 1020, cost: 0.5 })),
			assistantMessage(
				usage({
					input: 200,
					output: 30,
					cacheRead: 1_500,
					totalTokens: 1730,
					cost: 1.25,
					reasoning: 12,
				}),
			),
		];

		const totals = sumUsage(messages);

		expect(totals.input).toBe(300);
		expect(totals.cacheRead).toBe(2_400);
		expect(totals.cacheWrite).toBe(0);
		expect(totals.reasoning).toBe(12);
		// Reasoning is a subset of output: it must not inflate the context count.
		expect(totals.tokens).toBe(2_750);
	});

	it("accumulates cacheWrite across turns without letting it re-enter the context count", () => {
		const messages = [
			assistantMessage(usage({ input: 100, output: 10, cacheWrite: 500, totalTokens: 610, cost: 0 })),
			assistantMessage(usage({ input: 50, output: 5, cacheWrite: 300, totalTokens: 355, cost: 0 })),
		];

		const totals = sumUsage(messages);

		expect(totals.cacheWrite).toBe(800);
		expect(totals.tokens).toBe(965);
	});

	it("accumulates the hour-long share of cacheWrite without adding it to either total", () => {
		// `cacheWrite1h` is a subset of `cacheWrite`, which is itself already
		// excluded from the context count — so it must move neither number. It is
		// carried because it is the only field priced differently (2x base input
		// against 1.25x), and because it is the one signal that the reader's "long"
		// retention preference reached the provider.
		const messages = [
			assistantMessage(usage({ input: 100, output: 10, cacheWrite: 500, cacheWrite1h: 500, totalTokens: 610, cost: 0 })),
			assistantMessage(usage({ input: 50, output: 5, cacheWrite: 300, cacheWrite1h: 120, totalTokens: 355, cost: 0 })),
		];

		const totals = sumUsage(messages);

		expect(totals.cacheWrite).toBe(800);
		expect(totals.cacheWrite1h).toBe(620);
		expect(totals.tokens).toBe(965);
	});

	it("keeps the hour-long share unreported when a provider omits it but still writes cache", () => {
		// Every non-Anthropic adapter reports `cacheWrite` and omits the split. A
		// summed 0 there would render as "0 kept for an hour" — a claim about a
		// provider that never made one.
		const messages = [assistantMessage(usage({ input: 100, output: 10, cacheWrite: 500, totalTokens: 610, cost: 0 }))];

		const totals = sumUsage(messages);

		expect(totals.cacheWrite).toBe(500);
		expect(totals.cacheWrite1h).toBeUndefined();
	});

	it("leaves the breakdown undefined while no message reported it", () => {
		// A provider that never exposes a reasoning split omits the key entirely;
		// summing must not dress that up as a measured zero.
		const messages = [assistantMessage(usage({ input: 10, output: 5, totalTokens: 15, cost: 0 }))];

		const totals = sumUsage(messages);

		expect(totals.reasoning).toBeUndefined();
	});

	it("keeps a reported breakdown field once any message reported it", () => {
		// One turn with the split and one without: the total is the sum of what
		// was reported, not undefined — an absent field contributes nothing.
		const messages = [
			assistantMessage(usage({ input: 10, output: 5, totalTokens: 15, cost: 0, reasoning: 4 })),
			assistantMessage(usage({ input: 10, output: 5, totalTokens: 15, cost: 0 })),
		];

		expect(sumUsage(messages).reasoning).toBe(4);
	});
});

describe("formatting", () => {
	it("scales token counts", () => {
		expect(formatTokens(950)).toBe("950");
		expect(formatTokens(1_500)).toBe("1.5k");
		expect(formatTokens(2_400_000)).toBe("2.40M");
	});

	it("keeps sub-cent costs visible instead of rounding them to zero", () => {
		expect(formatCost(0)).toBe("$0");
		expect(formatCost(0.0021)).toBe("$0.0021");
		expect(formatCost(1.5)).toBe("$1.50");
	});
});

describe("measureContextFill", () => {
	it("marks a fresh conversation as heuristic-only, before any usage exists", () => {
		const fill = measureContextFill([userMessage("hello")], 100_000, compactionSettings());

		expect(fill.heuristicOnly).toBe(true);
		expect(fill.tokens).toBeGreaterThan(0);
	});

	it("trusts provider usage once an assistant turn has reported it", () => {
		const messages = [
			userMessage("first"),
			assistantMessage(usage({ input: 4_000, output: 0, totalTokens: 4_000, cost: 0 })),
			userMessage("tiny trailing prompt"),
		];

		const fill = measureContextFill(messages, 10_000, compactionSettings());

		expect(fill.heuristicOnly).toBe(false);
		expect(fill.ratio).toBeGreaterThan(0.4);
	});

	it("derives the compaction threshold from the reserve it was handed", () => {
		const fill = measureContextFill([], 1_000_000, compactionSettings({ reserveTokens: 16_384 }));

		expect(fill.compactionRatio).toBeCloseTo((1_000_000 - 16_384) / 1_000_000, 6);
	});

	it("moves the threshold with the configured reserve, so the meter tracks the user's setting", () => {
		// The regression this guards: the meter used to read pi's default while
		// compaction acted on the configured value, so the bar and the trigger
		// disagreed by exactly the difference between the two.
		const fill = measureContextFill([], 1_000_000, compactionSettings({ reserveTokens: 200_000 }));

		expect(fill.compactionRatio).toBeCloseTo(0.8, 6);
	});

	it("orders occupancy by reported usage so the meter can colour itself", () => {
		const ratioAt = (tokens: number): number =>
			measureContextFill(
				[assistantMessage(usage({ input: tokens, output: 0, totalTokens: tokens, cost: 0 }))],
				10_000,
				compactionSettings(),
			).ratio;

		expect(ratioAt(9_000)).toBeGreaterThan(ratioAt(7_000));
	});

	it("reports the window the caller passed, not a hardcoded one", () => {
		const fill = measureContextFill([], 128_000, compactionSettings());

		expect(fill.contextWindow).toBe(128_000);
	});
});

function compactionSettings(overrides: Partial<CompactionSettings> = {}): CompactionSettings {
	return { ...DEFAULT_COMPACTION_SETTINGS, ...overrides };
}

function usage(parts: {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	cacheWrite1h?: number;
	totalTokens: number;
	cost: number;
	reasoning?: number;
}): Usage {
	return {
		input: parts.input,
		output: parts.output,
		cacheRead: parts.cacheRead ?? 0,
		cacheWrite: parts.cacheWrite ?? 0,
		// Absent unless asked: only Anthropic reports the hour-long share.
		cacheWrite1h: parts.cacheWrite1h,
		totalTokens: parts.totalTokens,
		// Absent unless asked: mirrors the providers that never report a split.
		reasoning: parts.reasoning,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: parts.cost },
	};
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

function assistantMessage(messageUsage: Usage): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage: messageUsage,
		stopReason: "stop",
		timestamp: Date.now(),
	} as AgentMessage;
}
