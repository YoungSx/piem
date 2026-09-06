import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Structural gates over `styles.css` for two accessibility decisions that are
 * easy to undo by accident and impossible to catch in a rendering test here:
 * the panel's stylesheet is consumed by Obsidian, whose own `app.css` supplies
 * `--text-muted`, `--icon-opacity` and the `.clickable-icon` rules that the
 * plugin's values compose with. None of that exists under `bun test`.
 *
 * So these assert on the *shape of the decision* rather than on a rendered
 * pixel. The measured numbers behind each decision are recorded in the comments
 * in `styles.css`; they came from Chromium driven over CDP against the real
 * `app.css`, headful under Xvfb, because a headless Chromium reports
 * `(hover: none)` and `(pointer: none)` and so never matches the desktop
 * resting state these rules are about.
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
 * A rule body with its comments stripped.
 *
 * Every "not present" assertion below has to go through this: the rules in
 * `styles.css` name the property they deliberately omit in order to record why,
 * and a raw substring check reads that mention as the property itself.
 */
function declarations(body: string): string {
	return body.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * The whole stylesheet with comments stripped — the file-wide counterpart to
 * `declarations`. Every scan that sweeps the file for a forbidden construct has
 * to read this instead of `styles`, because the comments quote the constructs
 * they forbid: the hover note names `@media (hover: hover)`, the ramp note names
 * `--font-text-size`, and the breakpoint note names the `@media` query it
 * replaced.
 */
const allDeclarations = declarations(styles);

/**
 * The bodies of every `@media (<query>)` block in the stylesheet, found by
 * walking braces from each opener to its match — the same walk
 * {@link gatingBlockFor} does, collected for every opener instead of matched
 * against one selector.
 */
function mediaBlocks(query: string): string[] {
	const gate = `@media (${query}) {`;
	const blocks: string[] = [];
	for (let at = allDeclarations.indexOf(gate); at !== -1; at = allDeclarations.indexOf(gate, at + 1)) {
		let depth = 0;
		let end = at + gate.length - 1;
		for (let i = at + gate.length - 1; i < allDeclarations.length; i += 1) {
			if (allDeclarations[i] === "{") depth += 1;
			else if (allDeclarations[i] === "}") {
				depth -= 1;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		blocks.push(allDeclarations.slice(at, end + 1));
	}
	return blocks;
}

/**
 * The `@media (hover: hover)` block containing `selector`, or null when the rule
 * sits outside one. Walks braces from each gate opener to its match, so a rule
 * that merely follows a gated block is not mistaken for one inside it.
 */
function gatingBlockFor(selector: string): string | null {
	const gate = "@media (hover: hover) {";
	for (let at = allDeclarations.indexOf(gate); at !== -1; at = allDeclarations.indexOf(gate, at + 1)) {
		let depth = 0;
		let end = at + gate.length - 1;
		for (let i = at + gate.length - 1; i < allDeclarations.length; i += 1) {
			if (allDeclarations[i] === "{") depth += 1;
			else if (allDeclarations[i] === "}") {
				depth -= 1;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		const block = allDeclarations.slice(at, end + 1);
		if (block.includes(selector)) return block;
	}
	return null;
}

describe("icon contrast in the resting state (WCAG 1.4.11)", () => {
	/*
	 * `opacity` cannot express "muted" on an icon button in this codebase.
	 * Obsidian's `.clickable-icon` already applies `opacity: var(--icon-opacity)`
	 * (0.85), so any container opacity multiplies with it: the 0.55 that used to
	 * live here composited to 2.10:1 in the light theme and 2.80:1 in the dark
	 * one, both under the 3:1 floor. Raising the number does not fix the shape of
	 * the problem — 0.70 measured 2.68:1.
	 */
	for (const selector of [".piem-chat__message-actions", ".piem-chat__context-action"]) {
		it(`mutes ${selector} with a colour token, not opacity`, () => {
			const body = ruleBody(selector);

			expect(declarations(body)).not.toMatch(/(^|[^-])opacity\s*:/);
			expect(body).toContain("--icon-color: var(--text-muted)");
		});

		/*
		 * Obsidian re-declares `color: var(--icon-color-hover)` inside
		 * `.clickable-icon:hover`, and that token defaults to `--text-muted`. Setting
		 * only `--icon-color` therefore left the glyph muted at the moment the
		 * pointer was on it — measurably worse than resting, since the hover
		 * background lightens while the foreground does not.
		 */
		it(`moves --icon-color-hover with --icon-color on ${selector}`, () => {
			const body = ruleBody(selector);

			expect(body).toContain("--icon-color-hover: var(--text-muted)");
		});
	}

	/*
	 * The switcher is muted the same way but restored differently, so it cannot
	 * ride the loop above.
	 *
	 * Those two are revealed by their *container* — the message card, the context
	 * chip — so their base rule has to keep `--icon-color-hover` muted and a
	 * descendant rule lifts both tokens. The switcher is its own hover target and
	 * always visible, so the hover token is set to full strength in the base rule
	 * itself. Asserting it as muted here would demand the pointer-on-it state be
	 * dimmer than resting, which is the exact defect the sibling rules fix.
	 */
	it("mutes the model switcher with colour, and lifts it on its own hover", () => {
		const body = ruleBody(".piem-chat__model-switcher");

		expect(body).not.toMatch(/(^|[^-])opacity\s*:/);
		expect(body).toContain("--icon-color: var(--text-muted)");
		expect(body).toContain("--icon-color-hover: var(--text-normal)");
		// The label beside the glyph is text, not an icon, so the icon tokens do
		// not reach it; its own colour has to move on the same two states. Focus
		// stays ungated and hover rides the gated block, per the touch-hover rules.
		expect(body).toContain("color: var(--text-muted)");
		expect(ruleBody(".piem-chat__model-switcher:focus-visible")).toContain("color: var(--text-normal)");
		expect(ruleBody(".piem-chat__model-switcher:hover")).toContain("color: var(--text-normal)");
		expect(gatingBlockFor(".piem-chat__model-switcher:hover")).not.toBeNull();
	});

	/*
	 * Focus and hover are separate rules, not one selector list: the hover half is
	 * gated on `@media (hover: hover)` (see the touch-hover block below) while the
	 * focus half has to apply everywhere. Merging them would have swept keyboard
	 * focus into the media query and lost the affordance on a phone.
	 */
	it("restores full strength on keyboard focus, ungated", () => {
		// Both tokens have to move, or Obsidian's own hover rule wins.
		for (const body of [ruleBody(".piem-chat__message-actions:focus-within"), ruleBody(".piem-chat__context-chip:focus-within .piem-chat__context-action")]) {
			expect(body).toContain("--icon-color: var(--text-normal)");
			expect(body).toContain("--icon-color-hover: var(--text-normal)");
		}
	});

	it("restores full strength on hover, behind a hover-capable pointer", () => {
		for (const selector of [".piem-chat__message-actions:hover", ".piem-chat__context-chip:hover .piem-chat__context-action"]) {
			expect(ruleBody(selector)).toContain("--icon-color: var(--text-normal)");
			expect(ruleBody(selector)).toContain("--icon-color-hover: var(--text-normal)");
			expect(gatingBlockFor(selector)).not.toBeNull();
		}
	});

	it("keeps the disabled-button opacity, which WCAG 1.4.3 exempts", () => {
		// Deliberately untouched: `:disabled` is exempt, and this value is itself
		// the fix for a real bug (a full-strength Send that did nothing).
		expect(ruleBody(".piem-chat__icon-button:disabled")).toContain("opacity: 0.4");
	});
});

describe("the banner reports state with its glyph, not with a fill (WCAG 1.4.3 / 1.4.11)", () => {
	/*
	 * `--background-modifier-error` and `--text-error` both resolve to
	 * `--color-red` in stock Obsidian, which is what made the old treatment
	 * unmeasurable: the red border was the colour of the red fill it bordered
	 * (1.00:1), and `--text-normal` on that fill measured 2.47:1 dark / 3.78:1
	 * light. This row is `--font-ui-smaller`, so 4.5:1 is the floor for the words
	 * and 3:1 for the glyph, and the dark theme missed both.
	 *
	 * After the change, measured in Blink against a real `app.css`: glyph and
	 * border 3.50:1 dark / 4.10:1 light, words 8.64:1 dark / 15.51:1 light. Light
	 * is the stronger theme for the red, which an earlier draft of the stylesheet
	 * comment had backwards.
	 *
	 * Structural rather than numeric for the reason the file header gives: the
	 * tokens live in Obsidian's `app.css`, which does not exist here. What is
	 * assertable is the *shape* — no red fill anywhere on the row, and the red
	 * spent on the one child small enough to afford it.
	 */
	it("never fills the error row, so the words keep Obsidian's own body pair", () => {
		const shared = ruleBody(
			".piem-chat__banner--error,\n.piem-chat__banner--notice,\n.piem-chat__banner--wall,\n.piem-chat__banner--recovery",
		);

		expect(shared).toContain("background: var(--background-secondary-alt)");
		expect(shared).toContain("color: var(--text-normal)");
		expect(declarations(ruleBody(".piem-chat__banner--error"))).not.toContain("--background-modifier-error");
	});

	/*
	 * The height cap and its scrollbar are gone, and both halves of that matter.
	 * The cap existed for provider error dumps, which do not reach this surface any
	 * more — they report themselves in the transcript (#239) — and a scroll
	 * container with no `tabindex` is a WCAG 2.1.1 failure, so a sighted keyboard
	 * user could not read past its sixth line.
	 */
	it("caps neither the height of the row's text nor a reader's access to it", () => {
		const body = declarations(ruleBody(".piem-chat__banner-text"));

		expect(body).not.toContain("max-height");
		expect(body).not.toMatch(/overflow(-y)?: auto/);
	});

	/*
	 * Measured in Blink at 300px before this: icon 16 + action 108 + dismiss 32 +
	 * three 8px gaps left the text column 60px wide, which pushed a 68-character
	 * sentence past the old height cap and gave it an inner scrollbar inside a 60px
	 * column. The floor plus the container's wrap move the accessories to a second
	 * line instead.
	 */
	it("lets the row wrap rather than squeezing its sentence to nothing", () => {
		expect(declarations(ruleBody(".piem-chat__banner"))).toContain("flex-wrap: wrap");
		expect(declarations(ruleBody(".piem-chat__banner-text"))).toContain("min-width: 20ch");
	});

	it("spends the red on the glyph", () => {
		expect(ruleBody(".piem-chat__banner--error .piem-chat__banner-icon")).toContain("color: var(--text-error)");
	});

	/*
	 * The border is kept — it is the row's second red note and, unlike before,
	 * it now contrasts with what it borders.
	 */
	it("keeps the red border, which finally differs from the fill", () => {
		expect(ruleBody(".piem-chat__banner--error")).toContain("border-color: var(--text-error)");
	});

	/*
	 * `--recovery` had no rule of its own: the crash-recovery offer rendered on
	 * the bare `.piem-chat__banner` while its two sibling offers carried a
	 * background. A variant the component renders and the stylesheet does not
	 * name is the defect this asserts against.
	 */
	it("gives every variant the component renders a ground and an icon colour", () => {
		const muted = ruleBody(
			".piem-chat__banner--notice .piem-chat__banner-icon,\n.piem-chat__banner--wall .piem-chat__banner-icon,\n.piem-chat__banner--recovery .piem-chat__banner-icon",
		);

		expect(muted).toContain("color: var(--text-muted)");
	});
});

describe("message actions: revealed on hover where hover exists, visible where it doesn't", () => {
	/*
	 * The row must stay *laid out* on every device — only the buttons' paint is
	 * hidden on desktop. Hiding the row itself would add the actions' height to
	 * every message the moment the pointer reached it, shoving the transcript
	 * down mid-scroll. So the `opacity: 0` lives on the buttons, and the row's
	 * base rule keeps carrying no opacity at all (asserted by the contrast tests
	 * above, which is what keeps the muted-colour treatment the resting state
	 * is measured against).
	 */
	it("hides the buttons' paint, never the row's layout box", () => {
		const hidden = ruleBody(".piem-chat__message-actions button");
		expect(hidden).toContain("opacity: 0");
		expect(ruleBody(".piem-chat__message-actions")).not.toMatch(/opacity\s*:/);
	});

	/*
	 * A touch tap leaves `:hover` latched on the tapped element until the next
	 * tap lands elsewhere, so an ungated rule renders as a permanently "active"
	 * row on a phone — the same reason every other pointer rule here sits behind
	 * this gate. Touch must simply never match the hiding rule.
	 */
	it("gates the hiding and the hover reveal behind a hover-capable pointer", () => {
		for (const selector of [
			".piem-chat__message-actions button",
			".piem-chat__message:hover .piem-chat__message-actions button",
		]) {
			expect(gatingBlockFor(selector)).not.toBeNull();
		}
	});

	it("reveals the row when the pointer reaches the message or focus lands on a button", () => {
		// The hover target is the whole message — bubble plus the row's own
		// placeholder — so moving toward the invisible buttons already wakes them.
		const hover = ruleBody(".piem-chat__message:hover .piem-chat__message-actions button");
		expect(hover).toContain("opacity: 1");

		// Keyboard parity, ungated like every other focus state: on touch it
		// re-asserts the always-visible baseline; on desktop it keeps tabbing to
		// a hidden action from landing on an invisible control.
		const focus = ruleBody(".piem-chat__message-actions:focus-within button");
		expect(focus).toContain("opacity: 1");
		expect(gatingBlockFor(".piem-chat__message-actions:focus-within button")).toBeNull();
	});

	it("switches the reveal animation off under reduced motion", () => {
		// The stylesheet has several reduce blocks; the reveal's must be one of them.
		const reduced = mediaBlocks("prefers-reduced-motion: reduce").some((block) =>
			block.includes(".piem-chat__message-actions button"),
		);
		expect(reduced).toBe(true);
	});
});

describe("bare-button cascade against Obsidian's control chrome", () => {
	/*
	 * `app.css` styles every `button:not(.clickable-icon)` as a filled form
	 * control at (0,1,1). A plain class reset at (0,1,0) silently loses to it —
	 * which is how a 16px ring and a chip's file name both shipped inside filled,
	 * rounded boxes — and the loss is invisible under `bun test`, which loads
	 * neither `app.css` nor the plugin stylesheet. Only the shape of the selector
	 * proves the fix, so that is what is pinned here.
	 */
	const RESET = "button.piem-chat__command-menu-button,\nbutton.piem-chat__context-open";

	it("resets the bare buttons with an element-qualified selector, not a bare class", () => {
		// `ruleBody` matching at all proves the selector carries the element: a
		// `.piem-chat__context-open` rule would not be found under this key.
		const body = declarations(ruleBody(RESET));

		expect(body).toContain("background: transparent");
		expect(body).toContain("box-shadow: none");
	});

	it("wins the tie on source order, not by force or by surrendering specificity", () => {
		// `!important` would also silence the hover and selected states below the
		// reset; `:where()` contributes nothing and leaves the (0,1,1) tie unbroken.
		// Anchored at line start so the rule's own comment — which names both —
		// stays out of the match.
		const rule = styles.match(/(?:^|\n)button\.piem-chat__command-menu-button[\s\S]*?\{[^}]*\}/)?.[0] ?? "";

		expect(rule).not.toContain("!important");
		expect(rule).not.toContain(":where(");
	});

	it("pins the ring's icon opacity through the token, not by opting out of clickable-icon", () => {
		// The ring wears `clickable-icon` (see ContextGauge.tsx), whose 0.85
		// opacity would dilute the warn and near band colours. The class stays —
		// dropping it is what re-chromed the ring — and this pair answers the
		// opacity; both tokens, because `.clickable-icon:hover` re-declares
		// `--icon-opacity-hover` and Obsidian's mobile block drops it to 0.65.
		const body = ruleBody(".piem-chat__context-gauge");

		expect(body).toContain("--icon-opacity: 1");
		expect(body).toContain("--icon-opacity-hover: 1");
	});

	it("element-qualifies the one bare button that wants a fill, so it outranks the reset", () => {
		// `.piem-chat__latest` at (0,1,0) was losing its own `--background-secondary`
		// to both Obsidian's control rule and the reset, and silently wearing
		// `--interactive-normal` instead.
		const body = ruleBody("button.piem-chat__latest");

		expect(body).toContain("background: var(--background-secondary)");
		expect(declarations(body)).not.toContain("background: transparent");
	});
});

describe("touch targets (WCAG 2.5.5 / 2.5.8)", () => {
	/*
	 * `pointer` reports only the *primary* input, so an iPad with a keyboard — a
	 * mainstream way to run Obsidian mobile, which this plugin supports via
	 * `isDesktopOnly: false` — reported `fine` and dropped back to 32px targets
	 * while the screen stayed the main way to reach the panel.
	 *
	 * Layout blocks are the deliberate exception, not a loophole. The one-row
	 * header asks which input is driving *now*,
	 * and keying those on `any-pointer` would drag a mouse-driven touchscreen
	 * laptop into the phone arrangement. So the ban lands on what a `pointer`
	 * block may *declare* — never a touch-target size — rather than on the query
	 * itself.
	 */
	it("keys every touch-target rule on any-pointer, never on pointer alone", () => {
		expect(allDeclarations.match(/@media \(any-pointer: coarse\)/g)?.length).toBe(2);
		for (const block of mediaBlocks("pointer: coarse")) {
			expect(block).not.toMatch(/min-(?:height|width):/);
		}
	});

	it("grows the jump-to-latest button, by height only", () => {
		// It is a bare <button>, not a .piem-chat__icon-button, so the shared
		// selector never reached it — leaving a 32px control in the thumb zone.
		const coarse = styles.slice(styles.lastIndexOf("@media (any-pointer: coarse)"));
		const rule = coarse.match(/\.piem-chat__latest\s*\{([^}]*)\}/);
		expect(rule).not.toBeNull();
		expect(rule?.[1]).toContain("min-height: var(--size-4-12)");
		// A min-width would stretch a labelled button and fight translateX(-50%).
		expect(declarations(rule?.[1] ?? "")).not.toContain("min-width");
	});

	it("lets the model switcher shrink under a coarse pointer, unlike its siblings", () => {
		// The shared rule raises `min-width` to 48px, which on a phone would stop a
		// long model name from ellipsizing and push Send off the row. Height is the
		// half of the touch target that matters here; the button is wide by content.
		const coarse = styles.slice(styles.lastIndexOf("@media (any-pointer: coarse)"));
		const rule = coarse.match(/\.piem-chat__model-switcher\s*\{([^}]*)\}/);
		expect(rule).not.toBeNull();
		expect(rule?.[1]).toContain("min-height: var(--size-4-12)");
		expect(rule?.[1]).toContain("min-width: 0");
	});

	it("grows the command menu rows, by height only", () => {
		// The rows are bare <button>s, so the shared icon-button selector never
		// reached them either — a desc-less row measured ~28px in the thumb zone.
		// Width comes from the menu itself, so no floor is declared.
		const coarse = styles.slice(styles.lastIndexOf("@media (any-pointer: coarse)"));
		const rule = coarse.match(/\.piem-chat__command-menu-button\s*\{([^}]*)\}/);
		expect(rule).not.toBeNull();
		expect(rule?.[1]).toContain("min-height: var(--size-4-12)");
		expect(declarations(rule?.[1] ?? "")).not.toContain("min-width");
	});

	it("buys back list height for the taller command rows on a coarse pointer", () => {
		// 48px rows carve the shared 40vh ceiling into fewer visible choices, so
		// the coarse block lifts the ceiling — keyed on any-pointer like every
		// other touch rule, and absent from the base rule, which keeps 40vh.
		const base = ruleBody(".piem-chat__command-menu");
		expect(base).toContain("max-height: 40vh");
		const coarse = styles.slice(styles.lastIndexOf("@media (any-pointer: coarse)"));
		const rule = coarse.match(/\.piem-chat__command-menu\s*\{([^}]*)\}/);
		expect(rule).not.toBeNull();
		expect(rule?.[1]).toContain("max-height: 50vh");
	});

	it("leaves the in-chip buttons at 32px, which is a reasoned trade-off", () => {
		// Growing these to 48px would leave a 300px sidebar no room for the label;
		// they already clear the 24px WCAG 2.5.8 floor and sit inside a row that is
		// itself comfortably tappable.
		const body = ruleBody(".piem-chat__context-chip .piem-chat__context-action");
		expect(body).toContain("min-height: var(--size-4-8)");
		expect(body).toContain("min-width: var(--size-4-8)");
	});
});

