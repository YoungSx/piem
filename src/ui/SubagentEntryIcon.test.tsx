import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Language } from "../i18n";
import type { SubagentSnapshot } from "../subagent/inspectorModel";
import { flushRender, installDom } from "../testUtils/dom";
import { installObsidianStub } from "../testUtils/obsidianStub";

installObsidianStub();
const document = installDom();

// Dynamic imports so the mocked `obsidian` module wins over any cached real one.
const { SubagentEntryIcon } = await import("./SubagentEntryIcon");
const { TranslatorProvider } = await import("./TranslatorContext");
const { createRoot } = await import("react-dom/client");

/**
 * The way into the monitor, at the end of the context row.
 *
 * The three-state switch is the contract: absent with nothing delegated, animated
 * with a count while something runs, quiet once everything has settled. Each
 * state is a claim the composer makes before the user presses send, so a wrong
 * one is either a notification that never arrives or a permanent control for a
 * feature most turns never touch.
 *
 * Every mount is unmounted rather than detached, because this component
 * registers a capture-phase `pointerdown` listener on `document` while its
 * popover is open. A detached-but-live root keeps that listener, and a later
 * test's outside-press then reaches a tree nobody is asserting on — the exact
 * shape of the pre-existing order-dependent failure in `ContextGauge.test.tsx`.
 */

const mounted: Array<() => void> = [];

async function renderIcon(
	snapshots: readonly SubagentSnapshot[],
	onOpen: (id?: string) => void = () => undefined,
	language: Language = "en",
): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.push(() => {
		root.unmount();
		host.remove();
	});
	root.render(
		<TranslatorProvider language={language}>
			<SubagentEntryIcon snapshots={snapshots} onOpen={onOpen} />
		</TranslatorProvider>,
	);
	await flushRender();
	return host;
}

function button(host: HTMLElement): HTMLButtonElement | null {
	return host.querySelector<HTMLButtonElement>(".piem-chat__subagents-button");
}

function popover(host: HTMLElement): HTMLElement | null {
	return host.querySelector<HTMLElement>(".piem-chat__subagents-popover");
}

function items(host: HTMLElement): HTMLButtonElement[] {
	return Array.from(host.querySelectorAll<HTMLButtonElement>(".piem-chat__subagents-item"));
}

/**
 * A pointer arriving over an element.
 *
 * `pointerover`, not `pointerenter`: React synthesizes `onPointerEnter` from the
 * bubbling `pointerover`, so dispatching the non-bubbling native event would
 * test a handler React never wires up that way. Same reasoning — and same
 * helper — as `ContextGauge.test.tsx`.
 */
async function pointerOver(element: Element, pointerType: string): Promise<void> {
	element.dispatchEvent(new window.PointerEvent("pointerover", { bubbles: true, pointerType }));
	await flushRender();
}

async function pointerOut(element: Element, pointerType: string): Promise<void> {
	element.dispatchEvent(new window.PointerEvent("pointerout", { bubbles: true, pointerType, relatedTarget: document.body }));
	await flushRender();
}

/** Waits past CLOSE_DELAY_MS, so a deferred close has actually had its chance. */
async function afterCloseDelay(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 250));
	await flushRender();
}

