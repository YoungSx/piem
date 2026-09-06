import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { flushRender, installDom } from "../testUtils/dom";
import { installObsidianStub, platformMock, setTooltipMock } from "../testUtils/obsidianStub";

installObsidianStub();
const document = installDom();

// Dynamic imports so the mocked `obsidian` module wins over any cached real one.
const { ChatComposer } = await import("./ChatComposer");
const { createRoot } = await import("react-dom/client");

type Props = Parameters<typeof ChatComposer>[0];

const noop = (): void => undefined;

/**
 * The composer's send controls.
 *
 * What these pin is the pairing: the chord printed on the Send button must be the
 * chord the textarea actually honours. Those used to be able to disagree — the
 * hint lived in a status line beside the button and the binding was fixed — so
 * the label and the behaviour are asserted against the same prop here.
 */
function baseProps(overrides: Partial<Props> = {}): Props {
	return {
		input: "a draft",
		isStreaming: false,
		isCompacting: false,
		isRewinding: false,
		isInitializing: false,
		isConfigured: true,
		sendShortcut: "enter",
		onInputChange: noop,
		onSend: noop,
		onAbort: noop,
		commands: [],
		...overrides,
	};
}

async function renderInto(host: HTMLElement, props: Props): Promise<void> {
	const root = roots.get(host) ?? createRoot(host);
	roots.set(host, root);
	root.render(<ChatComposer {...props} />);
	await flushRender();
}

async function renderComposer(overrides: Partial<Props> = {}): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	await renderInto(host, baseProps(overrides));
	return host;
}

function sendButton(host: HTMLElement): HTMLButtonElement | null {
	return host.querySelector<HTMLButtonElement>(".piem-chat__send-button");
}

describe("ChatComposer send button", () => {
	beforeEach(() => {
		platformMock.isMobile = false;
		platformMock.isMacOS = false;
		setTooltipMock.mockClear();
		document.body.replaceChildren();
	});

	afterEach(() => {
		platformMock.isMobile = false;
		platformMock.isMacOS = false;
		document.body.replaceChildren();
	});

	it("prints the chord on the button rather than in a line beside it", async () => {
		const host = await renderComposer({ sendShortcut: "modEnter" });

		expect(host.querySelector(".piem-chat__send-chord")?.textContent).toBe("Ctrl+↵");
		// The old status slot carried this hint and doubled as the turn readout, so
		// the shortcut vanished exactly while a beginner was watching that spot.
		expect(host.querySelector(".piem-chat__composer-status")).toBeNull();
	});

	it("teaches the shortest way to send under Enter-to-send", async () => {
		const host = await renderComposer({ sendShortcut: "enter" });

		expect(host.querySelector(".piem-chat__send-chord")?.textContent).toBe("↵");
	});

	it("shows the platform's own modifier glyph", async () => {
		platformMock.isMacOS = true;
		const host = await renderComposer({ sendShortcut: "modEnter" });

		expect(host.querySelector(".piem-chat__send-chord")?.textContent).toBe("⌘↵");
	});

	it("carries the action and the chord in one accessible name, and hides the keycaps", async () => {
		const host = await renderComposer({ sendShortcut: "modEnter" });

		const button = sendButton(host);
		expect(button?.getAttribute("aria-label")).toBe("Send message · Ctrl+↵");
		expect(button?.getAttribute("title")).toBeNull();
		expect(setTooltipMock).toHaveBeenCalledWith(button, "Send message · Ctrl+↵");
		// Reading "Ctrl+↵" aloud as symbols would repeat what the name just said.
		expect(host.querySelector(".piem-chat__send-chord")?.getAttribute("aria-hidden")).toBe("true");
	});

	it("disables Send on an empty draft instead of letting it silently do nothing", async () => {
		const host = await renderComposer({ input: "   " });

		expect(sendButton(host)?.disabled).toBe(true);
	});

	it("turns the single slot into Stop mid-reply, and keeps a draft queueable", async () => {
		const host = await renderComposer({ isStreaming: true, input: "a draft" });

		// One slot, not two buttons: the element that was Send is now Stop.
		expect(host.querySelectorAll(".piem-chat__send-button, .piem-chat__stop-button")).toHaveLength(1);
		expect(host.querySelector(".piem-chat__stop-button")?.getAttribute("aria-label")).toBe("Stop response");
		// The mouse half of queueing: with the slot busy, the draft's send path
		// lives on this quiet text button, which only exists while a draft does.
		// It says "queue", because a mid-reply send waits — the control that does
		// not wait is the steer action on the chip it produces (issue #289).
		expect(host.querySelector(".piem-chat__queue-button")?.textContent).toBe("Queue draft");
	});

	it("does not offer the queue entry when there is nothing to queue", async () => {
		const host = await renderComposer({ isStreaming: true, input: "   " });

		expect(host.querySelector(".piem-chat__queue-button")).toBeNull();
	});

	it("queues the draft when the queue entry is clicked mid-reply", async () => {
		let sent = 0;
		const host = await renderComposer({ isStreaming: true, onSend: () => void ++sent });

		host.querySelector<HTMLButtonElement>(".piem-chat__queue-button")?.click();
		expect(sent).toBe(1);
	});

	it("re-mounts nothing between phases, so a held Send keeps focus into Stop", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		await renderInto(host, baseProps());
		sendButton(host)?.focus();
		const before = document.activeElement;

		await renderInto(host, baseProps({ isStreaming: true, input: "a draft" }));

		// Same fiber, same DOM node — the phase switch is a prop change, not a
		// mount. The old side-by-side rendering unmounted Send and mounted Stop,
		// dropping focus on the floor between the two; the class follows the
		// phase, the element does not.
		expect(document.activeElement).toBe(before);
		expect(document.activeElement).toBe(host.querySelector(".piem-chat__stop-button"));
	});

	it("names Stop plainly during compaction, which the status bar narrates", async () => {
		const host = await renderComposer({ isCompacting: true });

		expect(host.querySelector(".piem-chat__stop-button")?.getAttribute("aria-label")).toBe("Stop");
		expect(host.querySelectorAll(".piem-chat__send-button, .piem-chat__stop-button")).toHaveLength(1);
		expect(host.querySelector(".piem-chat__queue-button")).toBeNull();
	});
});

