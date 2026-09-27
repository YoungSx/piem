import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { flushRender, installDom } from "../testUtils/dom";
import { installObsidianStub, lastMenu, resetMenus, setTooltipMock } from "../testUtils/obsidianStub";
import type { ModelTarget } from "./modelSwitcherCopy";

installObsidianStub();
const document = installDom();

// Dynamic imports so the mocked `obsidian` module wins over any cached real one.
const { ModelSwitcher } = await import("./ModelSwitcher");
const { createRoot } = await import("react-dom/client");

const opus = { id: "m-opus", name: "Opus 5", provider: "OpenRouter", icon: "piem-vendor-anthropic" };
const sonnet = { id: "m-sonnet", name: "Sonnet 5", provider: "Anthropic", icon: "piem-vendor-anthropic" };

interface RenderOptions {
	target?: Partial<ModelTarget>;
	onSelect?: (modelId: string) => void;
	/** Omitted means the host cannot reach settings, as on a stubbed App. */
	onOpenSettings?: () => void;
}

async function renderSwitcher(options: RenderOptions = {}): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = roots.get(host) ?? createRoot(host);
	roots.set(host, root);
	root.render(
		<ModelSwitcher
			target={target(options.target)}
			onSelect={options.onSelect ?? (() => undefined)}
			onOpenSettings={options.onOpenSettings}
		/>,
	);
	await flushRender();
	return host;
}

function button(host: HTMLElement): HTMLButtonElement {
	const found = host.querySelector<HTMLButtonElement>(".piem-chat__model-switcher");
	if (!found) {
		throw new Error("switcher rendered without a button");
	}
	return found;
}

/** Presses the switcher and returns the menu production code built. */
async function openMenu(host: HTMLElement): Promise<ReturnType<typeof lastMenu>> {
	button(host).click();
	await flushRender();
	return lastMenu();
}

/**
 * The control that replaced the header's model line.
 *
 * What is pinned here is the difference between the two: the old line stated a
 * value, and this one states it *and* changes it. So every assertion is about
 * one of the three things that makes it a control rather than a readout — the
 * list it opens, the check that says which row is current, and the states in
 * which pressing it must not act.
 */
describe("ModelSwitcher label", () => {
	beforeEach(() => {
		setTooltipMock.mockClear();
		document.body.replaceChildren();
	});

	afterEach(() => {
		document.body.replaceChildren();
	});

	it("prints the model on the button and the endpoint in its name", async () => {
		const host = await renderSwitcher();

		expect(host.querySelector(".piem-chat__model-switcher-name")?.textContent).toBe("Opus 5");
		expect(button(host).getAttribute("aria-label")).toBe("Switch model · Opus 5 · OpenRouter");
	});

	it("hides the printed name from assistive tech, which the accessible name already carries", async () => {
		const host = await renderSwitcher();

		expect(host.querySelector(".piem-chat__model-switcher-name")?.getAttribute("aria-hidden")).toBe("true");
	});

	it("uses Obsidian's own tooltip rather than a native title attribute", async () => {
		const host = await renderSwitcher();

		expect(button(host).getAttribute("title")).toBeNull();
		expect(setTooltipMock).toHaveBeenCalledWith(button(host), "Switch model · Opus 5 · OpenRouter");
	});

	it("announces that it opens a list, not that it performs an action", async () => {
		// Without this, assistive tech reports a plain button: the user cannot tell
		// before pressing whether they are committing to something or browsing.
		const host = await renderSwitcher();

		expect(button(host).getAttribute("aria-haspopup")).toBe("menu");
	});
});

