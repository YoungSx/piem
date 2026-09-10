import type { Key as PiKey, KeyId } from "@earendil-works/pi-tui";
import { unavailable } from "../node/unavailable";

export type { KeyId };

/** Pi's public key identifiers. There is no terminal input listener or protocol state. */
export const Key: typeof PiKey = Object.freeze({
	escape: "escape", esc: "esc", enter: "enter", return: "return", tab: "tab", space: "space",
	backspace: "backspace", delete: "delete", insert: "insert", clear: "clear", home: "home", end: "end",
	pageUp: "pageUp", pageDown: "pageDown", up: "up", down: "down", left: "left", right: "right",
	f1: "f1", f2: "f2", f3: "f3", f4: "f4", f5: "f5", f6: "f6",
	f7: "f7", f8: "f8", f9: "f9", f10: "f10", f11: "f11", f12: "f12",
	backtick: "`", hyphen: "-", equals: "=", leftbracket: "[", rightbracket: "]", backslash: "\\",
	semicolon: ";", quote: "'", comma: ",", period: ".", slash: "/", exclamation: "!", at: "@",
	hash: "#", dollar: "$", percent: "%", caret: "^", ampersand: "&", asterisk: "*",
	leftparen: "(", rightparen: ")", underscore: "_", plus: "+", pipe: "|", tilde: "~",
	leftbrace: "{", rightbrace: "}", colon: ":", lessthan: "<", greaterthan: ">", question: "?",
	ctrl: key => `ctrl+${key}`, shift: key => `shift+${key}`, alt: key => `alt+${key}`, super: key => `super+${key}`,
	ctrlShift: key => `ctrl+shift+${key}`, shiftCtrl: key => `shift+ctrl+${key}`,
	ctrlAlt: key => `ctrl+alt+${key}`, altCtrl: key => `alt+ctrl+${key}`,
	shiftAlt: key => `shift+alt+${key}`, altShift: key => `alt+shift+${key}`,
	ctrlSuper: key => `ctrl+super+${key}`, superCtrl: key => `super+ctrl+${key}`,
	shiftSuper: key => `shift+super+${key}`, superShift: key => `super+shift+${key}`,
	altSuper: key => `alt+super+${key}`, superAlt: key => `super+alt+${key}`,
	ctrlShiftAlt: key => `ctrl+shift+alt+${key}`, ctrlShiftSuper: key => `ctrl+shift+super+${key}`,
});

const aliases: Readonly<Record<string, string>> = {
	esc: "escape", return: "enter", arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right",
	pageup: "pageUp", pagedown: "pageDown",
};
const legacyKeys: Readonly<Record<string, string>> = {
	"\r": "enter", "\n": "enter", "\t": "tab", " ": "space", "\u001b": "escape", "\u007f": "backspace", "\b": "backspace",
	"\u001b[A": "up", "\u001b[B": "down", "\u001b[C": "right", "\u001b[D": "left",
	"\u001b[H": "home", "\u001b[F": "end", "\u001b[2~": "insert", "\u001b[3~": "delete",
	"\u001b[5~": "pageUp", "\u001b[6~": "pageDown", "\u001b[Z": "shift+tab",
};
const names = new Set<string>(Object.values(Key).filter(value => typeof value === "string"));

export function parseKey(data: string): string | undefined {
	if (Object.prototype.hasOwnProperty.call(legacyKeys, data)) return legacyKeys[data];
	if (data.length === 1 && data.charCodeAt(0) > 0 && data.charCodeAt(0) < 27) return `ctrl+${String.fromCharCode(data.charCodeAt(0) + 96)}`;
	let base = data;
	const modifiers = new Set<string>();
	let modifier: RegExpExecArray | null;
	while ((modifier = /^(ctrl|alt|shift|super)\+/i.exec(base))) {
		modifiers.add(modifier[1]!.toLowerCase());
		base = base.slice(modifier[0].length);
	}
	if (/^[A-Z]$/.test(base)) modifiers.add("shift");
	base = aliases[base.toLowerCase()] ?? base.toLowerCase();
	if (!names.has(base) && !/^[a-z0-9]$/.test(base)) return undefined;
	return [...["ctrl", "alt", "shift", "super"].filter(value => modifiers.has(value)), base].join("+");
}

/** Native hosts pass key IDs; familiar single-key legacy codes also remain usable. */
export function matchesKey(data: string, keyId: KeyId): boolean {
	const key = parseKey(data);
	return key !== undefined && key === parseKey(keyId);
}

const selectionBindings: Readonly<Record<string, readonly KeyId[]>> = Object.freeze({
	"tui.select.up": ["up"], "tui.select.down": ["down"],
	"tui.select.pageUp": ["pageUp"], "tui.select.pageDown": ["pageDown"],
	"tui.select.confirm": ["enter"], "tui.select.cancel": ["escape", "ctrl+c"],
});

export interface CompatKeybindings {
	matches(data: string, keybinding: string): boolean;
	getKeys(keybinding: string): KeyId[];
}

export function createKeybindings(): CompatKeybindings {
	const getKeys = (keybinding: string): KeyId[] => {
		if (!Object.prototype.hasOwnProperty.call(selectionBindings, keybinding)) return unavailable(`native keybinding ${keybinding}`);
		return [...selectionBindings[keybinding]!];
	};
	return Object.freeze({ getKeys, matches: (data: string, keybinding: string) => getKeys(keybinding).some(key => matchesKey(data, key)) });
}

export const getKeybindings = createKeybindings;