describe("ChatComposer queued chips", () => {
	beforeEach(() => {
		platformMock.isMobile = false;
		document.body.replaceChildren();
	});

	afterEach(() => {
		document.body.replaceChildren();
	});

	const queued = [
		{ id: "queued-1", text: "Use the other note", imageCount: 0 },
		{ id: "queued-2", text: "And skip the summary", imageCount: 2 },
	];

	function chipActions(host: HTMLElement, index: number): HTMLButtonElement[] {
		const item = Array.from(host.querySelectorAll(".piem-chat__queue-item"))[index];
		if (!item) {
			throw new Error(`no queued chip at index ${index}`);
		}
		return Array.from(item.querySelectorAll<HTMLButtonElement>(".piem-chat__queue-action"));
	}

	it("lists one chip per waiting message, oldest first, with its image count", async () => {
		const host = await renderComposer({ isStreaming: true, queuedPrompts: queued });

		const texts = Array.from(host.querySelectorAll(".piem-chat__queue-text"), (node) => node.textContent);
		expect(texts).toEqual(["Use the other note", "And skip the summary2 images"]);
	});

	it("offers each chip all three decisions, named apart and in escalating order", async () => {
		// Three actions because sending now, taking the words back and throwing
		// them away are different intents and none stands in for another (issue
		// #289). An icon-only control has to say which it is: the label is the
		// whole affordance for a screen reader and the tooltip for everyone else,
		// and the steer's label has to carry its cost.
		const host = await renderComposer({ isStreaming: true, queuedPrompts: queued });

		expect(chipActions(host, 0).map((button) => button.getAttribute("aria-label"))).toEqual([
			"Send now — cuts the reply short",
			"Take back to edit",
			"Discard",
		]);
	});

	it("routes each chip's actions to its own id", async () => {
		const steered: string[] = [];
		const edited: string[] = [];
		const discarded: string[] = [];
		const host = await renderComposer({
			isStreaming: true,
			queuedPrompts: queued,
			onSteerQueuedPrompt: (id) => void steered.push(id),
			onEditQueuedPrompt: (id) => void edited.push(id),
			onDiscardQueuedPrompt: (id) => void discarded.push(id),
		});

		chipActions(host, 0)[0]?.click();
		chipActions(host, 1)[1]?.click();
		chipActions(host, 0)[2]?.click();

		expect(steered).toEqual(["queued-1"]);
		expect(edited).toEqual(["queued-2"]);
		expect(discarded).toEqual(["queued-1"]);
	});

	it("draws no queue region when nothing is waiting", async () => {
		const host = await renderComposer({ isStreaming: true, queuedPrompts: [] });

		expect(host.querySelector(".piem-chat__queue")).toBeNull();
	});
});

