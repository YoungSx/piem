import { describe, expect, it } from "bun:test";
import { installDom } from "../testUtils/dom";
import { matchesExtensionShortcut } from "./extensionShortcuts";

installDom();

function key(init: KeyboardEventInit): KeyboardEvent {
	const event = new KeyboardEvent("keydown", init);
	// happy-dom treats every Alt key as AltGraph, unlike Electron's macOS Option.
	const read = event.getModifierState.bind(event);
	event.getModifierState = modifier => modifier === "AltGraph" ? false : read(modifier);
	return event;
}

describe("extension shortcut matching", () => {
	it("matches exact modifiers and physical digit keys used with Option on macOS", () => {
		expect(matchesExtensionShortcut(new KeyboardEvent("keydown", { key: "N", ctrlKey: true, shiftKey: true }), "ctrl+shift+n")).toBe(true);
		expect(matchesExtensionShortcut(new KeyboardEvent("keydown", { key: "N", ctrlKey: true, shiftKey: true }), "ctrl+n")).toBe(false);
		expect(matchesExtensionShortcut(key({ key: "¡", code: "Digit1", altKey: true }), "alt+1")).toBe(true);
		expect(matchesExtensionShortcut(new KeyboardEvent("keydown", { key: "r", metaKey: true }), "super+r")).toBe(true);
	});

	it("leaves typing, composition, send, completion and editing keys alone", () => {
		for (const key of ["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowLeft", "Home"]) {
			expect(matchesExtensionShortcut(new KeyboardEvent("keydown", { key, ctrlKey: true }), `ctrl+${key.toLowerCase()}`)).toBe(false);
		}
		for (const key of ["a", "c", "v", "x", "y", "z"]) {
			expect(matchesExtensionShortcut(new KeyboardEvent("keydown", { key, metaKey: true }), `super+${key}`)).toBe(false);
		}
		expect(matchesExtensionShortcut(new KeyboardEvent("keydown", { key: "n" }), "n")).toBe(false);
		expect(matchesExtensionShortcut(new KeyboardEvent("keydown", { key: "n", ctrlKey: true, isComposing: true }), "ctrl+n")).toBe(false);
		expect(matchesExtensionShortcut(new KeyboardEvent("keydown", { key: "n", ctrlKey: true, repeat: true }), "ctrl+n")).toBe(false);
		const altGraph = key({ key: "@", code: "KeyQ", altKey: true, ctrlKey: true });
		altGraph.getModifierState = modifier => modifier === "AltGraph";
		expect(matchesExtensionShortcut(altGraph, "ctrl+alt+q")).toBe(false);
		const claimed = new KeyboardEvent("keydown", { key: "n", ctrlKey: true, cancelable: true });
		claimed.preventDefault();
		expect(matchesExtensionShortcut(claimed, "ctrl+n")).toBe(false);
	});
});
