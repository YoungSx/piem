import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Language } from "../i18n";
import { flushRender, installDom } from "../testUtils/dom";
import { installObsidianStub } from "../testUtils/obsidianStub";
import type { ContextFill, UsageTotals } from "../agent/usage";

installObsidianStub();
const document = installDom();

// Dynamic imports so the mocked `obsidian` module wins over any cached real one.
const { ContextGauge } = await import("./ContextGauge");
const { TranslatorProvider } = await import("./TranslatorContext");
const { createRoot } = await import("react-dom/client");

type Props = Parameters<typeof ContextGauge>[0];

const noop = (): void => undefined;

/**
 * The context ring beside Send.
 *
 * Most of the banding and wording assertions here moved from
 * `ChatStatusBar.test.tsx` along with the readout itself: the ok/warn/near
 * bands, the tilde on a heuristic estimate, and the level named in text rather
 * than carried by colour alone are the same contract they were as a bar. What is
 * new is the shape it is carried in — a focusable button plus a popover — and the
 * tier change: the ring is unconditional, while spend stays behind agent details.
 */
async function renderGauge(overrides: Partial<Props> = {}, language: Language = "en"): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = roots.get(host) ?? createRoot(host);
	roots.set(host, root);
	root.render(
		<TranslatorProvider language={language}>
			<ContextGauge
				fill={fill()}
				usage={usageTotals()}
				showAgentDetails={false}
				isStreaming={false}
				isCompacting={false}
				onTidy={noop}
				{...overrides}
			/>
		</TranslatorProvider>,
	);
	await flushRender();
	return host;
}

/** Opens the popover by pressing the ring, and waits for the render. */
async function openPopover(host: HTMLElement): Promise<HTMLElement | null> {
	host.querySelector<HTMLButtonElement>(".piem-chat__context-gauge")?.click();
	await flushRender();
	return popover(host);
}

function popover(host: HTMLElement): HTMLElement | null {
	return host.querySelector<HTMLElement>(".piem-chat__context-popover");
}

/**
 * A pointer arriving over an element.
 *
 * `pointerover`, not `pointerenter`: React synthesizes its `onPointerEnter` from
 * the bubbling `pointerover`, so dispatching the non-bubbling native event would
 * test a handler React never wires up that way.
 */
async function pointerOver(element: Element, pointerType: string): Promise<void> {
	element.dispatchEvent(new window.PointerEvent("pointerover", { bubbles: true, pointerType }));
	await flushRender();
}

async function pointerOut(element: Element, pointerType: string): Promise<void> {
	element.dispatchEvent(new window.PointerEvent("pointerout", { bubbles: true, pointerType, relatedTarget: document.body }));
	await flushRender();
}

/**
 * Waits past the grace period hover used to get, so a deferred close would have
 * had its chance to fire. Nothing schedules one any more; the wait is what makes
 * "still open" evidence rather than a coincidence of timing.
 */
async function afterCloseDelay(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 250));
	await flushRender();
}

