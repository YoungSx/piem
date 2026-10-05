import { afterEach, expect, test } from "bun:test";
import type { App } from "obsidian";
import type { NativeChatSession, NativeChatSnapshot } from "../session/NativeChatSession";
import { installObsidianStub } from "../testUtils/obsidianStub";
import { flushRender, installDom } from "../testUtils/dom";
import { Harness, MemoryStorage, createRegistry, type Submission } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
installObsidianStub();
const document = installDom();
const { NativeChatApp } = await import("./NativeChatApp");
const { ChatInputController } = await import("./ChatInputController");
const { DEFAULT_SETTINGS } = await import("../settings");
const { Component } = await import("obsidian");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(apiKey = "fixture-key") {
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
	const conversation = await harness.root(context, { agent: { model: { provider: "p1", modelId: "m1" } } });
	const view = await conversation.viewState(context);
	cleanups.push(async () => { view.dispose(); await harness.close(context); });
	let snapshot: NativeChatSnapshot = { view: view.value, paused: true, closed: false };
	const listeners = new Set<() => void>();
	const admission = Promise.withResolvers<Submission>();
	let submits = 0, aborts = 0, resumes = 0;
	const session = {
		id: "ui-fixture", path: "native.jsonl", getSnapshot: () => snapshot,
		subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
		submit: () => { submits++; return admission.promise; },
		abort: async () => { aborts++; }, resume: () => { resumes++; }, configure: async () => {},
	} as unknown as NativeChatSession;
	const settings = { ...DEFAULT_SETTINGS, language: "en" as const, activeModelId: "m1",
		providers: [{ id: "p1", name: "Fixture", baseUrl: "https://example.com/v1", protocol: "openai-completions" as const, apiKey, secretRef: "", source: "user" as const, oauthFlow: "" }],
		models: [{ id: "m1", providerId: "p1", modelApiId: "fixture-model", displayName: "Fixture", reasoning: false, supportsImages: false }],
	};
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	cleanups.push(() => { root.unmount(); host.remove(); });
	const inputController = new ChatInputController();
	root.render(createElement(NativeChatApp, { session, app: { vault: {} } as App, component: new Component(),
		getSettings: () => settings, inputController, onNewSession: async () => {}, onOpenHistory: () => {}, onReopen: async () => {},
	}));
	await flushRender(); await flushRender();
	return { host, inputController, admission, submits: () => submits, aborts: () => aborts, resumes: () => resumes,
		publish: (change: Partial<NativeChatSnapshot>) => { snapshot = { ...snapshot, ...change }; for (const listener of listeners) listener(); },
		snapshot: () => snapshot,
	};
}

test("failed admission retains the exact draft and exposes Stop before admission settles", async () => {
	const f = await fixture();
	await f.inputController.prefill("Keep this draft", "ui-fixture"); await flushRender();
	f.inputController.submit(); await flushRender();
	expect(f.submits()).toBe(1);
	expect(f.host.querySelector("textarea")?.value).toBe("Keep this draft");
	const stop = Array.from(f.host.querySelectorAll("button")).find(button => button.getAttribute("aria-label")?.includes("Stop"));
	expect(stop).toBeDefined(); stop!.click(); await flushRender();
	expect(f.aborts()).toBe(1);
	f.admission.reject(new Error("Disk full")); await flushRender();
	expect(f.host.querySelector("textarea")?.value).toBe("Keep this draft");
	expect(f.host.querySelector('[role="alert"]')?.textContent).toContain("Disk full");
});

test("prefill checks session identity and explicitly rejects references", async () => {
	const f = await fixture();
	expect(await f.inputController.prefill("Wrong", "other")).toBe(false);
	expect(await f.inputController.prefill("Reference", "ui-fixture", [{ kind: "file", path: "note.md" }])).toBe("reported");
	expect(f.host.querySelector("textarea")?.value).toBe("");
	await f.inputController.prefill("First", "ui-fixture");
	await f.inputController.prefill("Second", "ui-fixture"); await flushRender();
	expect(f.host.querySelector("textarea")?.value).toContain("First");
	expect(f.host.querySelector("textarea")?.value).toContain("Second");
});

test("missing provider credentials block the command route as well as the Send button", async () => {
	const f = await fixture("");
	await f.inputController.prefill("Do not send", "ui-fixture"); await flushRender();
	f.inputController.submit(); await flushRender();
	expect(f.submits()).toBe(0);
	expect(f.host.querySelector("textarea")?.value).toBe("Do not send");
});

test("a paused official run exposes Continue without resuming on render", async () => {
	const f = await fixture();
	f.publish({ view: { ...f.snapshot().view, docs: { ...f.snapshot().view.docs, "pi.live": { run: { taskId: 1, inputs: [] } } } } });
	await flushRender();
	expect(f.resumes()).toBe(0);
	const resume = Array.from(f.host.querySelectorAll("button")).find(button => button.textContent === "Continue");
	expect(resume).toBeDefined(); resume!.click(); await flushRender();
	expect(f.resumes()).toBe(1);
});


test("successful admission clears only the submitted draft", async () => {
	const f = await fixture();
	await f.inputController.prefill("Send me", "ui-fixture"); await flushRender();
	f.inputController.submit(); await flushRender();
	expect(f.host.querySelector("textarea")?.value).toBe("Send me");
	f.admission.resolve({} as Submission); await flushRender();
	expect(f.host.querySelector("textarea")?.value).toBe("");
});

test("editing during admission keeps the newer draft", async () => {
	const f = await fixture();
	await f.inputController.prefill("Send me", "ui-fixture"); await flushRender();
	f.inputController.submit(); await flushRender();
	await f.inputController.prefill("New thought", "ui-fixture"); await flushRender();
	f.admission.resolve({} as Submission); await flushRender();
	expect(f.host.querySelector("textarea")?.value).toContain("New thought");
});
