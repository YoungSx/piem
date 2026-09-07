import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Structural gates over the transcript's horizontal-overflow contract.
 *
 * The behaviour these protect is measured, not asserted, by
 * `scripts/measure-transcript.mjs`: it renders the real stylesheet against the
 * real markup in Chromium at three panel widths and fails if the message column
 * scrolls sideways or if a wide block ends up clipped instead of scrollable. That
 * harness is the source of truth, and it is the only thing that *can* be —
 * whether `max-width: 100%` bites depends on ancestor sizing that no substring
 * check can see.
 *
 * These tests exist because that harness needs a browser and `bun test` does not
 * have one. They pin the shape of the decision so a rule cannot quietly go
 * missing between two runs of the measurement, and each one names the ablation
 * that proved it load-bearing — dropping the rule and watching the measured
 * column widen. Rules that ablation showed to change nothing are deliberately
 * *not* pinned here; see the note on `min-width` in `styles.css`.
 */

const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");

/** Declarations of the first rule whose selector list matches `selector` exactly. */
function ruleBody(selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const found = styles.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
	const body = found?.[1];
	if (body === undefined) throw new Error(`no rule for ${selector}`);
	return body;
}

/**
 * A rule body with its comments stripped. Required for every assertion, not just
 * the negative ones: these rules record the declaration they replaced (`pre-wrap`)
 * and the one they deliberately omit (`min-width`), so a raw substring check
 * would read the prose as the declaration.
 */
