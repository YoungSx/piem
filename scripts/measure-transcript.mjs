/*
 * Asserts what the transcript's layout actually comes out as, in a real engine.
 *
 * Sibling of `measure-command-menu.mjs`. The stylesheet tests assert
 * declarations; this asserts consequences no amount of reading CSS answers.
 * Two of them, on one axis each.
 *
 * Horizontally: a fenced block, a wide table or a pasted screenshot must not drag
 * the message column sideways on a phone. Whether `max-width: 100%` bites depends
 * on whether an ancestor's automatic minimum size already grew, which only a
 * layout engine knows. The two checks there are not the same check twice:
 *
 *   - The transcript must not scroll sideways. That is the symptom.
 *   - Every element wider than the panel must sit inside something that scrolls.
 *     That is what stops the fix from being a lie: clipping the transcript with
 *     `overflow-x: hidden` and nothing else would satisfy the first check while
 *     making a wide table permanently unreadable.
 *
 * Vertically: the gap between two rows must not depend on how `pi` split the turn
 * into messages. A turn arrives as prose in an assistant message, a tool result as
 * a row of its own, the next sentence in another message — and `MessageRow` wraps
 * the first and third in `article.piem-chat__message` while returning the second
 * as a bare trace row. Every boundary between them still has to read as one 8px
 * gap, and the blocks inside one message as 4px.
 *
 * This half is here because its faults are invisible in a declaration. What
 * shipped was an 8px block padding on the article — spacing between rows, spent
 * inside one, so only the wrapped row kinds had it — plus two edge rules meant to
 * keep a message from spending margin on its outer faces, which tied the trace
 * row's own `margin-block` on specificity and lost on source order, 500 lines
 * apart in the file. Every declaration was correct and every value was the one
 * intended; the sums were 4px, 20px and 32px depending on which boundary you
 * looked at, and a folded run closing a turn sat 32px above the reply that
 * followed it. Nothing but computed geometry catches a rule that is right and
 * outranked.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const CHROME = process.env.CHROME ?? "/usr/bin/chromium-browser";
const PAGE = resolve(process.env.PREVIEW_DIR ?? ".preview", "transcript.html");

readFileSync(PAGE, "utf8"); // Fail loudly if the preview was never generated.

const dom = execFileSync(
	CHROME,
	["--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--virtual-time-budget=3000", "--dump-dom", `file://${PAGE}`],
	{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 },
);

const payload = dom.match(/<pre[^>]*id="results"[^>]*>([\s\S]*?)<\/pre>/)?.[1];
if (!payload) {
	const denied = dom.includes("ERR_ACCESS_DENIED") || dom.includes("ERR_FILE_NOT_FOUND");
	throw new Error(
		denied
			? `Chromium could not read ${PAGE}. A snap-packaged build is confined to non-hidden paths under $HOME, and this checkout is not one` +
				` — regenerate somewhere it can reach:\n  PREVIEW_DIR=~/piem-preview node scripts/preview-transcript.mjs\n` +
				`  PREVIEW_DIR=~/piem-preview node scripts/measure-transcript.mjs`
			: "the page did not report measurements; its inline script never ran",
	);
}
const panels = JSON.parse(payload.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));

/*
 * Below this the fixtures are genuinely wider than the column, so a scroller has
 * to exist. Above it the table fits and correctly scrolls nothing. 390px is the
 * phone from the issue; the widest fixture table measures ~440px, so both narrow
 * panels are covered and the 560px leaf is not asked for a scrollbar it should
 * not have.
 */
const NARROW_ENOUGH_TO_OVERFLOW = 400;

/*
 * The whole of the transcript's vertical vocabulary. Two numbers, and one question
 * decides which: does the conversation change footing across this boundary?
 *
 * 4px is a turn's own rhythm, and it is one number reached two ways on purpose —
 * a message hands its blocks a margin (`.piem-chat__message-content` is block
 * flow, which has no gap to give), the column hands its rows a `gap`, and they
 * agree because a reader must not be able to tell which boundary is which. `pi`
 * decides where a turn splits into messages; that decision is not information.
 *
 * 16px is that gap plus the 12px a question or a tidying seam adds on both
 * faces — the two boundaries in this column that mark meaning rather than
 * delivery. A third number means something has started spending spacing of its
 * own again.
 */
const WITHIN_TURN = 4;
const ACROSS_SPEAKERS = 16;

