/**
 * The file menu's entry into piem: which files offer a row, and what the click
 * does to the plugin.
 *
 * The menu row itself is asserted through the shared `Menu` stub's recording —
 * Obsidian renders menus into a popover that does not exist under `bun test`,
 * so the recorded builder calls are the only observable surface. The click's
 * work lives in the plugin's shared delivery path, driven here the same way
 * `settingsPersistence.test.ts` drives its plugin: an instance created off the
 * prototype, with the real service and a view that records delivery.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { installObsidianStub, lastMenu, resetMenus, resetNotices, shownNotices } from "./testUtils/obsidianStub";
// `main.ts` reaches the React tree (PiemChatView), and react-dom must be
// evaluated after the test DOM exists — every `src/ui` test holds this same
// ordering, and breaking it silently kills `useEffect` listeners there.
import { installDom } from "./testUtils/dom";
import type { App, Editor, Plugin, TAbstractFile } from "obsidian";
import type { ObsidianAgentService } from "./agent/ObsidianAgentService";
import type { ContextRequest } from "./ui/contextRequest";
import type PiemPluginType from "./main";

installObsidianStub();
installDom();

// Value imports: the classes are what `instanceof` (in production) and
// `Object.assign` (here) work on, and the type-only names would collide with
// the values.
const { TFile, TFolder, Menu } = await import("obsidian");
const { addAskPiemFileMenuEntry, askPiemFileMenuOptions, registerContextMenus, isWebUrl } = await import("./ui/fileMenuEntry");
const { default: PiemPlugin } = await import("./main");
const { normalizeSettings } = await import("./settings");
const { getT } = await import("./i18n");
const { PiemChatView } = await import("./ui/PiemChatView");
const { VIEW_TYPE_PIEM_CHAT } = await import("./constants");
const { harness: serviceHarness } = await import("./testUtils/nativeExtensionServiceHarness");

type TFileInstance = InstanceType<typeof TFile>;
type PluginInstance = InstanceType<typeof PiemPluginType>;

const en = getT("en");
const rowTitle = en.t("commands.menuAskAboutFile");

/** A file that exists in the vault, as the file menu would hand one over. */
function vaultFile(path: string): TFileInstance {
	return Object.assign(new TFile(), { path });
}

/** Keep the menu -> plugin -> real service -> model request chain in one harness. */
function pluginWith(options: { service?: ObsidianAgentService | null; open?: boolean } = {}) {
	const real = serviceHarness(() => undefined);
	const service = options.service === undefined ? real.service : options.service;
	const files = new Map<string, TAbstractFile>();
	const viewTypes: string[] = [];
	const prefills: { text: string; session?: string }[] = [];
	let revealed = 0, focused = 0;
	const view = Object.assign(Object.create(PiemChatView.prototype) as InstanceType<typeof PiemChatView>, {
		prefillComposer: async (text: string, session?: string) => { prefills.push({ text, session }); return true; },
		focusInput: () => { focused++; },
	});
	let open = options.open ?? false;
	const leaf = { view, setViewState: async (state: { type: string }) => { viewTypes.push(state.type); open = true; } };
	const workspace = {
		getLeavesOfType: (type: string) => type === VIEW_TYPE_PIEM_CHAT && open ? [leaf] : [],
		getRightLeaf: () => leaf,
		revealLeaf: async () => { revealed++; },
	};
	const plugin = Object.create(PiemPlugin.prototype) as PluginInstance;
	const app = { workspace, vault: { getAbstractFileByPath: (path: string) => files.get(path) ?? null } } as unknown as App;
	Object.assign(plugin, { settings: normalizeSettings(null), app, agentService: service });
	return { plugin, service, real, files, view, prefills, viewTypes, revealCount: () => revealed, focusCount: () => focused,
		dispose: () => { real.service.dispose(); if (service !== real.service) service?.dispose(); } };
}

function deliver(plugin: PluginInstance, request: ContextRequest): Promise<void> {
	return (plugin as unknown as { deliverContext(request: ContextRequest): Promise<void> }).deliverContext(request);
}

async function askPiemAboutFile(plugin: PluginInstance, file: TFileInstance): Promise<void> {
	await deliver(plugin, { paths: [file.path] });
}

