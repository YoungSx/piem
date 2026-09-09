import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { App } from "obsidian";
import { installDom } from "../testUtils/dom";
import { installObsidianStub, resetNotices, shownNotices, lastSuggestModal } from "../testUtils/obsidianStub";
import { getT } from "../i18n";
import type { BookmarkOutcome } from "../extensions/bookmarkHost";
installObsidianStub();
const document = installDom();
const { BookmarkDialogs } = await import("./bookmarkDialogs");
let dialogs: InstanceType<typeof BookmarkDialogs> | undefined;
beforeEach(() => { document.body.empty(); resetNotices(); });
afterEach(() => { dialogs?.dispose(); document.body.empty(); resetNotices(); });
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function setup(run?: (path: string, command: string, label?: string) => Promise<BookmarkOutcome>) {
	let path = "A";
	const calls: Array<{ path: string; command: string; label?: string }> = [];
	dialogs = new BookmarkDialogs({} as App, {
		getActiveSessionPath: () => path,
		runBookmark: async (owner, command, label) => { calls.push({ path: owner, command, label }); return run ? run(owner, command, label) : { changed: true, kind: "saved", label }; },
		listBookmarks: async () => [{ entryId: "one", label: "Important", text: "An answer" }],
	}, () => getT("en"));
	return { dialogs, calls, switchToB: () => { path = "B"; } };
}
function type(text: string) {
	const input = document.querySelector<HTMLInputElement>("input")!;
	input.value = text;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	return input;
}
describe("bookmark dialogs", () => {
	it("keeps the owner from modal opening and reports success only after saving", async () => {
		let finish!: (outcome: BookmarkOutcome) => void;
		const pending = new Promise<BookmarkOutcome>(resolve => { finish = resolve; });
		const f = setup(() => pending);
		f.dialogs.add();
		f.switchToB();
		type("My label");
		const button = document.querySelector<HTMLButtonElement>("button")!;
		button.click();
		await flush();
		expect(f.calls).toEqual([{ path: "A", command: "bookmark", label: "My label" }]);
		expect(shownNotices).toEqual([]);
		expect(button.disabled).toBe(true);
		finish({ changed: true, kind: "saved", label: "My label" });
		await flush();
		expect(shownNotices.map(notice => notice.message)).toContain("Bookmark saved: My label");
	});
	it("shows storage failure inline and leaves the entered label available for retry", async () => {
		const f = setup(async () => { throw new Error("Disk full"); });
		f.dialogs.add();
		type("Keep me");
		document.querySelector<HTMLButtonElement>("button")!.click();
		await flush();
		expect(document.querySelector("[role=alert]")?.textContent).toContain("Disk full");
		expect(document.querySelector<HTMLInputElement>("input")?.value).toBe("Keep me");
		expect(shownNotices).toEqual([]);
	});
	it("does not treat IME Enter as submit, and removes listeners on dispose", async () => {
		const f = setup();
		f.dialogs.add();
		const input = type("中文");
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
		await flush();
		expect(f.calls).toEqual([]);
		f.dialogs.dispose();
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await flush();
		expect(f.calls).toEqual([]);
	});
	it("lists and searches the current conversation's bookmarks", async () => {
		const f = setup();
		await f.dialogs.list();
		const picker = lastSuggestModal()!;
		await picker.type("Important");
		expect(picker.resultContainerEl.textContent).toContain("An answer");
		await picker.type("missing");
		expect(picker.resultContainerEl.textContent).not.toContain("An answer");
	});
});