describe("ChatComposer keyboard contract", () => {
	beforeEach(() => {
		platformMock.isMobile = false;
		platformMock.isMacOS = false;
		document.body.replaceChildren();
	});

	afterEach(() => {
		platformMock.isMobile = false;
		platformMock.isMacOS = false;
		document.body.replaceChildren();
	});

	it("names every chord that sends, not only the configured one", async () => {
		// The modifier chord sends under both settings, and naming one accepted
		// chord while hiding another is worse than naming none.
		const enterHost = await renderComposer({ sendShortcut: "enter" });
		expect(enterHost.querySelector("textarea")?.getAttribute("aria-keyshortcuts")).toBe("Enter Control+Enter Meta+Enter");

		document.body.replaceChildren();
		const modHost = await renderComposer({ sendShortcut: "modEnter" });
		expect(modHost.querySelector("textarea")?.getAttribute("aria-keyshortcuts")).toBe("Control+Enter Meta+Enter");
	});

	it("sends on a bare Enter under the default chord", async () => {
		const sent: number[] = [];
		const host = await renderComposer({ sendShortcut: "enter", onSend: () => sent.push(1) });

		expect(pressEnter(host)).toBe(true);
		expect(sent).toHaveLength(1);
	});

	it("leaves Enter to make a new line under the modifier chord", async () => {
		const sent: number[] = [];
		const host = await renderComposer({ sendShortcut: "modEnter", onSend: () => sent.push(1) });

		// Not cancelled, so the textarea receives the keypress and inserts a newline.
		expect(pressEnter(host)).toBe(false);
		expect(sent).toHaveLength(0);
		expect(pressEnter(host, { ctrlKey: true })).toBe(true);
		expect(sent).toHaveLength(1);
	});

	it("never sends mid-composition, whichever chord is configured", async () => {
		// Bare Enter is the dangerous case: it is how a Chinese writer accepts an
		// IME candidate, so sending here would fire off a half-typed sentence.
		const sent: number[] = [];
		const host = await renderComposer({ sendShortcut: "enter", onSend: () => sent.push(1) });

		expect(pressEnter(host, { isComposing: true })).toBe(false);
		expect(sent).toHaveLength(0);
	});

	it("binds the chord the phone override resolved to, not the stored one", async () => {
		platformMock.isMobile = true;
		const sent: number[] = [];
		const host = await renderComposer({ sendShortcut: "enter", onSend: () => sent.push(1) });

		expect(pressEnter(host)).toBe(false);
		expect(sent).toHaveLength(0);
	});

	it("overrides Enter-to-send on a phone, where the keycap goes but the binding stays", async () => {
		// A soft keyboard has no Shift+Enter, so Enter-to-send would leave a mobile
		// reader unable to type a second line at all. It has no Ctrl either, so the
		// button must not keep promising a chord that cannot be pressed: the keycap
		// and the chord in the name go. The binding itself survives — a hardware
		// keyboard on a tablet still sends through it, and the textarea keeps
		// advertising that to assistive tech.
		platformMock.isMobile = true;
		const host = await renderComposer({ sendShortcut: "enter" });

		expect(host.querySelector(".piem-chat__send-chord")).toBeNull();
		const send = host.querySelector<HTMLButtonElement>(".piem-chat__send-button");
		expect(send?.getAttribute("aria-label")).toBe("Send message");
		expect(host.querySelector("textarea")?.getAttribute("aria-keyshortcuts")).toBe("Control+Enter Meta+Enter");
	});
});

