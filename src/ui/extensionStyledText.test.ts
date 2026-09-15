import { describe, expect, it } from "bun:test";
import { parseExtensionStyledText, trimEdgeBlankLines } from "./extensionStyledText";
import { plainText } from "../extensions/compat/textMetrics";
import { theme } from "../extensions/compat/theme";

describe("extension styled text decoding", () => {
	it("splits plain runs from palette-sentinel runs by name", () => {
		expect(parseExtensionStyledText("plain")).toEqual([{ text: "plain", color: undefined }]);
		expect(parseExtensionStyledText(`${theme.fg("accent", "热")}的`)).toEqual([
			{ text: "热", color: "accent" },
			{ text: "的", color: undefined },
		]);
		expect(parseExtensionStyledText(`${theme.fg("error", "a")}${theme.fg("warning", "b")}`)).toEqual([
			{ text: "a", color: "error" },
			{ text: "b", color: "warning" },
		]);
		expect(parseExtensionStyledText("")).toEqual([]);
	});

	it("strips every other terminal command while keeping its text", () => {
		const raw = "\x1b[31mRed\x1b[2K\x1b]8;;https://xLink\x1b]8;;Go\x07";
		expect(parseExtensionStyledText(raw)).toEqual([
			{ text: "RedLinkGo", color: undefined },
		]);
		// Tabs and newlines are data; other C0 controls are dropped in place.
		expect(parseExtensionStyledText("a\tb\nc\r\bd")).toEqual([
			{ text: "a\tb\ncd", color: undefined },
		]);
	});

	it("treats out-of-palette sentinel lookalikes as plain text", () => {
		expect(parseExtensionStyledText("\x1b[38;2;0;0;99mdeep\x1b[0m")).toEqual([
			{ text: "deep", color: undefined },
		]);
		expect(parseExtensionStyledText("\x1b[38;2;255;0;0mnot-ours\x1b[0m")).toEqual([
			{ text: "not-ours", color: undefined },
		]);
	});
	it("closes a colored run on non-canonical SGR resets", () => {
		const esc = String.fromCharCode(27);
		expect(parseExtensionStyledText(`${theme.fg("accent", "Red")}${esc}[mEnd`)).toEqual([
			{ text: "Red", color: "accent" },
			{ text: "End", color: undefined },
		]);
		expect(parseExtensionStyledText(`${theme.fg("accent", "Red")}${esc}[0;0mEnd`)).toEqual([
			{ text: "Red", color: "accent" },
			{ text: "End", color: undefined },
		]);
	});

	it("strips C1 CSI sequences with their parameters in both sanitization points", () => {
		const raw = `${String.fromCharCode(155)}[31mRed${String.fromCharCode(27)}[2KTail`;
		expect(plainText(raw)).toBe("RedTail");
		expect(parseExtensionStyledText(raw)).toEqual([{ text: "RedTail", color: undefined }]);
	});
});

describe("extension edge blank trimming", () => {
	it("trims whitespace-only edge lines and keeps interior ones exact", () => {
		expect(trimEdgeBlankLines(["", "  ", "top", "", "mid", "\t", "bottom", " "])).toEqual(["top", "", "mid", "\t", "bottom"]);
		expect(trimEdgeBlankLines([""])).toEqual([]);
		expect(trimEdgeBlankLines([])).toEqual([]);
	});

	it("counts a sentinel-wrapped spacer line as blank", () => {
		expect(trimEdgeBlankLines([theme.fg("dim", "  "), "任务", theme.fg("dim", " ")]))
			.toEqual(["任务"]);
	});
});
