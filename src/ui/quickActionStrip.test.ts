import { describe, expect, it } from "bun:test";
import { STRIP_EDGE_EPSILON, WHEEL_LINE_HEIGHT, stripEdges, wheelStep, type StripEdges } from "./quickActionStrip";

const FLUSH: StripEdges = { left: false, right: false };
const BOTH: StripEdges = { left: true, right: true };
const LEFT_ONLY: StripEdges = { left: true, right: false };
const RIGHT_ONLY: StripEdges = { left: false, right: true };

describe("stripEdges", () => {
	it("fades neither side when nothing overflows", () => {
		expect(stripEdges(0, 300, 300)).toEqual(FLUSH);
		expect(stripEdges(0, 300, 299)).toEqual(FLUSH);
	});

	it("ignores a sliver of overflow a sub-pixel remainder left behind", () => {
		// Rounding can leave hidden width inside the epsilon that no scroll can
		// ever clear; a permanent one-sided fade pinned by it is worse than none.
		expect(STRIP_EDGE_EPSILON).toBe(1);
		expect(stripEdges(0, 300, 300 + STRIP_EDGE_EPSILON)).toEqual(FLUSH);
	});

	it("fades only the trailing side at either end of the scroll", () => {
		const hidden = 100;
		expect(stripEdges(0, 300, 300 + hidden)).toEqual(RIGHT_ONLY);
		expect(stripEdges(hidden, 300, 300 + hidden)).toEqual(LEFT_ONLY);
	});

	it("fades both sides in the middle of the scroll", () => {
		expect(stripEdges(50, 300, 400)).toEqual(BOTH);
	});

	it("stops fading a side once its remaining hidden width is spent", () => {
		const hidden = 100;
		expect(stripEdges(hidden - 2, 300, 300 + hidden)).toEqual(BOTH);
		// A remainder the epsilon no longer clears counts as flush — including
		// one that arrived exactly at the boundary.
		expect(stripEdges(hidden - STRIP_EDGE_EPSILON, 300, 300 + hidden)).toEqual(LEFT_ONLY);
		expect(stripEdges(hidden, 300, 300 + hidden)).toEqual(LEFT_ONLY);
	});

	it("reads a negative scrollLeft as distance travelled, for RTL", () => {
		// Chromium and WebKit report RTL scrollLeft as a negative distance from
		// the right edge; the question is how far along, not which way signed.
		const hidden = 100;
		expect(stripEdges(-hidden, 300, 300 + hidden)).toEqual(LEFT_ONLY);
		expect(stripEdges(-50, 300, 300 + hidden)).toEqual(BOTH);
	});
});

describe("wheelStep", () => {
	it("passes a dominant horizontal delta through to native scrolling", () => {
		// A trackpad's sideways swipe or shift+wheel already means exactly what
		// the browser will do with it; converting it would double-step.
		expect(wheelStep(-40, 0, 0, BOTH)).toBeNull();
		expect(wheelStep(40, 0, 0, BOTH)).toBeNull();
		expect(wheelStep(30, -30, 0, BOTH)).toBeNull();
	});

	it("converts a vertical notch into a sideways step while that direction hides content", () => {
		expect(wheelStep(0, 40, 0, BOTH)).toBe(40);
		expect(wheelStep(0, -40, 0, BOTH)).toBe(-40);
		expect(wheelStep(0, 40, 0, RIGHT_ONLY)).toBe(40);
		expect(wheelStep(0, -40, 0, LEFT_ONLY)).toBe(-40);
	});

	it("hands the notch back when the strip is already flush in that direction", () => {
		// At either edge the vertical wheel belongs to the transcript's scroll;
		// consuming it there would trap the reader mid-scroll.
		expect(wheelStep(0, 40, 0, LEFT_ONLY)).toBeNull();
		expect(wheelStep(0, 40, 0, FLUSH)).toBeNull();
		expect(wheelStep(0, -40, 0, RIGHT_ONLY)).toBeNull();
		expect(wheelStep(0, -40, 0, FLUSH)).toBeNull();
	});

	it("expands a line-mode delta by the row height it stands for", () => {
		expect(wheelStep(0, 3, 1, BOTH)).toBe(3 * WHEEL_LINE_HEIGHT);
		expect(wheelStep(0, -3, 1, BOTH)).toBe(-3 * WHEEL_LINE_HEIGHT);
	});

	it("does nothing with a zero delta", () => {
		expect(wheelStep(0, 0, 0, BOTH)).toBeNull();
	});
});