/**
 * The composer's touch focus contract.
 *
 * A tap does not move focus on iOS, so an unguarded tap on any control in the
 * shell would blur the textarea. The composer cancels that press; these pin
 * which presses are cancelled and which are left to the browser.
 *
 * Cancelling is the comfort, not the guarantee — iOS Safari blurs the field
 * during its own tap handling, which no `preventDefault` reaches. Nothing
 * breaks when it does: the send row is always rendered, so the pressed control
 * is never out of the layout by the time the tap resolves.
 */
describe("ChatComposer touch focus contract", () => {
	beforeEach(() => {
		platformMock.isMobile = false;
		platformMock.isMacOS = false;
		document.body.replaceChildren();
	});

	afterEach(() => {
		platformMock.isMobile = false;
		platformMock.isMacOS = false;
		document.body.replaceChildren();
	});

	it("keeps a touch press on a send-row control from stealing focus", async () => {
		const host = await renderComposer();

		// `defaultPrevented` is the assertion: preventing the pointerdown's
		// default action is what stops the browser from moving focus, while the
		// click on the pressed control still fires afterwards.
		expect(press(host, sendButton(host)!, "touch")).toBe(true);
	});

	it("leaves the textarea's own press alone so a first tap can still focus it", async () => {
		const host = await renderComposer();

		const textarea = host.querySelector("textarea");
		if (!textarea) {
			throw new Error("composer rendered without a textarea");
		}
		expect(press(host, textarea, "touch")).toBe(false);
	});

	it("leaves a mouse press alone, where native focus movement is what tab order expects", async () => {
		const host = await renderComposer();

		// A desktop keyboard user tabs into a control by pressing it; cancelling
		// that would strand focus on the draft and break the tab order.
		expect(press(host, sendButton(host)!, "mouse")).toBe(false);
	});
});

/**
 * The composer's fold.
 *
 * The fold is a phone-only affordance, so the toggle renders on mobile alone and
 * folding is a conditional unmount of everything below the top row — not a
 * `display: none`, which would keep the draft's rows in the accessibility tree
 * and the tab order. The queued chips are the exception by rule: they are words
 * the user already handed over, and a fold that hides them is a fold that hides
 * a promise.
 */
describe("ChatComposer fold toggle", () => {
	const queued = [{ id: "queued-1", text: "Use the other note", imageCount: 0 }];

	beforeEach(() => {
		platformMock.isMobile = true;
		platformMock.isMacOS = false;
		document.body.replaceChildren();
	});

	afterEach(() => {
		platformMock.isMobile = false;
		platformMock.isMacOS = false;
		document.body.replaceChildren();
	});

	function toggleButton(host: HTMLElement): HTMLButtonElement | null {
		return host.querySelector<HTMLButtonElement>(".piem-chat__composer-toggle");
	}

	it("renders the toggle on mobile and routes its press to the handler", async () => {
		let toggles = 0;
		const host = await renderComposer({ onToggleCollapsed: () => void ++toggles });

		expect(toggleButton(host)).not.toBeNull();
		toggleButton(host)?.click();
		expect(toggles).toBe(1);
	});

	it("renders no toggle on desktop, where the fold does not exist", async () => {
		platformMock.isMobile = false;
		const host = await renderComposer({ onToggleCollapsed: noop });

		expect(toggleButton(host)).toBeNull();
	});

	it("unmounts the draft's rows when folded, and keeps the queue on screen", async () => {
		const host = await renderComposer({ collapsed: true, queuedPrompts: queued, onToggleCollapsed: noop });

		// The fold is an unmount, not a hiding: the textarea and the send bar leave
		// the document, so they also leave the tab order and the accessibility tree.
		expect(host.querySelector("textarea")).toBeNull();
		expect(host.querySelector(".piem-chat__composer-bar")).toBeNull();
		// The chips stay — queued words are delivered words, and the fold may not
		// take them back out of sight.
		expect(host.querySelector(".piem-chat__queue-item")?.textContent).toContain("Use the other note");
		// The toggle itself survives its own action: it lives on the top row, the
		// one part of the composer the fold keeps.
		expect(toggleButton(host)).not.toBeNull();
	});

	it("flips the expander state and the name with the fold", async () => {
		// `aria-expanded` says the region's state, the label says the action: an
		// open composer offers to collapse, a folded one offers to expand.
		const expanded = await renderComposer({ collapsed: false, onToggleCollapsed: noop });
		expect(toggleButton(expanded)?.getAttribute("aria-expanded")).toBe("true");
		expect(toggleButton(expanded)?.getAttribute("aria-label")).toBe("Collapse composer");

		document.body.replaceChildren();
		const folded = await renderComposer({ collapsed: true, onToggleCollapsed: noop });
		expect(toggleButton(folded)?.getAttribute("aria-expanded")).toBe("false");
		expect(toggleButton(folded)?.getAttribute("aria-label")).toBe("Expand composer");
	});
});

