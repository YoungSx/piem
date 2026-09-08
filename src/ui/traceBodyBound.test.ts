import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Structural gate over the trace body's vertical bound.
 *
 * The bound is measured in a real engine by `measure-transcript.mjs`: an
 * eighteen-rem scrollbox around long tool output — and around a settled think,
 * which can run longer than the transcript column itself. Whether it bites
 * depends on ancestor sizing no substring check can see, so the arbiter there is
 * Chromium.
 *
 * This file is the other half, and the two halves are not the same check twice.
 * That harness is not in `verify` and not in CI, so on any given commit this test
 * is the only thing standing between the rule and a stylesheet edit. It pins the
 * shape of the decision *and* that nothing later in the sheet undoes it — the
 * first cut asserted only the former, matching the rule by its leading selector,
 * and so stayed green while a rule appended at the end of the file set
 * `max-height: none` on every variant it names. A gate that can only catch an
 * edit to the line it quotes is a gate against typos, not against the cascade.
 */

/*
 * Comments are stripped before anything else: three of them in this stylesheet
 * contain braces, and a scan that counted those would lose track of which rules
 * sit at the top level and which are nested inside a container query.
 */
const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

interface StyleRule {
	selector: string;
	declarations: string;
	/** The at-rules enclosing it, outermost first; empty for a top-level rule. */
	scope: string[];
}

/**
 * Every rule in the sheet, each with the at-rules it sits inside.
 *
 * Hand-rolled rather than one regex per rule because the question here is about
 * *all* the rules touching one class, so the scan cannot stop at the first match,
 * and because a rule nested in a container query is still a rule that can undo
 * the bound — at one width only, which is the hardest version of this bug to
 * see. A flat regex would either miss it or mistake the query's prelude for a
 * selector.
 */
function parseRules(css: string): StyleRule[] {
	const rules: StyleRule[] = [];
	const scope: string[] = [];
	let prelude = "";
	let index = 0;
	while (index < css.length) {
		const char = css[index];
		if (char === "{") {
			const head = prelude.trim();
			prelude = "";
			if (head.startsWith("@")) {
				scope.push(head);
				index += 1;
				continue;
			}
			// A declaration block: plain CSS nests no braces inside one, so the next
			// closing brace ends it.
			const end = css.indexOf("}", index);
			const stop = end === -1 ? css.length : end;
			rules.push({ selector: head, declarations: css.slice(index + 1, stop), scope: [...scope] });
			index = stop + 1;
			continue;
		}
		if (char === "}") {
			scope.pop();
			index += 1;
			continue;
		}
		prelude += char;
		index += 1;
	}
	return rules;
}

/**
 * Properties that decide how tall a trace body is, or whether it scrolls.
 *
 * `overflow` and `height` are in here alongside the two the rule itself sets: the
 * bound is a pair (a cap plus a scroller), and either half can be undone by the
 * shorthand or by a competing `height` without the words `max-height` or
 * `overflow-y` appearing anywhere.
 */
const VERTICAL_PROPERTIES = /(?:^|[\s;])(max-height|height|overflow-y|overflow)\s*:/;

/**
 * The rules allowed to decide a trace body's vertical extent, by the selector
 * each one leads with.
 *
 * A registry rather than a lint: two rules legitimately bound this box for
 * different reasons — a seam's summary caps at 12rem, the machine-traffic trio at
 * 18rem — and a third would be a decision somebody should have to record here
 * before it ships. Matching on the leading selector is what makes the trio's
 * comma list addressable as one entry.
 */
const REGISTERED_BOUNDS = [".piem-chat__trace--seam > .piem-chat__trace-body", ".piem-chat__trace--result .piem-chat__trace-body"];

const bodyRules = parseRules(styles).filter((rule) => rule.selector.includes(".piem-chat__trace-body"));
const boundingRules = bodyRules.filter((rule) => VERTICAL_PROPERTIES.test(rule.declarations));

/**
 * The bounded-body rule, captured from its first selector through its body.
 *
 * The rule is a comma list, so a first-selector-only match is how the whole list
 * is reached; everything up to the opening brace is the variant list, and the
 * group holds the declarations.
 */
const boundRule = styles.match(/\.piem-chat__trace--result \.piem-chat__trace-body,([\s\S]*?)\{([^}]*)\}/);

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
		const body = boundRule?.[2] ?? "";
		expect(body).toContain("max-height: 18rem");
		expect(body).toContain("overflow-y: auto");
		// Horizontal stays owned by the blocks inside (`.piem-chat__text`, the
		// `pre` contract); a width declaration here would claim it twice.
		expect(body).not.toContain("max-width");
		expect(body).not.toContain("overflow-x");
	});

	/*
	 * The cascade half. Every assertion above reads one rule, and a rule that is
	 * right can still be outranked — by a later rule with the same selector, which
	 * wins on source order, or by a more specific one, which wins outright. Both
	 * leave every line quoted above exactly as it is.
	 */
	it("is the only rule in the sheet that decides how tall a trace body is", () => {
		const unregistered = boundingRules.filter((rule) => !REGISTERED_BOUNDS.some((known) => rule.selector.startsWith(known)));
		expect(unregistered.map((rule) => rule.selector)).toEqual([]);
	});

	it("is not restated later in the sheet, where source order would decide it", () => {
		// One rule per registered selector. A second with the same selector needs no
		// extra specificity to win, so counting is the only thing that catches it.
		for (const known of REGISTERED_BOUNDS) {
			const matches = boundingRules.filter((rule) => rule.selector.startsWith(known));
			expect(matches.length, `${known} is set by ${matches.length} rules`).toBe(1);
		}
	});

	it("applies at every panel width, not just the one a container query names", () => {
		// A bound nested in a `@container` holds on some widths and not others, and
		// the harness measures three — so this is the fault it would report as a
		// puzzling pass at 560px and a failure at 390px.
		for (const rule of boundingRules) {
			expect(rule.scope, `${rule.selector} is nested inside ${rule.scope.join(" / ")}`).toEqual([]);
		}
	});
});
