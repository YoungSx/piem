import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushRender, installDom } from "../testUtils/dom";
import { installObsidianStub } from "../testUtils/obsidianStub";

installObsidianStub();
const document = installDom();

// Dynamic imports so the mocked `obsidian` module wins over any cached real one.
const { CommandMenu } = await import("./CommandMenu");
import type { CommandEntry } from "./CommandMenu";
const { createRoot } = await import("react-dom/client");

/*
 * happy-dom hangs `KeyboardEvent` off its window rather than installing it as a
 * global, so the test reaches for it there — the same trick ChatApp.test.tsx
 * uses to dispatch onto the composer.
 */
const { window: domWindow } = globalThis as unknown as {
	window: { KeyboardEvent: typeof KeyboardEvent };
};

/*
 * happy-dom's `Window` class and the DOM lib's `Window` type are two names for
 * the same idea, and TypeScript will not unify them on its own. The cast is the
 * whole bridge: the instance does implement the DOM surface, and that surface —
 * `document`, `KeyboardEvent` — is all the migration test touches.
 */
type PopoutWindow = Window & typeof globalThis;

const COMMANDS: CommandEntry[] = [
	{ name: "summarize", description: "Summarize the active note", kind: "skill", invocation: "summarize" },
	{ name: "echo", description: "Echo the arguments", kind: "template", invocation: "echo" },
	{ name: "translate", description: "Translate the active note", kind: "template", invocation: "translate" },
];

/** Every root created this test, so afterEach can unmount and free the document listener. */
const liveRoots: import("react-dom/client").Root[] = [];

interface Rendered {
	host: HTMLElement;
	onSelectCalls: string[];
	/*
	 * A function, not a number: a captured primitive would freeze at 0 and every
	 * close assertion would pass vacuously.
	 */
	closeCount: () => number;
	/** Every id reported through `onActiveChange`, oldest first. */
	activeReports: (string | null)[];
	/** The migration announcement stand-in installed on the anchor textarea. */
	migration: { listener?: (win: PopoutWindow) => void };
	rerender: (query: string) => Promise<void>;
}

async function renderMenu(query: string, commands: CommandEntry[] = COMMANDS): Promise<Rendered> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const onSelectCalls: string[] = [];
	const activeReports: (string | null)[] = [];
	let onCloseCalls = 0;
	// A real textarea stands in for the composer's: the menu keys off it to learn
	// which document its keydown belongs on, and the anchor is present from the
	// first render — the menu itself renders nothing on a zero-match frame, and
	// this suite drives exactly that frame.
	const textarea = document.createElement("textarea");
	const anchorRef: import("react").RefObject<HTMLTextAreaElement | null> = { current: textarea };
	// happy-dom's elements carry no Obsidian augmentation, so the migration
	// announcement is stood in here — installed before the first render, since
	// the menu reads it while binding.
	const migration: { listener?: (win: PopoutWindow) => void } = {};
	Object.defineProperty(textarea, "onWindowMigrated", {
		configurable: true,
		value: (listener: (win: Window) => void) => {
			migration.listener = listener;
			return () => {
				migration.listener = undefined;
			};
		},
	});
	const root = createRoot(host);
	liveRoots.push(root);
	const render = (q: string) =>
		root.render(
			<CommandMenu
				commands={commands}
				query={q}
				menuId="piem-test-menu"
				anchorRef={anchorRef}
				onActiveChange={(id) => activeReports.push(id)}
					onSelect={(command) => onSelectCalls.push(command.invocation)}
				onClose={() => {
					onCloseCalls += 1;
				}}
			/>,
		);
	render(query);
	await flushRender();
	return {
		host,
		onSelectCalls,
		closeCount: () => onCloseCalls,
		activeReports,
		migration,
		rerender: async (q: string) => {
			render(q);
			await flushRender();
		},
	};
}

function pressKey(key: string, init: KeyboardEventInit = {}): { defaultPrevented: boolean } {
	// Dispatched on document so the menu's capture-phase listener (also on
	// document) sees it, mirroring how a real keypress on the textarea bubbles up.
	const event = new domWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
	document.dispatchEvent(event);
	return { defaultPrevented: event.defaultPrevented };
}

