import { describe, expect, it } from "bun:test";
import { isControlKey, readControlValue, writeControlValue } from "./controlKeys";
import type { SettingsPanelSettings } from "./panelHost";

/**
 * The guard between a declarative `control` and the settings object.
 *
 * Obsidian names a control's target with a bare string and hands the new value
 * back as `unknown`, so both directions can fail silently: an unrecognized key
 * writes into a property nothing reads, and an unexpected value type lands in a
 * union-typed setting that later code assumes is a member. Neither throws. The
 * row renders, the control moves, and the setting quietly does nothing — or
 * worse, `sendShortcut` holds a chord `isSendShortcut` does not recognize and
 * sending by key stops working.
 *
 * So the assertions here are about refusal: what is rejected, and that a
 * rejection leaves the stored value alone.
 */

function settings(overrides: Partial<SettingsPanelSettings> = {}): SettingsPanelSettings {
	return {
		providers: [],
		models: [],
		networkTransport: "requestUrl",
		cacheRetention: "long",
		showAgentDetails: false,
		traceExpand: "collapsed",
		promptQueueStrategy: "afterRun",
		sendShortcut: "enter",
		language: "en",
		sessionRetention: 0,
		sessionDir: "piem/chats",
		userSkillsDir: "",
		disabledSkills: [],
		mcpServers: [],
		logLevel: "info",
		...overrides,
	};
}

describe("isControlKey", () => {
	it("admits the keys panel rows bind", () => {
		expect(isControlKey("showAgentDetails")).toBe(true);
		expect(isControlKey("language")).toBe(true);
		expect(isControlKey("networkTransport")).toBe(true);
	});

	it("refuses a setting whose row owns its own write rules", () => {
		// Both are strings in the schema, so a type-derived key list would have let
		// them through: `userSkillsDir` validates on blur and redraws its group,
		// `sessionDir` normalizes what was typed and reports the change in place.
		// A plain control would drop all of that.
		expect(isControlKey("userSkillsDir")).toBe(false);
		expect(isControlKey("sessionDir")).toBe(false);
	});

	it("refuses a key that is not a setting at all", () => {
		expect(isControlKey("showAgentDetail")).toBe(false);
		expect(isControlKey("")).toBe(false);
	});
});

describe("readControlValue", () => {
	it("reads the stored value a row should render", () => {
		expect(readControlValue(settings({ showAgentDetails: true }), "showAgentDetails")).toBe(true);
		expect(readControlValue(settings({ logLevel: "debug" }), "logLevel")).toBe("debug");
	});

	it("reads undefined for a setting with no stored value", () => {
		// The active model is genuinely absent until one is configured, and the
		// dropdown has to render that state rather than a stale id.
		expect(readControlValue(settings(), "activeModelId")).toBeUndefined();
	});
});

describe("writeControlValue", () => {
	it("writes a value of the expected type and reports the write landed", () => {
		const stored = settings();

		expect(writeControlValue(stored, "showAgentDetails", true)).toBe(true);
		expect(stored.showAgentDetails).toBe(true);
	});

	it("refuses a value of the wrong type without touching what is stored", () => {
		const stored = settings({ showAgentDetails: true });

		// A DOM control should never produce this, which is the point: the guard is
		// for the case where one does.
		expect(writeControlValue(stored, "showAgentDetails", "yes")).toBe(false);
		expect(stored.showAgentDetails).toBe(true);
	});

	it("refuses a string that is not a member of a union-typed setting", () => {
		const stored = settings({ sendShortcut: "enter" });

		// The failure this prevents is silent: `resolveSendShortcut` reads the stored
		// value expecting a chord it knows, so an unrecognized one disables sending
		// by key with nothing on screen to say why.
		expect(writeControlValue(stored, "sendShortcut", "ctrlK")).toBe(false);
		expect(stored.sendShortcut).toBe("enter");

		expect(writeControlValue(stored, "sendShortcut", "modEnter")).toBe(true);
		expect(stored.sendShortcut).toBe("modEnter");
	});

	it("refuses a log threshold outside the set the logger handles", () => {
		const stored = settings({ logLevel: "info" });

		expect(writeControlValue(stored, "logLevel", "verbose")).toBe(false);
		expect(stored.logLevel).toBe("info");

		expect(writeControlValue(stored, "logLevel", "off")).toBe(true);
		expect(stored.logLevel).toBe("off");
	});

	it("refuses a transport the network layer does not implement", () => {
		const stored = settings({ networkTransport: "requestUrl" });

		// Deliberately stricter than `obsidianFetch`'s own reader, which coerces an
		// unknown value to `requestUrl`. Coercing here would rewrite a choice the
		// user just made.
		expect(writeControlValue(stored, "networkTransport", "xhr")).toBe(false);
		expect(stored.networkTransport).toBe("requestUrl");

		expect(writeControlValue(stored, "networkTransport", "fetch")).toBe(true);
		expect(stored.networkTransport).toBe("fetch");
	});

	it("writes a retention level pi accepts, and refuses one it does not", () => {
		const stored = settings({ cacheRetention: "long" });

		// The rejected value is the API's own wire form, which is exactly the sort of
		// thing that would be typed in by hand: pi's option is "long", and "1h" is
		// what the provider receives.
		expect(writeControlValue(stored, "cacheRetention", "1h")).toBe(false);
		expect(stored.cacheRetention).toBe("long");

		expect(writeControlValue(stored, "cacheRetention", "short")).toBe(true);
		expect(stored.cacheRetention).toBe("short");

		expect(writeControlValue(stored, "cacheRetention", "none")).toBe(true);
		expect(stored.cacheRetention).toBe("none");
	});

	it("writes a trace-expand mode the panel renders, and refuses one it does not", () => {
		const stored = settings({ traceExpand: "collapsed" });

		expect(writeControlValue(stored, "traceExpand", "highValue")).toBe(true);
		expect(stored.traceExpand).toBe("highValue");

		expect(writeControlValue(stored, "traceExpand", "expanded")).toBe(true);
		expect(stored.traceExpand).toBe("expanded");

		expect(writeControlValue(stored, "traceExpand", "open")).toBe(false);
		expect(stored.traceExpand).toBe("expanded");
	});

	it("refuses a language outside the shipped set", () => {
		const stored = settings({ language: "en" });

		expect(writeControlValue(stored, "language", "fr")).toBe(false);
		expect(stored.language).toBe("en");

		expect(writeControlValue(stored, "language", "auto")).toBe(true);
		expect(stored.language).toBe("auto");
	});
});
