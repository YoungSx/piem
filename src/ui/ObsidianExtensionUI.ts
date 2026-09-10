import type { App } from "obsidian";
import type { AutocompleteProviderFactory, ExtensionUIDialogOptions, ExtensionWidgetOptions } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import type { ExtensionShortcutAction, ExtensionUIAdapter, NativeExtensionSurface } from "../extensions/extensionUI";
import type { Translator } from "../i18n";
import { ExtensionDialog } from "./ExtensionDialog";
import { NativeExtensionDialog } from "./NativeExtensionDialog";
import { matchesExtensionShortcut } from "./extensionShortcuts";

export interface ExtensionUISnapshot {
	widgets: ReadonlyArray<{ key: string; lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
	statuses: ReadonlyArray<{ key: string; text: string }>;
	autocomplete?: AutocompleteProvider;
	componentWidgets?: ReadonlyArray<{ key: string; surface: NativeExtensionSurface; placement: "aboveEditor" | "belowEditor" }>;
	shortcuts?: readonly ExtensionShortcutAction[];
	shortcutPending?: string;
	shortcutError?: string;
}

export const EMPTY_EXTENSION_UI: ExtensionUISnapshot = { widgets: [], statuses: [] };

interface EditorAccess {
	isCurrent(): boolean;
	getText(): string;
	setText(text: string): void;
	paste(text: string): void;
}

/** One panel conversation owns its dialogs, text surfaces and completion chain. */
export class ObsidianExtensionUI implements ExtensionUIAdapter {
	private snapshot: ExtensionUISnapshot = EMPTY_EXTENSION_UI;
	private readonly listeners = new Set<() => void>();
	private readonly dialogs = new Set<ExtensionDialog | NativeExtensionDialog>();
	private disposed = false;
	private shortcutRevision = 0;

	constructor(
		private readonly app: App,
		private readonly getT: () => Translator,
		private readonly editorAccess: EditorAccess,
		private readonly baseAutocomplete: AutocompleteProvider,
	) {}

	getSnapshot = (): ExtensionUISnapshot => this.snapshot;
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};

