import { afterEach, describe, expect, it } from "bun:test";
import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { flushRender, installDom } from "../testUtils/dom";
import { installObsidianStub } from "../testUtils/obsidianStub";

installObsidianStub();
const document = installDom();
const { createRoot } = await import("react-dom/client");
const { ChatComposer } = await import("./ChatComposer");
const { createComposerAutocomplete } = await import("./extensionAutocomplete");

const cleanups: (() => void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	await flushRender();
	document.body.replaceChildren();
});

async function mount(provider: AutocompleteProvider, commands: Parameters<typeof ChatComposer>[0]["commands"] = []) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	let input = "";
	let sends = 0;
	let unmounted = false;
	const unmount = (): void => { if (!unmounted) { unmounted = true; root.unmount(); } };
	cleanups.push(unmount);
	const render = (): void => root.render(<ChatComposer input={input} commands={commands}
		isStreaming={false} isCompacting={false} isRewinding={false} isInitializing={false} isConfigured
		sendShortcut="enter" extensionAutocomplete={provider}
		onInputChange={(value) => { input = value; render(); }} onSend={() => { sends++; }} onAbort={() => undefined} />);
	render();
	await flushRender();
	const textarea = host.querySelector("textarea")!;
	textarea.focus();
	const type = async (text: string, cursor = text.length): Promise<void> => {
		Reflect.set(window.HTMLTextAreaElement.prototype, "value", text, textarea);
		textarea.setSelectionRange(cursor, cursor);
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
		await flushRender();
	};
	const key = async (key: string, extras: KeyboardEventInit = {}): Promise<KeyboardEvent> => {
		const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extras });
		textarea.dispatchEvent(event);
		await flushRender();
		return event;
	};
	const show = async (): Promise<void> => {
		host.querySelector<HTMLButtonElement>('button[aria-label="Show suggestions"]')!.click();
		await flushRender();
	};
	return { host, textarea, type, key, show, unmount, input: () => input, sends: () => sends };
}

const base = () => createComposerAutocomplete(() => []);

