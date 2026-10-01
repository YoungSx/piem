/**
 * Covers the post-update greeting's decision: which release notes a reader has
 * not been shown yet.
 *
 * This is the whole of the dialog's brain. The window itself is Obsidian's
 * `Modal` drawing Obsidian's own widgets, and the version is recorded by a
 * callback the caller supplies, so what can be wrong here is a comparison —
 * and a wrong comparison is invisible until it greets the wrong reader.
 *
 * The shipped {@link WELCOME_ENTRIES} is empty until a release writes its
 * notes, so the interesting cases drive the decision against a local list.
 * That is why `pendingEntries` takes its entries as a parameter: the
 * comparison is testable today, before there is anything to compare.
 */

import { describe, expect, it } from "bun:test";
import { installObsidianStub } from "../testUtils/obsidianStub";

// `welcomeModal.ts` imports `obsidian` at module scope for `Modal` and
// `MarkdownRenderer`; register the stub before importing it.
installObsidianStub();

const { pendingEntries, WELCOME_ENTRIES } = await import("./welcomeModal");

/**
 * A stand-in for the shipped list, newest first.
 *
 * Spans a minor rollover and a pre-release on purpose. `1.9.0` against
 * `1.10.0` separates a numeric comparison from a text one, which is the
 * mistake that would silently drop a release's notes; the `1.11.0` pair covers
 * the suffix, which the real `manifest.json` can carry on a BRAT build.
 */
const SAMPLE = [
	{ version: "1.11.0-beta.2", body: "a" },
	{ version: "1.11.0", body: "b" },
	{ version: "1.11.0-beta.1", body: "c" },
	{ version: "1.10.0", body: "d" },
	{ version: "1.9.0", body: "e" },
	{ version: "1.8.0", body: "f" },
];

/** Which versions of `SAMPLE` a reader is owed. */
function owedTo(lastShownVersion: string | undefined, currentVersion: string): string[] {
	return pendingEntries(SAMPLE, lastShownVersion, currentVersion).map((entry) => entry.version);
}

/** Which versions of the shipped list a reader is owed. */
function owedInShippedList(lastShownVersion: string | undefined, currentVersion: string): string[] {
	return pendingEntries(WELCOME_ENTRIES, lastShownVersion, currentVersion).map((entry) => entry.version);
}