describe("ContextGauge ring", () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(() => {
		unmountAllRoots();
		document.body.replaceChildren();
	});

	it("draws nothing before the first measurement, since an empty ring would claim 0%", async () => {
		// null is "not measured yet", not "nothing used". Drawing an empty ring
		// would state the second.
		const host = await renderGauge({ fill: null });

		expect(host.querySelector(".piem-chat__context")).toBeNull();
	});

	it("turns warn in the last quarter of the runway and near once the threshold is crossed", async () => {
		// Threshold sits at ~98.4%; its 75% mark is ~73.8%, so 85% is "warn".
		const warnHost = await renderGauge({ fill: fill({ tokens: 850_000, ratio: 0.85, heuristicOnly: false }) });
		expect(warnHost.querySelector(".piem-chat__context")?.className).toContain("--warn");

		document.body.replaceChildren();
		const nearHost = await renderGauge({ fill: fill({ tokens: 990_000, ratio: 0.99, heuristicOnly: false }) });
		expect(nearHost.querySelector(".piem-chat__context")?.className).toContain("--near");

		document.body.replaceChildren();
		const okHost = await renderGauge();
		expect(okHost.querySelector(".piem-chat__context")?.className).toContain("piem-chat__context--ok");
	});

	it("drives the arc from a ratio custom property, so it paints instead of reflowing", async () => {
		const host = await renderGauge({ fill: fill({ tokens: 500_000, ratio: 0.5 }) });

		const arc = host.querySelector<HTMLElement>(".piem-chat__context-ring-fill");
		expect(arc?.style.getPropertyValue("--pi-context-ratio")).toBe("0.5");
	});

	it("clamps a heuristic overshoot rather than drawing past a full circle", async () => {
		// A characters/4 estimate can exceed the window; the arc cannot.
		const host = await renderGauge({ fill: fill({ tokens: 1_400_000, ratio: 1.4 }) });

		const arc = host.querySelector<HTMLElement>(".piem-chat__context-ring-fill");
		expect(arc?.style.getPropertyValue("--pi-context-ratio")).toBe("1");
	});

	it("carries the whole readout in the button's name, since the ring cannot show numbers", async () => {
		// This is what replaces `aria-valuetext` now that the meter is a button
		// rather than a progressbar: at 16px the figures exist only here and in
		// the popover, so the name has to state them.
		const host = await renderGauge({ fill: fill({ tokens: 12_400, ratio: 0.0124, heuristicOnly: true }) });

		const name = host.querySelector(".piem-chat__context-gauge")?.getAttribute("aria-label");
		expect(name).toContain("Context window use");
		expect(name).toContain("Estimated 12.4k of 1.00M tokens used");
		expect(name).toContain("1 percent");
		expect(name).toContain("ok");
	});

	it("is a focusable button, not a progressbar a touch user cannot reach", async () => {
		// The panel runs on phones (`isDesktopOnly: false`). A progressbar has
		// nothing to press, and pressing is now the only way the figures open.
		const host = await renderGauge();

		const gauge = host.querySelector(".piem-chat__context-gauge");
		expect(gauge?.tagName).toBe("BUTTON");
		expect(gauge?.getAttribute("aria-expanded")).toBe("false");
		expect(host.querySelector("[role='progressbar']")).toBeNull();
	});

	it("wears Obsidian's clickable-icon, without which the theme re-chromes the ring", async () => {
		// The load-bearing class. Obsidian styles every `button:not(.clickable-icon)`
		// as a filled form control at a specificity a plain class cannot outrank, so
		// opting out of the class is what wrapped the ring in a container. The 0.85
		// opacity the class carries is answered in `styles.css` by pinning
		// `--icon-opacity: 1` — answered there, not here, because happy-dom applies
		// neither `app.css` nor the plugin stylesheet.
		const host = await renderGauge();

		expect(host.querySelector(".piem-chat__context-gauge")?.className).toContain("clickable-icon");
	});
});

