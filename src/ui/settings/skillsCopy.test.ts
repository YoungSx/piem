import { describe, expect, it } from "bun:test";
import type { PromptTemplateDiagnostic, SkillDiagnostic } from "@earendil-works/pi-agent-core";
import { getT } from "../../i18n";
import {
	countSkillProblems,
	describeSkillReload,
	skillProblemRow,
	userSkillProblemsCopy,
	vaultSkillProblemsCopy,
} from "./skillsCopy";
import { emptySkillLoadReport, type SkillLoadReport } from "../../agent/skillLoader";

/**
 * These strings are what stands between a raw errno and a reader who concludes
 * the plugin is broken.
 *
 * The text they frame is not ours: pi's parser output, and for the user-level
 * layer the host filesystem's verbatim message — the reported case being
 * `EACCES: permission denied, realpath 'C:\Users\shang\.agents\skills\…'`. That
 * line used to ride the chat panel's banner on every send. Moving it to the tab
 * that owns those files is half the fix; these frames are the other half, and
 * the promises below are the ones that make an unexplained machine error read as
 * a report about a folder instead of a crash.
 *
 * English is asserted literally, then Chinese for the two things the English
 * fallback would hide: that the leaf exists at all, and that the phrase carrying
 * the "this is the machine talking" framing survived translation.
 */
const en = getT("en");
const zh = getT("zh-cn");

/**
 * A report with the given problem counts, and nothing else worth varying.
 *
 * `file_info_failed` is deliberate: it is the one code both diagnostic unions
 * share, so a single factory serves the skill layers and the template layer.
 */
function report(vault: number, user: number, templates = 0): SkillLoadReport {
	const diagnostic = (index: number): SkillDiagnostic & PromptTemplateDiagnostic => ({
		type: "warning",
		code: "file_info_failed",
		message: `problem ${index}`,
		path: `/path/${index}`,
	});
	return {
		...emptySkillLoadReport(),
		vault: Array.from({ length: vault }, (_, index) => diagnostic(index)),
		user: {
			skills: [],
			diagnostics: Array.from({ length: user }, (_, index) => diagnostic(index)),
			searched: [],
		},
		templates: Array.from({ length: templates }, (_, index) => diagnostic(index)),
	};
}

describe("vaultSkillProblemsCopy", () => {
	it("states the consequence, not only that the files failed", () => {
		// A parser message says what is wrong with a file and stops. The half it
		// never states is what the reader lost: the skill is missing from the list
		// they were just looking at.
		const { description } = vaultSkillProblemsCopy(en);

		expect(description).toContain("missing from the list above");
	});

	it("keeps one bad file from implying the rest are suspect", () => {
		expect(vaultSkillProblemsCopy(en).description).toContain("Every other skill loaded normally");
	});

	it("does not call the files broken", () => {
		// pi rejects a SKILL.md for reasons that are ordinary editing states — a
		// description not yet written, most of all. "Broken" would be a verdict on
		// work in progress.
		const copy = vaultSkillProblemsCopy(en);

		expect(`${copy.heading} ${copy.description}`.toLowerCase()).not.toContain("broken");
	});

	it("carries both halves in Chinese", () => {
		const { heading, description } = vaultSkillProblemsCopy(zh);

		expect(heading).toMatch(/\p{Script=Han}/u);
		expect(description).toContain("上面的列表里没有它们");
		expect(description).toContain("其余技能都正常加载了");
	});
});

describe("userSkillProblemsCopy", () => {
	it("says the words below are the filesystem's own", () => {
		// The single most important clause in this module. Without it, an errno
		// under a Piem heading is unexplained text that reads as our own failure,
		// and the reader stops looking at the folder that is actually unreadable.
		expect(userSkillProblemsCopy(en).description).toContain("in its own words");
	});

	it("states the consequence and spares the folders that worked", () => {
		const { description } = userSkillProblemsCopy(en);

		expect(description).toContain("not loaded");
		expect(description).toContain("unaffected");
	});

	it("keeps the machine-is-talking framing in Chinese", () => {
		// 「原样返回」 is what licenses a raw English error string on a Chinese
		// screen. Dropped in translation, the Chinese reader is left with foreign
		// text and no reason to read it as anything but a malfunction.
		const { description } = userSkillProblemsCopy(zh);

		expect(description).toContain("原样返回");
		expect(description).toContain("不受影响");
	});
});

describe("describeSkillReload", () => {
	it("confirms a clean reload, which changes nothing on screen", () => {
		// The verdict is required rather than decorative: with no problems, the
		// lists stay empty and every row redraws identically, so silence is
		// indistinguishable from a button that does not work.
		const copy = describeSkillReload(report(0, 0), en);

		expect(copy).toContain("nothing was wrong");
		expect(describeSkillReload(report(0, 0), zh)).toContain("没有发现问题");
	});

	it("reports problems without restating them", () => {
		// They are already listed under the section each belongs to, with the path
		// beside the message. A count in a toast that vanishes is the less useful
		// copy, and naming paths there invites memorising instead of scrolling.
		const copy = describeSkillReload(report(1, 2), en);

		expect(copy).toContain("listed with each section");
		expect(copy).not.toContain("problem 0");
		expect(copy).not.toContain("/path/0");
	});

	it("treats either layer alone as a problem", () => {
		const clean = describeSkillReload(report(0, 0), en);

		expect(describeSkillReload(report(1, 0), en)).not.toBe(clean);
		expect(describeSkillReload(report(0, 1), en)).not.toBe(clean);
	});
});

describe("countSkillProblems", () => {
	it("sums both layers", () => {
		expect(countSkillProblems(report(0, 0))).toBe(0);
		expect(countSkillProblems(report(2, 3))).toBe(5);
	});
});

describe("skillProblemRow", () => {
	it("keeps path and message apart, because they can name different things", () => {
		// pi substitutes the pre-canonicalization path into a diagnostic while the
		// message embeds the resolved one, so for a symlinked skill folder the path
		// is the link the user made and the message names the target that could not
		// be read. Comparing the two is the whole diagnosis; a join destroys it.
		const row = skillProblemRow({
			type: "warning",
			code: "file_info_failed",
			message: "EACCES: permission denied, realpath 'C:\\Users\\shang\\.agents\\skills\\superpowers'",
			path: "~/.agents/skills/superpowers",
		});

		expect(row.path).toBe("~/.agents/skills/superpowers");
		expect(row.message).toContain("C:\\Users\\shang");
	});

	it("does not surface the diagnostic code", () => {
		// A jargon token with no consequence attached. It goes to the log, where a
		// bug report gets assembled, not to a settings row.
		const row = skillProblemRow({ type: "warning", code: "list_failed", message: "could not list", path: "/a" });

		expect(JSON.stringify(row)).not.toContain("list_failed");
	});
});
