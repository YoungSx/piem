import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { flushRender, installDom } from "../testUtils/dom";
import { installObsidianStub } from "../testUtils/obsidianStub";
import type { createRoot } from "react-dom/client";
import type { QuickAction } from "./quickActionSuggestions";

installObsidianStub();
const document = installDom();

// Dynamic imports so the mocked `obsidian` module wins over any cached real one.
const { QuickActions } = await import("./QuickActions");
const { createRoot: createRootImpl } = await import("react-dom/client");

let createRootSync: typeof createRoot;

const roots = new WeakMap<HTMLElement, import("react-dom/client").Root>();

/**
 * A bare QuickActions row on a persistent host. Re-rendering with new actions
 * must go through the same root — fresh suggestions re-use the DOM nodes, and
 * that re-use is exactly what the reset test has to observe.
 */
function mountQuickActions() {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const render = (actions: QuickAction[], overrides: Partial<Parameters<typeof QuickActions>[0]> = {}) => {
		const root = roots.get(host) ?? createRootSync(host);
		roots.set(host, root);
		root.render(<QuickActions actions={actions} onSelect={() => undefined} {...overrides} />);
	};
	return { host, render };
}

/** Pins the metrics a real browser computes at layout time; happy-dom reports zeros. */
function pinMetrics(el: HTMLElement, clientWidth: number, scrollWidth: number): void {
	Object.defineProperty(el, "clientWidth", { value: clientWidth, configurable: true });
	Object.defineProperty(el, "scrollWidth", { value: scrollWidth, configurable: true });
}

function strip(host: HTMLElement): HTMLElement {
	const el = host.querySelector<HTMLElement>(".piem-chat__quick-actions");
	if (!el) {
		throw new Error("no quick-actions row rendered");
	}
	return el;
}

function fade(el: HTMLElement, side: "left" | "right"): string | null {
	return el.style.getPropertyValue(side === "left" ? "--piem-strip-flush-left" : "--piem-strip-flush-right") || null;
}

function scrollEvent(el: HTMLElement): void {
	el.dispatchEvent(new Event("scroll"));
}

function wheelEvent(el: HTMLElement, init: WheelEventInit): { defaultPrevented: boolean } {
	// Cancelable, or preventDefault is a no-op and the assertion reads the
	// dispatch, not the handler.
	const event = new WheelEvent("wheel", { cancelable: true, ...init });
	el.dispatchEvent(event);
	return event;
}

function chips(count: number): QuickAction[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `suggested-${index}`,
		label: `Chip ${index}`,
		prompt: `Prompt ${index}`,
	}));
}

const TWO: QuickAction[] = chips(2);
const SIX: QuickAction[] = chips(6);

beforeEach(() => {
	createRootSync = createRootImpl;
});

afterEach(() => {
	document.body.replaceChildren();
});

describe("QuickActions wrap layout", () => {
	it("renders one chip per action and sends its prompt on tap", async () => {
		const selected: string[] = [];
		const { host, render } = mountQuickActions();
		render(TWO, { onSelect: (prompt) => selected.push(prompt) });
		await flushRender();

		const row = strip(host);
		expect(row.className).not.toContain("--strip");
		const buttons = Array.from(row.querySelectorAll<HTMLButtonElement>(".piem-chat__quick-action"));
		expect(buttons.map((button) => button.textContent)).toEqual(["Chip 0", "Chip 1"]);
		buttons[1]?.click();
		await flushRender();
		expect(selected).toEqual(["Prompt 1"]);
		// The wrap has no scroller, so the hook must never have touched it.
		expect(fade(row, "left")).toBeNull();
		expect(fade(row, "right")).toBeNull();
	});

	it("renders nothing when there is nothing to suggest", async () => {
		const { host, render } = mountQuickActions();
		render([]);
		await flushRender();
		expect(host.querySelector(".piem-chat__quick-actions")).toBeNull();
	});
});