/*
 * The vertical bound on machine traffic, in pixels at the harness's root size.
 *
 * Stated as a number rather than read back off the element, because reading the
 * computed value and then asserting it matches itself is the check that let this
 * bound ship unmeasured: the stylesheet test already pins the declaration, and
 * what this harness adds is whether the cap *bites*. So the number is repeated
 * here on purpose, and the assertion below is about clipping, not about the cap.
 */
const BOUNDED_BODY_PX = 288;

const failures = [];
for (const panel of panels) {
	/*
	 * Asserted at all three widths, though nothing in the container queries touches
	 * spacing: that is exactly why it is cheap to check, and a narrow-panel rule
	 * that started to would be caught the day it landed rather than on a phone.
	 */
	for (const step of panel.rhythm ?? []) {
		const kind = step.speakerChange
			? { want: ACROSS_SPEAKERS, name: "a boundary where the speaker changes" }
			: {
					want: WITHIN_TURN,
					// Named for which boundary it is so a failure says whether the message
					// margin or the column gap drifted, even though both owe the same 4px.
					name: step.withinMessage ? "two blocks of one message" : "two rows of one turn",
				};
		if (Math.abs(step.gap - kind.want) > 0.5) {
			failures.push(`${panel.panel}: ${step.from} → ${step.to} sits ${step.gap}px apart, but ${kind.name} is ${kind.want}px`);
		}
	}
	if ((panel.rhythm ?? []).length === 0) {
		failures.push(`${panel.panel}: no rhythm pairs were measured — the fixture or its data-rhythm marks went missing, and the vertical half of this harness is asserting nothing`);
	}
	/*
	 * The vertical bound, which until now was asserted only as a declaration in
	 * `traceBodyBound.test.ts` and measured by nothing. A cap that never bites is
	 * invisible to that test and to every screenshot: the fixtures it had were one
	 * and two lines long, so nothing in this page ever reached eighteen rem.
	 *
	 * Three questions, because the bound is a pair and the exemption is a third
	 * thing: does the cap resolve to the height it claims, does the box actually
	 * clip its content, and does the row that must stay unbounded stay unbounded.
	 */
	for (const box of panel.bounds ?? []) {
		/*
		 * A seam bounds its own box at its own number, for a reason that is not this
		 * one — so it is neither asserted against the machine-traffic bound nor held
		 * to the live row's exemption. Skipped rather than absent from the report,
		 * because a seam that lost its bound entirely is a fault this page would
		 * otherwise be the natural place to catch, and the count below says how many
		 * bodies were considered.
		 */
		if (box.ownBound) {
			continue;
		}
		if (box.shouldBound) {
			if (box.maxHeight !== BOUNDED_BODY_PX) {
				failures.push(`${panel.panel}: ${box.case} — its body caps at ${box.maxHeight ?? "nothing"}px, but the machine-traffic bound is ${BOUNDED_BODY_PX}px`);
				continue;
			}
			/*
			 * The cap is only *demonstrably* working on a body that holds more than it
			 * allows. The short fixtures on this page are shorter than any bound and
			 * correctly scroll nothing; demanding a scrollbar from them would fail the
			 * rows that are right. The tall fixtures are the witnesses, and the count
			 * below is what stops them from going missing unnoticed.
			 */
			if (box.overflows && !box.clips) {
				failures.push(
					`${panel.panel}: ${box.case} — the ${BOUNDED_BODY_PX}px cap is declared but does not bite: ${box.scrollHeight}px of content sits in a ${box.clientHeight}px box with overflow-y ${box.overflowY}`,
				);
			}
			continue;
		}
		/*
		 * The live row's exemption, asserted as a consequence too. A cap here would
		 * park the newest sentences behind an inner scrollbar that the transcript's
		 * own follow-scroll can never reach, so this is the one body that must be
		 * able to grow past the bound.
		 */
		if (box.maxHeight !== null) {
			failures.push(`${panel.panel}: ${box.case} — a live think is capped at ${box.maxHeight}px, so following it would need a scrollbar the transcript cannot reach`);
		}
	}
	/*
	 * The witnesses have to exist. Every assertion above is vacuous on a page whose
	 * bodies are all shorter than the bound — which is exactly the state this page
	 * was in before the tall fixtures landed, and why a cap that never bit went
	 * unnoticed through every run of this harness. One clipped body per panel is
	 * the floor; three is what the fixtures provide.
	 */
	const witnesses = (panel.bounds ?? []).filter((box) => box.shouldBound && box.overflows);
	if (witnesses.length === 0) {
		failures.push(
			`${panel.panel}: no trace body on this page is taller than the ${BOUNDED_BODY_PX}px bound — the tall fixtures went missing, and the vertical bound is asserted by nothing again`,
		);
	}
	if (!(panel.bounds ?? []).some((box) => !box.shouldBound && !box.ownBound)) {
		failures.push(`${panel.panel}: no live thinking row was measured — the exemption from the bound is asserted by nothing`);
	}
	if (panel.panelScrollsSideways) {
		const blame = panel.pushers.map((p) => `${p.case} (${p.scrollWidth}px)`).join(", ") || "unknown";
		failures.push(`${panel.panel}: the transcript scrolls sideways — ${panel.scrollWidth}px of content in a ${panel.client}px column, pushed by ${blame}`);
	}
	for (const leak of panel.leaks) {
		failures.push(`${panel.panel}: ${leak.case} — <${leak.tag}${leak.cls ? ` class="${leak.cls}"` : ""}> overflows by ${leak.pushesBy}px with nothing scrolling to absorb it`);
	}
	/*
	 * The positive half. A harness that only forbade overflow would also pass on a
	 * stylesheet that wrapped every table into unreadable columns or clipped it
	 * outright, so the constructs whose horizontal extent carries meaning are
	 * required to stay reachable — the swipe has to exist, just not on the
	 * transcript.
	 *
	 * Asserted only on the widths where the fixture genuinely does not fit. At
	 * 560px the table fits the column outright and has nothing to scroll, which is
	 * the correct outcome and not a missing scroller — the first cut of this check
	 * demanded a scroller unconditionally and failed the one panel that was right.
	 */
	/*
	 * A scroll box whose right edge lies past the column is a scrollbar no thumb
	 * can reach, which on a phone is indistinguishable from the content simply
	 * being gone. The transcript's `overflow-x: hidden` makes this the failure mode
	 * to watch for: it would hide the symptom while leaving the block unusable.
	 */
	for (const box of panel.reachable) {
		if (!box.rightInside) {
			failures.push(`${panel.panel}: ${box.case} — its <${box.tag}> scroll box overhangs the column by ${box.overhang}px, so its scrollbar cannot be reached`);
		}
	}
	if (panel.width <= NARROW_ENOUGH_TO_OVERFLOW) {
		for (const required of ["fenced-code", "table-bare", "math-block"]) {
			const found = panel.contained.some((c) => c.case.endsWith(`/${required}`));
			if (!found) {
				failures.push(`${panel.panel}: ${required} is not inside any horizontal scroller — its content is clipped rather than reachable`);
			}
		}
	}
}

