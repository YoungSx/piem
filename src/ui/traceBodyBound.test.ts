import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Structural gate over the trace body's vertical bound.
 *
 * The bound is measured, not asserted, by the visual harness: an eighteen-rem
 * scrollbox around long tool output — and around a settled think, which can run
 * longer than the transcript column itself. Whether it bites depends on ancestor
 * sizing no substring check can see, so the real arbiter is Chromium.
 *
 * This test pins the shape of the decision so the rule cannot quietly lose a
 * variant between two runs of that harness — the same reason
 * `transcriptOverflow.test.ts` exists for the horizontal contract. The variant
 * list is the spec here: tool results, harness output and settled thinking share
 * one bound, while a still-running think is exempt from its own.
 */
const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");

/**
 * The bounded-body rule, captured from its first selector through its body.
 *
 * The rule is a comma list, so a first-selector-only match is how the whole list
 * is reached; everything up to the opening brace is the variant list, and the
 * group holds the declarations.
 */
const boundRule = styles.match(
	/\.piem-chat__trace--result \.piem-chat__trace-body,([\s\S]*?)\{([^}]*)\}/,
);

describe("the trace body's height bound", () => {
	it("exists", () => {
		expect(boundRule).not.toBeNull();
	});

	it("covers tool results, harness output and settled thinking — one bound, one vocabulary", () => {
		const variants = boundRule?.[1] ?? "";
		expect(variants).toContain(".piem-chat__trace--harness .piem-chat__trace-body");
		expect(variants).toContain(".piem-chat__trace--thinking:not(.piem-chat__trace--running) .piem-chat__trace-body");
	});

	it("exempts the live thinking row, whose reader is following, not auditing", () => {
		// The `:not(--running)` is the whole reason, so pin the exclusion itself:
		// a plain `.piem-chat__trace--thinking` variant here would also satisfy the
		// coverage assertion above while capping the stream mid-follow.
		const variants = boundRule?.[1] ?? "";
		expect(variants).not.toMatch(/\.piem-chat__trace--thinking(?!\S)/);
	});

	it("bounds the same box the tool bodies share, on the vertical axis only", () => {
		const body = (boundRule?.[2] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
		expect(body).toContain("max-height: 18rem");
		expect(body).toContain("overflow-y: auto");
		// Horizontal stays owned by the blocks inside (`.piem-chat__text`, the
		// `pre` contract); a width declaration here would claim it twice.
		expect(body).not.toContain("max-width");
		expect(body).not.toContain("overflow-x");
	});
});
