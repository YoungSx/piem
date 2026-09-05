import { beforeEach, describe, expect, it } from "bun:test";
import type { App } from "obsidian";
import { installDom } from "../testUtils/dom";
import { installObsidianStub } from "../testUtils/obsidianStub";

installObsidianStub();
const document = installDom();
/*
 * happy-dom hangs `MouseEvent` off its own window rather than installing it as a
 * global, and it validates dispatched events against that realm — so a click has
 * to be built from here, not from bun's built-in constructor.
 */
const { window: domWindow } = globalThis as unknown as { window: { MouseEvent: typeof MouseEvent } };

// Dynamic import so the mocked `obsidian` module wins over any cached real one.
const { routeMarkdownLinkClick } = await import("./markdownLinks");
type Outcome = Awaited<ReturnType<typeof routeMarkdownLinkClick>>;

const SOURCE_PATH = "Notes/active.md";

const opened: [linktext: string, sourcePath: string, newLeaf: unknown][] = [];
let openResult: () => Promise<void> = async () => undefined;

const app = {
	workspace: {
		openLinkText: async (linktext: string, sourcePath: string, newLeaf: unknown): Promise<void> => {
			opened.push([linktext, sourcePath, newLeaf]);
			await openResult();
		},
	},
} as unknown as App;

/**
 * Mounts one rendered-Markdown container and clicks something inside it.
 *
 * The click is dispatched for real and routed from a listener on the container,
 * the way {@link routeMarkdownLinkClick} is wired in `MarkdownText`. A hand-built
 * event object would carry no `target` and could not report `defaultPrevented`,
 * which is half of what these tests are checking.
 */
function clickInside(html: string, selector: string, init: MouseEventInit = {}): { outcome: Outcome; event: MouseEvent } {
	const container = document.createElement("div");
	container.innerHTML = html;
	document.body.appendChild(container);
	const targetEl = container.querySelector(selector);
	if (!targetEl) {
		throw new Error(`fixture has no ${selector}`);
	}
	let outcome: Outcome | undefined;
	container.addEventListener("click", (event) => {
		outcome = routeMarkdownLinkClick(app, event as MouseEvent, SOURCE_PATH);
	});
	const event = new domWindow.MouseEvent("click", { bubbles: true, cancelable: true, ...init });
	targetEl.dispatchEvent(event);
	if (!outcome) {
		throw new Error("the click never reached the container");
	}
	return { outcome, event };
}

const INTERNAL = '<p>see <a class="internal-link" data-href="Projects/beta" href="Projects/beta" target="_blank" rel="noopener nofollow">beta</a> now</p>';
const EXTERNAL = '<p>see <a class="external-link" href="https://example.com/page" target="_blank" rel="noopener nofollow">page</a> now</p>';

beforeEach(() => {
	opened.length = 0;
	openResult = async () => undefined;
	document.body.replaceChildren();
});