/**
 * Presses `target` with a pointer of the given type, returning whether the
 * composer cancelled the press.
 */
function press(host: HTMLElement, target: HTMLElement, pointerType: string): boolean {
	const event = new window.PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType });
	target.dispatchEvent(event);
	return event.defaultPrevented;
}

/**
 * Presses Enter in the composer, returning whether the keypress was consumed.
 *
 * `defaultPrevented` is the assertion that matters: a chord that sends must also
 * stop the textarea from inserting a newline behind the sent message, and a chord
 * that does not send must leave the keypress alone so a new line still happens.
 */
function pressEnter(host: HTMLElement, init: KeyboardEventInit & { isComposing?: boolean } = {}): boolean {
	const textarea = host.querySelector("textarea");
	if (!textarea) {
		throw new Error("composer rendered without a textarea");
	}
	const event = new (globalThis as unknown as { window: { KeyboardEvent: typeof KeyboardEvent } }).window.KeyboardEvent("keydown", {
		key: "Enter",
		bubbles: true,
		cancelable: true,
		...init,
	});
	textarea.dispatchEvent(event);
	return event.defaultPrevented;
}

const roots = new WeakMap<HTMLElement, import("react-dom/client").Root>();

/**
 * The composer's command-menu wiring, from the textarea's side of the ARIA
 * combobox pattern.
 *
 * The menu owns the listbox and the highlight; the textarea is where focus
 * lives, so it is the textarea that must advertise the menu (`aria-expanded`),
 * name it (`aria-controls`), and quote the highlighted option
 * (`aria-activedescendant`). What these tests pin is that the three attributes
 * all track the one signal the menu reports — open, moving, and gone again,
 * with no id left dangling once the matches dry up.
 */