describe("command menu rows are one line (issue #167)", () => {
	/*
	 * Each row was a two-line stack whose internal gap equalled the gap between
	 * rows, so the list read as stripes rather than rows. It is one flex line now,
	 * and three of that line's properties are load-bearing in a way no rendering
	 * test here can see: happy-dom does no layout, so it cannot report which span
	 * ellipsizes when a 300px sidebar runs out of room.
	 *
	 * Measured in Chromium against these rules (see `scripts/measure-command-menu.mjs`,
	 * which extracts them from this stylesheet rather than restating them): 23px
	 * rows at both 300px and 520px, the kind tag flush to the trailing edge in all
	 * twelve rendered rows including the description-less one, and at 300px the
	 * long description truncating while its name stayed whole.
	 */
	it("lays a row out as one flex line, not a column", () => {
		const body = declarations(ruleBody(".piem-chat__command-menu-button"));

		expect(body).toContain("display: flex");
		// The stack's `flex-direction: column` is what put the description on a
		// second line; a row is flex's default, so the property is simply absent.
		expect(body).not.toContain("flex-direction");
	});

	it("charges the shortfall to the description, so the name is the last to give up room", () => {
		// Shrink is weighted by basis: a basis of 0 contributes nothing to the
		// split, so the description absorbs the whole overflow before the name —
		// the command's identity, and the string being scanned for — narrows at all.
		expect(declarations(ruleBody(".piem-chat__command-menu-desc"))).toContain("flex: 1 1 0");
		expect(declarations(ruleBody(".piem-chat__command-menu-name"))).toContain("flex: 0 1 auto");
	});

	it("clips both flexible spans, which is what lets them shrink and what draws the ellipsis", () => {
		/*
		 * `overflow: hidden` is the load-bearing declaration, and it does two jobs:
		 * it zeroes the flex item's automatic minimum size — otherwise the content
		 * width, which is why a nowrap span classically refuses to shrink and pushes
		 * the row wide — and it gives `text-overflow` something to draw into.
		 *
		 * Measured in Chromium across four variants of the description rule: with
		 * `overflow: hidden` and no `min-width: 0` the layout is byte-identical to
		 * the shipped one (desc 170px, ellipsized, row intact); with `min-width: 0`
		 * and no `overflow: hidden` the width is constrained but nothing clips, so
		 * the text paints across the trailing tag; with neither the span takes its
		 * full 461px and the row overflows. So `min-width: 0` is pinned here as the
		 * explicit statement of intent, not as a load-bearing value.
		 */
		for (const selector of [".piem-chat__command-menu-desc", ".piem-chat__command-menu-name"]) {
			const body = declarations(ruleBody(selector));
			expect(body).toContain("overflow: hidden");
			expect(body).toContain("text-overflow: ellipsis");
			expect(body).toContain("white-space: nowrap");
			expect(body).toContain("min-width: 0");
		}
	});

	it("pins the kind tag to the trailing edge even when the row has no description", () => {
		// With a description present the growing middle claims the free space and
		// this margin resolves to zero; without one it is the only thing holding the
		// trailing column, and the rendered check above covers both cases.
		const body = declarations(ruleBody(".piem-chat__command-menu-kind"));

		expect(body).toContain("margin-left: auto");
		expect(body).toContain("flex-shrink: 0");
	});

	it("keeps the row's two gaps unequal, which is what makes it read as a pair plus an aside", () => {
		// The defect being fixed was equal spacing, so the fix is not merely "one
		// line" — the name/description pair is tighter than the run-up to the
		// trailing tag (8px against 8+4), and collapsing that padding would restore
		// the monotone the stack had.
		expect(declarations(ruleBody(".piem-chat__command-menu-button"))).toContain("gap: var(--size-4-2)");
		expect(declarations(ruleBody(".piem-chat__command-menu-kind"))).toContain("padding-left: var(--size-4-1)");
	});

	it("leaves no rule behind for the wrapper the stack needed", () => {
		// The heading span that paired name with kind is gone from the markup; a
		// rule still matching it would be dead weight the next reader has to price.
		expect(styles).not.toContain("command-menu-heading");
	});
});

