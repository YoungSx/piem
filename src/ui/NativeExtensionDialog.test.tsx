import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { App } from "obsidian";
import type { NativeComponentNode } from "../extensions/compat/componentTree";
import type { NativeExtensionSurface } from "../extensions/extensionUI";
import { flushRender, installDom } from "../testUtils/dom";
import { installObsidianStub } from "../testUtils/obsidianStub";

installObsidianStub();
const document = installDom();
const { NativeExtensionDialog } = await import("./NativeExtensionDialog");
const { ObsidianExtensionUI } = await import("./ObsidianExtensionUI");
const { createComposerAutocomplete } = await import("./extensionAutocomplete");
const { getT } = await import("../i18n");
const cleanups: (() => void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	await flushRender();
	document.body.replaceChildren();
});

function surface(node: NativeComponentNode = { kind: "text", text: "Keep this literal", paddingX: 0, paddingY: 0 }) {
	const listeners = new Set<() => void>();
	let cancelled = 0;
	const view: NativeExtensionSurface = {
		getSnapshot: () => node,
		subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		resize: () => {}, cancel: () => { cancelled++; },
	};
	return { view, listeners, cancelled: () => cancelled };
}

function adapter() {
	const ui = new ObsidianExtensionUI({} as App, () => getT("en"), {
		isCurrent: () => true, getText: () => "", setText: () => {}, paste: () => {},
	}, createComposerAutocomplete(() => []));
	cleanups.push(() => ui.dispose());
	return ui;
}

describe("native extension component dialogs", () => {
	it("focuses a real option, calls its callback and closes on the host completion signal", async () => {
		let choice: number | undefined;
		const controller = new AbortController();
		const view = surface({ kind: "select", items: [{ value: "one", label: "Review" }, { value: "two", label: "Write" }], selectedIndex: 1, maxVisible: 2,
			onSelect: index => { choice = index; controller.abort(); }, onSelectionChange: () => {}, onCancel: () => {},
		});
		const ui = adapter();
		const answer = ui.showComponent(view.view, controller.signal);
		await flushRender();
		expect(document.activeElement?.textContent).toBe("Write");
		(document.activeElement as HTMLButtonElement).click();
		await answer;
		await flushRender();
		expect(choice).toBe(1);
		expect(view.cancelled()).toBe(0);
		expect(view.listeners.size).toBe(0);
		expect(document.querySelector(".piem-native-extension-dialog")).toBeNull();
	});

	it("cancels once on user dismissal and always removes its abort listener", async () => {
		const controller = new AbortController();
		const view = surface();
		const remove = spyOn(controller.signal, "removeEventListener");
		cleanups.push(() => remove.mockRestore());
		const dialog = new NativeExtensionDialog({} as App, getT("zh-cn"), view.view, controller.signal);
		cleanups.push(() => dialog.close());
		dialog.open();
		await flushRender();
		expect(document.querySelector("button")?.textContent).toBe("取消");
		document.querySelector<HTMLButtonElement>("button")!.click();
		await dialog.result;
		dialog.close();
		controller.abort();
		await flushRender();
		expect(view.cancelled()).toBe(1);
		expect(remove.mock.calls.some(([event]) => event === "abort")).toBe(true);
		expect(view.listeners.size).toBe(0);
	});

	it("does not mount cancelled requests and refuses ordinary/custom modal overlap", async () => {
		const ui = adapter();
		const view = surface();
		const cancelled = new AbortController();
		cancelled.abort();
		await ui.showComponent(view.view, cancelled.signal);
		expect(document.body.children).toHaveLength(0);
		const first = ui.input("First question");
		await expect(ui.showComponent(view.view, new AbortController().signal)).rejects.toThrow("already open");
		ui.reset(); await first;
		const custom = ui.showComponent(view.view, new AbortController().signal);
		await expect(ui.input("Second question")).rejects.toThrow("already open");
		ui.reset(); await custom;
		expect(view.cancelled()).toBe(1);
	});

	it("disposes a pending custom modal and clears all component widgets", async () => {
		const ui = adapter();
		const view = surface();
		ui.setWidget("same", ["Plain"]);
		ui.setComponentWidget("same", view.view, { placement: "belowEditor" });
		expect(ui.getSnapshot().widgets).toHaveLength(0);
		expect(ui.getSnapshot().componentWidgets?.[0]?.placement).toBe("belowEditor");
		ui.setWidget("same", ["Back to text"]);
		expect(ui.getSnapshot().componentWidgets).toHaveLength(0);
		const answer = ui.showComponent(view.view, new AbortController().signal);
		await flushRender();
		ui.dispose();
		await answer; await flushRender();
		expect(view.cancelled()).toBe(1);
		expect(view.listeners.size).toBe(0);
		expect(ui.getSnapshot()).toEqual({ widgets: [], statuses: [] });
		await expect(ui.showComponent(view.view, new AbortController().signal)).rejects.toThrow("inactive conversation");
	});
});
