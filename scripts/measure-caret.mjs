/*
 * Asserts the streaming caret sits on the text's visual centre, in a real engine.
 *
 * Sibling of `measure-transcript.mjs`. The stylesheet tests assert declarations;
 * this asserts a consequence no amount of reading CSS answers. `vertical-align:
 * text-bottom` looks like the obvious way to seat a caret against a line — but it
 * aligns to the font's descent box, not the glyphs, and CJK faces carry generous
 * descent. The shipped value let the caret hang ~3.5px below centre at 20px: the
 * eye reads that as "caret on the line below", and nothing declarative catches it.
 *
 * The measurement renders the real `MarkdownText` with `isStreaming` on, removes
 * the live class long enough to append a zero-height baseline probe and a clone
 * of the caret's own geometry, and compares the caret's centre to the *inked*
 * centre of the last line — `actualBoundingBoxAscent/Descent`, not the em box,
 * because the em box is exactly the lie text-bottom tells.
 *
 * Faces: three are named because the offset moves with the font's descent, and
 * the repo cannot ship one value that is perfect everywhere — `-0.185em` is the
 * min-max pick across these three at 15px and 20px (worst case 1.3px, tolerance
 * 2px). A machine whose CJK face has different metrics than any of these can
 * drift differently; this harness proves the *mechanism* (baseline anchoring,
 * not descent-anchoring) and the tuned value's local behaviour, which is what a
 * declaration-level test could never reach.
 *
 * Not a test and not shipped — needs Chromium, so it stays out of `verify`.
 * Run: bun scripts/measure-caret.mjs (bun, not node: it imports the TSX fixture).
 * Under a snap-packaged Chromium in an agent worktree, export CHROME to a
 * build it can read and PREVIEW_DIR to a non-hidden path, as in the siblings.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";

const CHROME = process.env.CHROME ?? "/usr/bin/chromium-browser";
const OUT_DIR = process.env.PREVIEW_DIR ?? ".preview";

const { installObsidianStub } = await import("../src/testUtils/obsidianStub.ts");
installObsidianStub();
const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { MarkdownText } = await import("../src/ui/MarkdownText.tsx");

const styles = readFileSync("styles.css", "utf8");

/*
 * The languages the caret actually trails. `mixed` matters on its own: a
 * mid-stream line that switches script mid-sentence picks the metrics of
 * whichever run the engine measured last, and a caret tuned for pure CJK can
 * still sit wrong there.
 */
const CASES = [
	["zh", "成功写入部分中文\n已完成清单："],
	["en", "Saved the first notes\nWriting the list:"],
	["mixed", "笔记 notes 已写入，正在生成清单："],
];

/*
 * Whatever `styles.css` says the caret aligns to is what this measures — the
 * harness overrides nothing, so retuning the value here means retuning the
 * assertion's verdict, which is the failure mode a fixture copy would invite.
 */
const panels = CASES.flatMap(([name, text]) =>
	[15, 20].flatMap((fontSize) =>
		['sans-serif', '"Droid Sans Fallback", sans-serif', '"WenQuanYi Zen Hei", sans-serif'].map((font) =>
			`<section data-case="${name}-${fontSize}" style="--font-ui-medium:${fontSize}px;--font-interface:${font};font-family:${font}">` +
			renderToStaticMarkup(
				React.createElement(MarkdownText, { text, kind: "assistant", isStreaming: true, className: "piem-chat__block--live", app: {}, component: {}, sourcePath: "" }),
			) +
			"</section>",
		),
	),
);

const page = `<!doctype html><meta charset="utf-8"><style>
body { margin:24px; color:#222; line-height:1.5; }
section { margin:20px 0; width:300px; }
${styles}
.piem-chat__block--live::after { animation:none !important; }
</style>${panels.join("")}<pre id="results"></pre><script>
const results = [];
for (const section of document.querySelectorAll("section")) {
	const pre = section.querySelector("pre");
	const lastLine = pre.textContent.split("\\n").at(-1);
	const style = getComputedStyle(pre);

	// A stand-in carrying the caret's every geometry declaration, so the
	// measurement reads what ships rather than a restatement of it.
	const after = getComputedStyle(pre, "::after");
	const caret = document.createElement("span");
	for (const key of ["display", "width", "height", "margin-inline-start", "background-color", "vertical-align", "font", "line-height", "transform", "position", "top", "bottom", "padding", "border"]) {
		caret.style.setProperty(key, after.getPropertyValue(key));
	}

	// A zero-height inline block anchored to the baseline marks it without
	// shifting anything; the caret is appended after the real text, as in life.
	const baseline = document.createElement("span");
	baseline.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
	pre.classList.remove("piem-chat__block--live");
	pre.append(baseline, caret);

	const metrics = document.createElement("canvas").getContext("2d");
	metrics.font = style.font;
	const m = metrics.measureText(lastLine);
	const base = baseline.getBoundingClientRect().top;
	const box = caret.getBoundingClientRect();
	results.push({
		name: section.dataset.case,
		font: style.fontFamily,
		verticalAlign: after.verticalAlign,
		// Positive means the caret sits low of centre.
		centerOffset: (box.top + box.bottom - (base - m.actualBoundingBoxAscent) - (base + m.actualBoundingBoxDescent)) / 2,
	});
}
document.getElementById("results").textContent = JSON.stringify(results);
</script>`;

mkdirSync(OUT_DIR, { recursive: true });
const pagePath = resolve(OUT_DIR, "caret.html");
writeFileSync(pagePath, page);

const dom = execFileSync(
	CHROME,
	["--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--virtual-time-budget=3000", "--dump-dom", `file://${pagePath}`],
	{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
);
const payload = dom.match(/<pre[^>]*id="results"[^>]*>([\s\S]*?)<\/pre>/)?.[1];
if (!payload) {
	throw new Error(
		dom.includes("ERR_ACCESS_DENIED") || dom.includes("ERR_FILE_NOT_FOUND")
			? `Chromium could not read ${pagePath}. Snap confinement covers non-hidden paths under $HOME only:\n  PREVIEW_DIR=~/piem-preview CHROME=<build> bun scripts/measure-caret.mjs`
			: "the page did not report caret measurements; its inline script never ran",
	);
}
const results = JSON.parse(payload.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));

const TOLERANCE_PX = 2;
const failures = [];
for (const row of results) {
	if (Math.abs(row.centerOffset) > TOLERANCE_PX) {
		failures.push(`${row.name} (${row.font}): caret sits ${row.centerOffset > 0 ? "below" : "above"} centre by ${Math.abs(row.centerOffset).toFixed(2)}px, vertical-align ${row.verticalAlign}`);
	}
}
if (results.length === 0) {
	failures.push("no carets were measured — the fixture went missing and this harness is asserting nothing");
}
for (const failure of failures) {
	console.error(`✗ ${failure}`);
}
if (failures.length) {
	process.exit(1);
}
console.log(`✓ ${results.length} streaming carets sit within ${TOLERANCE_PX}px of their text's visual centre (worst ${Math.max(...results.map((r) => Math.abs(r.centerOffset))).toFixed(2)}px)`);
