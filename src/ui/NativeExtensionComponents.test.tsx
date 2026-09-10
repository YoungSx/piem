import { afterEach, describe, expect, it, spyOn } from "bun:test";
import React from "react";
import type { NativeComponentNode } from "../extensions/compat/componentTree";
import type { NativeExtensionSurface } from "../extensions/extensionUI";
import { flushRender, installDom } from "../testUtils/dom";
import { installObsidianStub } from "../testUtils/obsidianStub";

installObsidianStub();
const document = installDom();
const { createRoot } = await import("react-dom/client");
const { NativeExtensionComponents } = await import("./NativeExtensionComponents");
const cleanups: (() => void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	await flushRender();
	document.body.replaceChildren();
});

function surface(initial: NativeComponentNode) {
	let current = initial;
	const listeners = new Set<() => void>();
	const sizes: number[] = [];
	let cancelled = 0;
	const view: NativeExtensionSurface = {
		getSnapshot: () => current,
		subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		resize: columns => { sizes.push(columns); },
		cancel: () => { cancelled++; },
	};
	return {
		view, sizes, listeners, cancelled: () => cancelled,
		update: (node: NativeComponentNode) => { current = node; for (const listener of listeners) listener(); },
	};
}

async function mount(view: NativeExtensionSurface) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	let closed = false;
	const unmount = () => { if (!closed) { closed = true; root.unmount(); } };
	cleanups.push(unmount);
	root.render(<NativeExtensionComponents surface={view} />);
	await flushRender();
	return { host, unmount };
}