	async select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
		const result = await this.show({ kind: "select", title, options }, opts);
		return typeof result === "string" ? result : undefined;
	}

	async confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
		return await this.show({ kind: "confirm", title, message }, opts) === true;
	}

	async input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
		const result = await this.show({ kind: "input", title, placeholder }, opts);
		return typeof result === "string" ? result : undefined;
	}

	async editor(title: string, prefill?: string, signal?: AbortSignal): Promise<string | undefined> {
		const result = await this.show({ kind: "editor", title, prefill }, { signal });
		return typeof result === "string" ? result : undefined;
	}

	getEditorText(): string { this.assertActive(); return this.editorAccess.getText(); }
	setEditorText(text: string): void { this.assertActive(); this.editorAccess.setText(text); }
	pasteToEditor(text: string): void { this.assertActive(); this.editorAccess.paste(text); }

	setStatus(key: string, text: string | undefined): void {
		this.assertActive();
		const statuses = this.snapshot.statuses.filter((status) => status.key !== key);
		if (text !== undefined) statuses.push({ key, text });
		this.publish({ ...this.snapshot, statuses });
	}

	setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void {
		this.assertActive();
		const widgets = this.snapshot.widgets.filter((widget) => widget.key !== key);
		if (content?.length) widgets.push({ key, lines: [...content], placement: options?.placement ?? "aboveEditor" });
		this.publish({ ...this.snapshot, widgets, componentWidgets: this.snapshot.componentWidgets?.filter(widget => widget.key !== key) });
	}

	setComponentWidget(key: string, surface: NativeExtensionSurface | undefined, options?: ExtensionWidgetOptions): void {
		this.assertActive();
		const componentWidgets = (this.snapshot.componentWidgets ?? []).filter(widget => widget.key !== key);
		if (surface) componentWidgets.push({ key, surface, placement: options?.placement ?? "aboveEditor" });
		this.publish({ ...this.snapshot, componentWidgets, widgets: this.snapshot.widgets.filter(widget => widget.key !== key) });
	}

	async showComponent(surface: NativeExtensionSurface, signal: AbortSignal): Promise<void> {
		this.assertActive();
		if (signal.aborted) return;
		this.assertNoDialog();
		const dialog = new NativeExtensionDialog(this.app, this.getT(), surface, signal);
		this.dialogs.add(dialog);
		try { dialog.open(); await dialog.result; }
		finally { this.dialogs.delete(dialog); }
	}

	setShortcuts(shortcuts: readonly ExtensionShortcutAction[]): void {
		this.assertActive();
		const revision = ++this.shortcutRevision;
		this.publish({ ...this.snapshot, shortcutError: undefined, shortcutPending: undefined,
			shortcuts: shortcuts.map(action => ({ ...action, run: () => this.runShortcut(action, revision) })),
		});
	}

	/** The panel calls this only from its own textarea; no global hotkeys. */
	handleShortcut(event: KeyboardEvent): boolean {
		if (this.disposed || !this.editorAccess.isCurrent() || this.dialogs.size > 0 || this.snapshot.shortcutPending) return false;
		const action = this.snapshot.shortcuts?.find(shortcut => matchesExtensionShortcut(event, shortcut.key));
		if (!action) return false;
		event.preventDefault();
		event.stopPropagation();
		void action.run();
		return true;
	}

	addAutocompleteProvider(factory: AutocompleteProviderFactory): void {
		this.assertActive();
		const autocomplete = factory(this.snapshot.autocomplete ?? this.baseAutocomplete);
		this.publish({ ...this.snapshot, autocomplete });
	}

	reset(): void {
		this.shortcutRevision++;
		for (const dialog of this.dialogs) dialog.close();
		this.dialogs.clear();
		this.publish(EMPTY_EXTENSION_UI);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.reset();
		this.listeners.clear();
	}

	private assertActive(): void {
		if (this.disposed || !this.editorAccess.isCurrent()) throw new Error("Extension UI belongs to an inactive conversation");
	}

	private assertNoDialog(): void {
		if (this.dialogs.size > 0) throw new Error("An extension dialog is already open in this conversation");
	}

	private async runShortcut(action: ExtensionShortcutAction, revision: number): Promise<void> {
		const isCurrent = (): boolean => !this.disposed && this.editorAccess.isCurrent() && revision === this.shortcutRevision;
		if (!isCurrent() || this.snapshot.shortcutPending || this.dialogs.size > 0) return;
		this.publish({ ...this.snapshot, shortcutPending: action.key, shortcutError: undefined });
		try { await action.run(); }
		catch (error) {
			if (isCurrent() && !(error instanceof Error && error.name === "AbortError")) {
				this.publish({ ...this.snapshot, shortcutError: this.getT().t("extensionUI.actionFailed") });
			}
		} finally {
			if (isCurrent()) this.publish({ ...this.snapshot, shortcutPending: undefined });
		}
	}

	private async show(request: ConstructorParameters<typeof ExtensionDialog>[2], options?: ExtensionUIDialogOptions) {
		this.assertActive();
		if (options?.signal?.aborted) return undefined;
		if (options?.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout < 0)) {
			throw new Error("Extension dialog timeout must be a finite non-negative number");
		}
		// A second modal would hide the first question and its cancellation path.
		this.assertNoDialog();
		const dialog = new ExtensionDialog(this.app, this.getT(), request, options);
		this.dialogs.add(dialog);
		try {
			dialog.open();
			return await dialog.result;
		} finally {
			this.dialogs.delete(dialog);
		}
	}

	private publish(snapshot: ExtensionUISnapshot): void {
		this.snapshot = snapshot;
		for (const listener of this.listeners) listener();
	}
}
