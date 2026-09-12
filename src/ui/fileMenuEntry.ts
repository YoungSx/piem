import { TFile, TFolder, type Menu, type Plugin, type TAbstractFile } from "obsidian";
import { BRAND_ICON_ID } from "../brandIcon";
import type { Translator } from "../i18n";
import type { ContextRequest } from "./contextRequest";
import { requestNoteReference, warnIfTruncated } from "./noteReferenceCommand";

export function askPiemTarget(file: TAbstractFile): TFile | TFolder | null {
	return file instanceof TFile || file instanceof TFolder ? file : null;
}

export function askPiemFileMenuOptions(t: Translator, file?: TAbstractFile): { title: string; icon: string } {
	return { title: t.t(file instanceof TFolder ? "commands.menuAskAboutFolder" : "commands.menuAskAboutFile"), icon: BRAND_ICON_ID };
}

export function addAskPiemFileMenuEntry(
	menu: Menu,
	file: TAbstractFile,
	options: { title: string; icon: string; onAsk: (file: TFile | TFolder) => void },
): boolean {
	const target = askPiemTarget(file);
	if (!target) return false;
	menu.addItem(item => item.setTitle(options.title).setIcon(options.icon).onClick(() => options.onAsk(target)));
	return true;
}

export function isWebUrl(value: string): boolean {
	try { return ["http:", "https:"].includes(new URL(value).protocol); }
	catch { return false; }
}

/** Obsidian owns rendering and accessibility; the plugin owns event cleanup. */
export function registerContextMenus(plugin: Plugin, t: Translator, deliver: (request: ContextRequest) => void): void {
	plugin.registerEvent(plugin.app.workspace.on("file-menu", (menu, file) => {
		addAskPiemFileMenuEntry(menu, file, {
			...askPiemFileMenuOptions(t, file),
			onAsk: target => deliver({ paths: [target.path] }),
		});
	}));
	plugin.registerEvent(plugin.app.workspace.on("files-menu", (menu, files) => {
		if (!files.length) return;
		menu.addItem(item => item.setTitle(t.t("commands.menuAskAboutFiles")).setIcon(BRAND_ICON_ID)
			.onClick(() => deliver({ paths: files.map(file => file.path) })));
	}));
	plugin.registerEvent(plugin.app.workspace.on("url-menu", (menu, url) => {
		if (!isWebUrl(url)) return;
		menu.addItem(item => item.setTitle(t.t("commands.menuAskAboutUrl")).setIcon(BRAND_ICON_ID)
			.onClick(() => deliver({ text: t.t("noteReference.url", { url: JSON.stringify(url) }) })));
	}));
	plugin.registerEvent(plugin.app.workspace.on("editor-menu", (menu, editor, info) => {
		const path = info.file?.path;
		if (!path) return;
		const selectionOnly = Boolean(editor.getSelection().trim());
		menu.addItem(item => item.setTitle(t.t(selectionOnly ? "commands.menuAskAboutSelection" : "commands.askAboutNote"))
			.setIcon(BRAND_ICON_ID).onClick(() => {
				requestNoteReference(editor, path, { selectionOnly, deliver: (text, truncated) => {
					deliver({ text });
					warnIfTruncated(truncated, t);
				} });
			}));
	}));
}
