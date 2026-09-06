import { isLanguageSetting } from "../../i18n";
import { isLogLevelSetting } from "../../logging/logLevel";
import { isSendShortcutSetting } from "../keyboard";
import { isCacheRetentionSetting } from "../../net/cacheRetention";
import { isTraceExpandSetting } from "../traceExpand";
import type { NetworkTransport } from "../../net/obsidianFetch";
import { isPromptQueueStrategy } from "../../agent/queueStrategy";
import type { SettingsPanelSettings } from "./panelHost";

/**
 * The settings a declarative `control` may bind to, and how those bindings read
 * and write.
 *
 * Obsidian's `control` definitions name their target with a string key and leave
 * the storage to `getControlValue`/`setControlValue` on the tab. That indirection
 * is the whole reason this module exists: a bare string is not checked against
 * the settings object, so a typo — or a field renamed on one side only — reads
 * as `undefined` and writes into a property nothing else looks at. Neither
 * failure throws. The row renders, the toggle moves, and the setting silently
 * does nothing.
 *
 * So the keys are a closed union checked against {@link SettingsPanelSettings},
 * and the two accessors below are the only place a key becomes a property
 * access. A field renamed in the settings schema then fails to compile here
 * rather than degrading at runtime.
 *
 * Only flat, single-field bindings live here. Nested keys (`compaction.*`) are
 * deliberately absent: Obsidian supports dot-notation through a custom accessor,
 * but the compaction fields also need undefined-pruning — an emptied field has
 * to remove itself so the row falls back to pi's own default rather than
 * freezing a zero — and that is a write rule, not a path lookup. Those rows stay
 * in `render`.
 */

/**
 * The keys a panel row actually binds, listed rather than derived.
 *
 * Deriving from the settings schema would admit every string-or-boolean field in
 * it, which is wider than the truth: `userSkillsDir` is a string, but its row
 * validates on blur and redraws its own group afterwards, so binding it to a
 * plain control would drop both. Listing the keys keeps that decision visible —
 * a field becomes bindable when someone adds it here, which is where a reviewer
 * sees it happen.
 *
 * The `satisfies` clause is what ties the list back to the schema: a key
 * misspelled or renamed on the settings side fails to compile here rather than
 * reading as `undefined` at runtime.
 */
const CONTROL_KEYS = [
	"showAgentDetails",
	"traceExpand",
	"promptQueueStrategy",
	"language",
	"sendShortcut",
	"logLevel",
	"networkTransport",
	"cacheRetention",
	"activeModelId",
] as const satisfies readonly (keyof SettingsPanelSettings)[];

/**
 * Settings a `control` definition can bind to.
 *
 * Every member's stored type matches what a control persists — `toggle` writes a
 * boolean, `dropdown` a string. A key whose value is an array or an object would
 * typecheck at the definition site and corrupt settings at runtime, which is why
 * {@link writeControlValue} narrows each one before assigning.
 */
export type ControlKey = (typeof CONTROL_KEYS)[number];

/** Whether `key` is one of the settings a control may bind to. */
export function isControlKey(key: string): key is ControlKey {
	return (CONTROL_KEYS as readonly string[]).includes(key);
}

/** Reads the stored value a control should render. */
export function readControlValue(settings: SettingsPanelSettings, key: ControlKey): unknown {
	return settings[key];
}

/**
 * Writes a control's new value into settings.
 *
 * Values arrive as `unknown` from the framework, which reads them off a DOM
 * control rather than from typed state, so each key states the shape it accepts
 * and ignores anything else. That guard is not defensive noise: `sendShortcut`
 * and `logLevel` are unions whose stored value is read back by code that assumes
 * membership, and a stray string would reach it as a chord or a threshold nobody
 * handles — for `sendShortcut` that silently disables sending by key.
 *
 * Returns whether the write landed, so a caller can skip persisting a value it
 * rejected.
 */
export function writeControlValue(settings: SettingsPanelSettings, key: ControlKey, value: unknown): boolean {
	switch (key) {
		case "showAgentDetails":
			if (typeof value !== "boolean") return false;
			settings.showAgentDetails = value;
			return true;
		case "traceExpand":
			if (!isTraceExpandSetting(value)) return false;
			settings.traceExpand = value;
			return true;
		case "promptQueueStrategy":
			if (!isPromptQueueStrategy(value)) return false;
			settings.promptQueueStrategy = value;
			return true;
		case "language":
			if (!isLanguageSetting(value)) return false;
			settings.language = value;
			return true;
		case "sendShortcut":
			if (!isSendShortcutSetting(value)) return false;
			settings.sendShortcut = value;
			return true;
		case "logLevel":
			if (!isLogLevelSetting(value)) return false;
			settings.logLevel = value;
			return true;
		case "networkTransport":
			if (!isNetworkTransport(value)) return false;
			settings.networkTransport = value;
			return true;
		case "cacheRetention":
			if (!isCacheRetentionSetting(value)) return false;
			settings.cacheRetention = value;
			return true;
		case "activeModelId":
			if (typeof value !== "string") return false;
			settings.activeModelId = value;
			return true;
		default:
			// Exhaustiveness, not a runtime fallback: a key added to `ControlKey`
			// without a case here fails to compile at this assignment, which is the
			// only way to catch it — a silent `return false` would render the row and
			// drop every change the user made in it.
			return assertNever(key);
	}
}

/** Never called; the annotation is what makes a missing case a compile error. */
function assertNever(key: never): never {
	throw new Error(`unhandled control key: ${String(key)}`);
}

/**
 * Whether `value` is a transport the network layer implements.
 *
 * Local rather than exported from `obsidianFetch`: that module's own reader
 * coerces an unknown value to `requestUrl` instead of rejecting it, which is
 * right for loading a possibly-corrupt vault but wrong here — a dropdown that
 * silently rewrote a value the user picked would be worse than one that ignored
 * the change.
 */
function isNetworkTransport(value: unknown): value is NetworkTransport {
	return value === "requestUrl" || value === "fetch";
}
