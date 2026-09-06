import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { App } from "obsidian";
import { installDom } from "../testUtils/dom";
import { installObsidianStub, resetNotices, shownNotices } from "../testUtils/obsidianStub";

installObsidianStub();
const document = installDom();
/*
 * happy-dom hangs `MouseEvent` off its own window rather than installing it as a
 * global, and it validates dispatched events against that realm — so a click has
 * to be built from here, not from bun's built-in constructor.
 */
const { window: domWindow } = globalThis as unknown as { window: { MouseEvent: typeof MouseEvent } };

// Dynamic import so the mocked `obsidian` module wins over any cached real one.
const { routeMarkdownLinkClick, markUnresolvedLinks, UNRESOLVED_LINK_CLASS } = await import("./markdownLinks");
const { getT } = await import("../i18n");
type Outcome = ReturnType<typeof routeMarkdownLinkClick>;

const t = getT("en");
const SOURCE_PATH = "Notes/active.md";

/** Notes the fake vault holds. Mutable, so a test can create one mid-flight. */
const vaultFiles = new Set<string>();
const opened: [linktext: string, sourcePath: string, newLeaf: unknown][] = [];
const resolveCalls: [linkpath: string, sourcePath: string][] = [];
let openResult: () => Promise<void> = async () => undefined;

/**
 * Enough of `getFirstLinkpathDest` to be worth asserting against: an exact path,
 * the same path with `.md` appended, and a bare basename — the three shapes a
 * model writes, all three measured against a real vault as resolving to one file.
 */
const app = {
	workspace: {
		openLinkText: async (linktext: string, sourcePath: string, newLeaf: unknown): Promise<void> => {
			opened.push([linktext, sourcePath, newLeaf]);
			await openResult();
		},
	},
	metadataCache: {
		getFirstLinkpathDest: (linkpath: string, sourcePath: string): { path: string } | null => {
			resolveCalls.push([linkpath, sourcePath]);
			for (const candidate of [linkpath, `${linkpath}.md`]) {
				if (vaultFiles.has(candidate)) {
					return { path: candidate };
				}
			}
			const byBasename = Array.from(vaultFiles).find((file) => {
				const basename = file.split("/").pop();
				return basename === linkpath || basename === `${linkpath}.md`;
			});
			return byBasename === undefined ? null : { path: byBasename };
		},
	},
} as unknown as App;

/** Mounts a rendered-Markdown container holding `html`. */
function mount(html: string): HTMLElement {
	const container = document.createElement("div");
	container.className = "piem-chat__markdown";
	container.innerHTML = html;
	document.body.appendChild(container);
	return container;
}

/**
 * Clicks something inside a mounted container and reports what the router did.
 *
 * The click is dispatched for real and routed from a listener on the container,
 * the way `MarkdownText` wires it. A hand-built event object would carry no
 * `target` and could not report `defaultPrevented`, which is half of what these
 * tests check.
 */
function clickInside(container: HTMLElement, selector: string, init: MouseEventInit = {}): { outcome: Outcome; event: MouseEvent } {
	const targetEl = container.querySelector(selector);
	if (!targetEl) {
		throw new Error(`fixture has no ${selector}`);
	}
	let outcome: Outcome | undefined;
	container.addEventListener("click", (event) => {
		outcome = routeMarkdownLinkClick(app, t, event as MouseEvent, SOURCE_PATH);
	});
	const event = new domWindow.MouseEvent("click", { bubbles: true, cancelable: true, ...init });
	targetEl.dispatchEvent(event);
	if (!outcome) {
		throw new Error("the click never reached the container");
	}
	return { outcome, event };
}

const link = (cls: string, dataHref: string, text = dataHref): string =>
	`<a class="${cls}" data-href="${dataHref}" href="${dataHref}" target="_blank" rel="noopener nofollow">${text}</a>`;

