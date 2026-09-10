import bookmark from "./bookmarkFactory.mjs";
import { createExtensionHost, type ExtensionEntry } from "./extensionHost";

export type BookmarkEntry = ExtensionEntry;
export interface BookmarkCallbacks {
	getEntries(): BookmarkEntry[];
	getLabel(id: string): string | undefined;
	setLabel(id: string, label: string | undefined): void;
	notify(message: string): void;
}

/** The bookmark adapter shares the same host used by all bundled Pi extensions. */
export function createOfficialBookmark(callbacks: BookmarkCallbacks) {
	return createExtensionHost([{ id: "bookmark", factory: bookmark }], callbacks);
}
