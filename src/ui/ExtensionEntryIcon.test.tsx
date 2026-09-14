import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import React, { useSyncExternalStore } from "react";
import type { Language } from "../i18n";
import { flushRender, installDom } from "../testUtils/dom";
import { installObsidianStub } from "../testUtils/obsidianStub";

installObsidianStub();
const document = installDom();

// Dynamic imports so the mocked `obsidian` module wins over any cached real one.
const { ExtensionEntryIcon, hasExtensionEntry } = await import("./ExtensionEntryIcon");
const { TranslatorProvider } = await import("./TranslatorContext");
const { createRoot } = await import("react-dom/client");
const { createComposerAutocomplete } = await import("./extensionAutocomplete");
const { ObsidianExtensionUI } = await import("./ObsidianExtensionUI");
const { getT } = await import("../i18n");
import type { App } from "obsidian";

/**
 * The extension entry icon, at the end of the context row.
 *
 * The visibility rule is the contract: absent with no mounted panel and nothing
 * on the books, present once an extension mounts an above-editor panel, kept
 * alive on its own while a run is pending or a failure is unread. Every state
 * is a claim the composer row makes before the user presses send, so a wrong
 * one is either a notification that never arrives or a permanent control for a
 * feature most turns never touch.
 *
 * Every mount is unmounted rather than detached, because the popover binds an
 * outside-press listener while open — the same reason SubagentEntryIcon.test
 * unmounts (see that file's comment on the ContextGauge order-dependent failure).
 */
const mounted: Array<() => void> = [];

interface Snapshot {
	widgets: { key: string; lines: string[]; placement: "aboveEditor" | "belowEditor" }[];
	statuses: { key: string; text: string }[];
	componentWidgets?: { key: string; surface: unknown; placement: "aboveEditor" | "belowEditor" }[];
	shortcuts?: { key: string; description?: string; run(): Promise<void> }[];
	shortcutPending?: string;
	shortcutError?: string;
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
	return { widgets: [], statuses: [], ...overrides };
}

async function renderIcon(
	iconSnapshot: Snapshot,
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
			<ExtensionEntryIcon snapshot={iconSnapshot as never} />
		</TranslatorProvider>,
	);
	await flushRender();
	return host;
}

function button(host: HTMLElement): HTMLButtonElement | null {
	return host.querySelector<HTMLButtonElement>(".piem-chat__extension-entry-button");
}

function popover(host: HTMLElement): HTMLElement | null {
	return host.querySelector<HTMLElement>(".piem-chat__extension-entry-popover");
}

beforeEach(async () => { await import("./ExtensionEntryIcon"); });
afterEach(async () => {
	for (const cleanup of mounted.splice(0).reverse()) cleanup();
	await flushRender();
	document.body.replaceChildren();
});

describe("hasExtensionEntry", () => {
	it("is false with no shortcuts, no mount and nothing on the books", () => {
		expect(hasExtensionEntry(snapshot() as never)).toBe(false);
	});

	it("is false for shortcuts whose panel never mounted", () => {
		expect(hasExtensionEntry(snapshot({ shortcuts: [{ key: "ctrl+shift+t", run: async () => {} }] }) as never)).toBe(false);
	});

	it("is true once a panel mounts above the editor", () => {
		expect(hasExtensionEntry(snapshot({
			shortcuts: [{ key: "ctrl+shift+t", run: async () => {} }],
			componentWidgets: [{ key: "rpiv-todos", surface: {}, placement: "aboveEditor" }],
		}) as never)).toBe(true);
		expect(hasExtensionEntry(snapshot({
			shortcuts: [{ key: "ctrl+shift+t", run: async () => {} }],
			widgets: [{ key: "w", lines: ["x"], placement: "aboveEditor" }],
		}) as never)).toBe(true);
	});

	it("is true while a run is pending or a failure is unread, even with no panel", () => {
		expect(hasExtensionEntry(snapshot({ shortcutPending: "ctrl+shift+t" }) as never)).toBe(true);
		expect(hasExtensionEntry(snapshot({ shortcutError: "failed" }) as never)).toBe(true);
	});
});

describe("ExtensionEntryIcon visibility", () => {
	it("renders nothing with no shortcuts and no mount", async () => {
		const host = await renderIcon(snapshot());
		expect(button(host)).toBeNull();
	});

	it("renders nothing for a shortcut whose panel never mounted", async () => {
		const host = await renderIcon(snapshot({ shortcuts: [{ key: "ctrl+shift+t", run: async () => {} }] }));
		expect(button(host)).toBeNull();
	});

	it("renders once a panel mounts, and hides again when it unmounts", async () => {
		const live = snapshot({ shortcuts: [{ key: "ctrl+shift+t", run: async () => {} }] });
		const host = await renderIcon(live);
		expect(button(host)).toBeNull();
		live.componentWidgets = [{ key: "rpiv-todos", surface: {}, placement: "aboveEditor" }];
		await renderIcon(live);
		expect(document.querySelector(".piem-chat__extension-entry-button")).not.toBeNull();
		live.componentWidgets = [];
		await renderIcon(live);
		// The same host: the icon is gone when the panel is.
		expect(button(host)).toBeNull();
	});
});