describe("ContextGauge popover", () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(() => {
		unmountAllRoots();
		document.body.replaceChildren();
	});

	it("stays shut until asked", async () => {
		const host = await renderGauge();

		expect(host.querySelector(".piem-chat__context-popover")).toBeNull();
	});

	it("opens on click and reports it on the button", async () => {
		const host = await renderGauge();

		expect(await openPopover(host)).not.toBeNull();
		expect(host.querySelector(".piem-chat__context-gauge")?.getAttribute("aria-expanded")).toBe("true");
	});

	it("shows a heuristic estimate with a tilde and never an exact count", async () => {
		const host = await renderGauge({ fill: fill({ tokens: 12_400, ratio: 0.0124, heuristicOnly: true }) });

		const popover = await openPopover(host);
		expect(popover?.textContent).toContain("~12.4k / 1.00M");
		expect(popover?.textContent).not.toContain("12,400");
	});

	it("drops the tilde once the provider has reported usage", async () => {
		const host = await renderGauge({ fill: fill({ tokens: 500_000, ratio: 0.5, heuristicOnly: false }) });

		const popover = await openPopover(host);
		expect(popover?.textContent).toContain("500.0k / 1.00M");
		expect(popover?.textContent).not.toContain("~500.0k");
	});

	it("names the context state in text instead of relying on the ring's colour", async () => {
		const nearHost = await renderGauge({ fill: fill({ tokens: 990_000, ratio: 0.99 }) });
		expect((await openPopover(nearHost))?.textContent).toContain("context nearly full");

		document.body.replaceChildren();
		const okHost = await renderGauge();
		expect((await openPopover(okHost))?.textContent).toContain("ok");
	});

	it("explains an estimate, and what happens at the threshold, in the same slot", async () => {
		const estimateHost = await renderGauge({ fill: fill({ heuristicOnly: true }) });
		expect((await openPopover(estimateHost))?.querySelector(".piem-chat__context-note")?.textContent).toContain(
			"Estimated from message sizes",
		);

		document.body.replaceChildren();
		const measuredHost = await renderGauge({ fill: fill({ heuristicOnly: false }) });
		expect((await openPopover(measuredHost))?.querySelector(".piem-chat__context-note")?.textContent).toContain(
			"Tidying starts near 98%",
		);
	});

	it("is not a tooltip, which may not own the button inside it", async () => {
		// ARIA forbids focusable content in a tooltip, and a screen reader may skip
		// the subtree — taking the tidy button with it.
		const host = await renderGauge();

		const popover = await openPopover(host);
		expect(popover?.getAttribute("role")).toBe("group");
	});
});

describe("ContextGauge open and close", () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(() => {
		unmountAllRoots();
		document.body.replaceChildren();
	});

	it("ignores hover, so the readout appears only when it is asked for", async () => {
		// Hover used to open it, and the pointer path is the one that went: two
		// openers firing into one state could not be ordered (see the component
		// doc), and hover is the affordance no touch or keyboard reader has.
		const host = await renderGauge();

		await pointerOver(host.querySelector(".piem-chat__context")!, "mouse");
		expect(popover(host)).toBeNull();

		await pointerOver(host.querySelector(".piem-chat__context-gauge")!, "mouse");
		expect(popover(host)).toBeNull();
	});

	it("opens on a click, even though the focus that click brings lands first", async () => {
		// The ordering that rules focus-to-open out, asserted rather than argued: a
		// mouse press focuses the button before it clicks it, so a gauge that opened
		// on focus would be shut again by the click that focused it, and the ring
		// would look dead to every pointer user.
		const host = await renderGauge();
		const gauge = host.querySelector<HTMLButtonElement>(".piem-chat__context-gauge")!;

		gauge.focus();
		await flushRender();
		expect(popover(host)).toBeNull();

		gauge.click();
		await flushRender();
		expect(popover(host)).not.toBeNull();
	});

	it("opens on a touch tap, the one input with no hover to fall back on", async () => {
		// React synthesizes `onPointerEnter` from the bubbling `pointerover`, which
		// a tap fires on its way in. That is why hover and press could not coexist
		// here: the tap opened the popover as a hover and its own click shut it.
		const host = await renderGauge();
		const gauge = host.querySelector<HTMLButtonElement>(".piem-chat__context-gauge")!;

		await pointerOver(gauge, "touch");
		expect(popover(host)).toBeNull();

		gauge.click();
		await flushRender();
		expect(popover(host)).not.toBeNull();
	});

	it("closes on a second tap, so touch can dismiss what it opened", async () => {
		const host = await renderGauge();
		const gauge = host.querySelector<HTMLButtonElement>(".piem-chat__context-gauge")!;

		gauge.click();
		await flushRender();
		gauge.click();
		await flushRender();

		expect(popover(host)).toBeNull();
	});

	it("stays open when the pointer leaves, which is no longer a close signal", async () => {
		// Otherwise the popover evaporates as the pointer travels toward the tidy
		// button it holds — and on touch there is no pointer to keep inside it.
		const host = await renderGauge();
		host.querySelector<HTMLButtonElement>(".piem-chat__context-gauge")!.click();
		await flushRender();

		await pointerOut(host.querySelector(".piem-chat__context")!, "mouse");
		await afterCloseDelay();

		expect(popover(host)).not.toBeNull();
	});

	it("dismisses on a press outside it, which is what replaces the pointer leaving", async () => {
		// Tapping elsewhere does not reliably move focus on iOS Safari, so blur
		// alone would leave a touch reader with an open panel and no way to shut it.
		const host = await renderGauge();
		host.querySelector<HTMLButtonElement>(".piem-chat__context-gauge")!.click();
		await flushRender();

		document.body.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
		// The dismissal lives in a passive effect (a document-level listener), and
		// this press is dispatched on `body` — outside the React root, so React
		// never gets its discrete-event chance to flush pending effects first. A
		// bare flush assumed the effect had landed; under CI load it had not, and
		// the popover was still open at the assert. Wait for the close itself:
		// instant once it lands, loud after the timeout if the dismissal breaks.
		await flushRender(() => popover(host) === null);

		expect(popover(host)).toBeNull();
	});

	it("folds up once focus has left both the ring and the popover", async () => {
		// The keyboard's counterpart to pressing outside. A reader who Tabs onward
		// would otherwise leave a panel floating over the draft with nothing left
		// that shuts it, now that no pointer leave does.
		const host = await renderGauge();
		const gauge = host.querySelector<HTMLButtonElement>(".piem-chat__context-gauge")!;
		const elsewhere = document.createElement("button");
		document.body.appendChild(elsewhere);

		gauge.focus();
		gauge.click();
		await flushRender();
		expect(popover(host)).not.toBeNull();

		elsewhere.focus();
		await flushRender();

		expect(popover(host)).toBeNull();
	});
});