for (const panel of panels) {
	console.log(
		`${panel.panel.padEnd(16)} column=${String(panel.client).padStart(3)}px scrollWidth=${String(panel.scrollWidth).padStart(4)}px ` +
			`overflow-x=${panel.overflowX.padEnd(7)} ${panel.panelScrollsSideways ? "SCROLLS SIDEWAYS" : "holds still"} ` +
			`contained=${panel.contained.length} reachable=${panel.reachable.filter((b) => b.rightInside).length}/${panel.reachable.length} ` +
			`gaps=${[...new Set((panel.rhythm ?? []).map((r) => `${r.gap}px`))].sort().join("/")} ` +
			`clipped=${(panel.bounds ?? []).filter((b) => b.shouldBound && b.overflows && b.clips).length}/${(panel.bounds ?? []).filter((b) => b.shouldBound && b.overflows).length}` +
			`${(panel.bounds ?? []).some((b) => !b.shouldBound && b.maxHeight === null) ? " live=unbounded" : ""}`,
	);
}

if (failures.length > 0) {
	console.error(`\n${failures.length} layout failure(s):`);
	for (const failure of failures) {
		console.error(`  - ${failure}`);
	}
	process.exit(1);
}
console.log(
	`\nall ${panels.length} panel widths hold their column still, every wide construct stays reachable inside its own scroller,` +
		` the gaps are ${WITHIN_TURN}px everywhere inside a turn, ${ACROSS_SPEAKERS}px where the speaker changes,` +
		` and long machine traffic clips at ${BOUNDED_BODY_PX}px while a live think stays free to grow`,
);
