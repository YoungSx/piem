import { Component, Modal, Notice, Setting, SuggestModal, type App } from "obsidian";
import type { Translator } from "../i18n";
import type { ChatBookmark, BookmarkOutcome } from "../extensions/bookmarkHost";
import type { ObsidianAgentService } from "../agent/ObsidianAgentService";

type BookmarkService = Pick<ObsidianAgentService, "getActiveSessionPath" | "runBookmark" | "listBookmarks">;

export class BookmarkDialogs {
	private readonly openModals = new Set<Modal>();
	private disposed = false;
	constructor(private readonly app: App, private readonly service: BookmarkService, private readonly t: () => Translator) {}
	add(): void {
		if (this.disposed) return;
		const path = this.service.getActiveSessionPath();
		if (!path) { new Notice(this.t().t("bookmarks.noChat")); return; }
		let label = "";
		const lifetime = new Component();
		lifetime.load();
		const modal = new Modal(this.app);
		modal.setTitle(this.t().t("bookmarks.addTitle"));
		modal.contentEl.createEl("p", { text: this.t().t("bookmarks.description") });
		let saving = false;
		const error = modal.contentEl.createDiv({ attr: { role: "alert" } });
		const input = new Setting(modal.contentEl).setName(this.t().t("bookmarks.label"));
		let save: (() => Promise<void>) | undefined;
		input.addText(text => {
			text.setPlaceholder(this.t().t("bookmarks.placeholder"));
			text.inputEl.maxLength = 160;
			text.inputEl.setAttribute("aria-label", this.t().t("bookmarks.label"));
			lifetime.registerDomEvent(text.inputEl, "keydown", event => {
				if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); void save?.(); }
			});
			text.onChange(value => { label = value; });
		});
		new Setting(modal.contentEl).addButton(button => {
			button.setButtonText(this.t().t("bookmarks.save")).setCta();
			save = async () => {
				if (saving || this.disposed || !this.openModals.has(modal)) return;
				if (!label.trim() || label.trim().length > 160) { error.textContent = this.t().t("bookmarks.labelRequired"); return; }
				saving = true;
				button.setDisabled(true);
				try {
					const outcome = await this.service.runBookmark(path, "bookmark", label);
					if (!this.disposed && this.openModals.has(modal)) { this.announce(outcome); modal.close(); }
				} catch (cause) {
					if (!this.disposed && this.openModals.has(modal)) error.textContent = this.describeError(cause);
				} finally {
					saving = false;
					button.setDisabled(false);
				}
			};
			button.onClick(() => { void save?.(); });
		});
		modal.onClose = () => lifetime.unload();
		this.show(modal);
	}
	async remove(): Promise<void> {
		if (this.disposed) return;
		const path = this.service.getActiveSessionPath();
		if (!path) { new Notice(this.t().t("bookmarks.noChat")); return; }
		try {
			const outcome = await this.service.runBookmark(path, "unbookmark");
			if (!this.disposed) this.announce(outcome);
		} catch (cause) { if (!this.disposed) new Notice(this.describeError(cause)); }
	}
	async list(): Promise<void> {
		if (this.disposed) return;
		const path = this.service.getActiveSessionPath();
		if (!path) { new Notice(this.t().t("bookmarks.noChat")); return; }
		try {
			const bookmarks = await this.service.listBookmarks(path);
			if (this.disposed) return;
			if (!bookmarks.length) { new Notice(this.t().t("bookmarks.none")); return; }
			this.show(new BookmarkPicker(this.app, bookmarks, this.t(), item => {
				if (this.disposed) return;
				const modal = new Modal(this.app);
				modal.setTitle(item.label);
				modal.contentEl.createEl("p", { text: item.text, cls: "piem-bookmark-text" });
				if (item.truncated) modal.contentEl.createEl("p", { text: this.t().t("bookmarks.excerpt") });
				this.show(modal);
			}));
		} catch (cause) { if (!this.disposed) new Notice(this.describeError(cause)); }
	}
	dispose(): void {
		this.disposed = true;
		for (const modal of [...this.openModals]) modal.close();
		this.openModals.clear();
	}
	private show(modal: Modal): void {
		if (this.disposed) return;
		const original = modal.onClose.bind(modal);
		modal.onClose = () => { this.openModals.delete(modal); original(); modal.contentEl.empty(); };
		this.openModals.add(modal);
		modal.open();
	}
	private announce(outcome: BookmarkOutcome): void {
		const t = this.t();
		const message = outcome.kind === "saved" ? t.t("bookmarks.saved", { label: outcome.label ?? "" })
			: outcome.kind === "removed" ? t.t("bookmarks.removed")
				: outcome.kind === "no-message" ? t.t("bookmarks.noMessage") : t.t("bookmarks.none");
		new Notice(message);
	}
	private describeError(cause: unknown): string {
		return this.t().t("bookmarks.failed", { reason: cause instanceof Error ? cause.message : String(cause) });
	}
}

class BookmarkPicker extends SuggestModal<ChatBookmark> {
	constructor(app: App, private readonly bookmarks: ChatBookmark[], t: Translator, private readonly choose: (item: ChatBookmark) => void) {
		super(app);
		this.setPlaceholder(t.t("bookmarks.search"));
		this.emptyStateText = t.t("bookmarks.noMatch");
	}
	getSuggestions(query: string): ChatBookmark[] {
		const needle = query.trim().toLocaleLowerCase();
		return this.bookmarks.filter(item => `${item.label}\n${item.text}`.toLocaleLowerCase().includes(needle));
	}
	renderSuggestion(item: ChatBookmark, el: HTMLElement): void {
		el.createDiv({ cls: "piem-suggestion-value", text: item.label });
		el.createDiv({ cls: "piem-suggestion-description", text: item.text.slice(0, 160) });
	}
	onChooseSuggestion(item: ChatBookmark): void { this.choose(item); }
}