describe("routeMarkdownLinkClick", () => {
	it("opens a vault link and swallows the click", () => {
		const { outcome, event } = clickInside(INTERNAL, "a.internal-link");

		expect(outcome).toBe("opened-in-vault");
		expect(opened).toEqual([["Projects/beta", SOURCE_PATH, false]]);
		// Without this the anchor's own target="_blank" opens the link a second
		// time, as a window, on top of the navigation above.
		expect(event.defaultPrevented).toBe(true);
	});

	it("leaves an external link entirely alone", () => {
		const { outcome, event } = clickInside(EXTERNAL, "a.external-link");

		expect(outcome).toBe("left-to-platform");
		expect(opened).toEqual([]);
		// The platform's own routing to the system browser is the default action;
		// preventing it here would break the case that already works.
		expect(event.defaultPrevented).toBe(false);
	});

	it("leaves a click on plain prose alone", () => {
		const { outcome, event } = clickInside(INTERNAL, "p");

		expect(outcome).toBe("left-to-platform");
		expect(opened).toEqual([]);
		expect(event.defaultPrevented).toBe(false);
	});

	it("opens the link when the click lands on markup nested inside it", () => {
		const nested = '<p><a class="internal-link" data-href="Projects/beta" href="Projects/beta"><strong>beta</strong></a></p>';

		const { outcome } = clickInside(nested, "strong");

		// A reader aiming at bold link text is aiming at the link.
		expect(outcome).toBe("opened-in-vault");
		expect(opened).toEqual([["Projects/beta", SOURCE_PATH, false]]);
	});

	it("opens a link that sits inside an embedded note", () => {
		const embed =
			'<span class="internal-embed markdown-embed is-loaded"><div class="markdown-embed-content">' +
			'<a class="internal-link" data-href="Archive/moved-note" href="Archive/moved-note">moved</a>' +
			"</div></span>";

		const { outcome } = clickInside(embed, "a.internal-link");

		// `![[note]]` expands its target's body in place, links and all; those links
		// are as clickable as the ones written directly in the reply.
		expect(outcome).toBe("opened-in-vault");
		expect(opened).toEqual([["Archive/moved-note", SOURCE_PATH, false]]);
	});

	it("hands a heading or block reference through verbatim", () => {
		const deep = '<p><a class="internal-link" data-href="root-note#Root note" href="root-note#Root note">root-note &gt; Root note</a></p>';

		clickInside(deep, "a.internal-link");

		// `openLinkText` parses `#` and `^` itself, so splitting them here would
		// only lose the anchor — the opposite of the exact-path case in `ChatApp`,
		// which routes around that same parsing on purpose.
		expect(opened).toEqual([["root-note#Root note", SOURCE_PATH, false]]);
	});

	it("falls back to href when data-href is absent", () => {
		const bare = '<p><a class="internal-link" href="root-note">root</a></p>';

		const { outcome } = clickInside(bare, "a.internal-link");

		expect(outcome).toBe("opened-in-vault");
		expect(opened).toEqual([["root-note", SOURCE_PATH, false]]);
	});

	it("leaves an internal link with no target at all alone", () => {
		const empty = '<p><a class="internal-link">nowhere</a></p>';

		const { outcome, event } = clickInside(empty, "a.internal-link");

		// Nothing to open, so nothing is claimed either: swallowing the click would
		// make a broken anchor look like a working one that did nothing.
		expect(outcome).toBe("left-to-platform");
		expect(opened).toEqual([]);
		expect(event.defaultPrevented).toBe(false);
	});
});

/*
 * The modifier chords are the reason `Keymap.isModEvent` is called instead of a
 * hand-rolled `ctrlKey || metaKey`: a link in the panel should answer Cmd-click
 * the same way a link in a note does, including the two chords nobody remembers.
 */
describe("routeMarkdownLinkClick modifiers", () => {
	it("asks for a new tab on Cmd/Ctrl-click", () => {
		clickInside(INTERNAL, "a.internal-link", { ctrlKey: true });
		expect(opened.at(-1)?.[2]).toBe("tab");

		opened.length = 0;
		clickInside(INTERNAL, "a.internal-link", { metaKey: true });
		expect(opened.at(-1)?.[2]).toBe("tab");
	});

	it("asks for a split on Cmd/Ctrl+Alt and a window with Shift as well", () => {
		clickInside(INTERNAL, "a.internal-link", { ctrlKey: true, altKey: true });
		expect(opened.at(-1)?.[2]).toBe("split");

		clickInside(INTERNAL, "a.internal-link", { ctrlKey: true, altKey: true, shiftKey: true });
		expect(opened.at(-1)?.[2]).toBe("window");
	});

	it("asks for a new tab on a middle click", () => {
		clickInside(INTERNAL, "a.internal-link", { button: 1 });
		expect(opened.at(-1)?.[2]).toBe("tab");
	});
});

describe("routeMarkdownLinkClick failures", () => {
	it("logs a rejected open instead of leaving it unhandled", async () => {
		openResult = async () => {
			throw new Error("no such note");
		};
		const logged: unknown[] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => {
			logged.push(args);
		};
		try {
			const { outcome } = clickInside(INTERNAL, "a.internal-link");
			expect(outcome).toBe("opened-in-vault");
			// The rejection lands a microtask later; an uncaught one would surface as
			// an unhandled rejection rather than as a log line.
			await Promise.resolve();
			await Promise.resolve();
			expect(logged).toHaveLength(1);
		} finally {
			console.error = originalError;
		}
	});
});