describe("native component rendering", () => {
	it("renders literal text and typed controls without guessing actions from content", async () => {
		const view = surface({ kind: "container", children: [
			{ kind: "text", text: "<img src=x onerror=alert(1)>\nChoose 1 Review", paddingX: 2, paddingY: 1 },
			{ kind: "border" },
			{ kind: "loader", text: "Preparing", cancellable: false, aborted: false, onCancel: () => {} },
		] });
		const { host } = await mount(view.view);
		expect(host.querySelector("img")).toBeNull();
		expect(host.querySelector(".piem-native-extension__text")?.textContent).toBe("<img src=x onerror=alert(1)>\nChoose 1 Review");
		expect(host.querySelector("button")).toBeNull();
		expect(host.querySelector("hr")).not.toBeNull();
		expect(host.querySelector("progress")?.getAttribute("aria-label")).toBe("Loading");
		expect(host.querySelector("[role=status]")?.getAttribute("aria-busy")).toBe("true");
	});

	it("preserves native choice values, keyboard selection, touch activation and cancellation", async () => {
		const selected: number[] = [];
		const changed: number[] = [];
		let cancellations = 0;
		const node: Extract<NativeComponentNode, { kind: "select" }> = {
			kind: "select", items: [
				{ value: "original-a", label: "Review", description: "Read the proposal" },
				{ value: "original-b", label: "Write", description: "Prepare a draft" },
			], selectedIndex: 0, maxVisible: 2,
			onSelect: index => { selected.push(index); },
			onSelectionChange: index => { changed.push(index); view.update({ ...node, selectedIndex: index }); },
			onCancel: () => { cancellations++; },
		};
		const view = surface(node);
		const { host } = await mount(view.view);
		const first = host.querySelector<HTMLButtonElement>("[role=option]")!;
		first.focus();
		const down = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
		first.dispatchEvent(down);
		await flushRender();
		expect(down.defaultPrevented).toBe(true);
		expect(changed).toEqual([1]);
		const second = host.querySelectorAll<HTMLButtonElement>("[role=option]")[1]!;
		expect(document.activeElement).toBe(second);
		expect(second.getAttribute("aria-selected")).toBe("true");
		second.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		expect(selected).toEqual([1]);
		first.click();
		expect(selected).toEqual([1, 0]);
		expect(changed).toEqual([1]);
		second.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		expect(cancellations).toBe(1);
	});

	it("does not intercept composition, and reports callback failures without losing the controls", async () => {
		let selections = 0;
		const view = surface({ kind: "select", items: [{ value: "a", label: "Continue" }], selectedIndex: 0, maxVisible: 1,
			onSelect: () => { selections++; throw new Error("Private details"); }, onSelectionChange: () => {}, onCancel: () => {},
		});
		const { host } = await mount(view.view);
		const choice = host.querySelector<HTMLButtonElement>("button")!;
		const composing = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
		choice.dispatchEvent(composing);
		expect(composing.defaultPrevented).toBe(false);
		expect(selections).toBe(0);
		choice.click();
		await flushRender();
		expect(host.querySelector("[role=alert]")?.textContent).toBe("This action failed. Try again.");
		expect(host.textContent).not.toContain("Private details");
		expect(choice.isConnected).toBe(true);
	});

	it("keeps focused and selected options aligned after programmatic changes without stealing outside focus", async () => {
		const selections: number[] = [];
		const node: Extract<NativeComponentNode, { kind: "select" }> = {
			kind: "select", items: [{ value: "first", label: "First" }, { value: "second", label: "Second" }], selectedIndex: 0, maxVisible: 2,
			onSelect: index => { selections.push(index); }, onSelectionChange: () => {}, onCancel: () => {},
		};
		const view = surface(node);
		const { host } = await mount(view.view);
		const choices = host.querySelectorAll<HTMLButtonElement>("[role=option]");
		choices[0]!.focus();
		view.update({ ...node, selectedIndex: 1 });
		await flushRender();
		expect(document.activeElement).toBe(choices[1]!);
		expect(document.activeElement?.getAttribute("aria-selected")).toBe("true");
		document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		expect(selections).toEqual([1]);
		const editor = document.createElement("textarea");
		document.body.appendChild(editor);
		editor.focus();
		view.update({ ...node, selectedIndex: 0 });
		await flushRender();
		expect(document.activeElement).toBe(editor);
		expect(choices[0]!.getAttribute("aria-selected")).toBe("true");
	});

	it("updates loading state from the surface and releases its subscription when unmounted", async () => {
		let cancellations = 0;
		const loading: Extract<NativeComponentNode, { kind: "loader" }> = { kind: "loader", text: "Preparing", cancellable: true, aborted: false,
			onCancel: () => { cancellations++; view.update({ ...loading, aborted: true }); },
		};
		const view = surface(loading);
		const { host, unmount } = await mount(view.view);
		expect(view.listeners.size).toBe(1);
		host.querySelector<HTMLButtonElement>("button")!.click();
		await flushRender();
		expect(cancellations).toBe(1);
		expect(host.querySelector("progress")).toBeNull();
		expect(host.querySelector("[role=status]")?.textContent).toBe("Cancelled");
		expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
		unmount();
		expect(view.listeners.size).toBe(0);
		view.update({ kind: "text", text: "Late text", paddingX: 0, paddingY: 0 });
		expect(host.textContent).toBe("");
	});

	it("bounds measured columns and disconnects its observer without a polling timer", async () => {
		const owner = document.defaultView!;
		const original = owner.ResizeObserver;
		let measure: (() => void) | undefined;
		let disconnected = 0;
		let width = 320;
		const rect = spyOn(owner.HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			const measured = this.classList.contains("piem-native-extension__measure") ? 100 : width;
			return { width: measured, height: 20, top: 0, right: measured, left: 0, bottom: 20, x: 0, y: 0, toJSON: () => ({}) };
		});
		owner.ResizeObserver = class {
			constructor(callback: ResizeObserverCallback) { measure = () => callback([], this); }
			observe() {}
			unobserve() {}
			disconnect() { disconnected++; }
		};
		cleanups.push(() => { owner.ResizeObserver = original; rect.mockRestore(); });
		const view = surface({ kind: "text", text: "Sizing", paddingX: 0, paddingY: 0 });
		const { unmount } = await mount(view.view);
		expect(view.sizes).toEqual([32]);
		width = 10_000;
		measure?.();
		width = 2;
		measure?.();
		expect(view.sizes).toEqual([32, 500, 1]);
		unmount();
		expect(disconnected).toBe(1);
		measure?.();
		expect(view.sizes).toHaveLength(3);
	});
});
