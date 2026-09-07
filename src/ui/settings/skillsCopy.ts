import type { SkillDiagnostic } from "@earendil-works/pi-agent-core";
import type { Translator } from "../../i18n";
import type { SkillRow } from "../../skills/skillManager";
import type { SkillLoadReport } from "../../agent/skillLoader";

/**
 * Wording for the Skills tab's problem reports and its Reload verdict.
 *
 * This copy exists because of where the text under it comes from. The messages
 * these strings frame are not the plugin's own prose — they are pi's parser
 * output and, for the user-level layer, the host filesystem's verbatim errno
 * text: `EACCES: permission denied, realpath 'C:\Users\…\.agents\skills\…'`.
 * That line used to appear in the chat panel's banner, once per message sent,
 * next to no control that could act on it. Moving it here is only half the fix.
 * The other half is these strings, because a raw errno rendered under no heading
 * reads as the plugin crashing, and a reader who concludes that stops looking at
 * the folder that is actually broken.
 *
 * So the frames carry three things the machine's own text never does: that the
 * words below are the operating system's and not ours, what the consequence is
 * (those skills are not loaded), and that nothing else was affected. The last is
 * not padding — one unreadable folder in a list of three otherwise makes the
 * whole report look untrustworthy.
 *
 * Split into a module for the same reason
 * {@link import("./userSkillsCopy")} is: the promises above are testable and the
 * panel is not. Every function takes the {@link Translator}, so the language
 * stays the caller's decision and both tables are reachable through one entry
 * point.
 */

/** Heading and framing for one list of load problems. */
export interface SkillProblemsCopy {
	/** Names what the list is, in the plugin's own voice. */
	heading: string;
	/** Where the text came from, what it cost, and what it did not affect. */
	description: string;
}

/**
 * Framing for the vault layer's problems.
 *
 * Deliberately does not claim the files are broken — pi rejects a `SKILL.md`
 * for reasons that are ordinary editing states, a description not yet written
 * most of all. It states what happened (found, not readable as a skill) and the
 * consequence (missing from the list above), which together are what let a
 * reader go and fix it.
 */
export function vaultSkillProblemsCopy(t: Translator): SkillProblemsCopy {
	return { heading: t.t("skills.problemsHeading"), description: t.t("skills.problemsDesc") };
}

/**
 * Framing for the user-level layer's problems.
 *
 * Says out loud that the text below is the filesystem's own. That phrase is the
 * one doing the work: without it, an errno on a Chinese-language screen is
 * unexplained foreign text under a Piem heading, which reads as our bug rather
 * than as the report of a folder the operating system refused.
 */
export function userSkillProblemsCopy(t: Translator): SkillProblemsCopy {
	return { heading: t.t("skills.userProblemsHeading"), description: t.t("skills.userProblemsDesc") };
}

/**
 * What to say after a reload finished.
 *
 * A verdict is required rather than nice: a clean reload changes nothing on
 * screen — the problem lists stay empty and every row redraws identically — so
 * without a message the button is indistinguishable from a broken one. A reload
 * that returns the *same* problems is worse, because nothing moves at all.
 *
 * The problem case does not restate the problems. They are already listed under
 * the section each belongs to, with the path beside the message; a count in a
 * toast that disappears would be the less useful of the two copies, and naming
 * paths in a transient message invites the reader to memorise instead of scroll.
 */
export function describeSkillReload(report: SkillLoadReport, t: Translator): string {
	return countSkillProblems(report) === 0 ? t.t("skills.reloadClean") : t.t("skills.reloadProblems");
}

/**
 * Problems across both layers.
 *
 * Summed rather than reported per layer because every caller asks the same
 * yes-or-no question — did this load have anything to report — and a caller that
 * needs the split reads {@link SkillLoadReport} directly.
 */
export function countSkillProblems(report: SkillLoadReport): number {
	return report.vault.length + report.user.diagnostics.length;
}

/**
 * The two halves of one problem row, in reading order.
 *
 * Kept as a pair rather than joined into a sentence because they can name
 * different things, and the difference is the information: pi substitutes the
 * *pre-canonicalization* path into a diagnostic while the message embeds the
 * resolved one, so for a symlinked skill folder the path is the link the user
 * created and the message names the target that could not be read. A reader
 * comparing "what I pointed at" with "what was actually touched" needs both;
 * a join throws that away, and joining every message into one paragraph — which
 * is what the panel used to do — throws away even the pairing.
 */
export function skillProblemRow(diagnostic: SkillDiagnostic): { path: string; message: string } {
	return { path: diagnostic.path, message: diagnostic.message };
}

/** Keep the imported source URL selectable below the provenance badge. */
export function describeSkillRow(row: SkillRow): string | undefined {
	return row.provenance?.url;
}
