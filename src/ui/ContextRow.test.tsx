import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Language } from "../i18n";
import { flushRender, installDom } from "../testUtils/dom";
import { installObsidianStub } from "../testUtils/obsidianStub";

installObsidianStub();
const document = installDom();

// Dynamic imports so the mocked `obsidian` module wins over any cached real one.
const { ContextRow } = await import("./ContextRow");
const { TranslatorProvider } = await import("./TranslatorContext");
const { createRoot } = await import("react-dom/client");

type ContextRowProps = Parameters<typeof ContextRow>[0];

const noop = (): void => undefined;

async function renderRow(overrides: Partial<ContextRowProps> = {}, language: Language = "en"): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = roots.get(host) ?? createRoot(host);
	roots.set(host, root);
	root.render(
		// Wrapped in the provider the panel supplies at runtime (ChatApp reads it
		// off the snapshot), so a language can be named per test. English is the
		// default because that is also the context's default: the assertions below
		// are unchanged from before this row was translated, which is what makes
		// them evidence that the English wording survived the move word for word.
		<TranslatorProvider language={language}>
			<ContextRow
				refs={[]}
				isFollowingActive={true}
				onOpen={noop}
				onPin={noop}
				onUnpin={noop}
				onSetFollowActive={noop}
				{...overrides}
			/>
		</TranslatorProvider>,
	);
	await flushRender();
	return host;
}

function labels(host: HTMLElement): (string | null)[] {
	return Array.from(host.querySelectorAll("button"), (button) => button.getAttribute("aria-label"));
}

/**
 * Opens chip `index`'s disclosure and returns that chip's wrapper.
 *
 * The chip button no longer opens the note — its whole job now is to identify
 * the note and disclose the actions — so nearly every action test starts here.
 */
async function openPopover(host: HTMLElement, index = 0): Promise<HTMLElement> {
	const chip = host.querySelectorAll<HTMLElement>(".piem-chat__context-chip")[index]!;
	chip.querySelector<HTMLButtonElement>(".piem-chat__context-open")?.click();
	await flushRender();
	return chip;
}

/**
 * The popover's action button whose visible text is `text`.
 *
 * The rows carry their name as rendered text, not an `aria-label` — they are
 * ordinary labelled buttons, so `labels()` above cannot see them.
 */
function action(chip: HTMLElement, text: string): HTMLButtonElement | null {
	return Array.from(chip.querySelectorAll<HTMLButtonElement>(".piem-chat__context-chip-action")).find(
		(button) => button.textContent === text,
	) ?? null;
}

