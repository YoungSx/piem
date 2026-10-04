import { DEFAULT_COMPACTION_SETTINGS, type CompactionSettings } from "./piCompaction";

/**
 * The compaction configuration, as the user can set it.
 *
 * Its own module rather than a field buried in `settings.ts` because two
 * unrelated paths have to agree on it: {@link compactIfNeeded} decides when to
 * summarize, and `measureContextFill` draws the meter that tells the user it is
 * about to happen. When those read different numbers the panel lies — the bar
 * sits at 80% and compaction fires, or it pins at full and nothing happens.
 * Resolution lives here so both sides call one function.
 *
 * Stored as a partial: a vault that has never opened the advanced group holds
 * nothing, and every field the user did not touch has to keep following pi's
 * default rather than freezing whatever it happened to be at install time.
 *
 * Automatic compaction itself is not configurable: it is a hard rule, on by
 * construction. Letting the transcript outgrow the window is what turns a long
 * chat into a broken one, so the only user-facing choice is *when* it happens —
 * the two token fields below, or pressing tidy up early. The previously
 * supported `enabled` off switch is gone; `normalizeCompactionConfig` drops it,
 * so a vault that turned it off returns to the safe behaviour on next load.
 */

/** Persisted form. Every field optional; absent means "follow pi's default". */
export interface CompactionConfig {
	reserveTokens?: number;
	keepRecentTokens?: number;
}

/**
 * Lower bound for both token fields.
 *
 * Zero would be accepted by pi and is a coherent instruction — reserve nothing,
 * keep nothing — but it produces a summary request with no output budget and a
 * transcript cut to nothing, which reads as the plugin having eaten the
 * conversation. A floor of one page of tokens keeps the setting inside the range
 * where the outcome is still a conversation.
 */
export const MIN_COMPACTION_TOKENS = 1_024;

/**
 * Share of the window the two token fields may claim between them.
 *
 * They cannot be capped independently, and this is the trap worth spelling out.
 * Compaction fires at `window - reserveTokens` and then retains a tail of up to
 * `keepRecentTokens`, so when `reserve + keep` reaches the window there is a
 * band where pi decides to compact and then finds nothing it is allowed to
 * summarize: `findCutPoint` never reaches its retention budget, cuts at index 0,
 * and returns the entire transcript as the retained tail. The plugin then pays
 * for a summarization request, replaces the transcript with an identical one,
 * and the next prompt does it again — an unbounded loop of billed no-ops.
 *
 * Verified against pi 0.84.3: with an 8k window, `reserve` and `keep` both at
 * 4000, and 4001 tokens of history, `shouldCompact` is true and
 * `prepareCompaction` returns zero messages to summarize. Two fields each capped
 * at half the window reproduce exactly that, which is why the budget is shared
 * rather than per-field.
 */
export const MAX_COMPACTION_FRACTION = 0.6;

/**
 * Resolves the settings pi acts on, clamped against the active model's window.
 *
 * The clamp is applied here rather than in the settings form because the limit
 * depends on the model: a value that is generous on a 1M-token window is
 * self-defeating on 8k, and the user may switch models long after typing it.
 * Storing the typed number and clamping on read keeps their intent intact —
 * moving back to a large model restores the value they chose.
 *
 * The reserve is clamped first and the retention budget gets what is left, so
 * the trigger point is honoured before the tail: a compaction that fires and
 * summarizes a little is a working conversation, while one that fires and
 * summarizes nothing is the loop above.
 */
export function resolveCompactionSettings(config: CompactionConfig | undefined, contextWindow: number): CompactionSettings {
	const window = usableContextWindow(contextWindow);
	const floor = tokenFloor(window);
	// Held strictly below the window, which is what makes progress provable: the
	// retained tail can be at most `budget - reserve`, so `window - reserve`
	// exceeds it for any pair the clamps can produce.
	const budget = Math.min(Math.max(Math.floor(window * MAX_COMPACTION_FRACTION), floor * 2), window - 1);
	const reserveTokens = clamp(config?.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens, floor, budget - floor);
	return {
		// A hard rule, not a setting: compaction must never be disabled, so the
		// `enabled` flag pi reads is pinned on regardless of what an older vault
		// may still carry. The resolver is the one place both the trigger and the
		// meter agree on, which makes this the single point that enforces it.
		enabled: true,
		reserveTokens,
		keepRecentTokens: clamp(config?.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens, floor, budget - reserveTokens),
	};
}