describe("ExtensionEntryIcon popover", () => {
	it("lists each action with its description and keybinding, and runs it on press", async () => {
		let calls = 0;
		const host = await renderIcon(snapshot({
			shortcuts: [{ key: "ctrl+shift+t", description: "Collapse or expand the todo overlay", run: async () => { calls++; } }],
			componentWidgets: [{ key: "rpiv-todos", surface: {}, placement: "aboveEditor" }],
		}));
		expect(button(host)).not.toBeNull();
		expect(popover(host)).toBeNull();
		button(host)!.click();
		await flushRender();
		const list = popover(host)!;
		expect(list.querySelector("button")?.textContent).toContain("Collapse or expand the todo overlay");
		expect(list.querySelector("kbd")?.textContent).toBe("ctrl+shift+t");
		list.querySelector<HTMLButtonElement>("button")!.click();
		await flushRender();
		expect(calls).toBe(1);
	});

	it("disables actions and shows a status line while a run is pending", async () => {
		let release!: (error: Error) => void;
		let calls = 0;
		const host = await renderIcon(snapshot({
			shortcuts: [{ key: "ctrl+shift+t", description: "Toggle", run: () => { calls++; return new Promise((_resolve, reject) => { release = reject; }); } }],
			componentWidgets: [{ key: "rpiv-todos", surface: {}, placement: "aboveEditor" }],
		}));
		button(host)!.click();
		await flushRender();
		const list = popover(host)!;
		const action = list.querySelector<HTMLButtonElement>("button")!;
		const first = action.click(), pending = release as never;
		expect(calls).toBe(1);
	});

	it("keeps the icon visible on its own while a run is pending, even after the panel unmounts", async () => {
		const live = snapshot({ shortcuts: [{ key: "k", run: async () => {} }], shortcutPending: "k" });
		const host = await renderIcon(live);
		expect(button(host)).not.toBeNull();
		// The popover is closed and the run's receipt is the icon's breath state;
		// the status line only renders while the popover is open.
		expect(popover(host)).toBeNull();
		expect(host.querySelector(".piem-chat__extension-entry-button--running")).not.toBeNull();
		button(host)!.click();
		await flushRender();
		expect(host.querySelector("[role=status]")?.textContent).toBe("Running action…");
	});

	it("reports a failure in the current language, keeps the icon alive, and hides the details", async () => {
		const host = await renderIcon(snapshot({ shortcutError: "操作失败，请重试。" }), "zh-cn");
		expect(button(host)).not.toBeNull();
		expect(host.querySelector("[role=alert]")?.textContent).toBe("操作失败，请重试。");
		// The failure dot rides the icon, aria-hidden — the alert is the sentence.
		expect(host.querySelector(".piem-chat__extension-entry-failed-dot")).not.toBeNull();
		expect(host.textContent).not.toContain("aria-hidden");
	});

	it("closes through Escape without reaching the composer's own handler", async () => {
		const host = await renderIcon(snapshot({
			shortcuts: [{ key: "k", run: async () => {} }],
			componentWidgets: [{ key: "rpiv-todos", surface: {}, placement: "aboveEditor" }],
		}));
		button(host)!.click();
		await flushRender();
		expect(popover(host)).not.toBeNull();
		popover(host)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await flushRender();
		expect(popover(host)).toBeNull();
	});
});

describe("ExtensionEntryIcon in a live panel adapter", () => {
	it("runs the adapter's shortcut from the popover and clears its failure through retry", async () => {
		const ui = new ObsidianExtensionUI({} as import("obsidian").App, () => getT("en"), { isCurrent: () => true, getText: () => "", setText: () => {}, paste: () => {} }, createComposerAutocomplete(() => []));
		mounted.push(() => ui.dispose());
		let calls = 0;
		let fail!: (error: Error) => void;
		ui.setShortcuts([{ key: "ctrl+shift+t", description: "Toggle", run: () => { calls++; return new Promise((resolve, reject) => { fail = reject; }); } }]);
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		mounted.push(() => { root.unmount(); host.remove(); });
		function Panel() {
			const iconSnapshot = useSyncExternalStore(ui.subscribe, ui.getSnapshot);
			// A live adapter mounts a widget through setWidget; simulate the
			// panel presence the todo overlay would have registered.
			const visible = { ...iconSnapshot, componentWidgets: [{ key: "rpiv-todos", surface: {}, placement: "aboveEditor" as const }] };
			return <TranslatorProvider language="en"><ExtensionEntryIcon snapshot={visible as never} /></TranslatorProvider>;
		}
		root.render(<Panel />);
		await flushRender();
		host.querySelector<HTMLButtonElement>(".piem-chat__extension-entry-button")!.click();
		await flushRender();
		const action = popover(host)!.querySelector<HTMLButtonElement>("button")!;
		const first = action.click();
		await flushRender();
		expect(calls).toBe(1);
		expect(action.disabled).toBe(true);
		expect(popover(host)!.querySelector("[role=status]")?.textContent).toBe("Running action…");
		fail(new Error("Private failure details"));
		await first; await flushRender();
		expect(host.querySelector("[role=alert]")?.textContent).toBe("This action failed. Try again.");
		expect(host.textContent).not.toContain("Private failure details");
		const retry = popover(host)!.querySelector<HTMLButtonElement>("button")!.click();
		expect(calls).toBe(2);
		ui.reset();
	});
});
