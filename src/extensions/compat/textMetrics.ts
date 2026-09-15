/// <reference lib="es2022.intl" />
import { eastAsianWidth } from "get-east-asian-width";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const invisible = /[\p{Default_Ignorable_Code_Point}\p{Control}\p{Mark}\p{Surrogate}]/u;
const mark = /\p{Mark}/u;
const spacingMark = /\p{Spacing_Mark}/u;
const legacySpacingMark = /[\u065F\u0F7F\u102B\u102C\u1031\u1033-\u1035\u1038\u103A-\u103E]/u;
const emoji = /\p{Emoji_Presentation}|\p{Regional_Indicator}|\uFE0F|\u20E3/u;

/** Strip terminal commands, never interpret their colors, cursor moves or links.
 *  Data callers get pure text; render-path callers pass `styled` so the compat
 *  theme's own palette sentinels (theme.fg output) survive and are decoded by
 *  the host renderer. */
export function plainText(text: string, styled = false): string {
	let result = "";
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code === 27 || code === 155 || code === 157 || code === 159) {
			if (code === 27) {
				if (styled) {
					const escape = paletteSentinel(text, i);
					if (escape > 0) {
						result += text.slice(i, i + escape);
						i += escape - 1;
						continue;
					}
				}
			}
			const type = code === 27 ? text[++i] : code === 155 ? "[" : code === 157 ? "]" : "_";
			if (type === "[") {
				// C1 CSI hands us only the introducer byte; skip it too.
				if (code === 155) i++;
				while (++i < text.length && !(text.charCodeAt(i) >= 64 && text.charCodeAt(i) <= 126)) { /* discard CSI */ }
			} else if (type === "]" || type === "_" || type === "P" || type === "^") {
				while (++i < text.length) {
					if (text.charCodeAt(i) === 7 || text.charCodeAt(i) === 156) break;
					if (text.charCodeAt(i) === 27 && text[i + 1] === "\\") { i++; break; }
				}
			}
			continue;
		}
		if (code === 9 || code === 10 || (code >= 32 && (code < 127 || code > 159))) result += text[i];
	}
	return result;
}

/** The reset half of the sentinel pair, spelled without an escape literal. */
const RESET = String.fromCharCode(27) + "[0m";

/** SGR-zero resets we honor (the theme's own plus the canonical short forms
 *  a raw widget may embed); each must still close an open colored run. */
export function isPaletteReset(text: string, index: number): number {
	if (text[index + 1] !== "[") return 0;
	let end = index + 2;
	while (end < text.length && text[end] !== "m") end++;
	if (end >= text.length) return 0;
	const body = text.slice(index + 2, end);
	return body === "" || body === "0" || body === "0;0" ? end + 1 - index : 0;
}

/** Truecolor sentinels emitted by the compat theme, as their length (0 when
 *  the escape is not one of ours; resets are recognized by isPaletteReset). */
export function paletteSentinel(text: string, index: number): number {
	const reset = isPaletteReset(text, index);
	if (reset > 0) return reset;
	if (text[index + 1] !== "[" || text[index + 2] !== "3" || text[index + 3] !== "8") return 0;
	let end = index + 4;
	while (end < text.length && text[end] !== "m") end++;
	return /^.\[38;2;0;0;\d{1,2}m$/.test(text.slice(index, end + 1)) ? end + 1 - index : 0;
}

function takesMarkColumn(point: string): boolean {
	return legacySpacingMark.test(point) || (spacingMark.test(point) && point !== "\u1734" && point !== "\u302e" && point !== "\u302f");
}

function graphemeWidth(text: string): number {
	if (text === "\t") return 3;
	const points = [...text];
	if (points.every(takesMarkColumn)) return points.length;
	const baseIndex = points.findIndex(point => !invisible.test(point));
	if (baseIndex < 0) return 0;
	if (emoji.test(text)) return 2;
	let width = eastAsianWidth(points[baseIndex]!.codePointAt(0)!);
	let followsMark = false;
	for (const point of points.slice(baseIndex + 1)) {
		if (takesMarkColumn(point)) { width++; followsMark = false; }
		else if (mark.test(point)) followsMark = true;
		else if (!invisible.test(point)) {
			const code = point.codePointAt(0)!;
			if (followsMark || (code >= 0xff00 && code <= 0xffef)) width += eastAsianWidth(code);
			else if (code === 0x0e33 || code === 0x0eb3) width++;
			followsMark = false;
		}
	}
	return width;
}

/** Terminal-column arithmetic is retained for extension layout, never for DOM sizing. */
export function visibleWidth(text: string): number {
	let width = 0;
	for (const { segment } of graphemes.segment(plainText(text))) width += graphemeWidth(segment);
	return width;
}

/** Slices at whole graphemes up to the column budget; palette sentinels ride
 *  along free of charge, exactly as a terminal keeps escape codes through a
 *  truncation. Everything is pre-sanitized, so the only escapes met here are
 *  the palette's own. */
function takeColumns(text: string, width: number): { text: string; width: number } {
	let result = "";
	let used = 0;
	let index = 0;
	// An opener copied before the break stays active; close it so the dropped
	// tail's color never leaks onto whatever follows (e.g. the ellipsis).
	let opened = false;
	outer: while (index < text.length && used < width) {
		if (text.charCodeAt(index) === 27) {
			const sentinel = paletteSentinel(text, index);
			if (sentinel > 0) opened = !isPaletteReset(text, index);
			result += text.slice(index, index + sentinel);
			index += Math.max(sentinel, 1);
			continue;
		}
		let runEnd = index;
		while (runEnd < text.length && text.charCodeAt(runEnd) !== 27) runEnd++;
		for (const { segment } of graphemes.segment(text.slice(index, runEnd))) {
			const next = graphemeWidth(segment);
			if (used + next > width) break outer;
			result += segment;
			used += next;
		}
		index = runEnd;
	}
	if (opened) result += RESET;
	return { text: result, width: used };
}

export function truncateToWidth(text: string, maxWidth: number, ellipsis = "...", pad = false): string {
	const width = Number.isFinite(maxWidth) ? Math.max(0, Math.floor(maxWidth)) : 0;
	const value = plainText(text, true);
	const originalWidth = visibleWidth(value);
	if (originalWidth <= width) return value + (pad ? " ".repeat(width - originalWidth) : "");
	const suffix = takeColumns(plainText(ellipsis), width);
	const prefix = takeColumns(value, width - suffix.width);
	return prefix.text + suffix.text + (pad ? " ".repeat(width - prefix.width - suffix.width) : "");
}

/** Native CSS owns wrapping; fallback text also keeps whole grapheme clusters. */
export function wrapPlainText(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const paragraph of plainText(text).replace(/\t/g, "   ").split("\n")) {
		let line = "";
		let used = 0;
		for (const { segment } of graphemes.segment(paragraph)) {
			const next = graphemeWidth(segment);
			if (line && used + next > width) { lines.push(line); line = ""; used = 0; }
			line += segment;
			used += next;
		}
		lines.push(line);
	}
	return lines;
}
