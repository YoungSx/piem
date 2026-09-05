import { describe, expect, it } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { watchWindowFocus, type WindowBoundNode } from "./windowFocusWatch";

/**
 * happy-dom's `Window` class and the DOM lib's `Window` type are two names for
 * the same idea, and TypeScript will not unify them on its own. The cast is the
 * whole bridge: the instances do implement the DOM surface, and that surface —
 * `document`, `dispatchEvent`, the event constructors — is all these tests touch.
 */
const createWindow = (): Window & typeof globalThis => new HappyWindow() as unknown as Window & typeof globalThis;

/**
 * A stand-in for an Obsidian element: it knows which window it belongs to and
 * announces when that changes. happy-dom's own elements carry no Obsidian
 * augmentation, so this is what lets the migration path be driven at all —
 * and it is the exact shape {@link WindowBoundNode} was declared for.
 */
function createNode(win: Window): WindowBoundNode & { migrateTo(next: Window): void } {
	const listeners = new Set<(win: Window) => void>();
	return {
		win,
		onWindowMigrated(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		migrateTo(next) {
			for (const listener of [...listeners]) {
				listener(next);
			}
		},
	};
}

function focus(win: Window & typeof globalThis): void {
	// The window's own `Event`, not the global one: happy-dom validates a dispatched
	// event against its own realm's class, and under a bare `bun test <this file>`
	// the global is Bun's — rejected as "parameter 1 is not of type 'Event'". These
	// tests passed only when another file had installed a DOM and overwritten the
	// global first, which is exactly the cross-realm confusion the module is about.
	win.dispatchEvent(new win.Event("focus"));
}

describe("watchWindowFocus", () => {
	it("fires when the window the node lives in regains focus", () => {
		const win = createWindow();
		const node = createNode(win);
		const seen: number[] = [];

		const dispose = watchWindowFocus(node, () => seen.push(seen.length + 1));
		focus(win);

		expect(seen).toEqual([1]);
		dispose();
	});

	it("leaves the old window behind on a migration and binds the one it lands in", () => {
		const main = createWindow();
		const popout = createWindow();
		const node = createNode(main);
		const seen: number[] = [];

		const dispose = watchWindowFocus(node, () => seen.push(seen.length + 1));
		node.migrateTo(popout);

		// The panel was dragged out: focus now returns to the popout's window,
		// and the main window's listener must not answer for it any more.
		focus(main);
		expect(seen).toEqual([]);

		focus(popout);
		expect(seen).toEqual([1]);
		dispose();
	});

	it("keeps exactly one binding per window, not one per migration", () => {
		const first = createWindow();
		const second = createWindow();
		const node = createNode(first);
		const seen: number[] = [];

		const dispose = watchWindowFocus(node, () => seen.push(seen.length + 1));
		node.migrateTo(second);
		focus(second);
		focus(second);

		expect(seen).toEqual([1, 2]);
		dispose();
	});

	it("stops listening everywhere once disposed", () => {
		const main = createWindow();
		const popout = createWindow();
		const node = createNode(main);
		const seen: number[] = [];

		const dispose = watchWindowFocus(node, () => seen.push(seen.length + 1));
		node.migrateTo(popout);
		dispose();

		focus(popout);
		// A migration announced after disposal reaches nothing: the subscription
		// itself was released, not only the focus listener it had installed.
		node.migrateTo(main);
		focus(main);

		expect(seen).toEqual([]);
	});
});
