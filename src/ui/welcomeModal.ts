import { App, Component, MarkdownRenderer, Modal, Setting } from "obsidian";
import type { Translator } from "../i18n";
import type { LoggerLike } from "../logging/Logger";

/**
 * One entry in the post-update welcome dialog.
 *
 * A heading, optional date, and body copy. The shape is deliberately this
 * plain: it is what `MarkdownRenderer` can consume, so an entry can grow from
 * a single line to a bulleted list without a format change.
 */
export interface WelcomeEntry {
	/** Version this entry describes, exactly as `manifest.json` spells it. */
	version: string;
	/** Release date, or omitted to leave the heading bare. */
	date?: string;
	/** Body copy. Markdown; rendered, not set as text. */
	body: string;
}

/**
 * What the dialog shows, newest first.
 *
 * Empty on purpose until a release decides its own notes. The dialog is wired
 * end to end, so shipping it costs nothing to leave blank: with no entries the
 * modal still opens on an upgrade, states the version it is greeting, and
 * leaves the body empty. A reader sees a working feature rather than a
 * half-wired one.
 *
 * Populate per release, newest entry first. Entries above the reader's
 * installed version are the ones they have not seen, so a reader upgrading
 * across several releases gets the backlog rather than only the latest.
 */
export const WELCOME_ENTRIES: readonly WelcomeEntry[] = [];

/**
 * The entries a reader has not been shown yet.
 *
 * A reader is "at" the newest version listed below the one they recorded. An
 * installed version with no entry above it (a dev build, or notes not written
 * yet) contributes nothing rather than everything, so an entry written for
 * 2.0.0 never greets somebody still on 1.9.0.
 *
 * `entries` is a parameter rather than a read of {@link WELCOME_ENTRIES} so
 * the comparison is testable while the shipped list is still empty — which it
 * is until a release writes its own notes. {@link WELCOME_ENTRIES} is the only
 * caller that matters; the parameter exists so the decision can be exercised
 * against a list with a minor rollover in it, the case a text sort gets wrong.
 */
export function pendingEntries(
	entries: readonly WelcomeEntry[],
	lastShownVersion: string | undefined,
	currentVersion: string,
): WelcomeEntry[] {
	const seen = lastShownVersion ?? "";
	return entries.filter((entry) => compareVersions(entry.version, currentVersion) <= 0 && compareVersions(entry.version, seen) > 0);
}

/**
 * Orders two dotted versions, newest last.
 *
 * Segments compare numerically, so `1.10.0` is newer than `1.9.0` — the case a
 * text sort gets backwards, silently costing a reader the notes for a release
 * they just installed.
 *
 * A pre-release suffix sorts *below* the bare version it leads to, which is
 * what semver says and what the dialog needs: a reader who installed
 * `1.6.0-beta.1` and later updates to `1.6.0` is owed the `1.6.0` notes, and
 * comparing `1.6.0-beta.1` as if its fourth segment were part of the version
 * puts the release *below* its own beta and loses them. Two pre-releases of one
 * version still order by their own numbers, so `beta.1` precedes `beta.2`.
 */
function compareVersions(a: string, b: string): number {
	const left = splitVersion(a);
	const right = splitVersion(b);
	for (let i = 0; i < Math.max(left.numbers.length, right.numbers.length); i++) {
		const diff = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0);
		if (diff !== 0) return diff;
	}
	// Same numbers: the bare release wins, because it is what a beta reader is
	// moving towards and has therefore not read yet.
	if (left.prerelease === right.prerelease) return 0;
	if (!left.prerelease) return 1;
	if (!right.prerelease) return -1;
	return compareSegments(left.prerelease, right.prerelease);
}

/** A version split into its numbers and its pre-release suffix. */
function splitVersion(version: string): { numbers: number[]; prerelease: string } {
	const dash = version.indexOf("-");
	const core = dash === -1 ? version : version.slice(0, dash);
	const prerelease = dash === -1 ? "" : version.slice(dash + 1);
	// A non-numeric segment is 0 rather than NaN: a hand-edited version string
	// should degrade to "some early version", not poison the comparison.
	return { numbers: core.split(".").map((part) => Number(part) || 0), prerelease };
}

