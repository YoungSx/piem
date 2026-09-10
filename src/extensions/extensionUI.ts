import type { ExtensionUIContext, ExtensionWidgetOptions } from "@earendil-works/pi-coding-agent";
import type { NativeComponentNode } from "./compat/componentTree";

/** A mounted component exposes data and explicit actions, never terminal output. */
export interface NativeExtensionSurface {
	getSnapshot(): NativeComponentNode;
	subscribe(listener: () => void): () => void;
	resize(columns: number): void;
	cancel(): void;
}

export interface ExtensionShortcutAction {
	readonly key: string;
	readonly description: string;
	run(): Promise<void>;
}

/**
 * One conversation's native UI. Pi standard components use structured native
 * surfaces; raw terminal input and the terminal engine remain unavailable.
 *
 * `reset` cancels outstanding dialogs and clears extension-owned surfaces and
 * autocomplete providers. It is idempotent, and leaves the adapter reusable
 * when this conversation's agent is rebuilt. The panel owns final disposal.
 */
export interface ExtensionUIAdapter extends Pick<ExtensionUIContext,
	"select" | "confirm" | "input" | "setStatus" |
	"getEditorText" | "setEditorText" | "pasteToEditor" | "addAutocompleteProvider"
> {
	editor(title: string, prefill?: string, signal?: AbortSignal): Promise<string | undefined>;
	setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
	setComponentWidget?(key: string, surface: NativeExtensionSurface | undefined, options?: ExtensionWidgetOptions): void;
	showComponent?(surface: NativeExtensionSurface, signal: AbortSignal): Promise<void>;
	setShortcuts?(shortcuts: readonly ExtensionShortcutAction[]): void;
	reset(): void;
}
