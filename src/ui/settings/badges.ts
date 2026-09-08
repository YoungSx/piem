import type { Setting, SettingGroup } from "obsidian";
import type { Translator } from "../../i18n";
import type { SkillSource } from "../../agent/skillLoader";
import type { McpServerState } from "../../mcp/mcpManager";
import { countSkills, type UserSkillsDirReading } from "./userSkillsCopy";

export type BadgeTone = "ok" | "connecting" | "error" | "warn" | "untested" | "disabled" | "neutral";

export interface SettingBadge {
	label: string;
	tone: BadgeTone;
}

export const BADGE_CLASS = "piem-badge";

/** Scope wrapping to these rows without depending on CSS :has() support. */
export function appendSettingBadge(setting: Setting, badge: SettingBadge): HTMLElement {
	setting.setClass("piem-settings-badged-row");
	return appendBadge(setting.nameEl, badge);
}

/** Keep the name and badge independently wrappable, without changing the search name. */
export function appendBadge(nameEl: HTMLElement, badge: SettingBadge): HTMLElement {
	const existing = nameEl.querySelector<HTMLElement>(`:scope > .${BADGE_CLASS}`);
	if (existing) {
		setBadge(existing, badge);
		return existing;
	}
	const children = Array.from(nameEl.childNodes);
	const label = nameEl.createSpan({ cls: "piem-badged-name__label" });
	label.append(...children);
	nameEl.classList.add("piem-badged-name");
	const el = nameEl.createSpan();
	setBadge(el, badge);
	return el;
}

export function setBadge(el: HTMLElement, badge: SettingBadge): void {
	el.className = `${BADGE_CLASS} ${BADGE_CLASS}--${badge.tone}`;
	el.textContent = badge.label;
}

/** SettingGroup exposes a fragment setter; no access to its private heading DOM. */
export function setGroupHeadingBadge(group: SettingGroup, heading: string, badge?: SettingBadge): void {
	if (!badge) {
		group.setHeading(heading);
		return;
	}
	const fragment = createFragment();
	const title = fragment.createSpan({ text: heading });
	appendBadge(title, badge);
	group.setHeading(fragment);
}

export function describeMcpBadge(state: McpServerState, t: Translator): SettingBadge {
	if (!state.enabled) {
		return { label: t.t("badges.disabled"), tone: "disabled" };
	}
	if (state.status === "ok") {
		return { label: state.toolCount === 1 ? t.t("badges.mcpOkOne") : t.t("badges.mcpOkMany", { tools: state.toolCount }), tone: "ok" };
	}
	if (state.status === "error") {
		return { label: t.t("badges.mcpError"), tone: "error" };
	}
	return { label: t.t("badges.mcpPending"), tone: "untested" };
}

// Connecting exists only while a row's save or retry is pending.
export function mcpPendingBadge(t: Translator): SettingBadge {
	return { label: t.t("badges.mcpConnecting"), tone: "connecting" };
}

/**
 * The layer a skill row came from, as a single neutral badge.
 *
 * One badge per row rather than per-file provenance because the unified list
 * mixes all three layers and a reader scanning for "which of these can I
 * touch" reads the badge first; the file-level distinctions (imported vs.
 * hand-written vs. single note) remain in the data (`SkillRow.provenance`)
 * and drive the row's Update/Delete affordances instead of the badge.
 */
export function skillSourceBadge(source: SkillSource, t: Translator): SettingBadge {
	return {
		label: t.t(source === "builtin" ? "badges.builtin" : source === "user" ? "badges.user" : "badges.vault"),
		tone: "neutral",
	};
}

export function searchedReadingBadge(reading: UserSkillsDirReading, t: Translator): SettingBadge {
	// An unreadable folder has not been confirmed absent.
	if (reading.found === undefined) {
		return { label: t.t("badges.unknown"), tone: "warn" };
	}
	if (!reading.found) {
		return { label: t.t("badges.missing"), tone: "untested" };
	}
	if (reading.loaded === 0) {
		return { label: t.t("badges.empty"), tone: "untested" };
	}
	return { label: countSkills(reading.loaded, t), tone: "neutral" };
}

export function problemCountBadge(count: number, t: Translator): SettingBadge | undefined {
	return count === 0 ? undefined : {
		label: count === 1 ? t.t("badges.problemOne") : t.t("badges.problemMany", { count }),
		tone: "warn",
	};
}