/** Orders two dot-separated pre-release suffixes segment by segment. */
function compareSegments(a: string, b: string): number {
	const left = a.split(".");
	const right = b.split(".");
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = (Number(left[i]) || 0) - (Number(right[i]) || 0);
		if (diff !== 0) return diff;
	}
	return left.length - right.length;
}

/**
 * The post-install and post-update dialog.
 *
 * Obsidian ships no changelog API — `obsidian.d.ts` has no changelog entry at
 * all — so this is the community-standard shape: read the version out of the
 * manifest, remember what was last shown, and draw the window yourself with
 * the official `Modal`. `onLayoutReady` is the documented hook for work that
 * should not compete with first paint.
 */
export class WelcomeModal extends Modal {
	private readonly entries: readonly WelcomeEntry[];
	private readonly currentVersion: string;
	private readonly t: Translator;
	private readonly onDismiss: () => void;
	private readonly log: LoggerLike;
	/**
	 * Owns the lifecycle of what `MarkdownRenderer.render` builds.
	 *
	 * `Modal` is not a `Component`, but the render call needs one to hang the
	 * rendered children off, so the dialog keeps its own and unloads it on
	 * close. `render` is asynchronous, so a child registered after the reader
	 * dismissed the dialog would otherwise outlive the dialog that made it.
	 */
	private readonly content = new Component();

	constructor(
		app: App,
		entries: readonly WelcomeEntry[],
		currentVersion: string,
		t: Translator,
		log: LoggerLike,
		onDismiss: () => void,
	) {
		super(app);
		this.entries = entries;
		this.currentVersion = currentVersion;
		this.t = t;
		this.log = log;
		this.onDismiss = onDismiss;
		this.content.load();
	}

	onOpen(): void {
		this.setTitle(this.t.t("welcome.title"));
		this.modalEl.addClass("piem-welcome");

		this.contentEl.createEl("p", {
			text: this.t.t("welcome.version", { version: this.currentVersion }),
			cls: "piem-welcome__version",
		});

		// A release with no notes written yet still greets, so the dialog is
		// visibly the working feature rather than an empty shell.
		if (this.entries.length === 0) {
			this.contentEl.createEl("p", { text: this.t.t("welcome.noNotes"), cls: "piem-welcome__empty" });
		} else {
			for (const entry of this.entries) {
				this.renderEntry(entry);
			}
		}

		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText(this.t.t("welcome.dismiss")).setCta().onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
		// Before the greeting is recorded, so a dialog dismissed by any route is
		// the same outcome to the caller: this version has been shown, whether or
		// not the body was read.
		this.content.unload();
		this.onDismiss();
	}

	private renderEntry(entry: WelcomeEntry): void {
		const heading = this.contentEl.createEl("h3", { cls: "piem-welcome__heading" });
		heading.createSpan({ text: entry.version, cls: "piem-welcome__heading-version" });
		if (entry.date) {
			heading.createSpan({ text: entry.date, cls: "piem-welcome__heading-date" });
		}
		const body = this.contentEl.createDiv({ cls: "piem-welcome__body" });
		// Rendered rather than set as text: a release note that wants a list
		// should not have to hand-roll one, and body copy is authored here in
		// the repo, never supplied by a vault.
		void this.renderMarkdown(body, entry.body);
	}

	/**
	 * Renders entry markdown through Obsidian's own renderer.
	 *
	 * `MarkdownRenderer.render` is the app's renderer, so links, lists, and
	 * emphasis look like the rest of the vault, and {@link WelcomeModal.content}
	 * is the parent `Component` so the rendered children are torn down with the
	 * dialog. The promise is voided rather than awaited because `onOpen` is
	 * synchronous and blocking it buys nothing — a failure is recovered inline.
	 */
	private renderMarkdown(el: HTMLElement, markdown: string): void {
		void MarkdownRenderer.render(this.app, markdown, el, "", this.content).catch((error: unknown) => {
			// A renderer that cannot finish must not cost the reader the dialog;
			// the raw text is still the content, and it is readable. Logged
			// rather than thrown because a release note is decoration — the
			// failure belongs in the log, not in the reader's face.
			this.log.warn("Welcome dialog could not render release notes", () => ({ error: String(error) }));
			el.setText(markdown);
		});
	}
}