describe("ContextGauge spend tier", () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(() => {
		unmountAllRoots();
		document.body.replaceChildren();
	});

	it("shows the ring without agent details, because running out is everyone's wall", async () => {
		const host = await renderGauge({ showAgentDetails: false });

		expect(host.querySelector(".piem-chat__context")).not.toBeNull();
	});

	it("keeps spend behind the agent-details tier, which is a different question", async () => {
		const host = await renderGauge({ showAgentDetails: false, usage: { tokens: 4_200, cost: 0.02, requests: 3 } });

		expect((await openPopover(host))?.querySelector(".piem-chat__context-spend")).toBeNull();
	});

	it("shows tokens and spend once details are on and a request has landed", async () => {
		const host = await renderGauge({ showAgentDetails: true, usage: { tokens: 4_200, cost: 0.02, requests: 3 } });

		expect((await openPopover(host))?.querySelector(".piem-chat__context-spend")?.textContent).toContain("4.2k tokens");
	});

	it("hides spend before the first request, since there is nothing to total", async () => {
		const host = await renderGauge({ showAgentDetails: true, usage: usageTotals() });

		expect((await openPopover(host))?.querySelector(".piem-chat__context-spend")).toBeNull();
	});
});

describe("ContextGauge usage breakdown", () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(() => {
		unmountAllRoots();
		document.body.replaceChildren();
	});

	it("shows the cache line behind the same details tier as spend", async () => {
		const host = await renderGauge({
			showAgentDetails: true,
			usage: { tokens: 3_000, cost: 0.01, requests: 2, input: 300, cacheRead: 2_700 },
		});

		const popover = await openPopover(host);
		expect(popover?.querySelector(".piem-chat__context-cache")?.textContent).toContain("cache 90%");
	});

	it("keeps the breakdown out of the popover when details are off", async () => {
		const host = await renderGauge({
			showAgentDetails: false,
			usage: { tokens: 3_000, cost: 0.01, requests: 2, input: 300, cacheRead: 2_700 },
		});

		const popover = await openPopover(host);
		expect(popover?.querySelector(".piem-chat__context-cache")).toBeNull();
		expect(popover?.querySelector(".piem-chat__context-long-cache")).toBeNull();
		expect(popover?.querySelector(".piem-chat__context-reasoning")).toBeNull();
	});

	it("omits the cache line for a provider that reports the fields as zero", async () => {
		// Adapters for models without a prompt cache report 0, not absent — the
		// line must be absent rather than reading "cache 0% · 0 tokens".
		const host = await renderGauge({
			showAgentDetails: true,
			usage: { tokens: 500, cost: 0, requests: 1, input: 500, cacheRead: 0, cacheWrite: 0 },
		});

		expect((await openPopover(host))?.querySelector(".piem-chat__context-cache")).toBeNull();
	});

	it("omits the reasoning note when no provider reported a split", async () => {
		const host = await renderGauge({
			showAgentDetails: true,
			usage: { tokens: 3_000, cost: 0.01, requests: 2, input: 300, cacheRead: 2_700 },
		});

		expect((await openPopover(host))?.querySelector(".piem-chat__context-reasoning")).toBeNull();
	});

	it("shows the reasoning note once a split has landed", async () => {
		const host = await renderGauge({
			showAgentDetails: true,
			usage: { tokens: 3_000, cost: 0.01, requests: 2, reasoning: 1_500 },
		});

		expect((await openPopover(host))?.querySelector(".piem-chat__context-reasoning")?.textContent).toContain("1.5k");
	});

	it("shows the hour-long-cache footnote once Anthropic reports that share", async () => {
		// The reader's only feedback that the "long" retention setting took: a dropped
		// preference just bills at the cheaper rate and says nothing.
		const host = await renderGauge({
			showAgentDetails: true,
			usage: { tokens: 3_000, cost: 0.01, requests: 2, input: 300, cacheRead: 2_700, cacheWrite: 2_000, cacheWrite1h: 1_500 },
		});

		expect((await openPopover(host))?.querySelector(".piem-chat__context-long-cache")?.textContent).toContain("1.5k");
	});

	it("omits it for a provider that writes cache but reports no hour-long share", async () => {
		// Every non-Anthropic adapter. The cache line still shows; only the rate
		// footnote is absent, because no rate was reported.
		const host = await renderGauge({
			showAgentDetails: true,
			usage: { tokens: 3_000, cost: 0.01, requests: 2, input: 300, cacheRead: 2_700, cacheWrite: 2_000 },
		});

		const popover = await openPopover(host);
		expect(popover?.querySelector(".piem-chat__context-cache")).not.toBeNull();
		expect(popover?.querySelector(".piem-chat__context-long-cache")).toBeNull();
	});

	it("renders every breakdown line in Chinese", async () => {
		const host = await renderGauge(
			{
				showAgentDetails: true,
				usage: { tokens: 3_000, cost: 0.01, requests: 2, input: 300, cacheRead: 2_700, cacheWrite: 2_000, cacheWrite1h: 1_500, reasoning: 1_500 },
			},
			"zh-cn",
		);

		const popover = await openPopover(host);
		// 54%, not the 90% of the read-only fixtures above: the hit rate's denominator
		// is the billed prompt total, and this turn wrote 2k into the cache as well.
		expect(popover?.querySelector(".piem-chat__context-cache")?.textContent).toContain("缓存 54%");
		expect(popover?.querySelector(".piem-chat__context-reasoning")?.textContent).toContain("含推理 1.5k");
		expect(popover?.querySelector(".piem-chat__context-long-cache")?.textContent).toContain("保留一小时");
	});
});

