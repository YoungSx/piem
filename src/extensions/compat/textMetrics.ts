/// <reference lib="es2022.intl" />
import { eastAsianWidth } from "get-east-asian-width";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const invisible = /[\p{Default_Ignorable_Code_Point}\p{Control}\p{Mark}\p{Surrogate}]/u;
const mark = /\p{Mark}/u;
const spacingMark = /\p{Spacing_Mark}/u;
const legacySpacingMark = /[\u065F\u0F7F\u102B\u102C\u1031\u1033-\u1035\u1038\u103A-\u103E]/u;
const emoji = /\p{Emoji_Presentation}|\p{Regional_Indicator}|\uFE0F|\u20E3/u;

/** Strip terminal commands, never interpret their colors, cursor moves or links. */
export function plainText(text: string): string {
	let result = "";
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code === 27 || code === 155 || code === 157 || code === 159) {
			const type = code === 27 ? text[++i] : code === 155 ? "[" : code === 157 ? "]" : "_";
			if (type === "[") {
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

function takeColumns(text: string, width: number): { text: string; width: number } {
	let result = "";
	let used = 0;
	for (const { segment } of graphemes.segment(text)) {
		const next = graphemeWidth(segment);
		if (used + next > width) break;
		result += segment;
		used += next;
	}
	return { text: result, width: used };
}

export function truncateToWidth(text: string, maxWidth: number, ellipsis = "...", pad = false): string {
	const width = Number.isFinite(maxWidth) ? Math.max(0, Math.floor(maxWidth)) : 0;
	const value = plainText(text);
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