describe("native composer extension completions", () => {
	it("projects a completed skill and keeps subsequent provider offsets in the stored prompt", async () => {
		const commands = [{ name: "review", invocation: "skill:review", kind: "skill" as const, description: "Review notes" }];
		const provider = createComposerAutocomplete(() => commands);
		const panel = await mount(provider, commands);
		await panel.type("/rev");
		await panel.key("Tab");
		expect(panel.input()).toBe("/skill:review ");
		expect(panel.textarea.value).toBe("");
		expect(panel.textarea.selectionStart).toBe(0);
		await panel.type("Question");
		expect(panel.input()).toBe("/skill:review Question");
		expect(panel.textarea.value).toBe("Question");
		panel.host.querySelector<HTMLButtonElement>('[aria-label="Remove reference: review"]')!.click();
		await flushRender();
		expect(panel.input()).toBe("Question");
	});

	it("applies argument completion without overwriting the hidden skill prefix", async () => {
		const commands = [{ name: "review", invocation: "skill:review", kind: "skill" as const, description: "Review notes" }];
		let observed = "";
		const provider = createComposerAutocomplete(() => commands);
		const panel = await mount({ ...provider, getSuggestions: async (lines, line, col) => {
			observed = lines.join("\n").slice(0, col);
			return lines[0]?.endsWith("Quest") ? { prefix: "Quest", items: [{ value: "Question", label: "Question" }] } : null;
		} }, commands);
		await panel.type("/skill:review Quest");
		await panel.show();
		expect(observed).toBe("/skill:review Quest");
		await panel.key("Tab");
		expect(panel.input()).toBe("/skill:review Question");
		expect(panel.textarea.value).toBe("Question");
		expect(panel.textarea.selectionStart).toBe("Question".length);
	});
	it("shows empty-draft suggestions on demand and leaves ordinary Tab navigation intact", async () => {
		let forced = false;
		const panel = await mount({ ...base(), getSuggestions: async (lines, _line, _col, options) => {
			forced = options.force === true && lines.join("\n") === "";
			return { prefix: "", items: [{ value: "Write next", label: "Next step" }] };
		} });
		expect((await panel.key("Tab")).defaultPrevented).toBe(false);
		await panel.show();
		expect(forced).toBe(true);
		expect(panel.textarea.getAttribute("aria-expanded")).toBe("true");
		const active = panel.textarea.getAttribute("aria-activedescendant");
		expect(document.getElementById(active!)?.textContent).toBe("Next step");
		expect((await panel.key("Enter")).defaultPrevented).toBe(true);
		expect(panel.input()).toBe("Write next");
		expect(panel.sends()).toBe(0);
		expect(panel.textarea.selectionStart).toBe("Write next".length);
		expect(panel.textarea.getAttribute("aria-controls")).toBeNull();
	});

	it("preserves multiline text, suffix and the provider's returned cursor", async () => {
		let observed: unknown;
		const panel = await mount({ ...base(), getSuggestions: async (lines, cursorLine, cursorCol) => {
			observed = { lines, cursorLine, cursorCol };
			return { prefix: "re", items: [{ value: "result", label: "Result" }] };
		} });
		await panel.type("Heading\nUse re suffix", 14);
		expect(observed).toEqual({ lines: ["Heading", "Use re suffix"], cursorLine: 1, cursorCol: 6 });
		await panel.key("Tab");
		expect(panel.input()).toBe("Heading\nUse result suffix");
		expect(panel.textarea.selectionStart).toBe(18);
		expect(panel.textarea.selectionEnd).toBe(18);
	});

	it("lets an extension wrap the existing slash commands, including explicit collision invocations", async () => {
		const provider = createComposerAutocomplete(() => [
			{ name: "summarize", invocation: "extension:summarize", kind: "extension", description: "Summarize notes" },
		]);
		const panel = await mount({ ...provider, getSuggestions: (lines, line, col, options) => provider.getSuggestions(lines, line, col, options) });
		await panel.type("/sum");
		expect(panel.host.querySelector('[role="option"]')?.textContent).toContain("/summarize");
		await panel.key("Enter");
		expect(panel.input()).toBe("/extension:summarize ");
		expect(panel.sends()).toBe(0);
	});

	it("aborts superseded queries and never paints a late result into a newer draft", async () => {
		const pending: { signal: AbortSignal; resolve(value: AutocompleteSuggestions): void }[] = [];
		const panel = await mount({ ...base(), getSuggestions: (_lines, _line, _col, { signal }) => new Promise((resolve) => pending.push({ signal, resolve })) });
		await panel.type("Old");
		await panel.type("New");
		expect(pending).toHaveLength(2);
		expect(pending[0]!.signal.aborted).toBe(true);
		pending[1]!.resolve({ prefix: "New", items: [{ value: "New answer", label: "New suggestion" }] });
		await flushRender();
		pending[0]!.resolve({ prefix: "Old", items: [{ value: "Wrong answer", label: "Old suggestion" }] });
		await flushRender();
		expect(panel.host.querySelector('[role="option"]')?.textContent).toBe("New suggestion");
		await panel.key("Escape");
		expect(pending[1]!.signal.aborted).toBe(true);
		expect(panel.input()).toBe("New");
		expect(panel.textarea.getAttribute("aria-expanded")).toBe("false");
	});

	it("does not steal an IME candidate's Enter or replace a moved selection", async () => {
		const panel = await mount({ ...base(), getSuggestions: async () => ({ prefix: "a", items: [{ value: "answer", label: "Answer" }] }) });
		await panel.type("a");
		expect((await panel.key("Enter", { isComposing: true })).defaultPrevented).toBe(false);
		expect(panel.input()).toBe("a");
		expect(panel.sends()).toBe(0);
		panel.textarea.setSelectionRange(0, 1);
		panel.host.querySelector<HTMLButtonElement>('[role="option"] button')!.click();
		await flushRender();
		expect(panel.input()).toBe("a");
	});

	it("explains an empty explicit query and removes its listener and request on unmount", async () => {
		let signal: AbortSignal | undefined;
		const panel = await mount({ ...base(), getSuggestions: async (_lines, _line, _col, options) => { signal = options.signal; return null; } });
		await panel.show();
		expect(panel.host.querySelector('[role="status"]')?.textContent).toBe("No suggestions available");
		expect((await panel.key("Tab")).defaultPrevented).toBe(false);
		panel.unmount();
		expect(signal?.aborted).toBe(true);
		const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		document.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
	});
});