describe("SubagentEntryIcon states", () => {
	beforeEach(cleanup);
	afterEach(cleanup);

	it("renders nothing until something has been delegated", async () => {
		// The reason it can live in a row the user reads before every send: a
		// permanent control for a feature most turns never touch spends attention
		// on nothing.
		const host = await renderIcon([]);

		expect(host.querySelector(".piem-chat__subagents")).toBeNull();
	});

	it("marks the icon and shows a running count while a child works", async () => {
		const host = await renderIcon([snapshot({ status: "running" }), snapshot({ id: "s2", status: "done" })]);

		// The modifier sits on the button, which is where the icon-colour tokens
		// apply — the wrapper only positions the popover.
		expect(host.querySelector(".piem-chat__subagents-button--running")).not.toBeNull();
		expect(host.querySelector(".piem-chat__subagents-badge")?.textContent).toBe("1");
		// Counts what is running, not what exists: "is Piem still waiting on
		// someone?" is the question the badge answers at a glance.
		expect(button(host)?.getAttribute("aria-label")).toContain("1 subagent(s) working");
	});

	it("goes quiet once everything has settled, but stays reachable", async () => {
		const host = await renderIcon([snapshot({ status: "done" }), snapshot({ id: "s2", status: "failed" })]);

		expect(host.querySelector(".piem-chat__subagents-button--running")).toBeNull();
		// The badge keeps its shape so the icon does not jump when the last child
		// settles; the stylesheet mutes it.
		expect(host.querySelector(".piem-chat__subagents-badge--settled")).not.toBeNull();
		expect(button(host)?.getAttribute("aria-label")).toContain("2 subagent(s) in this chat");
	});

	it("stays put when every run has been archived, since it is the way back to them", async () => {
		/*
		 * The panel's archive is the panel's own tidying, and this icon is the only
		 * affordance that opens the panel. Hiding it in sympathy would strand the
		 * archived record behind the command palette — so archiving is a fact this
		 * component does not read at all, and the count keeps saying how many
		 * subagents this chat has had.
		 */
		const host = await renderIcon([snapshot({ status: "done", archived: true }), snapshot({ id: "s2", status: "failed", archived: true })]);

		expect(host.querySelector(".piem-chat__subagents")).not.toBeNull();
		expect(button(host)?.getAttribute("aria-label")).toContain("2 subagent(s) in this chat");
	});

	it("carries the count in the accessible name and hides the bare digit", async () => {
		// The button's name already says "2 subagents working" in a sentence;
		// announcing a bare "2" after that is the same fact twice, badly.
		const host = await renderIcon([snapshot({ status: "running" }), snapshot({ id: "s2", status: "running" })]);

		expect(host.querySelector(".piem-chat__subagents-badge")?.getAttribute("aria-hidden")).toBe("true");
	});
});

describe("SubagentEntryIcon opening", () => {
	beforeEach(cleanup);
	afterEach(cleanup);

	it("opens the panel with no run named when the icon is pressed", async () => {
		const opened: (string | undefined)[] = [];
		const host = await renderIcon([snapshot({})], (id) => opened.push(id));

		button(host)?.click();
		await flushRender();

		expect(opened).toEqual([undefined]);
	});

	it("names a run when a popover item is pressed", async () => {
		const opened: (string | undefined)[] = [];
		const host = await renderIcon([snapshot({ id: "s1" }), snapshot({ id: "s2" })], (id) => opened.push(id));
		await pointerOver(host.querySelector(".piem-chat__subagents")!, "mouse");

		items(host)[1]?.click();
		await flushRender();

		expect(opened).toEqual(["s2"]);
	});

	it("closes the popover before navigating, so it cannot outlive its subject", async () => {
		const host = await renderIcon([snapshot({})]);
		await pointerOver(host.querySelector(".piem-chat__subagents")!, "mouse");
		expect(popover(host)).not.toBeNull();

		items(host)[0]?.click();
		await flushRender();

		expect(popover(host)).toBeNull();
	});
});