describe("ChatComposer command menu wiring", () => {
	const COMMANDS = [
		{ name: "summarize", description: "Summarize the active note", kind: "skill" as const, invocation: "summarize" },
		{ name: "echo", description: "Echo the arguments", kind: "template" as const, invocation: "echo" },
	];

	/**
	 * Renders the composer with a real controlled-input loop.
	 *
	 * `renderComposer` fixes the draft at render time, but the command menu only
	 * opens through the input handler — so this loop feeds the typed value back
	 * through `onInputChange` the way ChatApp does. Roots are unmounted in
	 * afterEach: the menu binds a document-level keydown listener that survives
	 * `replaceChildren`, and a leftover one would eat later tests' keystrokes.
	 */
	const wiredRoots: import("react-dom/client").Root[] = [];
	async function renderWired(): Promise<HTMLElement> {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		wiredRoots.push(root);
		let input = "";
		const render = (): void => {
			root.render(
				<ChatComposer
					input={input}
					isStreaming={false}
					isCompacting={false}
					isRewinding={false}
					isInitializing={false}
					isConfigured={true}
					sendShortcut="enter"
					onInputChange={(value) => {
						input = value;
						render();
					}}
					onSend={noop}
					onAbort={noop}
					commands={COMMANDS}
				/>,
			);
		};
		render();
		await flushRender();
		return host;
	}

	beforeEach(() => {
		platformMock.isMobile = false;
		platformMock.isMacOS = false;
		document.body.replaceChildren();
	});

	afterEach(async () => {
		for (const root of wiredRoots.splice(0)) {
			root.unmount();
		}
		await flushRender();
		platformMock.isMobile = false;
		platformMock.isMacOS = false;
		document.body.replaceChildren();
	});

	it("keeps the combobox role but advertises nothing while the menu is closed", async () => {
		const host = await renderComposer({ commands: COMMANDS, input: "a plain draft" });

		const textarea = textareaEl(host);
		// The combobox role is permanent — the draft is the combobox whether or
		// not the menu is up — but with nothing to open, it says so and stops.
		expect(textarea?.getAttribute("role")).toBe("combobox");
		expect(textarea?.getAttribute("aria-expanded")).toBe("false");
		expect(textarea?.getAttribute("aria-controls")).toBeNull();
		expect(textarea?.getAttribute("aria-activedescendant")).toBeNull();
	});

	it("opens as a combobox that names its listbox and highlighted option", async () => {
		// `menuOpen` only flips through the input handler, so the `/` has to be
		// typed, not merely rendered in.
		const host = await renderWired();
		await typeDraft(textareaEl(host)!, "/");
		await flushRender();

		const textarea = textareaEl(host);
		// The menu is open and matched: expanded, named, and quoting an option
		// that actually exists in the listbox it points at.
		expect(textarea?.getAttribute("aria-expanded")).toBe("true");
		const controlsId = textarea?.getAttribute("aria-controls");
		expect(host.querySelector(`[id="${controlsId}"]`)?.getAttribute("role")).toBe("listbox");
		const activeId = textarea?.getAttribute("aria-activedescendant") ?? "";
		expect(host.querySelector(`[id="${activeId}"]`)?.getAttribute("role")).toBe("option");
	});

	it("moves aria-activedescendant with the keyboard highlight", async () => {
		const host = await renderWired();
		const textarea = textareaEl(host);
		await typeDraft(textarea!, "/");
		await flushRender();
		const first = textarea?.getAttribute("aria-activedescendant");

		// ArrowDown is consumed by the menu's document-level handler; dispatching
		// there mirrors a real keypress bubbling out of the textarea.
		const domWindow = globalThis as unknown as { window: { KeyboardEvent: typeof KeyboardEvent } };
		document.dispatchEvent(new domWindow.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		await flushRender();

		const second = textarea?.getAttribute("aria-activedescendant");
		expect(second).not.toBe(first);
		expect(host.querySelector(`[id="${second}"]`)?.getAttribute("aria-selected")).toBe("true");
	});

	it("retracts the combobox attributes the moment no command matches", async () => {
		// An unmatched `/nope` renders no menu at all, so the textarea must stop
		// claiming one — a dangling aria-controls would advertise a listbox that
		// is not there.
		const host = await renderWired();
		await typeDraft(textareaEl(host)!, "/nope");
		await flushRender();

		const textarea = textareaEl(host);
		expect(host.querySelector('[role="listbox"]')).toBeNull();
		expect(textarea?.getAttribute("aria-expanded")).toBe("false");
		expect(textarea?.getAttribute("aria-controls")).toBeNull();
		expect(textarea?.getAttribute("aria-activedescendant")).toBeNull();
	});

	function textareaEl(host: HTMLElement): HTMLTextAreaElement | null {
		return host.querySelector("textarea");
	}
});

/**
 * Types into the controlled textarea the way a user does.
 *
 * `textarea.value` directly leaves that record in place, so the following
 * `input` event would be swallowed by React's controlled-input bookkeeping —
 * see {@link ChatApp.test.tsx} for the fuller write-up of the same trap.
 */
async function typeDraft(textarea: HTMLTextAreaElement, text: string): Promise<void> {
	const domWindow = (globalThis as unknown as { window: { HTMLTextAreaElement: { prototype: HTMLTextAreaElement }; Event: typeof Event } })
		.window;
	if (!Reflect.set(domWindow.HTMLTextAreaElement.prototype, "value", text, textarea)) {
		throw new Error("textarea value setter rejected the write");
	}
	// The event constructor comes from the same window as the element — a global
	// `new Event` fails happy-dom's instanceof check, as ChatApp.test documents.
	textarea.dispatchEvent(new domWindow.Event("input", { bubbles: true }));
}
