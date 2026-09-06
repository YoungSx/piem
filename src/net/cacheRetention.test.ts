import { describe, expect, it } from "bun:test";
import { DEFAULT_CACHE_RETENTION, isCacheRetentionSetting, readCacheRetention } from "./cacheRetention";

/**
 * The value here reaches a paid API as a pricing decision, so these pin the two
 * things that cost money when they slip: that the default is the one the
 * arithmetic in the module header argues for, and that a stored value nobody
 * validated cannot become a retention nobody chose.
 */

describe("isCacheRetentionSetting", () => {
	it("accepts the three levels pi's StreamOptions define", () => {
		expect(isCacheRetentionSetting("none")).toBe(true);
		expect(isCacheRetentionSetting("short")).toBe(true);
		expect(isCacheRetentionSetting("long")).toBe(true);
	});

	it("rejects anything else, so a hand-edited data.json cannot reach a provider request", () => {
		expect(isCacheRetentionSetting("1h")).toBe(false);
		expect(isCacheRetentionSetting("forever")).toBe(false);
		expect(isCacheRetentionSetting("")).toBe(false);
		expect(isCacheRetentionSetting(true)).toBe(false);
		expect(isCacheRetentionSetting(undefined)).toBe(false);
		expect(isCacheRetentionSetting(null)).toBe(false);
	});
});

describe("DEFAULT_CACHE_RETENTION", () => {
	it("is the hour-long cache, not pi's five-minute default", () => {
		// Not a restatement of the constant: pi's own default is "short", and an
		// Obsidian reader's turns are minutes apart, so inheriting it would
		// re-bill the whole resident prompt as a fresh cache write every turn.
		expect(DEFAULT_CACHE_RETENTION).toBe("long");
	});
});

describe("readCacheRetention", () => {
	it("keeps a stored preference", () => {
		expect(readCacheRetention("none")).toBe("none");
		expect(readCacheRetention("short")).toBe("short");
		expect(readCacheRetention("long")).toBe("long");
	});

	it("falls back to the default for a vault that never stored the field", () => {
		expect(readCacheRetention(undefined)).toBe(DEFAULT_CACHE_RETENTION);
	});

	it("repairs a corrupted value instead of passing it to a provider", () => {
		expect(readCacheRetention("LONG")).toBe(DEFAULT_CACHE_RETENTION);
		expect(readCacheRetention(3600)).toBe(DEFAULT_CACHE_RETENTION);
		expect(readCacheRetention({})).toBe(DEFAULT_CACHE_RETENTION);
	});
});
