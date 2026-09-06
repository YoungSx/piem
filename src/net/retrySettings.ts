/**
 * The retry configuration, as the user can set it.
 *
 * Its own module rather than a field buried in `settings.ts` for the same reason
 * compaction's is: two unrelated paths consume it. {@link resolveRetrySettings}
 * feeds both the per-request budget (`StreamOptions.maxRetries`, reached through
 * {@link ./streamFn}) and the turn-level wrapper ({@link ./streamRetry}), and a
 * panel that writes while one reader disagrees with the other would retry one
 * path and not the other.
 *
 * Stored as a partial, like compaction: a vault that has never opened the
 * advanced group holds nothing, and every field keeps following the plugin's
 * default rather than freezing whatever shipped that install.
 *
 * There is no `enabled` switch, unlike compaction's story: `maxRetries: 0` *is*
 * the off switch, and the turn wrapper reads the same number, so one dial turns
 * both layers off together. An `enabled` flag would offer a second way to
 * disable one layer and silently not the other.
 */

/** Persisted form. Every field optional; absent means "follow the default". */
export interface RetryConfig {
	maxRetries?: number;
	baseDelayMs?: number;
}

/**
 * How many retries a transient failure earns.
 *
 * Kept small on purpose. Each retry re-bills the full prompt — these are
 * long-context conversations, not API smoke tests — so a failure that survived
 * five tries is not going to survive the sixth for a reason the plugin can fix.
 * Zero disables both layers: nothing retries, everything surfaces as the
 * failed message the plugin showed before this existed.
 */
export const MAX_RETRY_ATTEMPTS = 5;

/** Floor for the base backoff delay, in milliseconds. */
export const MIN_RETRY_BASE_DELAY_MS = 250;

/**
 * Ceiling for the base backoff delay, in milliseconds.
 *
 * The backoff grows exponentially, so this is the smallest quick step, not the
 * longest wait: at the default base the sixth step is already 32× it. Values
 * beyond this make every retry sluggish without ever matching what a provider's
 * `retry-after` header asks for anyway — the request layer honours that header
 * directly, and the turn layer caps each wait separately.
 */
export const MAX_RETRY_BASE_DELAY_MS = 10_000;

/**
 * The settings the plugin acts on, with every unset field at its default.
 *
 * Clamping is applied here rather than in the settings form, the opposite of
 * compaction's choice, and the difference is the reason: compaction's limits
 * depend on the active model's window, so the typed value has to survive a
 * model switch. A retry budget is absolute — 6 retries means the same thing on
 * every model — so there is no context to preserve by storing the raw number,
 * and clamping at normalize time means what sits in data.json is always inside
 * the range the settings form shows.
 */
export function resolveRetrySettings(config: RetryConfig | undefined): ResolvedRetrySettings {
	return {
		// The turn wrapper and the request layer reach this budget through
		// different code and must agree on the ceiling; naming it once here keeps
		// the two from drifting.
		maxRetries: clampInt(config?.maxRetries ?? DEFAULT_RETRY_SETTINGS.maxRetries, 0, MAX_RETRY_ATTEMPTS),
		baseDelayMs: clampInt(config?.baseDelayMs ?? DEFAULT_RETRY_SETTINGS.baseDelayMs, MIN_RETRY_BASE_DELAY_MS, MAX_RETRY_BASE_DELAY_MS),
	};
}

/** Fully-resolved retry settings: every field present, every value in range. */
export interface ResolvedRetrySettings {
	maxRetries: number;
	baseDelayMs: number;
}

/**
 * Defaults for both layers, aligned with pi's own compaction retry policy.
 *
 * `{2, 1000}` is what pi judged reasonable for the same class of failures on
 * the same providers, and the defaults the plugin ships should not disagree
 * with the default the library already picked without a reason.
 */
export const DEFAULT_RETRY_SETTINGS = { maxRetries: 2, baseDelayMs: 1_000 };

/**
 * Coerces persisted data into a config, dropping anything unusable.
 *
 * Unlike compaction, the range clamp lands here rather than in the resolver:
 * see {@link resolveRetrySettings} for why. A badly typed value is still
 * dropped rather than clamped, so `resolveRetrySettings` keeps following the
 * default for it — the two paths cannot disagree about what "unset" means.
 */
export function normalizeRetryConfig(data: unknown): RetryConfig | undefined {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return undefined;
	}
	const raw = data as { maxRetries?: unknown; baseDelayMs?: unknown };
	const config: RetryConfig = {};
	const maxRetries = readRetryAttempts(raw.maxRetries);
	if (maxRetries !== undefined) {
		// Stored already clamped, so what data.json holds always matches the
		// field's stated range instead of holding a value the form would have to
		// silently trim on read.
		config.maxRetries = Math.min(maxRetries, MAX_RETRY_ATTEMPTS);
	}
	const baseDelayMs = readRetryDelay(raw.baseDelayMs);
	if (baseDelayMs !== undefined) {
		config.baseDelayMs = Math.min(Math.max(baseDelayMs, MIN_RETRY_BASE_DELAY_MS), MAX_RETRY_BASE_DELAY_MS);
	}
	// An object whose every field was rejected is indistinguishable from never
	// having been configured; undefined keeps it out of data.json.
	return Object.keys(config).length > 0 ? config : undefined;
}

/**
 * Reads the attempt budget from a form or from disk, with 0 meaning "off".
 *
 * Accepts the string a text input produces as well as a number. Unlike the
 * delay field, zero is a real answer here — it disables retrying — so the
 * validity test is `>= 0` rather than `> 0`.
 */
export function readRetryAttempts(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
	// `Number` over `parseInt`: a half-typed field ("1.5") is a draft, not an
	// answer — truncating it to 1 would persist a value the user never entered.
	if (!Number.isInteger(parsed) || parsed < 0) {
		return undefined;
	}
	return parsed;
}

/**
 * Reads the base delay from a form or from disk.
 *
 * Clamped in the same pass rather than on read ({@link resolveRetrySettings}
 * explains why the two modules differ): the range is absolute, so a value below
 * the floor is raised here and the stored number is always the truth.
 */
export function readRetryDelay(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
	// Same reason as {@link readRetryAttempts}: half-typed drafts are drafts.
	if (!Number.isInteger(parsed) || parsed <= 0) {
		return undefined;
	}
	return parsed;
}

/** Ceiling wins over floor; the ceiling is a constant, so no window argument. */
function clampInt(value: number, floor: number, ceiling: number): number {
	return Math.min(Math.max(value, floor), ceiling);
}
