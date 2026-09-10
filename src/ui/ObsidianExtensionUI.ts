import type { App } from "obsidian";
import type { AutocompleteProviderFactory, ExtensionUIDialogOptions, ExtensionWidgetOptions } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import type { ExtensionUIAdapter } from "../extensions/extensionUI";
import type { Translator } from "../i18n";
import { ExtensionDialog } from "./ExtensionDialog";

export interface ExtensionUISnapshot {
	widgets: ReadonlyArray<{ key: string; lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
	statuses: ReadonlyArray<{ key: string; text: string }>;
	autocomplete?: AutocompleteProvider;
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
	private readonly dialogs = new Set<ExtensionDialog>();
	private disposed = false;

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
		this.publish({ ...this.snapshot, widgets });
	}

	addAutocompleteProvider(factory: AutocompleteProviderFactory): void {
		this.assertActive();
		const autocomplete = factory(this.snapshot.autocomplete ?? this.baseAutocomplete);
		this.publish({ ...this.snapshot, autocomplete });
	}

	reset(): void {
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

	private async show(request: ConstructorParameters<typeof ExtensionDialog>[2], options?: ExtensionUIDialogOptions) {
		this.assertActive();
		if (options?.signal?.aborted) return undefined;
		if (options?.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout < 0)) {
			throw new Error("Extension dialog timeout must be a finite non-negative number");
		}
		// A second modal would hide the first question and its cancellation path.
		if (this.dialogs.size > 0) throw new Error("An extension dialog is already open in this conversation");
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
