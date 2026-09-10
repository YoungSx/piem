import { afterEach, describe, expect, it } from "bun:test";
import React, { useSyncExternalStore } from "react";
import type { App } from "obsidian";
import { flushRender, installDom } from "../testUtils/dom";
import { installObsidianStub } from "../testUtils/obsidianStub";

installObsidianStub();
const document = installDom();
const { createRoot } = await import("react-dom/client");
const { ExtensionSurfaces } = await import("./ExtensionSurfaces");
const { ObsidianExtensionUI } = await import("./ObsidianExtensionUI");
const { createComposerAutocomplete } = await import("./extensionAutocomplete");
const { getT } = await import("../i18n");
const { TranslatorProvider } = await import("./TranslatorContext");
const cleanups: (() => void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	await flushRender();
	document.body.replaceChildren();
});

async function setup() {
	const ui = new ObsidianExtensionUI({} as App, () => getT("zh-cn"), { isCurrent: () => true, getText: () => "", setText: () => {}, paste: () => {} }, createComposerAutocomplete(() => []));
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	cleanups.push(() => ui.dispose(), () => root.unmount());
	function Panel() {
		const snapshot = useSyncExternalStore(ui.subscribe, ui.getSnapshot);
		return <TranslatorProvider language="zh-cn"><div data-position="above"><ExtensionSurfaces snapshot={snapshot} placement="aboveEditor" /></div>
			<div data-position="below"><ExtensionSurfaces snapshot={snapshot} placement="belowEditor" /></div></TranslatorProvider>;
	}
	root.render(<Panel />);
	await flushRender();
	return { ui, host };
}

describe("native extension surfaces", () => {
	it("shows no new controls until registered and exposes shortcuts as touch actions below the editor", async () => {
		const { ui, host } = await setup();
		expect(host.querySelector("section")).toBeNull();
		let calls = 0;
		ui.setShortcuts([{ key: "ctrl+shift+r", description: "Review draft", run: async () => { calls++; } }]);
		await flushRender();
		expect(host.querySelector("[data-position=above]")?.children).toHaveLength(0);
		const details = host.querySelector<HTMLDetailsElement>("details")!;
		expect(details.open).toBe(false);
		expect(details.querySelector("summary")?.textContent).toBe("扩展操作");
		details.open = true;
		details.querySelector<HTMLButtonElement>("button")!.click();
		await flushRender();
		expect(calls).toBe(1);
		expect(details.querySelector("kbd")?.textContent).toBe("ctrl+shift+r");
	});

	it("disables duplicate actions, reports failure in the current language and permits retry", async () => {
		const { ui, host } = await setup();
		let fail!: (error: Error) => void;
		let calls = 0;
		ui.setShortcuts([{ key: "ctrl+shift+r", description: "Review", run: () => { calls++; return new Promise((_resolve, reject) => { fail = reject; }); } }]);
		await flushRender();
		const action = ui.getSnapshot().shortcuts![0]!;
		const first = action.run();
		await action.run();
		await flushRender();
		expect(calls).toBe(1);
		expect(host.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
		expect(host.querySelector("[role=status]")?.textContent).toBe("正在执行…");
		fail(new Error("Private failure details"));
		await first; await flushRender();
		expect(host.querySelector("[role=alert]")?.textContent).toBe("操作失败，请重试。");
		expect(host.textContent).not.toContain("Private failure details");
		expect(host.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);
		const retry = action.run();
		expect(calls).toBe(2);
		fail(new DOMException("Stopped", "AbortError"));
		await retry; await flushRender();
		expect(host.querySelector("[role=alert]")).toBeNull();
	});

	it("ignores retained actions after reset and late failures cannot restore departed UI", async () => {
		const { ui, host } = await setup();
		let reject!: (error: Error) => void;
		let calls = 0;
		ui.setShortcuts([{ key: "ctrl+shift+r", description: "Review", run: () => { calls++; return new Promise((_resolve, fail) => { reject = fail; }); } }]);
		const old = ui.getSnapshot().shortcuts![0]!;
		const pending = old.run();
		ui.reset();
		await old.run();
		reject(new Error("Late failure"));
		await pending; await flushRender();
		expect(calls).toBe(1);
		expect(host.querySelector("section")).toBeNull();
		expect(ui.getSnapshot()).toEqual({ widgets: [], statuses: [] });
	});
});