describe("typing dots (issue #86)", () => {
	/*
	 * The pending-reply indicator is three empty spans whose only signal is a
	 * bouncing animation. Without a fill they are transparent, so the animation
	 * animated nothing and the placeholder vanished from the transcript — a
	 * rendering test under `bun test` cannot catch this, because happy-dom does
	 * not paint either. The fill rides `currentColor`, so the pending card's
	 * `color: var(--text-muted)` tints it and theme switches retint it for free.
	 */
	it("gives the dots a fill, tracked to the card's text colour", () => {
		const body = ruleBody(".piem-chat__typing-dot");

		expect(body).toContain("background: currentColor");
	});
});

describe("transcript text selection", () => {
	/*
	 * Obsidian's `app.css` sets `user-select: none` on `body` and hands it back
	 * only to its own surfaces, so a plugin view inherits `none` unless it says
	 * otherwise. Verified over CDP against the real `app.css`: before this rule
	 * every text block in the transcript came back unselectable and a drag
	 * produced an empty selection; after it, all eight blocks select, a
	 * double-click picks a word, and a sweep spanning two messages returns both.
	 */
	it("hands selection back to the transcript", () => {
		const body = ruleBody(".piem-chat__messages");

		expect(body).toMatch(/(^|[^-])user-select:\s*text/);
		// Obsidian ships the prefixed form on its own selectable surfaces; the
		// mobile app runs WKWebView builds that honour only that one.
		expect(body).toContain("-webkit-user-select: text");
	});

	/*
	 * Selection inherits, so the scroll container is the only place that has to
	 * state it — and stating it there keeps a two-message sweep a single range.
	 * Repeating it per text block would fragment that and invite drift.
	 */
	it("states it once on the container, not per text block", () => {
		for (const selector of [".piem-chat__text", ".piem-chat__text--prose", ".piem-chat__markdown pre"]) {
			expect(declarations(ruleBody(selector))).not.toContain("user-select");
		}
	});

	/*
	 * A declaration always beats an inherited value, so the disclosure rows keep
	 * their own `none`: double-clicking one opens it, and selecting the label
	 * under the cursor at the same time is not what that gesture means.
	 */
	it("leaves the disclosure rows drag-free", () => {
		expect(ruleBody(".piem-chat__trace-summary")).toContain("user-select: none");
	});

	/*
	 * Obsidian's reading view sets `user-select` alone. The transcript is a mixed
	 * surface — prose, disclosure rows, icon buttons — so an I-beam across all of
	 * it would misdescribe the parts that are not text.
	 */
	it("does not claim an I-beam over the whole surface", () => {
		// Declarations only: the rule's own comment names `cursor: text` to record
		// why it is absent, and a raw substring check would read that as present.
		expect(declarations(ruleBody(".piem-chat__messages"))).not.toContain("cursor:");
	});
});

