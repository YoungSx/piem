import { formatTokens } from "../agent/usage";
import type { ContextFill, UsageTotals } from "../agent/usage";
import type { Translator } from "../i18n";

/**
 * Copy and level rules for the context meter.
 *
 * Free of React and DOM imports so the wording can be unit-tested without a
 * renderer; `ChatStatusBar.tsx` owns the markup.
 *
 * Every function that returns prose takes the {@link Translator} rather than
 * reaching for a table itself: that keeps the language a caller's decision and
 * lets the tests assert both languages through the same entry points.
 *
 * Named for the header because that is where the meter used to live. Both of the
 * things that made the name accurate have since moved out — the meter to the
 * status bar, the model line to the composer's switcher — so the module is due a
 * rename; it is left for a pass that is not also changing what it says.
 */

/**
 * Text label for the context level, mirrored from the colour so the state is
 * legible without sight — required by the a11y contract, not cosmetic.
 */
export function contextStateText(level: ContextLevel, t: Translator): string {
	if (level === "near") {
		return t.t("context.nearlyFull");
	}
	if (level === "warn") {
		return t.t("context.filling");
	}
	return t.t("context.ok");
}

export type ContextLevel = "ok" | "warn" | "near";

/**
 * Bands the occupancy against the same threshold compaction acts on, so the
 * colour never disagrees with what actually triggers summarization.
 *
 * Automatic compaction is a hard rule (see `resolveCompactionSettings`), so the
 * threshold is always a live one: something really does step in at the line,
 * and the meter can colour and promise against it without hedging.
 */
export function contextLevel(fill: ContextFill): ContextLevel {
	if (fill.ratio >= fill.compactionRatio) {
		return "near";
	}
	return fill.ratio >= fill.compactionRatio * 0.75 ? "warn" : "ok";
}

export function meterTitle(fill: ContextFill, t: Translator): string {
	if (fill.heuristicOnly) {
		return t.t("context.meterHeuristic");
	}
	return t.t("context.meterMeasured", { percent: Math.round(fill.compactionRatio * 100) });
}

/**
 * Occupancy as "~12.4k / 1.00M".
 *
 * The tilde is load-bearing: before the first reply the count comes from a
 * characters/4 heuristic, so printing it bare would present a guess as a
 * measurement. See {@link ContextFill.heuristicOnly}.
 */
export function contextTokenSummary(fill: ContextFill): string {
	return `${fill.heuristicOnly ? "~" : ""}${formatTokens(fill.tokens)} / ${formatTokens(fill.contextWindow)}`;
}

/** Occupancy as a whole percent, clamped so a heuristic overshoot cannot read past 100. */
export function contextPercent(fill: ContextFill): number {
	return Math.min(Math.round(fill.ratio * 100), 100);
}

/**
 * The whole readout as one sentence: tokens, window, percent, state.
 *
 * Was assembled inline in the status bar while the meter was a bar with a
 * visible label beside it. The gauge is a 16px ring with no text, so this string
 * is the only channel the numbers have for a screen reader — which is why it
 * lives here, under test, rather than in the markup.
 */
export function contextValueText(fill: ContextFill, t: Translator): string {
	return t.t("chat.contextValueText", {
		estimated: fill.heuristicOnly ? t.t("chat.contextEstimatedPrefix") : "",
		tokens: formatTokens(fill.tokens),
		window: formatTokens(fill.contextWindow),
		unit: t.t("chat.tokensSuffix"),
		percent: contextPercent(fill),
		state: contextStateText(contextLevel(fill), t),
	});
}

/**
 * Accessible name for the gauge button: what the control is, then what it reads.
 *
 * The numbers are in the name rather than only inside the popover, so a screen
 * reader user learns the occupancy without having to open a disclosure to hear
 * it. Opening it adds the explanation and the tidy control, not the figures.
 */
export function contextGaugeName(fill: ContextFill, t: Translator): string {
	return `${t.t("chat.contextAria")}: ${contextValueText(fill, t)}`;
}