describe("QuickActions strip layout", () => {
	it("writes the fade custom properties the mask consumes", async () => {
		const { host, render } = mountQuickActions();
		render(SIX, { layout: "strip" });
		await flushRender();

		const row = strip(host);
		// happy-dom reports clientWidth == scrollWidth, so nothing is hidden and
		// both edges are flush — the properties exist, pinned at the solid stop.
		pinMetrics(row, 300, 300);
		scrollEvent(row);
		expect(fade(row, "left")).toBe("1");
		expect(fade(row, "right")).toBe("1");
	});

	it("fades the trailing edge and then the leading one as the row scrolls", async () => {
		const { host, render } = mountQuickActions();
		render(SIX, { layout: "strip" });
		await flushRender();

		const row = strip(host);
		pinMetrics(row, 300, 500);
		scrollEvent(row);
		expect(fade(row, "left")).toBe("1");
		expect(fade(row, "right")).toBe("0");

		row.scrollLeft = 100;
		scrollEvent(row);
		expect(fade(row, "left")).toBe("0");
		expect(fade(row, "right")).toBe("0");

		row.scrollLeft = 200;
		scrollEvent(row);
		expect(fade(row, "left")).toBe("0");
		expect(fade(row, "right")).toBe("1");
	});

	it("resyncs the fades when the row's width changes", async () => {
		const { host, render } = mountQuickActions();
		render(SIX, { layout: "strip" });
		await flushRender();

		const row = strip(host);
		// The ResizeObserver fires once on observe, with the metrics pinned
		// before the mount: the row starts flush and gains its trailing fade
		// when it narrows — the panel-squeeze case the hook re-measures for.
		pinMetrics(row, 300, 300);
		pinMetrics(row, 300, 500);
		// happy-dom delivers observer callbacks synchronously or on a timer; the
		// flush yields to whichever, and a second scroll event asserts the same
		// wiring without depending on that timing.
		scrollEvent(row);
		expect(fade(row, "right")).toBe("0");
	});

	it("consumes a vertical wheel notch only while that direction hides content", async () => {
		const { host, render } = mountQuickActions();
		render(SIX, { layout: "strip" });
		await flushRender();

		const row = strip(host);
		pinMetrics(row, 300, 500);
		// Flush left, hidden to the right: the notch scrolls the strip, and the
		// reverse notch scrolls it back — hidden content now sits to the left.
		scrollEvent(row);
		let event = wheelEvent(row, { deltaY: 40 });
		expect(event.defaultPrevented).toBe(true);
		expect(row.scrollLeft).toBe(40);

		event = wheelEvent(row, { deltaY: -40 });
		expect(event.defaultPrevented).toBe(true);
		expect(row.scrollLeft).toBe(0);

		// Flush left again: the upward notch belongs to the transcript's scroll.
		event = wheelEvent(row, { deltaY: -40 });
		expect(event.defaultPrevented).toBe(false);

		// And flush right, it is the downward notch that falls through.
		row.scrollLeft = 200;
		scrollEvent(row);
		event = wheelEvent(row, { deltaY: 40 });
		expect(event.defaultPrevented).toBe(false);
	});

	it("passes a dominant horizontal delta through untouched", async () => {
		const { host, render } = mountQuickActions();
		render(SIX, { layout: "strip" });
		await flushRender();

		const row = strip(host);
		pinMetrics(row, 300, 500);
		scrollEvent(row);
		// A trackpad's sideways swipe already means what the browser will do.
		const event = wheelEvent(row, { deltaX: -30, deltaY: 0 });
		expect(event.defaultPrevented).toBe(false);
		expect(row.scrollLeft).toBe(0);
	});

	it("greets its replacement at the left edge, not wherever it was scrolled", async () => {
		const { host, render } = mountQuickActions();
		render(SIX, { layout: "strip" });
		await flushRender();

		const row = strip(host);
		pinMetrics(row, 300, 500);
		row.scrollLeft = 120;
		scrollEvent(row);
		expect(fade(row, "left")).toBe("0");

		// The ids are positional, so a fresh suggestion set re-uses the DOM
		// nodes — the reset is what stops the new chips arriving half-hidden.
		render(chips(5), { layout: "strip" });
		await flushRender();
		// New actions, same element: the host's row is the same node.
		expect(strip(host)).toBe(row);
		expect(row.scrollLeft).toBe(0);
		expect(fade(row, "left")).toBe("1");
	});
});
