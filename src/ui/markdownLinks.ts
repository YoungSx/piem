import { Keymap, type App } from "obsidian";

/**
 * What a click inside chat-rendered Markdown turned out to be.
 *
 * The two names are two behaviours rather than two branches that happen to
 * differ: a vault link is ours to open, and everything else already works
 * better than anything we would put in its place.
 */
export type MarkdownLinkClickOutcome = "opened-in-vault" | "left-to-platform";

/**
 * Opens a vault link clicked inside chat-rendered Markdown, and leaves every
 * other click exactly as it found it.
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
 * page taking part. Claiming those clicks would mean replacing working behaviour
 * with a reimplementation of it, so they are passed through untouched.
 *
 * `sourcePath` is the note the block was rendered against. It decides nothing
 * unless the vault holds two notes sharing a basename, where it picks the nearer
 * one; an empty path still resolves `beta`, `Projects/beta` and `Projects/beta.md`
 * to the same file.
 */
export function routeMarkdownLinkClick(app: App, event: MouseEvent, sourcePath: string): MarkdownLinkClickOutcome {
	const target = event.target as { closest?: (selectors: string) => Element | null } | null;
	// `closest` rather than a test on the target itself, because the click lands on
	// whatever is innermost: a `<strong>` inside the link text, or a link nested in
	// an embedded note. Both are the same link to the reader.
	const anchor = target?.closest?.("a.internal-link") ?? null;
	if (!anchor) {
		return "left-to-platform";
	}
	// `data-href` is the link as written — `Projects/beta`, `note#heading`,
	// `note#^block` — which is the form `openLinkText` parses. `href` holds the same
	// string today and is read as a fallback rather than depended on.
	const linktext = anchor.getAttribute("data-href") ?? anchor.getAttribute("href");
	if (!linktext) {
		return "left-to-platform";
	}
	// The anchor's `target="_blank"` outlives the navigation below, so skipping this
	// leaves Electron opening the same link a second time as a window.
	event.preventDefault();
	// `isModEvent` is the whole modifier table — Cmd/Ctrl for a tab, +Alt for a
	// split, +Alt+Shift for a window — so a link here obeys the same chords a link
	// in a note does.
	void app.workspace.openLinkText(linktext, sourcePath, Keymap.isModEvent(event)).catch((error: unknown) => {
		console.error("piem: opening an internal link failed", error);
	});
	return "opened-in-vault";
}