const INTERNAL = `<p>see ${link("internal-link", "Projects/beta")} now</p>`;
const MISSING = `<p>start ${link("internal-link", "Weekly Review")} next</p>`;
const EXTERNAL = '<p>see <a class="external-link" href="https://example.com/page" target="_blank" rel="noopener nofollow">page</a> now</p>';

beforeEach(() => {
	opened.length = 0;
	resolveCalls.length = 0;
	openResult = async () => undefined;
	vaultFiles.clear();
	vaultFiles.add("Projects/beta.md");
	vaultFiles.add("Archive/moved-note.md");
	resetNotices();
	document.body.replaceChildren();
});

describe("markUnresolvedLinks", () => {
	it("marks a link whose note does not exist", () => {
		const container = mount(MISSING);

		markUnresolvedLinks(app, container, SOURCE_PATH);

		expect(container.querySelector("a.internal-link")?.classList.contains(UNRESOLVED_LINK_CLASS)).toBe(true);
	});

	it("leaves a link whose note exists unmarked", () => {
		const container = mount(INTERNAL);

		markUnresolvedLinks(app, container, SOURCE_PATH);

		expect(container.querySelector("a.internal-link")?.classList.contains(UNRESOLVED_LINK_CLASS)).toBe(false);
	});

	it("resolves against the path the block was rendered with", () => {
		markUnresolvedLinks(app, mount(MISSING), "Archive/dup.md");

		// The base only decides anything when two notes share a basename, but it has
		// to arrive for that case to work at all.
		expect(resolveCalls).toEqual([["Weekly Review", "Archive/dup.md"]]);
	});

	it("never looks at an external link", () => {
		const container = mount(EXTERNAL);

		markUnresolvedLinks(app, container, SOURCE_PATH);

		expect(resolveCalls).toEqual([]);
		expect(container.querySelector("a")?.classList.contains(UNRESOLVED_LINK_CLASS)).toBe(false);
	});

	it("takes the mark back off once the note exists", () => {
		const container = mount(MISSING);
		markUnresolvedLinks(app, container, SOURCE_PATH);
		expect(container.querySelector("a")?.classList.contains(UNRESOLVED_LINK_CLASS)).toBe(true);

		vaultFiles.add("Weekly Review.md");
		markUnresolvedLinks(app, container, SOURCE_PATH);

		// `toggle` with a force rather than `add`, so a second pass over the same
		// block after the note landed reports the vault as it is now.
		expect(container.querySelector("a")?.classList.contains(UNRESOLVED_LINK_CLASS)).toBe(false);
	});

	it("leaves a bare heading link alone", () => {
		const container = mount(`<p>jump to ${link("internal-link", "#Some heading", "Some heading")}</p>`);

		markUnresolvedLinks(app, container, SOURCE_PATH);

		// `[[#heading]]` addresses the note it was written in, not a file of its own,
		// so there is nothing to resolve and a mark would report a break that isn't.
		expect(container.querySelector("a")?.classList.contains(UNRESOLVED_LINK_CLASS)).toBe(false);
		expect(resolveCalls).toEqual([]);
	});

	it("leaves an anchor with no target alone", () => {
		const container = mount('<p><a class="internal-link">nowhere</a></p>');

		markUnresolvedLinks(app, container, SOURCE_PATH);

		expect(container.querySelector("a")?.classList.contains(UNRESOLVED_LINK_CLASS)).toBe(false);
	});

	it("marks each link on its own", () => {
		const container = mount(`<p>${link("internal-link", "Projects/beta")} and ${link("internal-link", "Weekly Review")}</p>`);

		markUnresolvedLinks(app, container, SOURCE_PATH);

		const marks = Array.from(container.querySelectorAll("a")).map((a) => a.classList.contains(UNRESOLVED_LINK_CLASS));
		expect(marks).toEqual([false, true]);
	});
});