/**
 * What the tidy control says — which is also why it cannot be pressed.
 *
 * The button is always rendered, never hidden: a control that comes and goes
 * teaches nobody where it lives. But `compactNow` returns early while a turn
 * streams, and `runExclusiveCompaction` single-flights, so pressing it in either
 * state genuinely does nothing. A disabled button has no channel other than its
 * own name to explain itself, so the name carries the reason.
 */
export function tidyLabel(state: { isStreaming: boolean; isCompacting: boolean }, t: Translator): string {
	if (state.isCompacting) {
		return t.t("context.tidyWhileCompacting");
	}
	if (state.isStreaming) {
		return t.t("context.tidyWhileStreaming");
	}
	return t.t("commands.tidyUp");
}

/**
 * The cache readout as "cache 87% · 12.4k tokens", or undefined when there is
 * nothing honest to say.
 *
 * The percent's denominator is `input + cacheRead + cacheWrite` — the billed
 * prompt total, not `totalTokens`. pi-ai normalizes `input` to *exclude* cached
 * tokens in every adapter, so that sum is exactly what the provider billed for
 * the prompt, on every provider; `totalTokens` cannot stand in for it because
 * some adapters derive their fallback total without the cache fields. The rate
 * is therefore "the share of billed prompt tokens served from cache" — a
 * property of the provider's caching, independent of how much the model replied.
 *
 * Gating: undefined while the provider reports no cache activity at all
 * (`cacheRead + cacheWrite` both 0), which is how adapters for models without a
 * prompt cache report — a "cache 0%" line on those would be noise, not signal.
 * `input` is required on pi-ai's `Usage`, but a defensive undefined here
 * declines the percentage rather than guessing a denominator.
 */
export function contextCacheLine(usage: UsageTotals, t: Translator): string | undefined {
	const read = usage.cacheRead ?? 0;
	const write = usage.cacheWrite ?? 0;
	if (read + write === 0 || usage.input === undefined) {
		return undefined;
	}
	const billedPrompt = usage.input + read + write;
	return t.t("chat.cacheLine", {
		percent: Math.round((read / billedPrompt) * 100),
		tokens: formatTokens(read),
		unit: t.t("chat.tokensSuffix"),
	});
}

/**
 * The hour-long-write footnote, or undefined when no provider reported one.
 *
 * Shown, never added: these tokens are already inside the cache line's write
 * figure — this only says which rate they were billed at. Anthropic charges
 * twice base input for an hour-long cache write against 1.25x for a five-minute
 * one, and `calculateCost` has already applied that split to the spend line
 * above, so the note explains a number the reader can already see rather than
 * introducing one.
 *
 * It is also the only feedback the retention setting has. `"long"` is a
 * preference each provider maps or drops on its own, so a reader who chose it
 * has no other way to learn whether it took — and a dropped preference is
 * invisible, since it simply bills at the cheaper rate. The `> 0` gate means
 * the line appears exactly when the hour-long write really happened: absent on
 * every provider that omits the split, and absent on `"short"` and `"none"`.
 */
export function contextLongCacheNote(usage: UsageTotals, t: Translator): string | undefined {
	if (!usage.cacheWrite1h) {
		return undefined;
	}
	return t.t("chat.longCacheNote", { tokens: formatTokens(usage.cacheWrite1h) });
}

/**
 * The reasoning note as "incl. 1.2k reasoning", or undefined when the provider
 * reports no split.
 *
 * Shown, never added: reasoning tokens are a subset of the reply, so the tokens
 * line above already counts them. Providers that expose a thinking breakdown
 * report it even when it is 0, hence the `> 0` gate rather than an undefined
 * check — a "incl. 0 reasoning" note is noise on exactly the models that do
 * think.
 */
export function contextReasoningNote(usage: UsageTotals, t: Translator): string | undefined {
	if (!usage.reasoning) {
		return undefined;
	}
	return t.t("chat.reasoningNote", { tokens: formatTokens(usage.reasoning) });
}
