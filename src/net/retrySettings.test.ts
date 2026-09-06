import { describe, expect, it } from "bun:test";
import {
	DEFAULT_RETRY_SETTINGS,
	MAX_RETRY_ATTEMPTS,
	MAX_RETRY_BASE_DELAY_MS,
	MIN_RETRY_BASE_DELAY_MS,
	normalizeRetryConfig,
	readRetryAttempts,
	readRetryDelay,
	resolveRetrySettings,
} from "./retrySettings";

/*
 * The two readers and the resolver are the whole contract the settings form and
 * the request defaults both lean on: "unset means default" and "0 means off"
 * have to hold identically whichever path reads them, so the tests pin the
 * edges — an emptied field, a mistyped one, and the clamps — rather than the
 * happy middle.
 */

describe("resolveRetrySettings", () => {
	it("returns pi's defaults when nothing is configured", () => {
		expect(resolveRetrySettings(undefined)).toEqual(DEFAULT_RETRY_SETTINGS);
	});

	it("fills each field independently, so one configured dial leaves the other on the default", () => {
		expect(resolveRetrySettings({ maxRetries: 4 })).toEqual({ maxRetries: 4, baseDelayMs: DEFAULT_RETRY_SETTINGS.baseDelayMs });
		expect(resolveRetrySettings({ baseDelayMs: 500 })).toEqual({ maxRetries: DEFAULT_RETRY_SETTINGS.maxRetries, baseDelayMs: 500 });
	});

	it("clamps out-of-range values into range rather than passing them through", () => {
		expect(resolveRetrySettings({ maxRetries: 99 }).maxRetries).toBe(MAX_RETRY_ATTEMPTS);
		expect(resolveRetrySettings({ baseDelayMs: 1 }).baseDelayMs).toBe(MIN_RETRY_BASE_DELAY_MS);
		expect(resolveRetrySettings({ baseDelayMs: 999_999 }).baseDelayMs).toBe(MAX_RETRY_BASE_DELAY_MS);
	});

	it("keeps zero as a real answer — the off switch — rather than snapping it to the default", () => {
		expect(resolveRetrySettings({ maxRetries: 0 }).maxRetries).toBe(0);
	});
});

describe("readRetryAttempts", () => {
	it("accepts the string a text input produces", () => {
		expect(readRetryAttempts("3")).toBe(3);
	});

	it("reads 0 as off rather than as unset", () => {
		expect(readRetryAttempts(0)).toBe(0);
		expect(readRetryAttempts("0")).toBe(0);
	});

	it("rejects a half-typed or cleared field, which means follow the default", () => {
		expect(readRetryAttempts("")).toBeUndefined();
		expect(readRetryAttempts("  ")).toBeUndefined();
		expect(readRetryAttempts("1.5")).toBeUndefined();
		expect(readRetryAttempts("-2")).toBeUndefined();
		expect(readRetryAttempts("abc")).toBeUndefined();
		expect(readRetryAttempts(undefined)).toBeUndefined();
	});
});

describe("readRetryDelay", () => {
	it("accepts the string a text input produces", () => {
		expect(readRetryDelay("750")).toBe(750);
	});

	it("rejects zero — a zero-delay retry is a misstroke, not a setting", () => {
		expect(readRetryDelay(0)).toBeUndefined();
		expect(readRetryDelay("0")).toBeUndefined();
	});

	it("rejects junk the same way the attempts reader does", () => {
		expect(readRetryDelay("")).toBeUndefined();
		expect(readRetryDelay("12.5")).toBeUndefined();
		expect(readRetryDelay("soon")).toBeUndefined();
	});
});

describe("normalizeRetryConfig", () => {
	it("drops everything unusable so the persisted form only holds real settings", () => {
		expect(normalizeRetryConfig({ maxRetries: "nope", baseDelayMs: 0 })).toBeUndefined();
		expect(normalizeRetryConfig(null)).toBeUndefined();
		expect(normalizeRetryConfig("retry")).toBeUndefined();
		expect(normalizeRetryConfig([1, 2])).toBeUndefined();
	});

	it("clamps into the stored range, so data.json never holds a value the form would have to trim", () => {
		expect(normalizeRetryConfig({ maxRetries: 50 })).toEqual({ maxRetries: MAX_RETRY_ATTEMPTS });
		expect(normalizeRetryConfig({ baseDelayMs: 5 })).toEqual({ baseDelayMs: MIN_RETRY_BASE_DELAY_MS });
		expect(normalizeRetryConfig({ baseDelayMs: 50_000 })).toEqual({ baseDelayMs: MAX_RETRY_BASE_DELAY_MS });
	});

	it("keeps a real config and fills nothing in", () => {
		expect(normalizeRetryConfig({ maxRetries: 1, baseDelayMs: 2_000 })).toEqual({ maxRetries: 1, baseDelayMs: 2_000 });
	});
});
