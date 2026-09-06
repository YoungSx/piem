import { describe, expect, it } from "bun:test";
import type { ContextFill, UsageTotals } from "../agent/usage";
import {
	contextCacheLine,
	contextLongCacheNote,
	contextGaugeName,
	contextLevel,
	contextPercent,
	contextReasoningNote,
	contextStateText,
	contextTokenSummary,
	contextValueText,
	meterTitle,
	tidyLabel,
} from "./headerCopy";
import { getT } from "../i18n";

const en = getT("en");
const zh = getT("zh-cn");

describe("contextLevel", () => {
	it("bands against the threshold compaction actually acts on", () => {
		expect(contextLevel(fill({ ratio: 0.1 }))).toBe("ok");
		// Threshold ~0.9836; its 75% mark is ~0.7377.
		expect(contextLevel(fill({ ratio: 0.85 }))).toBe("warn");
		expect(contextLevel(fill({ ratio: 0.99 }))).toBe("near");
	});
});

describe("contextStateText", () => {
	it("names every level in words, so the bar's colour is never the only signal", () => {
		expect(contextStateText("ok", en)).toBe("ok");
		expect(contextStateText("warn", en)).toBe("filling");
		expect(contextStateText("near", en)).toBe("context nearly full");
	});

	it("names every level in Chinese too", () => {
		expect(contextStateText("ok", zh)).toBe("正常");
		expect(contextStateText("warn", zh)).toBe("正在填充");
		expect(contextStateText("near", zh)).toBe("上下文即将占满");
	});
});

describe("meterTitle", () => {
	it("flags a heuristic estimate rather than presenting it as measured", () => {
		expect(meterTitle(fill({ heuristicOnly: true }), en)).toContain("Estimated");
	});

	it("quotes the compaction threshold once the provider reports usage", () => {
		expect(meterTitle(fill({ heuristicOnly: false }), en)).toContain("98%");
	});

	it("keeps the interpolated threshold when translated", () => {
		expect(meterTitle(fill({ heuristicOnly: false }), zh)).toContain("98%");
		expect(meterTitle(fill({ heuristicOnly: true }), zh)).toContain("估算");
	});
});

describe("contextTokenSummary", () => {
	/*
	 * The tilde is load-bearing, not decoration: before the first reply the count
	 * comes from a characters/4 heuristic, so printing it bare would present a
	 * guess as a measurement.
	 */
	it("marks a heuristic count with a tilde and drops it once measured", () => {
		expect(contextTokenSummary(fill({ tokens: 12_400, heuristicOnly: true }))).toBe("~12.4k / 1.00M");
		expect(contextTokenSummary(fill({ tokens: 500_000, heuristicOnly: false }))).toBe("500.0k / 1.00M");
	});
});

describe("contextPercent", () => {
	it("rounds to a whole percent", () => {
		expect(contextPercent(fill({ ratio: 0.0124 }))).toBe(1);
		expect(contextPercent(fill({ ratio: 0.855 }))).toBe(86);
	});

	it("clamps a heuristic overshoot, which can exceed the window", () => {
		// A characters/4 estimate can run past the real window; "140 percent full"
		// is not a state the reader can act on, and 100 is.
		expect(contextPercent(fill({ ratio: 1.4 }))).toBe(100);
	});
});

describe("contextValueText", () => {
	/*
	 * This string is the whole readout for a screen reader: the ring is a 16px
	 * glyph with no text, so nothing else states the figures.
	 */
	it("states tokens, window, percent and level in one sentence", () => {
		const text = contextValueText(fill({ tokens: 12_400, ratio: 0.0124, heuristicOnly: true }), en);

		expect(text).toBe("Estimated 12.4k of 1.00M tokens used, 1 percent, ok");
	});

	it("drops the estimate prefix once the provider reports usage", () => {
		const text = contextValueText(fill({ tokens: 500_000, ratio: 0.5, heuristicOnly: false }), en);

		expect(text).toBe("500.0k of 1.00M tokens used, 50 percent, ok");
	});

	it("translates the frame and the level, never the numbers", () => {
		const text = contextValueText(fill({ tokens: 990_000, ratio: 0.99, heuristicOnly: false }), zh);

		expect(text).toBe("已使用 990.0k / 1.00M token，99%，上下文即将占满");
	});
});

describe("contextGaugeName", () => {
	it("names the control before reading it out, since the ring shows no numbers", () => {
		const name = contextGaugeName(fill({ tokens: 12_400, ratio: 0.0124, heuristicOnly: true }), en);

		expect(name).toBe("Context window use: Estimated 12.4k of 1.00M tokens used, 1 percent, ok");
	});

	it("translates both halves", () => {
		expect(contextGaugeName(fill({ heuristicOnly: false }), zh)).toStartWith("上下文窗口占用: ");
	});
});

