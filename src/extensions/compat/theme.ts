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
	"thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax", "bashMode", "scrollbarThumb",
]);
const backgrounds = new Set<ThemeBg>([
	"selectedBg", "searchMatchBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg",
]);
const identity = (text: string): string => text;

/**
 * Theme colors the host renderer styles, in emission order. Each becomes a
 * truecolor sentinel with the palette index in the blue channel; the renderer
 * maps it to an Obsidian color token and strips unknown escapes untouched.
 * black-on-black values no real theme picks, so a genuine collision is
 * effectively unconstructable.
 */
export const EXTENSION_FG_PALETTE = Object.freeze(["accent", "dim", "muted", "success", "error", "warning"] as const);
const paletteIndex = new Map<string, number>(EXTENSION_FG_PALETTE.map((name, index) => [name, index]));

export type CompatTheme = Pick<Theme, "name" | "fg" | "bg" | "bold" | "italic" | "underline" | "inverse" | "strikethrough" | "getThinkingBorderColor" | "getBashModeBorderColor">;

/**
 * Pi formatters return plain strings here, except for the styled palette:
 * those emit sentinels (see EXTENSION_FG_PALETTE) that survive column
 * arithmetic and are decoded by the host renderer into real colors. Native
 * controls inherit Obsidian's theme; other terminal colors/emphasis are not
 * encoded as HTML, ANSI or guessed text markers.
 */
export const theme: CompatTheme = new Proxy(Object.freeze({
	name: "obsidian",
	fg: (color: ThemeColor, text: string): string => {
		if (!colors.has(color)) return unavailable(`theme color ${color}`);
		const index = paletteIndex.get(color);
		if (index === undefined || text === "") return text;
		return `\x1b[38;2;0;0;${index}m${text}\x1b[0m`;
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
