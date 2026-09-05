/**
 * Static gate against a CSS animation naming keyframes that are not there.
 *
 * `animation: piem-breathe 1.8s ease-in-out infinite` on a name nothing defines
 * is not an error in CSS. It is not a warning either. The declaration parses, the
 * element renders, and the animation simply never runs — so the only way to
 * notice is to look at the pixels of the one state that was supposed to move, in
 * the one theme, at the one moment it was supposed to move in.
 *
 * That is not hypothetical. `piem-subagent-breathe` was renamed to `piem-breathe`
 * when a second surface started sharing it, and the rename missed
 * `.piem-chat__subagents-button--running .piem-chat__subagents-icon` — a third
 * consumer that had been borrowing the subagent panel's keyframes from outside
 * that panel. Its icon stopped breathing. Every test passed, `eslint` passed,
 * `tsc` passed, the bundle gate passed, and the screenshot of that button looked
 * correct, because a still frame of a paused breath and a still frame of a
 * running one are the same picture. It was caught by reading
 * `document.getAnimations()` in a headless browser, which is not something a repo
 * can be expected to do on every change.
 *
 * So the gate is mechanical and reads both directions:
 *
 * - An `animation` or `animation-name` naming keyframes with no `@keyframes`
 *   block. This is the defect above: silent, and invisible to every other check.
 * - A `@keyframes` block nothing names. The same drift from the other end — the
 *   half of a rename that got done, leaving dead frames that read as live
 *   vocabulary to the next person deciding whether a new animation exists yet.
 *
 * ## What is deliberately not a violation
 *
 * - **Comments.** This file's own header names `piem-subagent-breathe`, and the
 *   stylesheet's comments discuss animations constantly. Comments are stripped
 *   before parsing, with their newlines kept so line numbers stay honest.
 * - **`animation-delay`, `animation-play-state`, and the rest of the longhands.**
 *   Only `animation` and `animation-name` carry a keyframes name.
 * - **`animation: none`** and every other shorthand keyword, timing value,
 *   easing function, and iteration count. What is left after those is the name.
 * - **A name behind `var()`.** Nothing static can resolve it, so it is reported
 *   in the summary as unresolved rather than failed — a gate that guesses is a
 *   gate that gets switched off.
 */
import { readFileSync } from "node:fs";
import process from "node:process";

/** Stylesheets to check. The plugin ships exactly one. */
const FILES = process.argv.length > 2 ? process.argv.slice(2) : ["styles.css"];

/**
 * Shorthand values that are not a keyframes name.
 *
 * The `animation` shorthand takes its components in any order, so the name
 * cannot be found by position — it is whatever is left once everything with a
 * fixed vocabulary is removed.
 */
const SHORTHAND_KEYWORDS = new Set([
	// timing-function
	"ease", "ease-in", "ease-out", "ease-in-out", "linear", "step-start", "step-end",
	// iteration-count
	"infinite",
	// direction
	"normal", "reverse", "alternate", "alternate-reverse",
	// fill-mode
	"none", "forwards", "backwards", "both",
	// play-state
	"running", "paused",
	// CSS-wide
	"inherit", "initial", "unset", "revert", "revert-layer",
]);

/** A time (`1.8s`, `-0.9s`, `250ms`) or a bare iteration count. */
const NUMERIC = /^-?[\d.]+(m?s)?$/;

/**
 * Comments out, newlines kept.
 *
 * Replacing each non-newline character with a space preserves both offsets and
 * line breaks, so a match's line number is the line a person will open.
 */
function stripComments(css) {
	return css.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
}

function lineOf(text, index) {
	let line = 1;
	for (let cursor = 0; cursor < index; cursor += 1) {
		if (text[cursor] === "\n") {
			line += 1;
		}
	}
	return line;
}

/** Every `@keyframes` block's name, vendor prefixes included. */
function definitions(css) {
	const found = new Map();
	for (const match of css.matchAll(/@(?:-\w+-)?keyframes\s+([\w-]+)/g)) {
		const name = match[1];
		if (!found.has(name)) {
			found.set(name, lineOf(css, match.index));
		}
	}
	return found;
}

/**
 * Every keyframes name an `animation` or `animation-name` declaration asks for.
 *
 * The longhand alternative is listed first so `animation-name:` matches it rather
 * than backtracking through `animation`, and the preceding character class is
 * what keeps `animation-delay:` out: after `animation` comes `-delay`, not a
 * colon.
 */
function references(css) {
	const found = [];
	const unresolved = [];
	for (const match of css.matchAll(/(?:^|[;{}])\s*(animation-name|animation)\s*:\s*([^;{}]*)/gi)) {
		const value = match[2];
		const line = lineOf(css, match.index);
		if (value.includes("var(")) {
			unresolved.push({ line, value: value.trim() });
			continue;
		}
		// Functions (`cubic-bezier(0.16, 1, 0.3, 1)`, `steps(4, end)`) hold spaces
		// and commas of their own, so they go before anything is split.
		const flattened = value.replace(/[\w-]+\([^)]*\)/g, " ");
		for (const layer of flattened.split(",")) {
			for (const token of layer.trim().split(/\s+/)) {
				if (!token || SHORTHAND_KEYWORDS.has(token.toLowerCase()) || NUMERIC.test(token)) {
					continue;
				}
				found.push({ name: token, line });
			}
		}
	}
	return { found, unresolved };
}

const failures = [];
let defined = 0;
let referenced = 0;
let unresolvedCount = 0;

for (const file of FILES) {
	const css = stripComments(readFileSync(file, "utf8"));
	const defs = definitions(css);
	const { found, unresolved } = references(css);
	defined += defs.size;
	referenced += found.length;
	unresolvedCount += unresolved.length;

	for (const { name, line } of found) {
		if (defs.has(name)) {
			continue;
		}
		failures.push({
			at: `${file}:${line}`,
			what: `animation names "${name}", which no @keyframes block defines`,
			why:
				`CSS does not complain about this: the rule parses and the element simply never animates. ` +
				`Either the keyframes were renamed and this reference was missed, or the name is a typo. ` +
				`Defined here: ${[...defs.keys()].sort().join(", ") || "(none)"}.`,
		});
	}

	const used = new Set(found.map((reference) => reference.name));
	for (const [name, line] of defs) {
		if (used.has(name)) {
			continue;
		}
		failures.push({
			at: `${file}:${line}`,
			what: `@keyframes ${name} is defined and never named`,
			why:
				`The other half of the same drift: a rename that updated the definition and not its callers ` +
				`leaves frames that animate nothing, and they read as available vocabulary to whoever asks next ` +
				`whether this animation already exists. Delete them, or wire them up.`,
		});
	}
}

if (failures.length > 0) {
	console.error(`check-css: ${failures.length} animation name(s) with no counterpart\n`);
	for (const failure of failures) {
		console.error(`  ✗ ${failure.at}  ${failure.what}`);
		console.error(`    ${failure.why}\n`);
	}
	process.exit(1);
}

const unresolvedNote = unresolvedCount > 0 ? `, ${unresolvedCount} behind var() and unchecked` : "";
console.log(
	`check-css: ${FILES.join(", ")} clean (${defined} @keyframes, ${referenced} reference(s) all resolved${unresolvedNote})`,
);