describe("ContextRow", () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(() => {
		document.body.replaceChildren();
	});

	it("renders nothing while following with no note open", async () => {
		const host = await renderRow();

		// An empty row would spend scarce sidebar height on the absence of
		// information.
		expect(host.querySelector(".piem-chat__context-row")).toBeNull();
	});

	it("draws a followed note provisionally and a pin solidly", async () => {
		const host = await renderRow({
			refs: [
				{ kind: "active", path: "Notes/today.md", isPinned: false },
				{ kind: "pinned", path: "Notes/spec.md", isPinned: true },
			],
		});

		// The two are different kinds of thing, not two states of one thing: one
		// arrived on its own and will change on its own, the other was chosen.
		expect(host.querySelectorAll(".piem-chat__context-chip--active")).toHaveLength(1);
		expect(host.querySelectorAll(".piem-chat__context-chip--pinned")).toHaveLength(1);
	});

	it("discloses actions instead of opening on the press itself", async () => {
		const opened: string[] = [];
		const host = await renderRow({
			refs: [{ kind: "active", path: "Notes/today.md", isPinned: false }],
			onOpen: (path) => opened.push(path),
		});
		const chip = await openPopover(host);

		// A first press that opened the note would make the popover unreachable
		// on the second — the toggle *is* the disclosure. The note opens from the
		// popover's own row instead.
		expect(chip.querySelector(".piem-chat__context-chip-popover")).not.toBeNull();
		expect(chip.querySelector<HTMLButtonElement>(".piem-chat__context-open")?.getAttribute("aria-expanded")).toBe("true");
		expect(opened).toEqual([]);

		chip.querySelector<HTMLButtonElement>(".piem-chat__context-open")?.click();
		await flushRender();

		expect(chip.querySelector(".piem-chat__context-chip-popover")).toBeNull();
	});

	it("shows the file name, and the full path only once disclosed", async () => {
		const host = await renderRow({ refs: [{ kind: "active", path: "Projects/2026/Q3/weekly-0827.md", isPinned: false }] });

		// A real vault path has no chance in a 300px sidebar, but the folder is the
		// one thing a reader cannot recover from context — it comes back in the
		// popover, where there is room for it. A `title` beside it stacked a second
		// tooltip on top of Obsidian's on every hover, so there is none.
		expect(host.querySelector(".piem-chat__context-chip-label")?.textContent).toBe("weekly-0827");
		const open = host.querySelector(".piem-chat__context-open");
		expect(open?.getAttribute("title")).toBeNull();
		expect(open?.getAttribute("aria-label")).toBe("Projects/2026/Q3/weekly-0827.md, followed automatically");

		const chip = await openPopover(host);
		expect(chip.querySelector(".piem-chat__context-chip-path")?.textContent).toBe("Projects/2026/Q3/weekly-0827.md");
	});

	it("names the kind in the accessible name, not only in the fill", async () => {
		const host = await renderRow({
			refs: [
				{ kind: "active", path: "Notes/followed.md", isPinned: false },
				{ kind: "pinned", path: "Notes/kept.md", isPinned: true },
			],
		});

		// Visually the two differ by a fill the other lacks, and the icons are
		// aria-hidden. Without this a screen reader user could not tell a note
		// that will change by itself from one they chose. The kind word moved from
		// the verb ("open") to the identity once the button stopped opening
		// anything directly — promising "open" would now lie.
		const names = Array.from(host.querySelectorAll(".piem-chat__context-open"), (button) => button.getAttribute("aria-label"));
		expect(names).toEqual(["Notes/followed.md, followed automatically", "Notes/kept.md, pinned"]);
	});

	it("opens the note from the chip's popover, closing first", async () => {
		const opened: string[] = [];
		const host = await renderRow({
			refs: [{ kind: "active", path: "Notes/today.md", isPinned: false }],
			onOpen: (path) => opened.push(path),
		});
		const chip = await openPopover(host);

		chip.querySelector<HTMLButtonElement>(".piem-chat__context-chip-action")?.click();
		await flushRender();

		// The popover closes before navigating: a panel left hanging over the
		// composer would outlive its own subject.
		expect(opened).toEqual(["Notes/today.md"]);
		expect(chip.querySelector(".piem-chat__context-chip-popover")).toBeNull();
	});

	it("labels the dismiss control by the behaviour it stops, not the note", async () => {
		const host = await renderRow({ refs: [{ kind: "active", path: "Notes/today.md", isPinned: false }] });

		// Naming the note would promise something the control cannot deliver:
		// opening another file would bring it right back.
		const chip = await openPopover(host);
		expect(action(chip, "Unfollow")).not.toBeNull();
	});

	it("stops following from the followed chip's popover", async () => {
		const follows: boolean[] = [];
		const host = await renderRow({
			refs: [{ kind: "active", path: "Notes/today.md", isPinned: false }],
			onSetFollowActive: (follow) => follows.push(follow),
		});
		const chip = await openPopover(host);

		action(chip, "Unfollow")?.click();
		await flushRender();

		expect(follows).toEqual([false]);
	});

	it("offers a pin control on the followed note only", async () => {
		const host = await renderRow({ refs: [{ kind: "active", path: "Notes/today.md", isPinned: false }] });
		expect(action(await openPopover(host), "Pin")).not.toBeNull();

		document.body.replaceChildren();
		const pinnedHost = await renderRow({ refs: [{ kind: "pinned", path: "Notes/today.md", isPinned: true }] });
		// Already pinned; a second pin control would do nothing.
		expect(action(await openPopover(pinnedHost), "Pin")).toBeNull();
	});

	it("drops the pin control once the followed note is pinned", async () => {
		// Pinning the note you are looking at keeps one entry, still reported as
		// active. Leaving the control up would give the user a live button whose
		// second press is silently ignored.
		const host = await renderRow({ refs: [{ kind: "active", path: "Notes/today.md", isPinned: true }] });
		const chip = await openPopover(host);

		expect(action(chip, "Pin")).toBeNull();
		// The dismiss control stays: following can still be turned off.
		expect(action(chip, "Unfollow")).not.toBeNull();
	});

	it("pins the followed note, keeping the popover open as the visible answer", async () => {
		const pinned: string[] = [];
		const host = await renderRow({
			refs: [{ kind: "active", path: "Notes/today.md", isPinned: false }],
			onPin: (path) => pinned.push(path),
		});
		const chip = await openPopover(host);

		action(chip, "Pin")?.click();
		await flushRender();

		// Closing here would leave the reader unsure whether the press landed.
		// The pin row leaving the popover is the answer; the popover staying is
		// the proof nothing was lost.
		expect(pinned).toEqual(["Notes/today.md"]);
		expect(chip.querySelector(".piem-chat__context-chip-popover")).not.toBeNull();
	});

	it("removes a pin by its own name", async () => {
		const unpinned: string[] = [];
		const host = await renderRow({
			refs: [{ kind: "pinned", path: "Notes/spec.md", isPinned: true }],
			onUnpin: (path) => unpinned.push(path),
		});
		const chip = await openPopover(host);

		action(chip, "Remove")?.click();
		await flushRender();

		expect(unpinned).toEqual(["Notes/spec.md"]);
	});

	it("closes on Escape, returning focus to the chip that opened it", async () => {
		const host = await renderRow({ refs: [{ kind: "active", path: "Notes/today.md", isPinned: false }] });
		const chip = await openPopover(host);
		const toggle = chip.querySelector<HTMLButtonElement>(".piem-chat__context-open")!;

		toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await flushRender();

		// The composer and the transcript have their own Escape handlers; this
		// press is about the popover. And an unmount without the focus handback
		// would drop a keyboard user to <body>.
		expect(chip.querySelector(".piem-chat__context-chip-popover")).toBeNull();
		expect(document.activeElement).toBe(toggle);
	});

	it("dismisses on a press outside the chip", async () => {
		const host = await renderRow({ refs: [{ kind: "active", path: "Notes/today.md", isPinned: false }] });
		const chip = await openPopover(host);

		// Tapping elsewhere does not reliably move focus on iOS Safari, so blur
		// alone would leave a touch reader with an open panel and no way to shut
		// it. The press is dispatched on `body`, outside the React root, so wait
		// for the close rather than for a flush.
		document.body.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
		await flushRender(() => chip.querySelector(".piem-chat__context-chip-popover") === null);

		expect(chip.querySelector(".piem-chat__context-chip-popover")).toBeNull();
	});

	it("offers a way back once following is dismissed", async () => {
		const follows: boolean[] = [];
		const host = await renderRow({
			refs: [],
			isFollowingActive: false,
			onSetFollowActive: (follow) => follows.push(follow),
		});

		// The row must still render with nothing in it, or dismissing would be
		// irreversible for the rest of the conversation.
		expect(host.querySelector(".piem-chat__context-row")).not.toBeNull();
		host.querySelector<HTMLButtonElement>(".piem-chat__context-resume")?.click();
		expect(follows).toEqual([true]);
	});

	it("hides the resume control while following", async () => {
		const host = await renderRow({ refs: [{ kind: "active", path: "Notes/today.md", isPinned: false }] });

		expect(host.querySelector(".piem-chat__context-resume")).toBeNull();
	});

	it("names the group so its purpose is announced", async () => {
		const host = await renderRow({ refs: [{ kind: "active", path: "Notes/today.md", isPinned: false }] });

		const row = host.querySelector(".piem-chat__context-row");
		expect(row?.getAttribute("role")).toBe("group");
		expect(row?.getAttribute("aria-label")).toBe("Notes shared with Piem");
	});

	it("hands focus to the resume control when following is dismissed", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = roots.get(host) ?? createRoot(host);
		roots.set(host, root);
		let following = true;
		const render = (): void => {
			root.render(
				<ContextRow
					refs={following ? [{ kind: "active", path: "Notes/today.md", isPinned: false }] : []}
					isFollowingActive={following}
					onOpen={noop}
					onPin={noop}
					onUnpin={noop}
					onSetFollowActive={(follow) => {
						following = follow;
						render();
					}}
				/>,
			);
		};
		render();
		await flushRender();

		const chip = await openPopover(host);
		const dismiss = action(chip, "Unfollow");
		dismiss?.focus();
		dismiss?.click();
		await flushRender();

		// Dismissing unmounts the button that was pressed. Without this the browser
		// resets focus to <body> and a keyboard user loses their place entirely.
		expect(document.activeElement?.getAttribute("aria-label")).toBe("Follow the active note");
	});

	it("keeps focus inside the row when a pin is removed", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = roots.get(host) ?? createRoot(host);
		roots.set(host, root);
		let pinned = ["Notes/first.md", "Notes/second.md"];
		const render = (): void => {
			root.render(
				<ContextRow
					refs={pinned.map((path) => ({ kind: "pinned" as const, path, isPinned: true }))}
					isFollowingActive={true}
					onOpen={noop}
					onPin={noop}
					onUnpin={(path) => {
						pinned = pinned.filter((candidate) => candidate !== path);
						render();
					}}
					onSetFollowActive={noop}
				/>,
			);
		};
		render();
		await flushRender();

		const chip = await openPopover(host, 1);
		const remove = action(chip, "Remove");
		remove?.focus();
		remove?.click();
		await flushRender();

		// The removed chip unmounts with its popover; the row's first remaining
		// control — the other chip's toggle — is where the user's place now is.
		expect(document.activeElement?.getAttribute("aria-label")).toBe("Notes/first.md, pinned");
	});

	it("translates the accessible names, which is the row's only channel for the kind", async () => {
		const host = await renderRow(
			{
				refs: [
					{ kind: "active", path: "Notes/today.md", isPinned: false },
					{ kind: "pinned", path: "Notes/spec.md", isPinned: true },
				],
			},
			"zh-cn",
		);

		// This row was the last component holding hardcoded English, and the
		// strings it held were all accessible names. A Chinese vault therefore
		// looked fully translated — the chips render file names, which are data —
		// while the one channel carrying "followed" vs "pinned" spoke a foreign
		// language to exactly the users who had nothing else to read.
		const names = Array.from(host.querySelectorAll(".piem-chat__context-open"), (button) => button.getAttribute("aria-label"));
		expect(names).toEqual(["Notes/today.md，自动跟随中", "Notes/spec.md，已固定"]);
		expect(host.querySelector(".piem-chat__context-row")?.getAttribute("aria-label")).toBe("共享给 Piem 的笔记");
	});

	it("translates the popover's actions", async () => {
		const host = await renderRow({ refs: [{ kind: "active", path: "Notes/today.md", isPinned: false }] }, "zh-cn");

		// Each verb means the note the popover is about, so none carries the name;
		// the file name is the path line's job.
		const chip = await openPopover(host);
		expect(action(chip, "打开")).not.toBeNull();
		expect(action(chip, "固定")).not.toBeNull();
		// Still the behaviour, not the note: a translation that said "移除"
		// would promise something the control cannot deliver in any language.
		expect(action(chip, "取消跟随")).not.toBeNull();
	});

	it("translates the resume control, the one way back from a dismissal", async () => {
		const host = await renderRow({ refs: [], isFollowingActive: false }, "zh-cn");

		expect(host.querySelector(".piem-chat__context-resume")?.getAttribute("aria-label")).toBe("跟随当前笔记");
	});

	it("keeps a pinned note distinct from a followed one at the same path", async () => {
		const host = await renderRow({
			refs: [
				{ kind: "active", path: "Notes/a.md", isPinned: false },
				{ kind: "pinned", path: "Notes/b.md", isPinned: true },
			],
		});

		// Distinct React keys: keying on path alone would collide the moment the
		// same note appeared in both roles.
		expect(host.querySelectorAll(".piem-chat__context-chip")).toHaveLength(2);
	});
});

const roots = new WeakMap<HTMLElement, import("react-dom/client").Root>();