describe("hover on touch (Obsidian's own convention)", () => {
	/*
	 * A tap latches `:hover` onto the tapped element until the next tap lands
	 * somewhere else, so an ungated hover rule renders as a stuck "active" state on
	 * a phone — and this plugin ships `isDesktopOnly: false`. Obsidian answers this
	 * by wrapping every one of its own hover rules in `@media (hover: hover)`; there
	 * are 123 such blocks in `app.css`. These gates hold the panel to that.
	 */
	it("gates every :hover rule behind a hover-capable pointer", () => {
		const ungated: string[] = [];
		// Top-of-line selectors only: anything indented already sits inside a block,
		// and `gatingBlockFor` is what proves which block that is.
		for (const match of allDeclarations.matchAll(/^(\S[^{\n]*:hover[^{\n]*)\{/gm)) {
			const selector = (match[1] ?? "").trim();
			if (selector !== "" && gatingBlockFor(selector) === null) ungated.push(selector);
		}

		expect(ungated).toEqual([]);
	});

	it("leaves focus states ungated, so they survive on touch", () => {
		// The counterpart to the rule above: if a later edit sweeps focus into the
		// media query alongside hover, keyboard users lose the affordance on mobile.
		for (const selector of [".piem-chat__message-actions:focus-within", ".piem-chat__context-chip:focus-within .piem-chat__context-action"]) {
			expect(gatingBlockFor(selector)).toBeNull();
		}
	});
});

describe("narrow-panel layout is keyed on the panel, not the window", () => {
	/*
	 * This view opens in a side leaf, so viewport width says nothing about how much
	 * room the panel has. As an `@media (max-width: 32rem)` query the narrow layout
	 * was unreachable on every desktop — a 300px sidebar on a 1920px display does
	 * not match — and fired only on a phone, where the sidebar is `100vw` and the
	 * two measurements coincide. Obsidian uses `@container` for exactly this, in
	 * four blocks in `app.css`.
	 */
	it("declares the panel shell as the named query container", () => {
		const body = ruleBody(".piem-chat");

		expect(body).toContain("container-type: inline-size");
		// Named, or the query can bind to one of Obsidian's anonymous containers —
		// `.vertical-tab-content` is one, and it is an ancestor of the settings half.
		expect(body).toContain("container-name: piem-chat");
	});

	it("queries that container rather than the viewport", () => {
		expect(allDeclarations).toContain("@container piem-chat (max-width: 32rem)");
	});

	it("has no viewport-width breakpoint left anywhere", () => {
		// The regression this guards is silent: a `max-width` media query still
		// parses, still reads correctly in review, and simply never matches in a leaf.
		const viewportWidthQueries = [...allDeclarations.matchAll(/@media[^{]*\b(?:max|min)-width\b[^{]*/g)].map((match) => match[0].trim());

		expect(viewportWidthQueries).toEqual([]);
	});
});

describe("type ramp scales as one unit (WCAG 1.4.4)", () => {
	/*
	 * On mobile Obsidian rebinds the UI scale to the reader's note size:
	 * `.is-mobile` sets `--font-ui-medium: var(--font-text-size)` and derives the
	 * other two from it, so a phone at 20px notes draws this panel at 20/18.7/16.
	 * A hardcoded px here would be the one element that refuses to follow that — a
	 * resize-text failure surfacing only on a device none of these tests run on.
	 */
	it("takes every font-size from the --font-ui-* ramp", () => {
		const allowed = new Set(["var(--font-ui-smaller)", "var(--font-ui-small)", "var(--font-ui-medium)", "var(--font-ui-large)", "inherit"]);
		const offenders = [...allDeclarations.matchAll(/font-size:\s*([^;]+);/g)].map((match) => (match[1] ?? "").trim()).filter((value) => !allowed.has(value));

		expect(offenders).toEqual([]);
	});

	it("never reads --font-text-size directly", () => {
		// It is the *note* body size. Reaching for it would size the panel off the
		// reading scale on desktop, where the UI scale is deliberately independent.
		expect(allDeclarations).not.toContain("--font-text-size");
	});

	it("pairs the transcript with the panel title on one token", () => {
		// The bug this fixed was the reply rendering a step *above* the title, so the
		// two have to move together — which means reading from the same token.
		expect(ruleBody(".piem-chat__message-content")).toContain("font-size: var(--font-ui-medium)");
		expect(ruleBody(".piem-chat__title")).toContain("font-size: var(--font-ui-medium)");
	});
});

describe("z-index falls back to Obsidian's own layer value", () => {
	/*
	 * `--layer-menu` is 65 in `app.css`. The fallback these rules used to carry was
	 * `10`, which is `--layer-sidedock` — so on any theme that drops the token, a
	 * popover tied with the sidebar it lives in and lost to everything above it.
	 * A wrong fallback is invisible until the one theme that omits the token.
	 */
	it("uses 65, not a lower layer's value", () => {
		const fallbacks = [...allDeclarations.matchAll(/var\(--layer-menu,\s*([^)]+)\)/g)].map((match) => (match[1] ?? "").trim());

		expect(fallbacks.length).toBeGreaterThan(0);
		expect([...new Set(fallbacks)]).toEqual(["65"]);
	});
});


describe("scanner compatibility: hiding layers and the composer ring (issue #204)", () => {
	/*
	 * The official scanner flags `:has()` (broad invalidation) and, for Obsidian
	 * 1.11.4, `clip-path` (partial support). The composer ring keys on
	 * `:focus-within`; the skip link and the screen-reader-only clip hide through
	 * the classic `clip: rect(0 0 0 0)` box — usable back before `clip-path`
	 * existed — with `clip-path` kept as the modern rider, and focus releases
	 * both. The negative `:has` check runs over the whole file including
	 * comments: the scanner reads the raw text, so even a comment that names it
	 * would count as a hit.
	 */
	it("the composer ring keys on :focus-within, and the stylesheet has no :has anywhere", () => {
		expect(ruleBody(".piem-chat__composer-shell:focus-within")).toContain(
			"box-shadow: 0 0 0 1px var(--background-modifier-border-focus)",
		);
		expect(styles).not.toMatch(/:has\(/);
	});

	it("the skip link hides through both clip layers and focus releases both", () => {
		const hidden = ruleBody(".piem-chat__skip-link");
		// `clip` only works on a positioned box — the guard that makes it real.
		expect(hidden).toContain("position: absolute");
		expect(hidden).toContain("clip: rect(0 0 0 0)");
		expect(hidden).toContain("clip-path: inset(50%)");

		const revealed = ruleBody(".piem-chat__skip-link:focus");
		expect(revealed).toContain("clip: auto");
		expect(revealed).toContain("clip-path: none");
	});

	it("the screen-reader-only clip stands without clip-path support", () => {
		const body = ruleBody(".piem-chat__visually-hidden");
		expect(body).toContain("position: absolute");
		expect(body).toContain("clip: rect(0 0 0 0)");
		expect(body).toContain("clip-path: inset(50%)");
	});
});

describe("scanner compatibility: hiding layers and the composer ring (issue #204)", () => {
	/*
	 * The official scanner flags `:has()` (broad invalidation) and, for Obsidian
	 * 1.11.4, `clip-path` (partial support). The composer ring keys on
	 * `:focus-within`; the skip link and the screen-reader-only clip hide through
	 * the classic `clip: rect(0 0 0 0)` box — usable back before `clip-path`
	 * existed — with `clip-path` kept as the modern rider, and focus releases
	 * both. The negative `:has` check runs over the whole file including
	 * comments: the scanner reads the raw text, so even a comment that names it
	 * would count as a hit.
	 */
	it("the composer ring keys on :focus-within, and the stylesheet has no :has anywhere", () => {
		expect(ruleBody(".piem-chat__composer-shell:focus-within")).toContain(
			"box-shadow: 0 0 0 1px var(--background-modifier-border-focus)",
		);
		expect(styles).not.toMatch(/:has\(/);
	});

	it("the skip link hides through both clip layers and focus releases both", () => {
		const hidden = ruleBody(".piem-chat__skip-link");
		// `clip` only works on a positioned box — the guard that makes it real.
		expect(hidden).toContain("position: absolute");
		expect(hidden).toContain("clip: rect(0 0 0 0)");
		expect(hidden).toContain("clip-path: inset(50%)");

		const revealed = ruleBody(".piem-chat__skip-link:focus");
		expect(revealed).toContain("clip: auto");
		expect(revealed).toContain("clip-path: none");
	});

	it("the screen-reader-only clip stands without clip-path support", () => {
		const body = ruleBody(".piem-chat__visually-hidden");
		expect(body).toContain("position: absolute");
		expect(body).toContain("clip: rect(0 0 0 0)");
		expect(body).toContain("clip-path: inset(50%)");
	});
});

/*
 * A ring nobody can see is a keyboard user with no idea where they are, which is
 * why these sit here rather than beside the layout gates: WCAG 2.4.11 asks that
 * the focus indicator be *visible*, and a scroll container is the one thing in
 * this stylesheet that can take it away after the fact.
 *
 * The mechanism, once, since four rules answer to it: a scroll container paints
 * nothing outside its padding box, `overflow-y: auto` drags the inline axis into
 * `auto` with it (CSS computes a `visible` axis to `auto` when its partner is
 * not `visible`), and a focus ring is drawn *outside* the control's border box —
 * 2px at 1px offset for this file's own rings, 3px for the fields Obsidian
 * styles. Any control flush with such a box's edge therefore loses its ring on
 * that side, which is what #219's first two screenshots caught in the MCP form:
 * 3px of ring down the left edge of a focused field against 1px down its right.
 *
 * Two answers, chosen by who owns the ring. Where it is Obsidian's, the box
 * reserves the band (`padding`) and hands the same distance back to the layout
 * (a negative margin), because redrawing the host's focus treatment from a
 * plugin stylesheet is not a repair. Where both the scroller and the ring are
 * ours, the ring moves inside the border box instead and no geometry changes.
 *
 * The measurement is in the comments on each rule; it was taken in Chromium
 * against the real stylesheet, with the reserve ablated to confirm the clip
 * comes back.
 */
describe("focus rings survive their scroll container (issue #219)", () => {
	/** The band a rule reserves, read back from its own `padding`. */
	function reservedBand(selector: string): number {
		const body = declarations(ruleBody(selector));
		const padding = /padding:\s*(\d+)px\s*;/.exec(body)?.[1];
		if (padding === undefined) throw new Error(`${selector} reserves no uniform padding band`);
		return Number(padding);
	}

	/*
	 * `>= 3` rather than `=== 3`: the number has to cover the widest ring the box
	 * can hold, and the two rings in play are both exactly 3px. A theme with a
	 * fatter ring loses only the excess, which is the failure this cannot fix
	 * from inside a plugin — but it must never be *narrower* than the rings this
	 * file draws itself.
	 */
	/*
	 * `.piem-ask-modal .piem-ask`, not `.piem-ask`. The question form renders in two
	 * frames now, and only one of them is a scroll box: in the transcript the
	 * scroller is `.piem-chat__messages`, which draws its ring inside its own border
	 * box already, and a second scroller nested inside it would trap the reader's
	 * wheel over the question they are scrolling past. So the bound — and therefore
	 * the band — belongs to the dialog alone.
	 */
	for (const selector of [".piem-settings-modal", ".piem-ask-modal .piem-ask"]) {
		it(`reserves the ring's band inside ${selector}, without moving the content box`, () => {
			const band = reservedBand(selector);
			expect(band).toBeGreaterThanOrEqual(3);
			// Equal and opposite: the scrollport grows outward, the content box
			// stays put. Without this the rows would sit `band` px right of the
			// modal title, which is a sibling of the scroll box and does not move.
			expect(declarations(ruleBody(selector))).toContain(`margin-inline: -${band}px`);
		});
	}

	/*
	 * The modal footers stick. `bottom: 0` pins the footer's border box — padding
	 * and all — to the scrollport's bottom edge, so the box's own reserve stops
	 * covering Save at exactly the point the form is long enough to scroll.
	 */
	it("gives the sticky footer its own band, inside the row", () => {
		const band = reservedBand(".piem-settings-modal");
		expect(declarations(ruleBody(".piem-settings-modal .piem-settings-modal-footer"))).toContain(`padding-block-end: ${band}px`);
		expect(declarations(ruleBody(".piem-settings-modal .piem-settings-modal-footer"))).toContain("position: sticky");
	});

	/*
	 * The chips' controls set the height of a row that scrolls, so they are flush
	 * with its top and bottom edges. Both the ring and the scroller are ours, so
	 * the ring is drawn inside the border box — the treatment `.piem-chat__messages`
	 * and `.piem-chat__trace-summary` already use for the same reason.
	 */
	it("insets the ring where both the scroller and the ring are ours", () => {
		for (const selector of [
			".piem-chat__context-row .piem-chat__icon-button:focus-visible",
			".piem-chat__trace-summary:focus-visible",
			".piem-chat__messages:focus-visible",
		]) {
			expect(declarations(ruleBody(selector))).toContain("outline-offset: -2px");
		}
	});
});

/*
 * A link to a note that does not exist marks itself, and the mark is a line
 * rather than less of anything.
 *
 * Two guidelines meet on this one rule. 1.4.3 is the reason the colour cannot
 * move: measured in a real 1.13.7, Obsidian's accent reads 4.26:1 on the light
 * theme's white at the panel's 15px — already under the 4.5:1 that normal-size
 * text needs, so the state has no contrast to spend, and Obsidian's own
 * `--link-unresolved-opacity: 0.7` would take it to roughly 3.1. 1.4.1 is the
 * reason a line works where a hue would not: the dash is a shape, so it survives
 * a reader who cannot separate the two colours at all.
 *
 * The rule is also the state's only styling. The reading view's own
 * `.markdown-rendered .internal-link.is-unresolved` wants an ancestor this panel
 * does not have, so nothing here can be left to inherit.
 */
describe("an unresolved link marks itself with a line, not with less contrast (WCAG 1.4.1 / 1.4.3)", () => {
	const unresolved = declarations(ruleBody(".piem-chat__markdown a.internal-link.is-unresolved"));

	it("dashes the underline", () => {
		expect(unresolved).toContain("text-decoration-style: dashed");
	});

	it("spends no contrast on the state", () => {
		// `color:` matched loosely would also hit `text-decoration-color`, which is a
		// legitimate thing to add later; only a bare `color` is forbidden.
		expect(unresolved).not.toMatch(/(?:^|[\s;])color\s*:/);
		expect(unresolved).not.toContain("opacity");
	});

	it("states the line rather than inheriting one a theme may have switched off", () => {
		// `--link-decoration: none` is a shipped value in Obsidian's own CSS, and
		// under it there would be no underline for `dashed` to be a variant of.
		expect(unresolved).toContain("text-decoration-line: underline");
	});

	it("clears the descenders, so the mark cannot read as strikethrough", () => {
		// At the browser's `auto` the `y` in a link named "Weekly Review" cuts through
		// the dashes and the word reads as struck out; 0.2em was measured to clear it
		// and 0.12em was measured not to.
		expect(unresolved).toMatch(/text-underline-offset:\s*0\.2em/);
		expect(unresolved).toContain("text-decoration-thickness: 1px");
	});
});