function declarations(body: string): string {
	return body.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Every construct whose horizontal extent carries meaning, and which therefore
 * has to scroll rather than wrap. Ablating any one of these was measured to make
 * the column scroll sideways again at one or more panel widths.
 */
/*
 * `.piem-chat__compaction pre` used to be listed separately. It matched the same
 * element `.piem-chat__text` does — the compaction divider's summary block — and
 * only existed to add a height bound; the seam row that replaced the divider
 * carries that bound on its body instead (`.piem-chat__trace--seam >
 * .piem-chat__trace-body`), so the width half is `.piem-chat__text`'s alone and
 * a second selector for it would assert the same rule twice.
 */
const SCROLLS_IN_PLACE = [".piem-chat__markdown pre", ".piem-chat__markdown table", ".piem-chat__text"];

describe("the transcript column never scrolls sideways", () => {
	/*
	 * The symptom the fix is for. `overflow-y: auto` alone does not leave the other
	 * axis `visible` — CSS computes it to `auto` — so the transcript was a two-axis
	 * scroller by omission, and one fenced code block took a 359px column to 1209px
	 * of scroll width on a phone.
	 */
	it("states overflow-x on the scroll container instead of inheriting auto", () => {
		expect(declarations(ruleBody(".piem-chat__messages"))).toContain("overflow-x: hidden");
	});

	it("clips rather than scroll-clips, so descendants stay scrollable by script", () => {
		// `clip` would also forbid `scrollIntoView` on the newest message and focus
		// moving into a long block; `hidden` clips the paint and keeps that working.
		expect(declarations(ruleBody(".piem-chat__messages"))).not.toContain("overflow-x: clip");
	});
});

describe("wide content scrolls inside its own box", () => {
	/*
	 * The half that keeps the fix honest. Clipping the column and stopping there
	 * would make the symptom disappear while silently truncating every wide table —
	 * so each construct that can exceed the column has to own a scroll box, and the
	 * measurement asserts the resulting scrollbar is reachable inside the column.
	 */
	it.each(SCROLLS_IN_PLACE)("bounds %s to the column and lets it scroll", (selector) => {
		const body = declarations(ruleBody(selector));

		expect(body).toContain("max-width: 100%");
		expect(body).toMatch(/overflow(-x)?: auto/);
	});

	it("makes the table a block so overflow applies, without collapsing its columns", () => {
		/*
		 * `overflow` does nothing on `display: table`, so the table has to become a
		 * block box to scroll at all — and `width: max-content` is what stops that
		 * from also discarding the column widths the table layout computed. Verified
		 * in Chromium: 161/47/100 column widths either way.
		 */
		const body = declarations(ruleBody(".piem-chat__markdown table"));

		expect(body).toContain("display: block");
		expect(body).toContain("width: max-content");
	});

	it("also scrolls Obsidian's own table wrapper when the renderer emits one", () => {
		// The reading view wraps Markdown tables in `.table-wrapper`; when it is
		// there it, not the table, is the right scroll box.
		expect(declarations(ruleBody(".piem-chat__markdown .table-wrapper"))).toMatch(/overflow(-x)?: auto/);
	});
});

describe("the quick-action strip scrolls inside the row", () => {
	/*
	 * The reply placement's row is the one sanctioned sideways scroller that is
	 * not a wide block but the transcript's own furniture: six model-suggested
	 * chips, laid out in one line. These pins hold the shape the fades and the
	 * wheel handling both assume, so neither can silently scroll nothing.
	 */
	it("declares the strip a one-line sideways scroller", () => {
		const body = declarations(ruleBody(".piem-chat__quick-actions--strip"));
		expect(body).toContain("overflow-x: auto");
		expect(body).toContain("flex-wrap: nowrap");
	});

	it("fades only the strip, never the empty screen's wrapping row", () => {
		// The base rule is shared with the wrap layout; the mask belongs to the
		// modifier alone, so a chip row that cannot scroll can never dim its edge.
		expect(declarations(ruleBody(".piem-chat__quick-actions"))).not.toContain("mask-image");
		expect(declarations(ruleBody(".piem-chat__quick-actions--strip"))).toContain("mask-image");
	});

	it("keeps each chip a fixed block the fade decides to clip", () => {
		const body = declarations(ruleBody(".piem-chat__quick-actions--strip .piem-chat__quick-action"));
		expect(body).toContain("white-space: nowrap");
		expect(body).toContain("flex: none");
	});
});

describe("prose wraps where machine output scrolls", () => {
	/*
	 * The split is the design. Prose has no columns to preserve, so an unbreakable
	 * URL or vault path should break mid-token rather than push the column; code,
	 * tables and equations carry meaning in their horizontal extent, so they scroll.
	 */
	it("lets prose break inside a token", () => {
		expect(declarations(ruleBody(".piem-chat__markdown"))).toContain("overflow-wrap: break-word");
	});

	it("keeps a line of code on one line", () => {
		/*
		 * `pre`, not `pre-wrap`. Measured at 359px, `pre-wrap` did not remove the
		 * scroll it was there to avoid — an unbreakable token still needed 557px —
		 * it only decided which content got mangled first: a wrapped statement's
		 * indentation stops describing its nesting. The trade is one line plus a
		 * scroll, which is what every code editor picks.
		 */
		expect(declarations(ruleBody(".piem-chat__markdown pre"))).toContain("white-space: pre;");
	});

	it("leaves the inner code element to inherit, so a theme can still soft-wrap", () => {
		/*
		 * An explicit `white-space` on `pre code` was in an earlier cut and measured
		 * redundant — `white-space` inherits. Removing it also hands the choice back
		 * to the theme: a theme declaring `pre-wrap` on `code` gets it, and the
		 * `<pre>`'s own scroll still keeps the content inside the column.
		 */
		expect(styles).not.toContain(".piem-chat__markdown pre code");
	});
});

/*
 * The provider's own words, behind the failure row's disclosure (#239). Machine
 * output, but not code: its horizontal extent carries nothing, so it wraps
 * rather than owning a scroll box — which is what keeps it out of
 * `SCROLLS_IN_PLACE` above and keeps the column the only thing that scrolls.
 * A later switch to `<pre>` would satisfy neither half of the invariant.
 */
describe("a provider error wraps rather than scrolling", () => {
	it("breaks inside a token, so an org id or URL cannot push the column", () => {
		expect(declarations(ruleBody(".piem-chat__cutoff-raw"))).toContain("overflow-wrap: anywhere");
	});

	it("keeps the newlines a provider joined its message with", () => {
		// Without `pre-line` a multi-line diagnostic collapses into one run-on
		// sentence; with `pre` it would stop wrapping and need a scroll box.
		expect(declarations(ruleBody(".piem-chat__cutoff-raw"))).toContain("white-space: pre-line");
	});

	it("takes no height cap, unlike the banner it replaced", () => {
		/*
		 * The banner caps this content at 9em with its own scrollbar, because it
		 * sits *above* the transcript and an unbounded dump pushed the conversation
		 * out of a sidebar pane. Inside the transcript there is nothing to push, and
		 * a reader who opened the disclosure asked for all of it.
		 */
		expect(declarations(ruleBody(".piem-chat__cutoff-raw"))).not.toContain("max-height");
	});
});

describe("intrinsically sized media comes down to the column", () => {
	/*
	 * A screenshot pasted from a desktop carries its own width — the fixture here is
	 * 1400px against a 359px phone column. `height: auto` is what keeps the aspect
	 * ratio while the width comes down; without it the picture squashes.
	 */
	it.each(["img", "svg", "video"])("holds %s to the column and preserves its ratio", (tag) => {
		const body = declarations(ruleBody(`.piem-chat__markdown img,\n.piem-chat__markdown svg,\n.piem-chat__markdown video`));

		expect(body).toContain("max-width: 100%");
		expect(body).toContain("height: auto");
		expect(styles).toContain(`.piem-chat__markdown ${tag}`);
	});
});

/*
 * Whether the measurement is looking at the plugin's markup at all.
 *
 * `scripts/preview-transcript.mjs` writes its fixtures by hand, so a construct can
 * be renamed in `styles.css` and in the component while the fixture keeps emitting
 * the old class. That is not a quiet failure — it is a loud, misdirected one. When
 * the tidying seam replaced the compaction divider it took `.piem-chat__compaction`
 * out of the stylesheet and left the fixture naming it, so that fixture's `<pre>`
 * matched no rule the plugin ships and laid out at browser defaults: the harness
 * reported the transcript scrolling sideways by 1816px at all three widths, and the
 * file it pointed at was holding the column still the whole time.
 *
 * Pinned from both ends deliberately. Requiring only that the harness name a class
 * would pass a rename that moved the stylesheet on without it; requiring only the
 * stylesheet is what every rule above already does. The pair is what makes such a
 * rename fail here — in a suite CI runs — rather than in a browser run that needs a
 * Chromium nobody has in CI and a reader to interpret it.
 *
 * One entry per subject the rules above take: the two text faces, the seam whose
 * body carries the height bound the divider used to, and the provider's own words.
 */
const MEASURED_CONSTRUCTS = ["piem-chat__markdown", "piem-chat__text", "piem-chat__trace--seam", "piem-chat__cutoff-raw"];

/**
 * Classes the harness writes into a `class="…"` attribute.
 *
 * Attributes rather than every `piem-` mention in the file, so the harness's own
 * guard list — which names classes as bare strings — cannot satisfy a pin that is
 * supposed to be about a fixture. Interpolated names (`piem-chat__trace--${variant}`)
 * are skipped rather than half-matched: their bases are covered by the rows that
 * spell a class out.
 */
function fixtureClasses(harness: string): string[] {
	const classes = new Set<string>();
	for (const attribute of harness.matchAll(/class="([^"]*)"/g)) {
		for (const token of (attribute[1] ?? "").split(/\s+/)) {
			if (token.startsWith("piem-") && !token.includes("$")) classes.add(token);
		}
	}
	return [...classes];
}

describe("the harness measures the markup the plugin ships", () => {
	const harness = readFileSync(new URL("../../scripts/preview-transcript.mjs", import.meta.url), "utf8");

	it.each(MEASURED_CONSTRUCTS)("%s is a class the stylesheet defines and the fixtures wear", (construct) => {
		expect(styles).toContain(`.${construct}`);
		expect(fixtureClasses(harness)).toContain(construct);
	});
});
