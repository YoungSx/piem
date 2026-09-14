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
	it("shows no new controls until registered and renders widget content above the editor", async () => {
		const { ui, host } = await setup();
		expect(host.querySelector("section")).toBeNull();
		ui.setWidget("hint", ["One", "Two"]);
		await flushRender();
		const above = host.querySelector("[data-position=above]")!;
		expect(above.children).toHaveLength(1);
		expect(above.querySelector("section")?.textContent).toContain("One");
		// The below-editor surface stays empty: shortcut actions moved to the
		// context row's entry icon, and the content surface renders nothing
		// without content of its own.
		expect(host.querySelector("[data-position=below]")?.children).toHaveLength(0);
		ui.setWidget("hint", undefined);
		await flushRender();
		expect(host.querySelector("section")).toBeNull();
	});

	it("renders no shortcut strip below the editor even while shortcuts and a failure are on the books", async () => {
		const { ui, host } = await setup();
		ui.setShortcuts([{ key: "ctrl+shift+r", description: "Review", run: async () => {} }]);
		ui.setWidget("panel", ["A mounted panel"]);
		await flushRender();
		// The actions live in the entry icon now; the surfaces stay content-only.
		expect(host.querySelector("details")).toBeNull();
		expect(host.querySelector("[role=status]")).toBeNull();
		expect(host.querySelector("[role=alert]")).toBeNull();
		expect(host.querySelector("kbd")).toBeNull();
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
