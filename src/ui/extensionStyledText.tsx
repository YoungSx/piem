import React from "react";
import { EXTENSION_FG_PALETTE } from "../extensions/compat/theme";
import { isPaletteReset, paletteSentinel } from "../extensions/compat/textMetrics";

/**
 * The host-side decoder for the compat theme's palette sentinels, and the one
 * sanitization point for extension text reaching the DOM: known sentinels
 * become styled spans, every other escape or control character is dropped
 * with its text kept. Data stays data here — rendering is the only place that
 * interprets anything.
 */
export interface ExtensionStyledSegment {
	readonly text: string;
	readonly color: (typeof EXTENSION_FG_PALETTE)[number] | undefined;
}

export function parseExtensionStyledText(text: string): ExtensionStyledSegment[] {
	const segments: ExtensionStyledSegment[] = [];
	let buffer = "";
	let color: ExtensionStyledSegment["color"];
	const flush = (): void => {
		if (buffer) segments.push({ text: buffer, color });
		buffer = "";
	};
	for (let index = 0; index < text.length;) {
		const code = text.charCodeAt(index);
		if (code === 27 || code === 155 || code === 157 || code === 159) {
			// The palette's own truecolor pair (see paletteSentinel): the opener
			// starts a colored run, any SGR-zero reset closes it; anything else
			// is dropped as an unknown escape below.
			const reset = isPaletteReset(text, index);
			if (reset > 0) { flush(); color = undefined; index += reset; continue; }
			const sentinel = code === 27 || code === 155 ? paletteSentinel(text, index) : 0;
			if (sentinel > 0) {
				const name = EXTENSION_FG_PALETTE[Number(text.slice(index + 11, index + sentinel - 1))];
				if (name) { flush(); color = name; index += sentinel; continue; }
			}
			// Unknown escape: drop the sequence itself (CSI to its final byte,
			// OSC-style strings through their terminator, else just the ESC).
			const introducer = code === 27 || code === 155 ? text[index + 1]
				: code === 157 ? "]" : "_";
			if (introducer === "[") {
				let end = index + 2;
				while (end < text.length && !(text.charCodeAt(end) >= 64 && text.charCodeAt(end) <= 126)) end++;
				index = Math.min(end + 1, text.length);
				continue;
			}
			if (introducer === "]" || introducer === "_" || introducer === "P" || introducer === "^") {
				let end = index + 2;
				while (end < text.length) {
					const code = text.charCodeAt(end);
					if (code === 7 || code === 156) { end++; break; }
					if (code === 27 && text[end + 1] === "\\") { end += 2; break; }
					end++;
				}
				index = Math.min(end, text.length);
				continue;
			}
			index++;
			continue;
		}
		if ((code < 32 && code !== 9 && code !== 10) || (code >= 127 && code < 160)) {
			index++;
			continue;
		}
		buffer += text[index++];
	}
	flush();
	return segments;
}

/**
 * Drops whitespace-only lines at the widget's edges, never interior ones.
 *
 * Terminal widgets separate themselves from their neighbours with leading and
 * trailing spacer rows; here the host already spaces surfaces with margins and
 * padding, so rendering the spacers charges the same separation twice. The
 * trim reads shape alone — any extension's spacers, no extension's identity.
 */
export function trimEdgeBlankLines(lines: readonly string[]): string[] {
	let start = 0;
	let end = lines.length;
	// Blank by visible shape: sentinels and unknown escapes carry no columns,
	// so a spacer line wearing color is as blank as its bare twin.
	const blank = (line: string): boolean =>
		parseExtensionStyledText(line).every((segment) => /^\s*$/.test(segment.text));
	while (start < end && blank(lines[start]!)) start++;
	while (end > start && blank(lines[end - 1]!)) end--;
	return lines.slice(start, end);
}

/** Decoded widget text: plain runs stay literal, palette runs get their classes. */
export function ExtensionStyledText({ text }: { text: string }): React.JSX.Element | null {
	const segments = parseExtensionStyledText(text);
	if (segments.length === 0) return null;
	return <>
		{segments.map((segment, index) => segment.color
			? <span key={index} className={`piem-ext-fg-${segment.color}`}>{segment.text}</span>
			: <React.Fragment key={index}>{segment.text}</React.Fragment>)}
	</>;
}