describe("addAskPiemFileMenuEntry", () => {
	beforeEach(() => resetMenus());

	it("offers the piem row for a file and hands that file to the asker", () => {
		const asked: TAbstractFile[] = [];
		const file = vaultFile("Projects/plan.md");

		const added = addAskPiemFileMenuEntry(new Menu(), file, {
			...askPiemFileMenuOptions(en),
			onAsk: (target) => asked.push(target),
		});

		expect(added).toBe(true);
		const menu = lastMenu();
		expect(menu.titles()).toEqual([rowTitle]);
		expect(menu.items[0]?.icon).toBe("piem-brand");
		menu.click(rowTitle);
		expect(asked).toEqual([file]);
	});

	it("offers a folder without treating it as a file", () => {
		const asked: TAbstractFile[] = [];
		// The stub's recording is what a test reads, not the instance: the built
		// menu is reachable through `lastMenu()` even when nothing was added.
		const menu = new Menu();

		const folder = Object.assign(new TFolder(), { path: "Projects" });
		const added = addAskPiemFileMenuEntry(menu, folder, {
			...askPiemFileMenuOptions(en, folder),
			onAsk: (target) => asked.push(target),
		});

		expect(added).toBe(true);
		lastMenu().click(en.t("commands.menuAskAboutFolder"));
		expect(asked).toEqual([folder]);
	});
});

describe("context menu delivery", () => {
	beforeEach(() => { resetMenus(); resetNotices(); });

	it("reports a single folder reference refused by a closed view", async () => {
		const h = pluginWith();
		h.files.set("Projects", Object.assign(new TFolder(), { path: "Projects" }));
		Object.assign(h.view, { prefillComposer: async () => false });
		try {
			await deliver(h.plugin, { paths: ["Projects"] });
			expect(shownNotices.map(notice => notice.message)).toContain(en.t("noteReference.unavailable"));
		} finally { h.dispose(); }
	});

	it("keeps the first file through initialization and the actual model request", async () => {
		const h = pluginWith();
		const file = vaultFile("Projects/first.md"); h.files.set(file.path, file);
		try {
			await askPiemAboutFile(h.plugin, file);
			expect(h.real.service.getSnapshot().contextRefs.map(ref => ref.path)).toContain(file.path);
			await h.real.service.sendPrompt("Review the file I chose");
			expect(JSON.stringify(h.real.requests[0]?.messages)).toContain("Pinned note: Projects/first.md");
			expect(h.viewTypes).toEqual([VIEW_TYPE_PIEM_CHAT]);
			expect(h.focusCount()).toBe(1);
		} finally { h.dispose(); }
	});

	it("reuses an open panel and never materializes a blank chat just to pin a file", async () => {
		const h = pluginWith({ open: true });
		const file = vaultFile("Projects/plan.md"); h.files.set(file.path, file);
		try {
			await askPiemAboutFile(h.plugin, file);
			expect(h.viewTypes).toEqual([]);
			expect(h.revealCount()).toBe(1);
			expect(h.real.sessions.isBlankSession(h.real.service.getActiveSessionPath()!)).toBe(true);
		} finally { h.dispose(); }
	});

	it("opens nothing when the plugin never built a service", async () => {
		const h = pluginWith({ service: null });
		try {
			await askPiemAboutFile(h.plugin, vaultFile("Projects/plan.md"));
			expect(h.viewTypes).toEqual([]);
			expect(shownNotices).toEqual([{ message: en.t("commands.couldNotOpenChat"), timeout: undefined }]);
		} finally { h.dispose(); }
	});

	it("keeps every selected target across pins, overflow and mixed folders", async () => {
		const h = pluginWith();
		const paths = Array.from({ length: 20 }, (_, i) => `Projects/${i}.md`);
		for (const path of paths) h.files.set(path, vaultFile(path));
		h.files.set("Projects", Object.assign(new TFolder(), { path: "Projects" }));
		try {
			await deliver(h.plugin, { paths: [...paths, paths[0]!, "Projects", "deleted.md"] });
			expect(h.real.service.getSnapshot().contextRefs.filter(ref => ref.isPinned)).toHaveLength(8);
			const text = h.prefills[0]?.text ?? "";
			expect(text).toContain('vault folder "Projects"');
			for (const path of paths.slice(8)) expect(text).toContain(JSON.stringify(path));
			expect(text).not.toContain("deleted.md");
			await h.real.service.sendPrompt(text + "Compare these");
			const request = JSON.stringify(h.real.requests[0]?.messages);
			for (const path of paths) expect(request).toContain(path);
			expect(shownNotices.map(notice => notice.message)).toContain(en.t("noteReference.batchResult", { added: 8, existing: 0, drafted: 13, missing: 1 }));
		} finally { h.dispose(); }
	});

	it.each([0, 7, 8])("reports exact results with %d pins already present", async (count) => {
		const h = pluginWith();
		try {
			await h.real.service.initialize();
			const paths = Array.from({ length: 10 }, (_, i) => `Notes/${i}.md`);
			for (const path of paths) h.files.set(path, vaultFile(path));
			for (const path of paths.slice(0, count)) h.real.service.pinContextRef(path);
			await deliver(h.plugin, { paths });
			expect(shownNotices.map(notice => notice.message)).toContain(en.t("noteReference.batchResult", { added: 8 - count, existing: count, drafted: 2, missing: 0 }));
		} finally { h.dispose(); }
	});

	it("refuses a stale delivery when opening the panel switched conversations", async () => {
		const h = pluginWith();
		try {
			await h.real.service.initialize();
			const old = h.real.service.getActiveSessionPath();
			Object.assign(h.plugin, { activateChatView: async () => h.real.service.newSession({ force: true }) });
			const file = vaultFile("Notes/old.md"); h.files.set(file.path, file);
			await askPiemAboutFile(h.plugin, file);
			expect(h.real.service.getActiveSessionPath()).not.toBe(old);
			expect(h.real.service.getSnapshot().contextRefs).toEqual([]);
			expect(h.prefills).toEqual([]);
		} finally { h.dispose(); }
	});
});

