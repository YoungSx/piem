import { useCallback, useEffect, type RefObject } from "react";

/**
 * The horizontal-scrolling variant of the quick-actions row.
 *
 * The reply placement's chips can now number six, and six wrapped chips read
 * as a menu rather than a palette, so that placement scrolls sideways instead.
 * Everything here stays free of React state: edge state in state would
 * re-render the row on every scroll frame, while the fade the stylesheet
 * draws and the wheel the scroller consumes both read the live element just
 * as well. The pure halves (`stripEdges`, `wheelStep`) sit below the hook so
 * the decisions unit-test without a renderer.
 */

/** Which sides of a horizontal scroller still hide content. */
export interface StripEdges {
	left: boolean;
	right: boolean;
}

/**
 * Slack under which a sliver of hidden content does not count. A sub-pixel
 * remainder from rounding would otherwise pin a permanent one-sided fade that
 * no scroll can ever clear.
 */
export const STRIP_EDGE_EPSILON = 1;

/** Row height a `deltaMode === 1` wheel event scrolls per notch. */
export const WHEEL_LINE_HEIGHT = 24;

/**
 * Which sides of a scroller still hide content, from its live metrics.
 *
 * `abs` keeps the comparison right under RTL, where Chromium and WebKit report
 * `scrollLeft` as a negative distance from the right edge — the question is
 * "how far along am I", not "which way am I signed".
 */
export function stripEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): StripEdges {
	const hidden = scrollWidth - clientWidth;
	if (hidden <= STRIP_EDGE_EPSILON) {
		return { left: false, right: false };
	}
	const offset = Math.abs(scrollLeft);
	return {
		left: offset > STRIP_EDGE_EPSILON,
		right: hidden - offset > STRIP_EDGE_EPSILON,
	};
}

/**
 * How far one wheel event should scroll the strip, or null to let it pass.
 *
 * The wheel's vertical delta is the strip's horizontal gesture, but only while
 * there is something left to reveal in that direction — a strip at its right
 * edge hands the next notch back to the transcript's own vertical scroll,
 * which is what makes an embedded scroller feel native rather than like a
 * trap. A dominant `deltaX` (trackpad sideways, shift+wheel) already means
 * what the user wants, so it passes through untouched.
 *
 * The delta itself is returned unsmoothed: instant stepping needs no
 * animation, and skipping `scrollBy({ behavior: "smooth" })` spares this the
 * `prefers-reduced-motion` gate the stylesheet would otherwise owe.
 *
 * Not RTL-aware: with no RTL locale in the plugin the vertical wheel always
 * means "reveal what is to the right", which is recorded here as a known
 * limit rather than guessed at.
 */
export function wheelStep(deltaX: number, deltaY: number, deltaMode: number, edges: StripEdges): number | null {
	if (Math.abs(deltaX) >= Math.abs(deltaY)) {
		return null;
	}
	const delta = deltaMode === 1 ? deltaY * WHEEL_LINE_HEIGHT : deltaY;
	if (delta > 0) {
		return edges.right ? delta : null;
	}
	if (delta < 0) {
		return edges.left ? delta : null;
	}
	return null;
}

/**
 * Wires a horizontal scroller's fade edges and wheel handling.
 *
 * Writes `--piem-strip-fade-left` / `--piem-strip-fade-right` (1 or 0) onto
 * the element for the stylesheet's mask to consume — via `setCssProps`, which
 * the Obsidian lint rules require so themes keep a hook on the element. The
 * wheel listener is native and `{ passive: false }` because React attaches
 * `onWheel` passively, where `preventDefault` cannot stop the transcript
 * behind the strip from scrolling too. A `ResizeObserver` re-syncs the fades
 * when the panel changes width; the chips' own content changes arrive through
 * `resetKey`, which also rewinds the scroll — fresh suggestions reuse the
 * same DOM nodes (ids are positional), and a row scrolled to its middle must
 * not greet its replacement half-hidden.
 *
 * A null `ref` opts out entirely — the wrap layout has nothing to wire — and
 * every read guards it, since the hook runs even when the row renders nothing.
 */
export function useStripScroll(ref: RefObject<HTMLElement | null> | null, resetKey: string): void {
	const sync = useCallback(() => {
		const el = ref?.current;
		if (!el) {
			return;
		}
		const edges = stripEdges(el.scrollLeft, el.clientWidth, el.scrollWidth);
		el.setCssProps({
			"--piem-strip-fade-left": edges.left ? "1" : "0",
			"--piem-strip-fade-right": edges.right ? "1" : "0",
		});
	}, [ref]);

	useEffect(() => {
		const el = ref?.current;
		if (!el) {
			return;
		}
		sync();
		el.addEventListener("scroll", sync, { passive: true });
		const onWheel = (event: WheelEvent): void => {
			const step = wheelStep(event.deltaX, event.deltaY, event.deltaMode, stripEdges(el.scrollLeft, el.clientWidth, el.scrollWidth));
			if (step === null) {
				return;
			}
			event.preventDefault();
			el.scrollLeft += step;
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		// Taken from the element's own window so a popout's panel observes its
		// own document, and optional so environments without one skip cleanly.
		const observer = el.ownerDocument.defaultView?.ResizeObserver ? new el.ownerDocument.defaultView.ResizeObserver(sync) : null;
		observer?.observe(el);
		return () => {
			el.removeEventListener("scroll", sync);
			el.removeEventListener("wheel", onWheel);
			observer?.disconnect();
		};
	}, [ref, sync]);

	useEffect(() => {
		const el = ref?.current;
		if (!el) {
			return;
		}
		el.scrollLeft = 0;
		sync();
	}, [resetKey, ref, sync]);
}