describe("SubagentEntryIcon popover", () => {
	beforeEach(cleanup);
	afterEach(cleanup);

	it("stays shut until asked", async () => {
		const host = await renderIcon([snapshot({})]);

		expect(popover(host)).toBeNull();
		expect(button(host)?.getAttribute("aria-expanded")).toBe("false");
	});

	it("opens on hover and closes once the pointer has been gone a moment", async () => {
		const host = await renderIcon([snapshot({})]);
		const wrapper = host.querySelector(".piem-chat__subagents")!;

		await pointerOver(wrapper, "mouse");
		expect(popover(host)).not.toBeNull();

		await pointerOut(wrapper, "mouse");
		// Deferred, not immediate: closing on pointerleave outright is the classic
		// hover-menu failure, where the pointer crosses the gap to the list and the
		// list it was travelling to has already gone.
		await afterCloseDelay();

		expect(popover(host)).toBeNull();
	});

	it("skips the popover on a touch tap and opens the panel instead", async () => {
		// React reports `pointerover` for a tap, so without the pointerType guard a
		// tap would open the popover and the tap's own click would open the panel
		// behind it.
		const opened: (string | undefined)[] = [];
		const host = await renderIcon([snapshot({})], (id) => opened.push(id));
		const wrapper = host.querySelector(".piem-chat__subagents")!;

		await pointerOver(wrapper, "touch");
		expect(popover(host)).toBeNull();

		button(host)?.click();
		await flushRender();

		expect(opened).toEqual([undefined]);
	});

	it("pins the popover on keyboard focus, since there is no pointer to leave", async () => {
		// Without this the items would be unreachable by Tab: a hover-only open has
		// nothing a keyboard reader can trigger, and nothing to keep it open once
		// focus moves into it.
		const host = await renderIcon([snapshot({})]);

		button(host)?.focus();
		await flushRender();
		expect(popover(host)).not.toBeNull();

		await pointerOut(host.querySelector(".piem-chat__subagents")!, "mouse");
		await afterCloseDelay();

		expect(popover(host)).not.toBeNull();
	});

	it("wires the button to the popover it controls", async () => {
		const host = await renderIcon([snapshot({})]);
		await pointerOver(host.querySelector(".piem-chat__subagents")!, "mouse");

		// Coalesced rather than left nullable: `toBe` takes `string | undefined`,
		// and an absent attribute has to fail the id comparison below rather than
		// the call's own types.
		const controls = button(host)?.getAttribute("aria-controls") ?? "";

		expect(button(host)?.getAttribute("aria-expanded")).toBe("true");
		expect(controls).not.toBe("");
		expect(popover(host)?.id).toBe(controls);
	});

	it("names each item by its task, not by opaque id", async () => {
		const host = await renderIcon([snapshot({ id: "s1", role: "scout", status: "running" })]);
		await pointerOver(host.querySelector(".piem-chat__subagents")!, "mouse");

		// Task first: a reader scanning rows remembers what they asked, and the
		// role describes several of them while the task describes one.
		expect(items(host)[0]?.getAttribute("aria-label")).toBe("Summarize the vault — open run");
	});

	it("carries the status word beside each item, not colour alone", async () => {
		const host = await renderIcon([snapshot({ status: "failed" })]);
		await pointerOver(host.querySelector(".piem-chat__subagents")!, "mouse");

		expect(items(host)[0]?.querySelector(".piem-chat__subagents-item-status")?.textContent).toContain("failed");
	});

	it("lists the task, which is what a reader remembers a run by", async () => {
		const host = await renderIcon([snapshot({ task: "Sweep Projects/ for stale links" })]);
		await pointerOver(host.querySelector(".piem-chat__subagents")!, "mouse");

		expect(items(host)[0]?.querySelector(".piem-chat__subagents-item-task")?.textContent).toBe("Sweep Projects/ for stale links");
	});

	it("translates the icon and the list", async () => {
		const host = await renderIcon([snapshot({ status: "running" })], () => undefined, "zh-cn");
		await pointerOver(host.querySelector(".piem-chat__subagents")!, "mouse");

		expect(button(host)?.getAttribute("aria-label")).toContain("正在干活");
		expect(items(host)[0]?.querySelector(".piem-chat__subagents-item-status")?.textContent).toContain("进行中");
	});
});

describe("SubagentEntryIcon offers no way to act on a child", () => {
	beforeEach(cleanup);
	afterEach(cleanup);

	it("has exactly one control per run, and it only navigates", async () => {
		// The popover is a shortcut into the panel, not a second control surface: a
		// stop button here would be the same rule break as one in the panel, with
		// less room to explain itself.
		const host = await renderIcon([snapshot({ status: "running" })]);
		await pointerOver(host.querySelector(".piem-chat__subagents")!, "mouse");

		const labels = Array.from(host.querySelectorAll("button"), (element) => element.getAttribute("aria-label") ?? "");

		expect(labels).toHaveLength(2);
		expect(labels.join(" ").toLowerCase()).not.toContain("stop");
		expect(labels.join(" ").toLowerCase()).not.toContain("kill");
	});
});

function cleanup(): void {
	while (mounted.length > 0) {
		mounted.pop()?.();
	}
	document.body.replaceChildren();
}

function snapshot(overrides: Partial<SubagentSnapshot>): SubagentSnapshot {
	return {
		id: "s1",
		role: "general",
		task: "Summarize the vault",
		depth: 1,
		ownerId: "chat-a",
		modelId: "test-model",
		thinkingLevel: "off",
		status: "done",
		spawnedAt: 1_000,
		settledAt: 4_000,
		durationMs: 3_000,
		messages: [],
		...overrides,
	};
}
