import type { ExtensionUIContext, ExtensionWidgetOptions } from "@earendil-works/pi-coding-agent";

/**
 * One conversation's native UI. Attaching it enables Pi's RPC mode; terminal
 * component factories and raw terminal input remain unavailable.
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
	reset(): void;
}