describe("ContextGauge tidy action", () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(() => {
		unmountAllRoots();
		document.body.replaceChildren();
	});

	it("offers tidying at any level, not only once the context is nearly full", async () => {
		const host = await renderGauge({ fill: fill({ tokens: 12_400, ratio: 0.0124 }) });

		const tidy = (await openPopover(host))?.querySelector<HTMLButtonElement>(".piem-chat__context-tidy");
		expect(tidy).not.toBeNull();
		expect(tidy?.disabled).toBe(false);
	});

	it("runs the compaction and closes, leaving the status bar to report it", async () => {
		let calls = 0;
		const host = await renderGauge({ onTidy: () => (calls += 1) });

		(await openPopover(host))?.querySelector<HTMLButtonElement>(".piem-chat__context-tidy")?.click();
		await flushRender();

		expect(calls).toBe(1);
		expect(host.querySelector(".piem-chat__context-popover")).toBeNull();
	});

	it("disables itself while a turn streams, and says why", async () => {
		// `compactNow` returns early during a stream, so a live button would do
		// nothing — and a disabled control has no channel but its name.
		const host = await renderGauge({ isStreaming: true });

		const tidy = (await openPopover(host))?.querySelector<HTMLButtonElement>(".piem-chat__context-tidy");
		expect(tidy?.disabled).toBe(true);
		expect(tidy?.getAttribute("aria-label")).toBe("Tidy earlier thoughts once the reply finishes");
	});

	it("disables itself while a compaction is already running, and says so", async () => {
		const host = await renderGauge({ isCompacting: true });

		const tidy = (await openPopover(host))?.querySelector<HTMLButtonElement>(".piem-chat__context-tidy");
		expect(tidy?.disabled).toBe(true);
		expect(tidy?.getAttribute("aria-label")).toBe("Tidying thoughts…");
	});
});