describe("pendingEntries", () => {
	it("reports nothing while no release has written notes", () => {
		// The shipped state: the dialog is wired, the notes are not written yet.
		// This is the assertion that keeps the blank list from reading as a bug,
		// and a tripwire for whoever writes the first entry — they will have to
		// update it, which is the moment to read the two cases below it.
		expect(WELCOME_ENTRIES).toEqual([]);
		expect(pendingEntries(WELCOME_ENTRIES, undefined, "1.0.0")).toEqual([]);
		expect(pendingEntries(WELCOME_ENTRIES, "1.0.0", "1.0.0")).toEqual([]);
	});

	it("owes a first install every note up to the running version", () => {
		expect(owedTo(undefined, "1.10.0")).toEqual(["1.10.0", "1.9.0", "1.8.0"]);
	});

	it("owes nothing once the running version is recorded", () => {
		// The reader dismissed the dialog, so the same version must stay quiet.
		// This is the case that would regress into a dialog on every launch.
		expect(owedTo("1.10.0", "1.10.0")).toEqual([]);
	});

	it("owes only the backlog after a reader skips releases", () => {
		// A reader on 1.8.0 who updates to 1.10.0 must be told about both
		// releases they missed, not just the newest one.
		expect(owedTo("1.8.0", "1.10.0")).toEqual(["1.10.0", "1.9.0"]);
	});

	it("orders versions numerically, not as text", () => {
		// The reason `compareVersions` is not a string compare: as text,
		// "1.9.0" sorts above "1.10.0", so a reader crossing that boundary
		// would be shown the older release's notes and not the newer one's.
		const owed = owedTo("1.8.0", "1.10.0");
		expect(owed.indexOf("1.10.0")).toBeLessThan(owed.indexOf("1.9.0"));
	});

	it("never shows notes for a release newer than the one running", () => {
		// Notes written for an unreleased version must not greet a reader on an
		// older build; the alternative is describing changes they do not have.
		expect(owedTo(undefined, "1.9.0")).toEqual(["1.9.0", "1.8.0"]);
	});

	it("carries a pre-release forward to the release that supersedes it", () => {
		// A reader on `1.11.0-beta.1` who updates to `1.11.0` is owed the
		// stable release's notes. This is the case that makes the pre-release
		// suffix a *sort* rule rather than a cosmetic one: read as a fourth
		// segment, `beta.1` outranks the bare `1.11.0` and the reader is told
		// there is nothing new on the very release they moved onto.
		//
		// `beta.2` is owed too — it really is newer than a reader who recorded
		// `beta.1` — so the first assertion is that the stable release is
		// present, not that it is alone.
		expect(owedTo("1.11.0-beta.1", "1.11.0")).toContain("1.11.0");
		expect(owedTo("1.11.0-beta.2", "1.11.0")).toEqual(["1.11.0"]);
	});

	it("keeps a pre-release below its own release", () => {
		// The same rule from the other side: a fresh install on a beta must
		// still be shown that beta's notes, and the release it precedes must
		// sort above it rather than swallow it.
		const owed = owedTo(undefined, "1.11.0-beta.2");
		expect(owed).toContain("1.11.0-beta.2");
		expect(owed).toContain("1.11.0-beta.1");
		// `1.11.0` stable is newer than the beta running, so it is not owed yet.
		expect(owed).not.toContain("1.11.0");
	});

	it("does not re-greet a beta a reader has already seen", () => {
		expect(owedTo("1.11.0-beta.2", "1.11.0-beta.2")).toEqual([]);
	});

	it("reads a malformed version as an early one rather than as nothing", () => {
		// A hand-edited `data.json` or manifest can hold anything. The promise
		// `splitVersion` makes is that a non-numeric segment degrades to 0, so
		// `1.x.0` reads as `1.0.0` — an early version, still owed, still shown —
		// rather than producing a NaN comparison, which would make every `> 0`
		// false and swallow every entry, leaving the dialog empty forever.
		const broken = [{ version: "1.x.0", body: "a" }, { version: "1.9.0", body: "b" }];
		// A first install is owed both, the broken one first because it reads older.
		expect(pendingEntries(broken, undefined, "1.10.0").map((e) => e.version)).toEqual(["1.x.0", "1.9.0"]);
		// Already seen as `1.0.0`: the healthy entry is still owed, and the broken
		// one is exactly equal to what was seen, so it is correctly not repeated.
		expect(pendingEntries(broken, "1.0.0", "1.10.0").map((e) => e.version)).toEqual(["1.9.0"]);
	});

	it("keeps the shipped list newest-first", () => {
		// A reader reads this list top to bottom, so each entry has to be newer
		// than the one below it. Expressed through `pendingEntries` rather than
		// a sort of the test's own: with two adjacent entries `newer` and
		// `older`, `owedInShippedList(newer, older)` must come back empty —
		// nothing the reader has not already seen lies between them — and
		// `owedInShippedList(older, newer)` must contain `newer`, the entry they
		// have not. Both halves are needed: the first alone also passes on a
		// reversed list.
		//
		// Vacuous while `WELCOME_ENTRIES` is empty, and deliberately left that
		// way: the loop has nothing to walk, so it cannot fail until a release
		// writes the first entry, which is exactly when the ordering is worth
		// checking.
		const versions = WELCOME_ENTRIES.map((entry) => entry.version);
		for (const [i, newer] of versions.slice(0, -1).entries()) {
			// `slice(0, -1)` guarantees the next index exists; the guard is here
			// because the index type says otherwise.
			const older = versions[i + 1];
			if (older === undefined) continue;
			expect(owedInShippedList(newer, older)).toEqual([]);
			expect(owedInShippedList(older, newer)).toContain(newer);
		}
	});
});