describe("tidyLabel", () => {
	/*
	 * The button is always rendered and disabled while busy, so its own name is
	 * the only channel it has to explain why it cannot be pressed.
	 */
	it("names the action when it can run", () => {
		expect(tidyLabel({ isStreaming: false, isCompacting: false }, en)).toBe("Tidy earlier thoughts");
	});

	it("says a compaction is already running", () => {
		expect(tidyLabel({ isStreaming: false, isCompacting: true }, en)).toBe("Tidying thoughts…");
	});

	it("says to wait for the reply, since compaction cannot start mid-turn", () => {
		expect(tidyLabel({ isStreaming: true, isCompacting: false }, en)).toBe("Tidy earlier thoughts once the reply finishes");
	});

	it("prefers the in-flight reason when both hold, since it is the nearer one", () => {
		// A compaction that is already running is the more specific fact; naming the
		// stream instead would tell the reader to wait for something that already ended.
		expect(tidyLabel({ isStreaming: true, isCompacting: true }, en)).toBe("Tidying thoughts…");
	});

	it("translates every reason", () => {
		expect(tidyLabel({ isStreaming: false, isCompacting: false }, zh)).toBe("整理较早思维");
		expect(tidyLabel({ isStreaming: false, isCompacting: true }, zh)).toBe("整理思维中…");
		expect(tidyLabel({ isStreaming: true, isCompacting: false }, zh)).toBe("回复结束后可整理较早思维");
	});
});

describe("contextCacheLine", () => {
	/*
	 * The denominator is `input + cacheRead + cacheWrite` — the billed prompt
	 * total. pi-ai normalizes `input` to exclude cached tokens in every adapter,
	 * so that sum is what the provider actually billed for the prompt; using
	 * `totalTokens` instead would let a provider's fallback arithmetic (bedrock
	 * derives one without the cache fields) skew the rate.
	 */
	it("divides cached reads by the billed prompt total", () => {
		// 2.7k served from cache against 300 fresh + 2.7k cached = 3k billed.
		const line = contextCacheLine(usageTotals({ input: 300, cacheRead: 2_700 }), en);

		expect(line).toBe("cache 90% · 2.7k tokens");
	});

	it("counts fresh cache writes as billed prompt, so a cold turn reads 0% rather than hiding", () => {
		const line = contextCacheLine(usageTotals({ input: 300, cacheWrite: 700, cacheRead: 0 }), en);

		expect(line).toBe("cache 0% · 0 tokens");
	});

	it("stays undefined while the provider reports no cache activity at all", () => {
		// Adapters for models without a prompt cache report the fields as 0, not
		// absent — a "cache 0%" line there would be noise, not signal.
		expect(contextCacheLine(usageTotals({ input: 500 }), en)).toBeUndefined();
	});

	it("declines the percentage when the fresh-prompt figure is missing", () => {
		// `input` is required on pi-ai's Usage, so this is defensive: guessing a
		// denominator from the cache fields alone would read 100%.
		expect(contextCacheLine({ tokens: 100, cost: 0, requests: 1 }, en)).toBeUndefined();
	});

	it("rounds to a whole percent", () => {
		expect(contextCacheLine(usageTotals({ input: 1, cacheRead: 2 }), en)).toBe("cache 67% · 2 tokens");
	});

	it("translates the frame, never the numbers", () => {
		expect(contextCacheLine(usageTotals({ input: 300, cacheRead: 2_700 }), zh)).toBe("缓存 90% · 2.7k token");
	});
});

describe("contextLongCacheNote", () => {
	it("names the share billed at the hour-long rate, which the cache line above already counts", () => {
		expect(contextLongCacheNote(usageTotals({ cacheWrite: 2_000, cacheWrite1h: 1_500 }), en)).toBe(
			"incl. 1.5k kept for an hour, at 2× the write price",
		);
	});

	it("stays undefined when the provider reports no split", () => {
		// Every non-Anthropic adapter: cache writes happen, the hour-long share is
		// simply not a number they have.
		expect(contextLongCacheNote(usageTotals({ cacheWrite: 2_000 }), en)).toBeUndefined();
	});

	it("stays undefined on a reported zero, which is what short and off retention produce", () => {
		// Anthropic sets the field on every turn, so 0 is the normal reading under
		// `"short"` — and it is the reading that must show nothing, or the note stops
		// being evidence that `"long"` took effect.
		expect(contextLongCacheNote(usageTotals({ cacheWrite: 2_000, cacheWrite1h: 0 }), en)).toBeUndefined();
	});

	it("translates", () => {
		expect(contextLongCacheNote(usageTotals({ cacheWrite: 2_000, cacheWrite1h: 1_500 }), zh)).toBe(
			"含 1.5k 保留一小时，写入价 2 倍",
		);
	});
});

describe("contextReasoningNote", () => {
	it("names the reasoning share, which the tokens line above already counts", () => {
		// A subset of output, so it annotates rather than adds.
		expect(contextReasoningNote(usageTotals({ reasoning: 1_500 }), en)).toBe("incl. 1.5k reasoning");
	});

	it("stays undefined when no provider reported a split", () => {
		expect(contextReasoningNote(usageTotals(), en)).toBeUndefined();
	});

	it("stays undefined on a reported zero, which thinking-capable providers emit on plain turns", () => {
		// OpenAI and Google always set the field, possibly to 0 — "incl. 0" is noise.
		expect(contextReasoningNote(usageTotals({ reasoning: 0 }), en)).toBeUndefined();
	});

	it("translates", () => {
		expect(contextReasoningNote(usageTotals({ reasoning: 1_500 }), zh)).toBe("含推理 1.5k");
	});
});

function fill(overrides: Partial<ContextFill> = {}): ContextFill {
	return {
		tokens: 12_400,
		contextWindow: 1_000_000,
		ratio: 0.0124,
		compactionRatio: (1_000_000 - 16_384) / 1_000_000,
		heuristicOnly: true,
		...overrides,
	};
}

function usageTotals(overrides: Partial<UsageTotals> = {}): UsageTotals {
	return { tokens: 3_000, cost: 0.01, requests: 2, input: 0, cacheRead: 0, cacheWrite: 0, ...overrides };
}