function menus() {
	const callbacks = new Map<string, (...args: unknown[]) => void>();
	const refs: unknown[] = [];
	const requests: ContextRequest[] = [];
	const plugin = { app: { workspace: { on: (name: string, callback: (...args: unknown[]) => void) => {
		callbacks.set(name, callback); return { name };
	} } }, registerEvent: (ref: unknown) => refs.push(ref) } as unknown as Plugin;
	registerContextMenus(plugin, en, request => requests.push(request));
	return { callbacks, refs, requests };
}

describe("registered context menus", () => {
	beforeEach(() => resetMenus());
	it("registers all four events for plugin teardown and does no work until clicked", () => {
		const h = menus();
		expect(h.refs).toHaveLength(4);
		h.callbacks.get("files-menu")!(new Menu(), [vaultFile("A.md"), Object.assign(new TFolder(), { path: "Folder" })]);
		expect(h.requests).toEqual([]);
		lastMenu().click(en.t("commands.menuAskAboutFiles"));
		expect(h.requests).toEqual([{ paths: ["A.md", "Folder"] }]);
	});

	it.each(["https://example.org/a?q=你好", "http://example.org"])("offers external web URL %s", url => {
		const h = menus(); h.callbacks.get("url-menu")!(new Menu(), url);
		lastMenu().click(en.t("commands.menuAskAboutUrl"));
		expect(h.requests[0]?.text).toContain(JSON.stringify(url));
	});

	it.each(["mailto:a@example.org", "javascript:alert(1)", "obsidian://open", "file:///etc/passwd", "not a URL"])("declines an unfetchable URL %s", url => {
		const h = menus(); h.callbacks.get("url-menu")!(new Menu(), url);
		expect(lastMenu().titles()).toEqual([]); expect(isWebUrl(url)).toBe(false);
	});

	it.each(["", "selected text"])("uses the editor's actual target for selection %s", selection => {
		const h = menus();
		const editor = { getSelection: () => selection, listSelections: () => [] } as unknown as Editor;
		h.callbacks.get("editor-menu")!(new Menu(), editor, { file: { path: "Note.md" } });
		lastMenu().click(en.t(selection ? "commands.menuAskAboutSelection" : "commands.askAboutNote"));
		expect(h.requests[0]?.text).toContain("Note.md");
		if (selection) expect(h.requests[0]?.text).toContain(selection);
	});
});