describe("ContextGauge in Chinese", () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(() => {
		unmountAllRoots();
		document.body.replaceChildren();
	});

	it("translates the readout, the state and the action", async () => {
		const host = await renderGauge({ fill: fill({ tokens: 990_000, ratio: 0.99, heuristicOnly: false }) }, "zh-cn");

		expect(host.querySelector(".piem-chat__context-gauge")?.getAttribute("aria-label")).toContain("上下文窗口占用");
		const popover = await openPopover(host);
		expect(popover?.textContent).toContain("上下文即将占满");
		expect(popover?.querySelector(".piem-chat__context-tidy")?.getAttribute("aria-label")).toBe("整理较早思维");
	});

	it("translates the disabled reason too", async () => {
		const host = await renderGauge({ isStreaming: true }, "zh-cn");

		const tidy = (await openPopover(host))?.querySelector(".piem-chat__context-tidy");
		expect(tidy?.getAttribute("aria-label")).toBe("回复结束后可整理较早思维");
	});
});

function fill(overrides: Partial<ContextFill> = {}): ContextFill {
	return {
		tokens: 12_400,
		contextWindow: 1_000_000,
		ratio: 0.0124,
		compactionRatio: (1_000_000 - 16_384) / 1_000_000,
		heuristicOnly: true,
		...overrides,
	};
}

function usageTotals(): UsageTotals {
	return { tokens: 0, cost: 0, requests: 0 };
}

const roots = new Map<HTMLElement, import("react-dom/client").Root>();

/**
 * Tears down every live root between tests.
 *
 * `document.body.replaceChildren()` alone leaves React roots mounted with their
 * effects still attached — including `ContextGauge`'s `document`-level capture
 * listeners for the press-outside dismissal. Thirty such ghosts survive one full
 * file run, and the next test that asserts a dismissal races all of them: the
 * listener of an *earlier*, already-abandoned gauge re-opens or re-closes state
 * the current test did not ask for, and the case ran ~98s while poisoned and
 * 0.6s alone. Unmounting is the cleanup `replaceChildren` pretends to do.
 */
function unmountAllRoots(): void {
	for (const root of roots.values()) {
		root.unmount();
	}
	roots.clear();
}