describe("ModelSwitcher menu", () => {
	beforeEach(() => {
		resetMenus();
		document.body.replaceChildren();
	});

	afterEach(() => {
		document.body.replaceChildren();
	});

	it("lists every configured model, in the order settings stores them", async () => {
		const host = await renderSwitcher();

		expect((await openMenu(host)).titles()).toEqual(["Opus 5 · OpenRouter", "Sonnet 5 · Anthropic"]);
	});

	it("carries each model's mark on its row, so the menu reads like the composer face", async () => {
		const host = await renderSwitcher();

		expect((await openMenu(host)).items.map((item) => item.icon)).toEqual([opus.icon, sonnet.icon]);
	});

	it("marks the active row with a check, since its label deliberately does not say so", async () => {
		const host = await renderSwitcher();

		const items = (await openMenu(host)).items;
		expect(items.map((item) => item.checked)).toEqual([true, false]);
	});

	it("routes a selection to the host by model id, not by label", async () => {
		const chosen: string[] = [];
		const host = await renderSwitcher({ onSelect: (modelId) => chosen.push(modelId) });

		(await openMenu(host)).click("Sonnet 5 · Anthropic");

		expect(chosen).toEqual([sonnet.id]);
	});

	it("offers the settings door below the models, so the next one can be added", async () => {
		const host = await renderSwitcher({ onOpenSettings: () => undefined });

		const menu = await openMenu(host);
		expect(menu.titles()).toEqual(["Opus 5 · OpenRouter", "Sonnet 5 · Anthropic", "Manage models…"]);
		expect(menu.items.some((item) => item.separator)).toBe(true);
	});

	it("says the list is empty rather than opening an empty popover", async () => {
		// The one state where the switcher has nothing to switch between. A menu
		// holding only an action would read as a list that failed to load.
		const host = await renderSwitcher({ target: { modelChoices: [], activeModelId: undefined }, onOpenSettings: () => undefined });

		const menu = await openMenu(host);
		expect(menu.titles()).toEqual(["No models configured", "Manage models…"]);
		expect(menu.items[0]?.isLabel).toBe(true);
		// No rule against the menu's own top edge: the label and the door are one
		// block, not two.
		expect(menu.items.some((item) => item.separator)).toBe(false);
	});

	it("routes the settings row to the host callback", async () => {
		let opened = 0;
		const host = await renderSwitcher({ onOpenSettings: () => (opened += 1) });

		(await openMenu(host)).click("Manage models…");

		expect(opened).toBe(1);
	});

	/*
	 * A keyboard-activated button dispatches a click at `0, 0`, so anchoring the
	 * menu to the event would drop it in the window's top-left corner — off the
	 * panel, for the users least able to go looking for it.
	 */
	it("anchors the menu to the button rather than to the pointer", async () => {
		const host = await renderSwitcher();
		// happy-dom lays nothing out, so the rect is planted: an unstubbed one reads
		// as all zeros, which is indistinguishable from the corner this is about.
		button(host).getBoundingClientRect = () => ({ left: 40, top: 300 }) as DOMRect;

		const menu = await openMenu(host);

		expect(menu.shown).toBe(true);
		expect(menu.position).toEqual({ x: 40, y: 300 });
	});
});

describe("ModelSwitcher availability", () => {
	beforeEach(() => {
		resetMenus();
		document.body.replaceChildren();
	});

	afterEach(() => {
		document.body.replaceChildren();
	});

	it("stays usable mid-turn: a mid-run switch is deferred until the run lands", async () => {
		// Issue #252: the setting writes through at once, the run keeps its model,
		// and the service applies the choice when the run settles. Nothing here has
		// to go inert, so the button never greys out under the user's hands.
		const host = await renderSwitcher({ target: { runningModelId: "claude-opus-5" } });

		expect(button(host).disabled).toBe(false);
	});

	it("notes in the title when the run in flight is still on another model", async () => {
		const host = await renderSwitcher({ target: { runningModelId: "claude-opus-5" } });

		expect(button(host).getAttribute("aria-label")).toBe("Switch model · Opus 5 · OpenRouter · Takes effect after this reply");
	});

	it("leaves the title alone once the run is on the chosen model", async () => {
		const host = await renderSwitcher({ target: { runningModelId: "deepseek-v4-pro" } });

		expect(button(host).getAttribute("aria-label")).toBe("Switch model · Opus 5 · OpenRouter");
	});

	it("disables itself when there is nothing to pick and nowhere to go", async () => {
		// No configured models and no route to settings: the menu would open with a
		// single dead line in it, which reads as a bug rather than as a state.
		const host = await renderSwitcher({ target: { modelChoices: [], activeModelId: undefined } });

		expect(button(host).disabled).toBe(true);
	});

	it("stays live with no models when settings are reachable, since that is the fix", async () => {
		const host = await renderSwitcher({ target: { modelChoices: [], activeModelId: undefined }, onOpenSettings: () => undefined });

		expect(button(host).disabled).toBe(false);
	});
});

function target(overrides: Partial<ModelTarget> = {}): ModelTarget {
	return {
		modelChoices: [opus, sonnet],
		activeModelId: opus.id,
		provider: "deepseek",
		modelId: "deepseek-v4-pro",
		...overrides,
	};
}

const roots = new WeakMap<HTMLElement, import("react-dom/client").Root>();