describe("routeMarkdownLinkClick", () => {
	it("opens a vault link and swallows the click", () => {
		const { outcome, event } = clickInside(mount(INTERNAL), "a.internal-link");

		expect(outcome).toBe("opened-in-vault");
		expect(opened).toEqual([["Projects/beta", SOURCE_PATH, false]]);
		// Without this the anchor's own target="_blank" opens the link a second
		// time, as a window, on top of the navigation above.
		expect(event.defaultPrevented).toBe(true);
	});

	it("leaves an external link entirely alone", () => {
		const { outcome, event } = clickInside(mount(EXTERNAL), "a.external-link");

		expect(outcome).toBe("left-to-platform");
		expect(opened).toEqual([]);
		// The platform's own routing to the system browser is the default action;
		// preventing it here would break the case that already works.
		expect(event.defaultPrevented).toBe(false);
	});

	it("leaves a click on plain prose alone", () => {
		const { outcome, event } = clickInside(mount(INTERNAL), "p");

		expect(outcome).toBe("left-to-platform");
		expect(opened).toEqual([]);
		expect(event.defaultPrevented).toBe(false);
	});

	it("opens the link when the click lands on markup nested inside it", () => {
		const nested = '<p><a class="internal-link" data-href="Projects/beta" href="Projects/beta"><strong>beta</strong></a></p>';

		const { outcome } = clickInside(mount(nested), "strong");

		// A reader aiming at bold link text is aiming at the link.
		expect(outcome).toBe("opened-in-vault");
		expect(opened).toEqual([["Projects/beta", SOURCE_PATH, false]]);
	});

	it("opens a link that sits inside an embedded note", () => {
		const embed =
			'<span class="internal-embed markdown-embed is-loaded"><div class="markdown-embed-content">' +
			'<a class="internal-link" data-href="Archive/moved-note" href="Archive/moved-note">moved</a>' +
			"</div></span>";

		const { outcome } = clickInside(mount(embed), "a.internal-link");

		// `![[note]]` expands its target's body in place, links and all; those links
		// are as clickable as the ones written directly in the reply.
		expect(outcome).toBe("opened-in-vault");
		expect(opened).toEqual([["Archive/moved-note", SOURCE_PATH, false]]);
	});

	it("hands a heading reference through verbatim", () => {
		const deep = '<p><a class="internal-link" data-href="Projects/beta#Notes" href="Projects/beta#Notes">beta &gt; Notes</a></p>';

		clickInside(mount(deep), "a.internal-link");

		// `openLinkText` parses `#` and `^` itself, so splitting them here would only
		// lose the anchor — the opposite of the exact-path case in `ChatApp`, which
		// routes around that same parsing on purpose.
		expect(opened).toEqual([["Projects/beta#Notes", SOURCE_PATH, false]]);
	});

	it("falls back to href when data-href is absent", () => {
		const bare = '<p><a class="internal-link" href="Projects/beta">beta</a></p>';

		const { outcome } = clickInside(mount(bare), "a.internal-link");

		expect(outcome).toBe("opened-in-vault");
		expect(opened).toEqual([["Projects/beta", SOURCE_PATH, false]]);
	});

	it("leaves an internal link with no target at all alone", () => {
		const empty = '<p><a class="internal-link">nowhere</a></p>';

		const { outcome, event } = clickInside(mount(empty), "a.internal-link");

		// Nothing to open, so nothing is claimed either: swallowing the click would
		// make a broken anchor look like a working one that did nothing.
		expect(outcome).toBe("left-to-platform");
		expect(opened).toEqual([]);
		expect(event.defaultPrevented).toBe(false);
	});
});

/*
 * The missing-note branch. Obsidian's own answer to this click is to create the
 * note, which is right in a document the reader wrote and wrong here: the link is
 * the model's, and following it is checking a claim rather than declaring an
 * intention. So the vault must come out of this click untouched.
 */
