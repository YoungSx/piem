import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { App } from "obsidian";
import { flushRender, installDom } from "../testUtils/dom";
import { installObsidianStub } from "../testUtils/obsidianStub";

installObsidianStub();
const document = installDom();
const { ObsidianExtensionUI } = await import("./ObsidianExtensionUI");
const { createComposerAutocomplete } = await import("./extensionAutocomplete");
const { getT } = await import("../i18n");

const adapters: InstanceType<typeof ObsidianExtensionUI>[] = [];
function setup() {
	let text = "draft";
	let current = true;
	const ui = new ObsidianExtensionUI({} as App, () => getT("en"), {
		isCurrent: () => current,
		getText: () => text,
		setText: (value) => { text = value; },
		paste: (value) => { text += value; },
	}, createComposerAutocomplete(() => []));
	adapters.push(ui);
	return { ui, switchAway: () => { current = false; } };
}
function button(label: string): HTMLButtonElement {
	const found = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((entry) => entry.textContent === label);
	if (!found) throw new Error(`Missing dialog button: ${label}`);
	return found;
}
afterEach(async () => {
	for (const adapter of adapters.splice(0)) adapter.dispose();
	await flushRender();
	document.body.replaceChildren();
});

describe("Obsidian extension dialogs", () => {
	it("returns the selected native option and closes its form", async () => {
		const { ui } = setup();
		const answer = ui.select("Next step", ["Review", "Write"]);
		await flushRender();
		const select = document.querySelector("select")!;
		select.value = "Write";
		button("Confirm").click();
		expect(await answer).toBe("Write");
		expect(document.querySelector("form")).toBeNull();
	});

	it("supports confirmation, single-line input and multiline editing", async () => {
		const { ui } = setup();
		const confirmed = ui.confirm("Apply?", "Update this draft?");
		await flushRender();
		expect(document.querySelector("p")?.textContent).toBe("Update this draft?");
		button("Confirm").click();
		expect(await confirmed).toBe(true);
		const input = ui.input("Name", "New name");
		await flushRender();
		expect(document.querySelector("input")?.placeholder).toBe("New name");
		document.querySelector("input")!.value = "A title";
		button("Confirm").click();
		expect(await input).toBe("A title");
		const edited = ui.editor("Edit proposal", "First line\nSecond line");
		await flushRender();
		expect(document.querySelector("textarea")?.value).toBe("First line\nSecond line");
		document.querySelector("textarea")!.value = "Revised\nDraft";
		button("Save").click();
		expect(await edited).toBe("Revised\nDraft");
	});

	it("cancels through the native form, abort signal and reset", async () => {
		const { ui } = setup();
		const confirm = ui.confirm("Continue?", "A message");
		await flushRender();
		button("Cancel").click();
		expect(await confirm).toBe(false);
		const controller = new AbortController();
		const answer = ui.input("Name", undefined, { signal: controller.signal });
		controller.abort();
		expect(await answer).toBeUndefined();
		const editorController = new AbortController();
		const edited = ui.editor("Draft", "Words", editorController.signal);
		editorController.abort();
		expect(await edited).toBeUndefined();
		const reset = ui.editor("Draft", "Words");
		ui.reset();
		expect(await reset).toBeUndefined();
		expect(document.querySelector("form")).toBeNull();
	});

	it("refuses stacked dialogs and invalid timeouts", async () => {
		const { ui } = setup();
		const first = ui.input("First");
		await expect(ui.input("Second")).rejects.toThrow("already open");
		ui.reset();
		await first;
		for (const timeout of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
			await expect(ui.input("Invalid", undefined, { timeout })).rejects.toThrow("finite non-negative");
		}
		expect(document.querySelector("form")).toBeNull();
	});

	it("clears its countdown and abort listener on dismissal and disposal", async () => {
		const { ui } = setup();
		const controller = new AbortController();
		const remove = spyOn(controller.signal, "removeEventListener");
		const clear = spyOn(window, "clearTimeout");
		try {
			const answer = ui.input("Name", undefined, { timeout: 60_000, signal: controller.signal });
			await flushRender();
			expect(document.querySelector(".piem-extension-dialog__timeout")?.textContent).toBe("Closes in 60 seconds");
			ui.dispose();
			expect(await answer).toBeUndefined();
			expect(clear).toHaveBeenCalled();
			expect(remove.mock.calls.some(([event]) => event === "abort")).toBe(true);
		} finally {
			clear.mockRestore();
			remove.mockRestore();
		}
	});

	it("times out and skips an already aborted request", async () => {
		const { ui } = setup();
		expect(await ui.select("Short", ["One"], { timeout: 5 })).toBeUndefined();
		const controller = new AbortController();
		controller.abort();
		expect(await ui.input("Gone", undefined, { signal: controller.signal })).toBeUndefined();
		expect(document.querySelector("form")).toBeNull();
	});
});

describe("Obsidian extension UI ownership", () => {
	it("updates text surfaces, wraps autocomplete and resets for agent rebuild", async () => {
		const { ui } = setup();
		ui.setEditorText("A");
		ui.pasteToEditor("B");
		expect(ui.getEditorText()).toBe("AB");
		ui.setWidget("hint", ["One", "Two"]);
		ui.setWidget("hint", ["Replaced"], { placement: "belowEditor" });
		ui.setStatus("progress", "Ready");
		ui.addAutocompleteProvider((current) => ({ ...current, triggerCharacters: ["@"] }));
		expect(ui.getSnapshot().autocomplete?.triggerCharacters).toEqual(["@"]);
		expect(ui.getSnapshot().widgets).toEqual([{ key: "hint", lines: ["Replaced"], placement: "belowEditor" }]);
		ui.reset();
		expect(ui.getSnapshot()).toEqual({ widgets: [], statuses: [] });
		ui.setStatus("next", "Working");
		expect(ui.getSnapshot().statuses).toEqual([{ key: "next", text: "Working" }]);
	});

	it("rejects writes and dialogs from a departed conversation", async () => {
		const { ui, switchAway } = setup();
		switchAway();
		expect(() => ui.getEditorText()).toThrow("inactive conversation");
		expect(() => ui.setEditorText("Leak")).toThrow("inactive conversation");
		expect(() => ui.pasteToEditor("Leak")).toThrow("inactive conversation");
		expect(() => ui.setWidget("x", ["Leak"])).toThrow("inactive conversation");
		await expect(ui.input("Old question")).rejects.toThrow("inactive conversation");
		ui.dispose();
		expect(() => ui.setStatus("x", "Leak")).toThrow("inactive conversation");
	});
});
