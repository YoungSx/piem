import { afterEach, describe, expect, it } from "bun:test";
import React, { StrictMode, useRef, useState } from "react";
import type { App } from "obsidian";
import type { ObsidianAgentService } from "../agent/ObsidianAgentService";
import type { ExtensionUIAdapter } from "../extensions/extensionUI";
import { flushRender, installDom } from "../testUtils/dom";
import { installObsidianStub } from "../testUtils/obsidianStub";

installObsidianStub();
const document = installDom();
const { createRoot } = await import("react-dom/client");
const { useExtensionUI } = await import("./useExtensionUI");
const { projectComposerDraft, withComposerText } = await import("./composerDraft");
const skillCommands = [{ name: "review", invocation: "skill:review", kind: "skill" as const, description: "Review notes" }];
const cleanups: (() => void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	await flushRender();
	document.body.replaceChildren();
});

async function mount(options: { ready?: boolean; strict?: boolean } = {}) {
	let activePath = "session-a";
	const attachments: ExtensionUIAdapter[] = [];
	let detached = 0;
	const service = {
		getApp: () => ({} as App),
		getSnapshot: () => ({ session: { path: activePath } }),
		attachExtensionUI: (_path: string, adapter: ExtensionUIAdapter) => {
			attachments.push(adapter);
			return () => { detached++; adapter.reset(); };
		},
	} as unknown as ObsidianAgentService;
	function Panel({ path, ready }: { path: string; ready: boolean }) {
		const [input, setInput] = useState("Draft");
		const inputRef = useRef(input);
		inputRef.current = input;
		const ui = useExtensionUI(service, path, "en", skillCommands, inputRef, setInput, ready);
		const draft = projectComposerDraft(input, skillCommands);
		return <textarea ref={ui.bindEditor} value={draft.text} onChange={(event) => setInput(withComposerText(draft, event.currentTarget.value))} />;
	}
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	let unmounted = false;
	const unmount = (): void => { if (!unmounted) { unmounted = true; root.unmount(); } };
	cleanups.push(unmount);
	const render = async (ready: boolean, path = activePath): Promise<void> => {
		activePath = path;
		const panel = <Panel path={path} ready={ready} />;
		root.render(options.strict ? <StrictMode>{panel}</StrictMode> : panel);
		await flushRender();
	};
	await render(options.ready ?? true);
	const latest = (): ExtensionUIAdapter => {
		const adapter = attachments.at(-1);
		if (!adapter) throw new Error("Panel has not attached its extension UI");
		return adapter;
	};
	return { host, attachments, latest, render, unmount, detached: () => detached };
}