/**
 * Per-field floor for one window.
 *
 * {@link MIN_COMPACTION_TOKENS} is the floor that keeps a summary request
 * well-formed, but on a window smaller than a few thousand tokens it exceeds the
 * window itself — and a floor above the ceiling would leave the two fields
 * summing past what the model can hold. Such a model is not one anybody runs an
 * agent on, so the floor yields to the window rather than the invariant.
 */
function tokenFloor(contextWindow: number): number {
	return Math.min(MIN_COMPACTION_TOKENS, Math.max(Math.floor(contextWindow * 0.1), 1));
}

/**
 * Smallest window the resolver will reason about.
 *
 * Below this the floors and the shared budget cannot all be satisfied at once,
 * and there is no useful answer anyway: a few hundred tokens does not hold a
 * system prompt. Treating a smaller figure as this one keeps the resolved pair
 * coherent instead of producing zeroes.
 */
const MIN_CONTEXT_WINDOW = 512;

/**
 * The window the resolver reasons about, with unusable figures replaced.
 *
 * A model spec with a missing, zero, or absurd window would otherwise resolve
 * the two fields into a degenerate pair. No real model is this small, but the
 * window arrives from provider metadata the plugin does not own, so the
 * invariant is made to hold by construction rather than by assumption.
 */
export function usableContextWindow(contextWindow: number): number {
	if (!Number.isFinite(contextWindow)) {
		return MIN_CONTEXT_WINDOW;
	}
	return Math.max(Math.floor(contextWindow), MIN_CONTEXT_WINDOW);
}

/**
 * Whether the resolved pair can actually make progress.
 *
 * Exported for the test that pins the invariant, and readable as the definition
 * of what {@link resolveCompactionSettings} guarantees: the trigger point has to
 * sit far enough above the retained tail that summarizing has something to do.
 */
export function canMakeProgress(settings: CompactionSettings, contextWindow: number): boolean {
	return usableContextWindow(contextWindow) - settings.reserveTokens > settings.keepRecentTokens;
}

/**
 * Coerces persisted data into a config, dropping anything unusable.
 *
 * A field that fails validation is dropped rather than replaced with the
 * default, so `resolveCompactionSettings` keeps following pi's default for it —
 * the two paths cannot disagree about what "unset" means.
 *
 * The retired `enabled` field is dropped unconditionally: it is read as an
 * unknown key and left out of the rebuilt config, so the next save quietly
 * scrubs it from data.json and an old "compaction off" choice cannot outlive
 * the off switch.
 */
export function normalizeCompactionConfig(data: unknown): CompactionConfig | undefined {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return undefined;
	}
	const raw = data as { enabled?: unknown; reserveTokens?: unknown; keepRecentTokens?: unknown };
	const config: CompactionConfig = {};
	const reserveTokens = readTokenCount(raw.reserveTokens);
	if (reserveTokens !== undefined) {
		config.reserveTokens = reserveTokens;
	}
	const keepRecentTokens = readTokenCount(raw.keepRecentTokens);
	if (keepRecentTokens !== undefined) {
		config.keepRecentTokens = keepRecentTokens;
	}
	// An object whose every field was rejected is indistinguishable from never
	// having been configured, and returning undefined keeps it out of data.json.
	return Object.keys(config).length > 0 ? config : undefined;
}

/**
 * Reads one token field from a form or from disk.
 *
 * Accepts the string a text input produces as well as a number, and applies the
 * floor here so a value typed below it is raised rather than dropped — dropping
 * would silently restore pi's default, which is not what "I typed 200" means.
 */
export function readTokenCount(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number.parseInt(value, 10) : NaN;
	if (!Number.isInteger(parsed) || parsed <= 0) {
		return undefined;
	}
	return Math.max(parsed, MIN_COMPACTION_TOKENS);
}

/** Ceiling wins over floor: a window too small for both must not overflow. */
function clamp(value: number, floor: number, ceiling: number): number {
	return Math.min(Math.max(value, floor), ceiling);
}

export { DEFAULT_COMPACTION_SETTINGS, type CompactionSettings };
