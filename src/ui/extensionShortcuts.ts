import { isComposing } from "./keyboard";

const EDITING_KEYS = new Set(["enter", "tab", "escape", "backspace", "delete", "arrowup", "arrowdown", "arrowleft", "arrowright", "home", "end", "pageup", "pagedown"]);
const EDITING_MODIFIED_KEYS = new Set(["a", "c", "v", "x", "y", "z"]);

/** Only explicit modified keys participate; typing and native editor keys win. */
export function matchesExtensionShortcut(event: KeyboardEvent, shortcut: string): boolean {
	if (event.defaultPrevented || event.repeat || isComposing(event) || event.getModifierState("AltGraph")) return false;
	const key = event.key.toLowerCase();
	if (EDITING_KEYS.has(key) || key === "dead" || key === "process") return false;
	const physical = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code);
	const physicalKey = (physical?.[1] ?? physical?.[2])?.toLowerCase();
	if ((event.ctrlKey || event.metaKey) && (EDITING_MODIFIED_KEYS.has(key) || (physicalKey !== undefined && EDITING_MODIFIED_KEYS.has(physicalKey)))) return false;
	if (!event.ctrlKey && !event.metaKey && !event.altKey) return false;
	const parts = shortcut.toLowerCase().split("+");
	const expected = parts.pop();
	if (!expected || parts.some(part => !["ctrl", "alt", "shift", "super", "meta"].includes(part))) return false;
	if (event.ctrlKey !== parts.includes("ctrl") || event.altKey !== parts.includes("alt") || event.shiftKey !== parts.includes("shift")
		|| event.metaKey !== (parts.includes("super") || parts.includes("meta"))) return false;
	return expected === key || expected === physicalKey;
}