describe("native extension UI attachment", () => {
	it("waits for the stored draft and creates a fresh adapter after another load", async () => {
		const panel = await mount({ ready: false });
		expect(panel.attachments).toHaveLength(0);
		await panel.render(true);
		const first = panel.latest();
		first.setEditorText("Ready draft");
		await flushRender();
		expect(panel.host.querySelector("textarea")?.value).toBe("Ready draft");
		await panel.render(false);
		expect(() => first.setEditorText("Old write")).toThrow("inactive conversation");
		await panel.render(true);
		const second = panel.latest();
		expect(second).not.toBe(first);
		second.setEditorText("Reloaded draft");
		await flushRender();
		expect(panel.host.querySelector("textarea")?.value).toBe("Reloaded draft");
		expect(() => first.getEditorText()).toThrow("inactive conversation");
	});

	it("uses a fresh adapter after StrictMode cleanup instead of reviving the old one", async () => {
		const panel = await mount({ strict: true });
		expect(panel.attachments).toHaveLength(2);
		expect(panel.detached()).toBe(1);
		expect(() => panel.attachments[0]!.setStatus("old", "Stale")).toThrow("inactive conversation");
		panel.latest().setEditorText("Survives StrictMode");
		await flushRender();
		expect(panel.host.querySelector("textarea")?.value).toBe("Survives StrictMode");
	});

	it("pastes into the real selection and keeps the resulting caret after the insert", async () => {
		const panel = await mount();
		const ui = panel.latest();
		ui.setEditorText("One\nReplace this\nTail");
		await flushRender();
		const editor = panel.host.querySelector("textarea")!;
		editor.setSelectionRange(4, 16);
		ui.pasteToEditor("New");
		expect(ui.getEditorText()).toBe("One\nNew\nTail");
		expect(editor.selectionStart).toBe(7);
		await flushRender();
		expect(editor.value).toBe("One\nNew\nTail");
		expect(editor.selectionEnd).toBe(7);
	});

	it("maps extension replacements and pastes through the skill card's visible question", async () => {
		const panel = await mount();
		const ui = panel.latest();
		ui.setEditorText("/skill:review One Replace Tail");
		await flushRender();
		const editor = panel.host.querySelector("textarea")!;
		expect(editor.value).toBe("One Replace Tail");
		editor.setSelectionRange(4, 11);
		ui.pasteToEditor("New");
		await flushRender();
		expect(ui.getEditorText()).toBe("/skill:review One New Tail");
		expect(editor.value).toBe("One New Tail");
		expect(editor.selectionStart).toBe(7);
		ui.setEditorText("Plain replacement");
		await flushRender();
		expect(ui.getEditorText()).toBe("Plain replacement");
		expect(editor.value).toBe("Plain replacement");
	});

	it("leaves the caret before the question when an extension pastes a new skill prefix", async () => {
		const panel = await mount();
		const ui = panel.latest();
		ui.setEditorText("Tail"); await flushRender();
		const editor = panel.host.querySelector("textarea")!;
		editor.setSelectionRange(0, 0);
		ui.pasteToEditor("/skill:review "); await flushRender();
		expect(ui.getEditorText()).toBe("/skill:review Tail");
		expect(editor.value).toBe("Tail");
		expect(editor.selectionStart).toBe(0);
		expect(editor.selectionEnd).toBe(0);
	});

	it("cancels dialogs and invalidates every departed adapter on switch or unmount", async () => {
		const panel = await mount();
		const first = panel.latest();
		const answer = first.input("Question for A");
		await panel.render(true, "session-b");
		expect(await answer).toBeUndefined();
		expect(document.querySelector("form")).toBeNull();
		expect(() => first.setEditorText("For A only")).toThrow("inactive conversation");
		const second = panel.latest();
		const edited = second.editor("Question for B", "Prefill");
		await panel.render(true, "session-a");
		expect(await edited).toBeUndefined();
		expect(() => first.setEditorText("Old A write")).toThrow("inactive conversation");
		const third = panel.latest();
		third.setEditorText("Current A draft");
		await flushRender();
		expect(panel.host.querySelector("textarea")?.value).toBe("Current A draft");
		const finalQuestion = third.input("Last question");
		panel.unmount();
		expect(await finalQuestion).toBeUndefined();
		expect(() => second.getEditorText()).toThrow("inactive conversation");
		expect(() => third.getEditorText()).toThrow("inactive conversation");
		expect(() => first.setEditorText("A is still gone")).toThrow("inactive conversation");
	});

	it("runs shortcuts only within the current textarea and preserves composition and native editing", async () => {
		const panel = await mount({ strict: true });
		let calls = 0;
		panel.latest().setShortcuts?.([
			{ key: "ctrl+shift+r", description: "Review", run: async () => { calls++; } },
			{ key: "ctrl+c", description: "Reserved", run: async () => { calls += 10; } },
		]);
		await flushRender();
		const editor = panel.host.querySelector("textarea")!;
		const dispatch = (target: EventTarget, options: KeyboardEventInit = {}) => {
			const event = new KeyboardEvent("keydown", { key: "R", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true, ...options });
			target.dispatchEvent(event);
			return event;
		};
		expect(dispatch(document.body).defaultPrevented).toBe(false);
		expect(calls).toBe(0);
		expect(dispatch(editor).defaultPrevented).toBe(true);
		await flushRender();
		expect(calls).toBe(1);
		expect(dispatch(editor, { isComposing: true }).defaultPrevented).toBe(false);
		expect(dispatch(editor, { key: "c", shiftKey: false }).defaultPrevented).toBe(false);
		expect(calls).toBe(1);
		await panel.render(true, "session-b");
		expect(dispatch(editor).defaultPrevented).toBe(false);
		expect(calls).toBe(1);
		panel.latest().setShortcuts?.([{ key: "ctrl+shift+r", description: "Current", run: async () => { calls += 2; } }]);
		expect(dispatch(editor).defaultPrevented).toBe(true);
		await flushRender();
		expect(calls).toBe(3);
		panel.unmount();
		expect(dispatch(editor).defaultPrevented).toBe(false);
		expect(calls).toBe(3);
	});
});
