import { calculateContextTokens, estimateContextTokens, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { CompactionSettings } from "./compactionSettings";

/** Token and cost totals for a conversation. */
export interface UsageTotals {
	tokens: number;
	cost: number;
	/** Requests that reported usage, so a zero total can be told from "no data yet". */
	requests: number;
	/**
	 * Prompt tokens billed as fresh (not served from cache), summed.
	 *
	 * pi-ai normalizes `input` to *exclude* cached tokens in every adapter, so
	 * `input + cacheRead + cacheWrite` is the billed prompt total, which is what
	 * makes a cache hit rate computable without trusting `totalTokens` (whose
	 * fallback semantics vary by provider). Undefined while no request reported
	 * the field — legacy transcripts and providers that never cache.
	 */
	input?: number;
	/** Prompt tokens served from the prompt cache, summed. Undefined while unreported. */
	cacheRead?: number;
	/**
	 * Prompt tokens written to the cache (what a later turn can hit), summed.
	 * Undefined while unreported; providers that never cache report 0 rather
	 * than omit the field, which the UI hides as "no cache activity".
	 */
	cacheWrite?: number;
	/**
	 * The part of {@link cacheWrite} written with hour-long retention, summed.
	 *
	 * A subset of `cacheWrite`, so it annotates rather than adds — the same
	 * relationship {@link reasoning} has to the output count. It is carried because
	 * it is the only field that prices differently: Anthropic bills an hour-long
	 * cache write at twice base input where a five-minute one is 1.25x, and pi's
	 * `calculateCost` already splits the total on exactly this number. Surfacing it
	 * is also the only way a reader can tell that the `"long"` retention they chose
	 * is in force — a dropped preference bills at the cheaper rate and reports
	 * nothing.
	 *
	 * Undefined unless a provider reported the split; only Anthropic does.
	 */
	cacheWrite1h?: number;
	/**
	 * Reasoning tokens, summed. A subset of the visible output, so adding it to
	 * the other fields would double-count: it annotates, it never adds to
	 * {@link tokens}. Some providers only report it on thinking models.
	 */
	reasoning?: number;
}

export const EMPTY_USAGE_TOTALS: UsageTotals = { tokens: 0, cost: 0, requests: 0 };

/**
 * Adds two optional counters.
 *
 * `undefined` means "never reported" and must stay distinguishable from 0
 * (reported-but-nothing), otherwise a single request that omits the field would
 * silently present the breakdown as measured. Two unreported fields stay
 * unreported; one reported value survives an unreported partner as itself.
 */
function plus(a: number | undefined, b: number | undefined): number | undefined {
	if (a === undefined && b === undefined) {
		return undefined;
	}
	return (a ?? 0) + (b ?? 0);
}

/**
 * Sums usage across a transcript.
 *
 * pi has no exported usage aggregator: `Session.getStats()` sums usage records
 * written by the harness, which this plugin does not use, and `combineUsage` is
 * module-private. Per-token accounting is taken from pi's
 * {@link calculateContextTokens} so a provider that omits `totalTokens` still
 * reports correctly, and cost comes straight off the message, where the API
 * layer already priced it against the model that served the request.
 */
export function sumUsage(messages: AgentMessage[], extra: Usage[] = []): UsageTotals {
	const reported = [...messages.flatMap(getMessageUsage), ...extra];
	return reported.reduce<UsageTotals>(
		(totals, usage) => ({
			tokens: totals.tokens + calculateContextTokens(usage),
			cost: totals.cost + usage.cost.total,
			requests: totals.requests + 1,
			input: plus(totals.input, usage.input),
			cacheRead: plus(totals.cacheRead, usage.cacheRead),
			cacheWrite: plus(totals.cacheWrite, usage.cacheWrite),
			cacheWrite1h: plus(totals.cacheWrite1h, usage.cacheWrite1h),
			reasoning: plus(totals.reasoning, usage.reasoning),
		}),
		EMPTY_USAGE_TOTALS,
	);
}

function getMessageUsage(message: AgentMessage): Usage[] {
	if (message.role !== "assistant") {
		return [];
	}
	// Aborted and errored turns still report what the provider charged for.
	return message.usage ? [message.usage] : [];
}

/**
 * Adds two totals, for an accumulator that outlives any one transcript.
 *
 * {@link sumUsage} answers "what did these messages cost", which is the whole
 * question while one transcript is the whole record. A subagent given several
 * errands has several — and a mid-run compaction drops the messages an earlier
 * one was measured from — so a running total has to be kept rather than
 * re-derived from whatever context survives.
 */
export function addUsageTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
	return {
		tokens: a.tokens + b.tokens,
		cost: a.cost + b.cost,
		requests: a.requests + b.requests,
		input: plus(a.input, b.input),
		cacheRead: plus(a.cacheRead, b.cacheRead),
		cacheWrite: plus(a.cacheWrite, b.cacheWrite),
		cacheWrite1h: plus(a.cacheWrite1h, b.cacheWrite1h),
		reasoning: plus(a.reasoning, b.reasoning),
	};
}

/** Formats a token count for a compact status line: 1234 → "1.2k". */
export function formatTokens(tokens: number): string {
	if (tokens < 1_000) {
		return `${tokens}`;
	}
	if (tokens < 1_000_000) {
		return `${(tokens / 1_000).toFixed(1)}k`;
	}
	return `${(tokens / 1_000_000).toFixed(2)}M`;
}

/** How full the model's context window is, plus the threshold compaction uses. */
export interface ContextFill {
	/** Estimated tokens the current transcript occupies. */
	tokens: number;
	/** The active model's context window in tokens. */
	contextWindow: number;
	/**
	 * Occupancy as a fraction of the window (0..1); can exceed 1 on a
	 * heuristic-only estimate that later turns would push past the window.
	 */
	ratio: number;
	/**
	 * Occupancy fraction at which automatic compaction fires
	 * (`window - reserveTokens`, from the resolved {@link CompactionSettings}),
	 * so the indicator can colour itself against the same line pi acts on.
	 */
	compactionRatio: number;
	/**
	 * True while no assistant turn has reported usage, meaning {@link tokens}
	 * is a per-character heuristic rather than a provider-measured figure and
	 * must not be presented as precise.
	 */
	heuristicOnly: boolean;
}

/**
 * Measures how much of the model's context window the conversation occupies.
 *
 * `estimateContextTokens` trusts the newest assistant usage block when one
 * exists and falls back to a characters/4 heuristic before the first response,
 * so `heuristicOnly` tells the UI which regime it is in. The threshold mirrors
 * `shouldCompact` exactly (`contextWindow - reserveTokens`) — deriving the
 * display's warning colour from anything else would disagree with what actually
 * triggers compaction.
 *
 * `settings` is required rather than defaulted: the caller resolves it from the
 * user's configuration, and a default here would let a caller that forgot to
 * pass it draw a threshold the compaction path does not use.
 */
export function measureContextFill(messages: AgentMessage[], contextWindow: number, settings: CompactionSettings): ContextFill {
	const estimate = estimateContextTokens(messages);
	const usable = Math.max(contextWindow - settings.reserveTokens, 1);
	return {
		tokens: estimate.tokens,
		contextWindow,
		ratio: estimate.tokens / contextWindow,
		compactionRatio: usable / contextWindow,
		heuristicOnly: estimate.lastUsageIndex === null,
	};
}

/**
 * Formats a cost in USD.
 *
 * Sub-cent totals keep four decimals because a single cheap turn would otherwise
 * render as "$0.00" and look free.
 */
export function formatCost(cost: number): string {
	if (cost === 0) {
		return "$0";
	}
	return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}
