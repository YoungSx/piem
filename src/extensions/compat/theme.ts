import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { SelectListTheme } from "@earendil-works/pi-tui";
import { unavailable } from "../node/unavailable";

type ThemeBg = Parameters<Theme["bg"]>[0];

const colors = new Set<ThemeColor>([
	"accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text",
	"thinkingText", "searchMatchText", "userMessageText", "customMessageText", "customMessageLabel", "toolTitle", "toolOutput",
	"mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet",
	"toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable",
	"syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation", "thinkingOff", "thinkingMinimal",
	"thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax", "bashMode",
]);
const backgrounds = new Set<ThemeBg>([
	"selectedBg", "scrollbarThumb", "searchMatchBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg",
]);
const identity = (text: string): string => text;

export type CompatTheme = Pick<Theme, "name" | "fg" | "bg" | "bold" | "italic" | "underline" | "inverse" | "strikethrough" | "getThinkingBorderColor" | "getBashModeBorderColor">;

/**
 * Pi formatters return plain strings here. Native controls inherit Obsidian's theme;
 * terminal colors/emphasis are not encoded as HTML, ANSI or guessed text markers.
 */
export const theme: CompatTheme = new Proxy(Object.freeze({
	name: "obsidian",
	fg: (color: ThemeColor, text: string): string => {
		if (!colors.has(color)) return unavailable(`theme color ${color}`);
		return text;
	},
	bg: (color: ThemeBg, text: string): string => {
		if (!backgrounds.has(color)) return unavailable(`theme background ${color}`);
		return text;
	},
	bold: identity, italic: identity, underline: identity, inverse: identity, strikethrough: identity,
	getThinkingBorderColor: (level: Parameters<Theme["getThinkingBorderColor"]>[0]): ((text: string) => string) => {
		if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) return unavailable(`thinking border ${level}`);
		return identity;
	},
	getBashModeBorderColor: (): ((text: string) => string) => identity,
}), {
	get(target, name, receiver): unknown {
		if (Object.prototype.hasOwnProperty.call(target, name)) return Reflect.get(target, name, receiver);
		return unavailable(`terminal theme.${String(name)}`);
	},
});

export function getSelectListTheme(): SelectListTheme {
	return { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity };
}
