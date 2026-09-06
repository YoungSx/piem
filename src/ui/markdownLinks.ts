import { Keymap, Notice, parseLinktext, type App } from "obsidian";
import type { Translator } from "../i18n";

/**
 * Class Obsidian's reading view puts on a link whose target does not exist, and
 * which `styles.css` styles for this panel. Named here because three places have
 * to agree on it — the marker below, the stylesheet, and the tests.
 */
export const UNRESOLVED_LINK_CLASS = "is-unresolved";

/**
 * Whether a link, written the way it appears in the text, addresses a note that
 * exists.
 *
 * `parseLinktext` splits off the `#heading` or `#^block` part, because only the
 * path in front of it names a file. A link that is *nothing but* an anchor
 * (`[[#Some heading]]`) points inside whatever note it was written in rather than
 * at a file of its own, so there is no path to resolve and it is left alone: a
 * mark there would be reporting a broken link that isn't one.
 */
function resolvesInVault(app: App, linktext: string, sourcePath: string): boolean {
	const { path } = parseLinktext(linktext);
	if (path === "") {
		return true;
	}
	return app.metadataCache.getFirstLinkpathDest(path, sourcePath) !== null;
}

/** The link a rendered anchor addresses, as written; empty when it has none. */
function linktextOf(anchor: Element): string {
	return anchor.getAttribute("data-href") ?? anchor.getAttribute("href") ?? "";
}

/**
 * Marks every internal link in a rendered block whose note does not exist.
 *
 * Obsidian classifies its anchors but does not resolve them: `internal-link` is
 * on every link addressing the vault, existing or not, and the reading view adds
 * `is-unresolved` in a pass of its own that a plugin's container never gets. So a
 * reply naming a note the model invented looked exactly like one naming a note
 * that is right there — measured against a real 1.13.7, identical computed style
 * down to the colour.
 *
 * `toggle` with an explicit force rather than `add`, so the pass is idempotent
 * and a re-render after the note was finally created takes the mark back off.
 */
export function markUnresolvedLinks(app: App, container: HTMLElement, sourcePath: string): void {
	for (const anchor of Array.from(container.querySelectorAll("a.internal-link"))) {
		const linktext = linktextOf(anchor);
		anchor.classList.toggle(UNRESOLVED_LINK_CLASS, linktext !== "" && !resolvesInVault(app, linktext, sourcePath));
	}
}

/**
 * What a click inside chat-rendered Markdown turned out to be.
 *
 * Three behaviours rather than three branches that happen to differ: a link to a
 * note is ours to open, a link to a note that does not exist is ours to explain,
 * and everything else already works better than anything we would put in its
 * place.
 */
export type MarkdownLinkClickOutcome = "opened-in-vault" | "reported-missing" | "left-to-platform";

/**
 * Acts on a click inside chat-rendered Markdown, and leaves anything that is not
 * a vault link exactly as it found it.
 *
 * `MarkdownRenderer.render` draws the anchors and classifies them — `internal-link`
 * for anything addressing the vault, `external-link` for the rest — and that is
 * where its involvement ends. Click handling for internal links belongs to
 * Obsidian's reading view, and a plugin's own container is not that: measured
 * against a real Obsidian 1.13.7, a click on a rendered `[[wikilink]]` inside an
 * `ItemView` travels to `window`, through `document` and back out with
 * `defaultPrevented` still false and nothing opened. Dressing the container in the
 * reading view's own classes does not change it; neither does a full
 * pointerdown/up sequence, nor a trusted (non-synthetic) mouse event. The link is
 * drawn correctly and has no listener. Embeds are the giveaway that this is about
 * listeners and not markup: `![[note]]` expands its target's body in the same
 * container, so the renderer clearly knows how to reach the vault.
 *
 * External links are the mirror image — they already work, and the working part is
 * not JavaScript. Every anchor carries `target="_blank"`, so Electron's own
 * window-open handler routes the click to the system browser with nothing on the
 * page taking part. A handler that claimed those clicks would be replacing working
 * behaviour with a reimplementation of it, so they are passed through untouched.
 *
 * A link to a note that does not exist reports instead of navigating. Obsidian's
 * own answer there is to create the note, which is right in a document the reader
 * wrote: the link is their own note-to-self. Here the link is something the model
 * wrote, and a reader following it is checking a claim, not declaring an
 * intention — creating an empty note as the answer to "does this exist?" leaves
 * them worse off than the question did, holding a file they now have to delete.
 * So the click answers the question and the vault stays as it was.
 *
 * `sourcePath` is the note the block was rendered against. It decides nothing
 * unless the vault holds two notes sharing a basename, where it picks the nearer
 * one; an empty path still resolves `beta`, `Projects/beta` and `Projects/beta.md`
 * to the same file.
 */
export function routeMarkdownLinkClick(app: App, t: Translator, event: MouseEvent, sourcePath: string): MarkdownLinkClickOutcome {
	const target = event.target as { closest?: (selectors: string) => Element | null } | null;
	// `closest` rather than a test on the target itself, because the click lands on
	// whatever is innermost: a `<strong>` inside the link text, or a link nested in
	// an embedded note. Both are the same link to the reader.
	const anchor = target?.closest?.("a.internal-link") ?? null;
	if (!anchor) {
		return "left-to-platform";
	}
	const linktext = linktextOf(anchor);
	if (linktext === "") {
		return "left-to-platform";
	}
	// Before the split, not inside either arm: the anchor's `target="_blank"`
	// outlives both outcomes, so skipping this leaves Electron opening a window for
	// a link we either just navigated or just declined to.
	event.preventDefault();
	if (!resolvesInVault(app, linktext, sourcePath)) {
		// Resolved again at click time rather than read off the class the marker
		// left: the mark records how the vault looked when the block was drawn, and
		// the note may have been created — or deleted — in the minutes since.
		new Notice(t.t("chat.unresolvedLink", { link: linktext }));
		return "reported-missing";
	}
	// `isModEvent` is the whole modifier table — Cmd/Ctrl for a tab, +Alt for a
	// split, +Alt+Shift for a window — so a link here obeys the same chords a link
	// in a note does.
	void app.workspace.openLinkText(linktext, sourcePath, Keymap.isModEvent(event)).catch((error: unknown) => {
		console.error("piem: opening an internal link failed", error);
	});
	return "opened-in-vault";
}