describe("routeMarkdownLinkClick on a note that does not exist", () => {
	it("reports instead of navigating, and leaves the vault alone", () => {
		const { outcome, event } = clickInside(mount(MISSING), "a.internal-link");

		expect(outcome).toBe("reported-missing");
		expect(opened).toEqual([]);
		// Still claimed: the anchor's target="_blank" would otherwise open a window
		// for a note that does not exist.
		expect(event.defaultPrevented).toBe(true);
	});

	it("names the link in the notice, in the panel's language", () => {
		clickInside(mount(MISSING), "a.internal-link");

		expect(shownNotices).toHaveLength(1);
		// Asserted against the table rather than a quoted sentence, so rewording the
		// copy stays a copy change — but the link has to reach it either way.
		expect(shownNotices[0]?.message).toBe(t.t("chat.unresolvedLink", { link: "Weekly Review" }));
		expect(shownNotices[0]?.message).toContain("Weekly Review");
	});

	it("still refuses to create when a modifier asks for a new pane", () => {
		const { outcome } = clickInside(mount(MISSING), "a.internal-link", { ctrlKey: true });

		// A chord names *where* to open something, never whether to bring it into
		// existence.
		expect(outcome).toBe("reported-missing");
		expect(opened).toEqual([]);
	});

	it("re-resolves at click time rather than trusting the mark", () => {
		const container = mount(MISSING);
		markUnresolvedLinks(app, container, SOURCE_PATH);
		vaultFiles.add("Weekly Review.md");

		const { outcome } = clickInside(container, "a.internal-link");

		// The note arrived after the block was drawn, so the stale mark says missing
		// and the vault says otherwise. The vault wins, and the reader gets the note
		// they clicked rather than a notice about a file that is right there.
		expect(outcome).toBe("opened-in-vault");
		expect(opened).toEqual([["Weekly Review", SOURCE_PATH, false]]);
		expect(shownNotices).toEqual([]);
	});

	it("opens a link whose note was deleted after the block rendered as a report", () => {
		const container = mount(INTERNAL);
		markUnresolvedLinks(app, container, SOURCE_PATH);
		vaultFiles.delete("Projects/beta.md");

		const { outcome } = clickInside(container, "a.internal-link");

		// The mirror of the case above, and the reason the check is not read off the
		// class: the mark says resolved, the vault has moved on.
		expect(outcome).toBe("reported-missing");
		expect(opened).toEqual([]);
	});
});

/*
 * The modifier chords are the reason `Keymap.isModEvent` is called instead of a
 * hand-rolled `ctrlKey || metaKey`: a link in the panel should answer Cmd-click
 * the same way a link in a note does, including the two chords nobody remembers.
 */
describe("routeMarkdownLinkClick modifiers", () => {
	it("asks for a new tab on Cmd/Ctrl-click", () => {
		clickInside(mount(INTERNAL), "a.internal-link", { ctrlKey: true });
		expect(opened.at(-1)?.[2]).toBe("tab");

		opened.length = 0;
		clickInside(mount(INTERNAL), "a.internal-link", { metaKey: true });
		expect(opened.at(-1)?.[2]).toBe("tab");
	});

	it("asks for a split on Cmd/Ctrl+Alt and a window with Shift as well", () => {
		clickInside(mount(INTERNAL), "a.internal-link", { ctrlKey: true, altKey: true });
		expect(opened.at(-1)?.[2]).toBe("split");

		clickInside(mount(INTERNAL), "a.internal-link", { ctrlKey: true, altKey: true, shiftKey: true });
		expect(opened.at(-1)?.[2]).toBe("window");
	});

	it("asks for a new tab on a middle click", () => {
		clickInside(mount(INTERNAL), "a.internal-link", { button: 1 });
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
			const { outcome } = clickInside(mount(INTERNAL), "a.internal-link");
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

describe("the marker's class and the stylesheet", () => {
	it("agree on one name", () => {
		const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");

		// The class is the whole contract between this module and `styles.css`, and a
		// rename on either side is silent: the marker would keep marking and the rule
		// would keep matching nothing.
		expect(styles).toContain(`a.internal-link.${UNRESOLVED_LINK_CLASS} {`);
	});
});
