import { describe, expect, it } from "bun:test";
import { prepareCompaction, shouldCompact } from "./piCompaction";
import { type AgentMessage } from "@earendil-works/pi-agent-core";
import { type Entry } from "../session/sessionTypes";
import { resolveCompactionSettings, type CompactionConfig } from "./compactionSettings";
import { measureContextFill } from "./usage";

/**
 * The one property the compaction setting exists to protect.
 *
 * `measureContextFill` draws the meter and `shouldCompact` decides when to
 * summarize; before this setting existed both read pi's default, so they agreed
 * by accident. Now that the numbers come from the user, the agreement has to be
 * asserted: a reader who sees the bar cross the line and nothing happen — or
 * compaction fire at 70% — is watching the panel lie about what the agent does.
 *
 * The messages are irrelevant here, so occupancy is expressed as a token count
 * fed to both sides directly.
 */
function crossesMeterThreshold(tokens: number, contextWindow: number, config: CompactionConfig | undefined): boolean {
	const fill = measureContextFill([], contextWindow, resolveCompactionSettings(config, contextWindow));
	return tokens / contextWindow >= fill.compactionRatio;
}

function piWouldCompact(tokens: number, contextWindow: number, config: CompactionConfig | undefined): boolean {
	return shouldCompact(tokens, contextWindow, resolveCompactionSettings(config, contextWindow));
}

/**
 * A transcript of roughly `tokens` tokens, alternating user and assistant.
 *
 * pi estimates at four characters per token and only cuts on turn boundaries, so
 * the messages have to be many and small: one enormous message offers no valid
 * cut point and would make the assertion pass for the wrong reason.
 */
function transcript(tokens: number): Entry[] {
	const messageCount = 40;
	const charsEach = Math.max(Math.ceil((tokens * 4) / messageCount), 4);
	const entries: Entry[] = [];
	for (let index = 0; index < messageCount; index += 1) {
		const message = {
			role: index % 2 === 0 ? "user" : "assistant",
			content: [{ type: "text", text: "x".repeat(charsEach) }],
			timestamp: index + 1,
		} as unknown as AgentMessage;
		entries.push({
			type: "message",
			id: `message-${index}`,
			seq: index + 1,
			parentId: index === 0 ? null : `message-${index - 1}`,
			timestamp: index + 1,
			message,
		} as Entry);
	}
	return entries;
}

describe("meter and trigger agreement", () => {
	const configs: Array<{ label: string; config: CompactionConfig | undefined }> = [
		{ label: "unset", config: undefined },
		{ label: "explicit default", config: { reserveTokens: 16_384 } },
		{ label: "generous reserve", config: { reserveTokens: 200_000 } },
		{ label: "reserve below the floor", config: { reserveTokens: 1 } },
		{ label: "reserve past the cap", config: { reserveTokens: 10_000_000 } },
	];

	for (const { label, config } of configs) {
		it(`puts the meter's line where pi actually compacts (${label})`, () => {
			const contextWindow = 1_000_000;
			const settings = resolveCompactionSettings(config, contextWindow);
			const threshold = contextWindow - settings.reserveTokens;

			// Just under: neither side acts.
			expect(crossesMeterThreshold(threshold - 1, contextWindow, config)).toBe(false);
			expect(piWouldCompact(threshold - 1, contextWindow, config)).toBe(false);

			// Just over: both do. `shouldCompact` is a strict `>` while the meter
			// bands on `>=`, so the exact boundary token is the one point where the
			// bar reaches the line a moment before pi acts — checked one token past.
			expect(crossesMeterThreshold(threshold + 1, contextWindow, config)).toBe(true);
			expect(piWouldCompact(threshold + 1, contextWindow, config)).toBe(true);
		});
	}

	it("never draws a threshold at or past the full window, which would make the bar unreachable", () => {
		for (const contextWindow of [1_000, 8_192, 128_000, 1_000_000]) {
			for (const { config } of configs) {
				const fill = measureContextFill([], contextWindow, resolveCompactionSettings(config, contextWindow));

				expect(fill.compactionRatio).toBeGreaterThan(0);
				expect(fill.compactionRatio).toBeLessThanOrEqual(1);
			}
		}
	});

	it("leaves pi something to summarize whenever it decides to compact", () => {
		// The invariant `canMakeProgress` asserts, checked against pi itself rather
		// than against our own predicate. Before the shared budget, a reserve and a
		// retention budget each capped at half the window could sum to the whole
		// window: pi fired, `prepareCompaction` returned the entire transcript as
		// the retained tail, and the plugin paid for a summary that changed nothing
		// — then did it again on the next prompt.
		const extremes = [1, 1_024, 20_000, 500_000, 10_000_000];
		for (const contextWindow of [8_000, 128_000, 1_000_000]) {
			for (const reserveTokens of extremes) {
				for (const keepRecentTokens of extremes) {
					const settings = resolveCompactionSettings({ reserveTokens, keepRecentTokens }, contextWindow);
					// Occupancy one token past pi's own trigger, which is where a
					// no-progress loop would start.
					const tokens = contextWindow - settings.reserveTokens + 1;
					const entries = transcript(tokens);
					if (!shouldCompact(tokens, contextWindow, settings)) {
						continue;
					}

					const prepared = prepareCompaction(entries, settings);
					if (!prepared.ok) {
						throw new Error(`prepareCompaction failed: ${prepared.error.message}`);
					}

					expect(prepared.value?.messagesToSummarize.length ?? 0).toBeGreaterThan(0);
				}
			}
		}
	});

	it("compacts at any occupancy, because the hard rule has no off state", () => {
		// Automatic compaction is a hard rule now: there is no user-facing switch,
		// so the meter's threshold always names a line pi really acts on. Pinned
		// here so a future "let the user disable it" cannot re-open the gap this
		// file exists to close.
		expect(piWouldCompact(999_999, 1_000_000, undefined)).toBe(true);
	});
});