describe("CommandMenu", () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(async () => {
		// Unmount every root so each CommandMenu's capture-phase document listener
		// is removed by its effect cleanup; otherwise listeners pile up across
		// tests and an earlier one can preventDefault a key this test dispatches.
		for (const root of liveRoots) {
			root.unmount();
		}
		liveRoots.length = 0;
		await flushRender();
		document.body.replaceChildren();
	});

	it("with an empty query lists every command in service order, each as /name — description", async () => {
		const { host } = await renderMenu("");

		const items = host.querySelectorAll(".piem-chat__command-menu-item");
		expect(items).toHaveLength(3);
		expect(items[0]?.querySelector(".piem-chat__command-menu-name")?.textContent).toBe("/summarize");
		expect(items[0]?.querySelector(".piem-chat__command-menu-desc")?.textContent).toBe("Summarize the active note");
		expect(items[0]?.querySelector(".piem-chat__command-menu-kind")?.textContent).toBe("Skill");
	});

	it("puts a row's three strings on one flex line, in reading order", async () => {
		// The row was a two-line stack: a name-and-kind heading over a description.
		// The wrapper is gone with it — the button is the flex line now — and the
		// three spans are direct children in the order they are read as well as the
		// order they are seen, so nothing has to be reordered in CSS and a screen
		// reader cannot disagree with the eye about which kind qualifies which name.
		const { host } = await renderMenu("");

		expect(host.querySelector(".piem-chat__command-menu-heading")).toBeNull();
		const row = host.querySelector(".piem-chat__command-menu-button");
		expect(Array.from(row?.children ?? [], (child) => child.className)).toEqual([
			"piem-chat__command-menu-name",
			"piem-chat__command-menu-desc",
			"piem-chat__command-menu-kind",
		]);
	});

	it("labels built-in extension commands without calling them skills", async () => {
		const { host } = await renderMenu("", [{ name: "continue", description: "Continue current task", kind: "extension", invocation: "continue" }]);
		expect(host.querySelector(".piem-chat__command-menu-kind")?.textContent).toBe("Extension");
	});

	it("keeps the kind tag at the trailing edge of a row with no description", async () => {
		// A description-less row has no growing middle to push the tag over, so the
		// trailing column is held by `margin-left: auto` in the stylesheet rather
		// than by the layout. What the markup must not do is emit an empty span to
		// stand in for the missing description — a blank flex child would take the
		// row's slack and defeat the margin.
		const commands: CommandEntry[] = [{ name: "bare", description: "", kind: "template", invocation: "bare" }];
		const { host } = await renderMenu("", commands);

		const row = host.querySelector(".piem-chat__command-menu-button");
		expect(Array.from(row?.children ?? [], (child) => child.className)).toEqual([
			"piem-chat__command-menu-name",
			"piem-chat__command-menu-kind",
		]);
	});

	it("keeps duplicate names distinct by source and selects the skill's disambiguated invocation", async () => {
		const commands: CommandEntry[] = [
			{ name: "summarize", description: "Prompt version", kind: "template", invocation: "summarize" },
			{ name: "summarize", description: "Skill version", kind: "skill", invocation: "skill:summarize" },
		];
		const { host, onSelectCalls } = await renderMenu("sum", commands);

		expect(Array.from(host.querySelectorAll(".piem-chat__command-menu-kind"), (el) => el.textContent)).toEqual(["Prompt", "Skill"]);
		pressKey("ArrowDown");
		await flushRender();
		pressKey("Enter");
		await flushRender();

		expect(onSelectCalls).toEqual(["skill:summarize"]);
	});

	it("matches subsequences, not just prefixes, so /sm finds summarize", async () => {
		// `sm` is no prefix of any name, but `summarize` contains both letters in
		// order; the prefix-only filter this test replaces returned nothing here.
		const { host } = await renderMenu("sm");

		const names = Array.from(host.querySelectorAll(".piem-chat__command-menu-name"), (el) => el.textContent);
		expect(names).toEqual(["/summarize"]);
	});

	it("reaches into hyphenated skill names, so /org finds tag-organize", async () => {
		const commands: CommandEntry[] = [
			{ name: "tag-organize", description: "Organize tags", kind: "skill", invocation: "tag-organize" },
			{ name: "find-skills", description: "Find skills", kind: "skill", invocation: "find-skills" },
		];
		const { host } = await renderMenu("org", commands);

		const names = Array.from(host.querySelectorAll(".piem-chat__command-menu-name"), (el) => el.textContent);
		expect(names).toEqual(["/tag-organize"]);
	});

	it("ranks tighter matches first, keeping every hit in the list", async () => {
		// All three names contain `e`. The stub (like real Obsidian) scores the
		// shortest, tightest candidate highest, so `echo` leads the ranking.
		const { host } = await renderMenu("e");

		const names = Array.from(host.querySelectorAll(".piem-chat__command-menu-name"), (el) => el.textContent);
		expect(names).toEqual(["/echo", "/summarize", "/translate"]);
	});

	it("renders nothing when no command matches, so an unknown /name stays a plain draft", async () => {
		const { host } = await renderMenu("nope");

		expect(host.querySelector(".piem-chat__command-menu")).toBeNull();
	});

	it("highlights the first item on open and moves down on ArrowDown", async () => {
		const { host } = await renderMenu("");

		expect(host.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
		expect(host.querySelector('[aria-selected="true"] .piem-chat__command-menu-name')?.textContent).toBe("/summarize");

		pressKey("ArrowDown");
		await flushRender();

		expect(host.querySelector('[aria-selected="true"] .piem-chat__command-menu-name')?.textContent).toBe("/echo");
	});

	it("wraps from the last item back to the first on ArrowDown", async () => {
		const { host } = await renderMenu("");
		// Move to the last item.
		pressKey("ArrowDown");
		pressKey("ArrowDown");
		await flushRender();
		expect(host.querySelector('[aria-selected="true"] .piem-chat__command-menu-name')?.textContent).toBe("/translate");

		pressKey("ArrowDown");
		await flushRender();
		expect(host.querySelector('[aria-selected="true"] .piem-chat__command-menu-name')?.textContent).toBe("/summarize");
	});

	it("moves up on ArrowUp and wraps from the first back to the last", async () => {
		const { host } = await renderMenu("");

		pressKey("ArrowUp");
		await flushRender();
		expect(host.querySelector('[aria-selected="true"] .piem-chat__command-menu-name')?.textContent).toBe("/translate");
	});

	it("completes the highlighted command on Enter without sending", async () => {
		const { onSelectCalls, closeCount } = await renderMenu("");

		pressKey("ArrowDown");
		await flushRender();
		pressKey("Enter");
		await flushRender();

		// Enter selects `echo` — the composer turns this into `/echo ` — and never
		// reaches send. The onSelect is the only observable.
		expect(onSelectCalls).toEqual(["echo"]);
		// The menu does not close itself; the composer closes it in its onSelect
		// handler, so onClose is the composer's responsibility, not the menu's.
		expect(closeCount()).toBe(0);
		// The keypress is swallowed so the textarea never inserts a newline.
	});

	it("closes on Escape", async () => {
		const { closeCount } = await renderMenu("");

		const result = pressKey("Escape");
		await flushRender();

		expect(result.defaultPrevented).toBe(true);
		expect(closeCount()).toBe(1);
	});

	it("closes on Escape even with no matches, while the menu renders nothing", async () => {
		// A zero-match frame removes the list — the menu's only DOM — but the
		// `/unknown` draft is still open for editing, and Escape there must close
		// the menu all the same. This is the frame that decides how the menu
		// learns its document: it cannot ask its own element, which does not
		// exist, so it asks the anchor the composer always renders.
		const { closeCount, rerender } = await renderMenu("");
		await rerender("nope");

		const result = pressKey("Escape");
		await flushRender();

		expect(result.defaultPrevented).toBe(true);
		expect(closeCount()).toBe(1);
	});

	it("re-hangs the keydown when the anchor migrates to a popout window, dropping the old binding", async () => {
		// happy-dom's `Window` type bridges to the DOM lib's `Window` by cast: the
		// instance implements the surface this test touches (`document`,
		// `KeyboardEvent`), it just is not declared as that type.
		const popout = new HappyWindow() as unknown as PopoutWindow;
		const { closeCount, migration } = await renderMenu("");

		// The panel is dragged out mid-life; React does not re-run the effect, so
		// the re-hang has to come from the element's migration announcement.
		migration.listener?.(popout);

		// The main document's listener must be gone — a stranded one would close
		// the menu from a window the panel no longer lives in.
		const mainEvent = new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		document.dispatchEvent(mainEvent);
		expect(mainEvent.defaultPrevented).toBe(false);
		expect(closeCount()).toBe(0);

		const popoutEvent = new popout.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		popout.document.dispatchEvent(popoutEvent);
		expect(popoutEvent.defaultPrevented).toBe(true);
		expect(closeCount()).toBe(1);
	});

	it("lets a modifier-chord Enter pass, so ⌘/Ctrl+Enter still sends while the menu is open", async () => {
		const { onSelectCalls } = await renderMenu("");

		// The send shortcut is sacred: completing on ⌘↵ would swallow a send the
		// user clearly asked for, so the menu leaves modifier chords alone.
		pressKey("Enter", { metaKey: true });
		pressKey("Enter", { ctrlKey: true });
		await flushRender();

		expect(onSelectCalls).toEqual([]);
	});

	it("keeps the highlight inside the filtered set as the query narrows", async () => {
		// Open with all three, move down twice to highlight `translate`, then narrow
		// the query so only `summarize` remains. The highlight must reset to the
		// first (and only) match rather than pointing past the end of the list.
		const { host, rerender } = await renderMenu("");
		pressKey("ArrowDown");
		pressKey("ArrowDown");
		await flushRender();

		await rerender("su");

		expect(host.querySelectorAll(".piem-chat__command-menu-item")).toHaveLength(1);
		expect(host.querySelector('[aria-selected="true"] .piem-chat__command-menu-name')?.textContent).toBe("/summarize");
	});

	it("wears the composer's menu id, and each option an id derived from it", async () => {
		// The composer quotes these ids in `aria-controls` and
		// `aria-activedescendant`; they only resolve if the listbox and its options
		// carry exactly the ids the combobox names.
		const { host } = await renderMenu("");

		expect(host.querySelector(".piem-chat__command-menu")?.id).toBe("piem-test-menu");
		const options = Array.from(host.querySelectorAll('[role="option"]'));
		expect(options.map((option) => option.id)).toEqual([
			"piem-test-menu-option-0",
			"piem-test-menu-option-1",
			"piem-test-menu-option-2",
		]);
	});

	it("reports the highlighted option's id upward, and null when it has none", async () => {
		// `onActiveChange` is the channel the composer mirrors onto the textarea's
		// `aria-activedescendant`; the reports must be ids that resolve, and must
		// clear to null the moment no option is highlighted.
		const { activeReports, rerender } = await renderMenu("");

		// The first render already reports the initial highlight.
		expect(activeReports.at(-1)).toBe("piem-test-menu-option-0");

		pressKey("ArrowDown");
		await flushRender();
		expect(activeReports.at(-1)).toBe("piem-test-menu-option-1");

		// Narrow to no matches: the menu renders nothing, so nothing is active.
		await rerender("nope");
		expect(activeReports.at(-1)).toBeNull();
	});

	it("never reports an id for a highlight that points past the filtered set", async () => {
		// The reset effect clears the index one render *after* the query narrows;
		// the id lookup guards the gap frame, where the stale index would otherwise
		// dangle a nonexistent option in front of a screen reader.
		const { activeReports, rerender } = await renderMenu("");

		pressKey("ArrowDown");
		pressKey("ArrowDown");
		await flushRender();
		await rerender("su");

		// One item left, highlight reset to it — never an option-2 of a list of one.
		expect(activeReports.at(-1)).toBe("piem-test-menu-option-0");
	});

	it("ignores Enter, Escape and the arrows while an input method is composing", async () => {
		// During composition the IME owns these keys: Enter accepts a candidate,
		// Escape cancels it, the arrows page the candidate list. Completing or
		// closing on any of them hijacks the input method mid-word.
		const { host, onSelectCalls, closeCount } = await renderMenu("");
		const composing = { isComposing: true } satisfies KeyboardEventInit;

		expect(pressKey("ArrowDown", composing).defaultPrevented).toBe(false);
		expect(pressKey("ArrowUp", composing).defaultPrevented).toBe(false);
		expect(pressKey("Enter", composing).defaultPrevented).toBe(false);
		expect(pressKey("Escape", composing).defaultPrevented).toBe(false);
		await flushRender();

		expect(onSelectCalls).toEqual([]);
		expect(closeCount()).toBe(0);
		// The highlight never moved either: the first row stayed active.
		expect(host.querySelector('[aria-selected="true"] .piem-chat__command-menu-name')?.textContent).toBe("/summarize");
	});

	it("lets the legacy keyCode 229 composition signal through the same guard", async () => {
		// Some webviews ship no `isComposing` on the candidate-accepting Enter,
		// only the legacy `keyCode: 229`; the guard reads both, and this is the
		// webview the failure was reported on. `keyCode` is not constructible
		// through KeyboardEventInit, so it is stamped onto the event directly.
		const { onSelectCalls } = await renderMenu("");

		const event = new domWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
		Object.defineProperty(event, "keyCode", { value: 229 });
		document.dispatchEvent(event);
		await flushRender();

		expect(event.defaultPrevented).toBe(false);
		expect(onSelectCalls).toEqual([]);
	});
});
