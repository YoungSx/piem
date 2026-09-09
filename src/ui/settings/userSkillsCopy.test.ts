import { describe, expect, it } from "bun:test";
import { getT } from "../../i18n";
import { installObsidianStub } from "../../testUtils/obsidianStub";
installObsidianStub();
const {
	describeUserSkillsDirProblem,
	USER_SKILLS_DIR_PLACEHOLDER,
	userSkillsDirDescription,
	userSkillsSearchedDescription,
} = await import("./userSkillsCopy");
const { searchedReadingBadge } = await import("./badges");

/**
 * This copy is the entire feedback loop for a folder the plugin reads on a
 * machine the panel cannot inspect. A path that resolves somewhere the user did
 * not mean produces no error anywhere — pi's loader treats a missing directory
 * as "no skills here" — so these strings are the only place the mismatch can
 * surface. That is the defect the whole change exists to fix, and it is what
 * these tests pin.
 *
 * The promises are asserted in English, where the wording can be checked
 * literally, and then again in Chinese for the two things the English fallback
 * would hide: that the leaf exists at all, and that counts survive translation.
 */
const en = getT("en");
const zh = getT("zh-cn");

describe("userSkillsDirDescription", () => {
	it("names both accepted spellings, rather than leaving them to a rejection", () => {
		expect(userSkillsDirDescription(en)).toContain("~");
		expect(userSkillsDirDescription(en)).toContain("full path");
	});

	it("says what an empty field does, since empty is an answer and not an omission", () => {
		// Unlike the chat folder, nothing here falls back to a default: the
		// built-in pair simply stays the whole set.
		expect(userSkillsDirDescription(en)).toContain("empty");
	});

	it("keeps both halves in Chinese", () => {
		const copy = userSkillsDirDescription(zh);

		expect(copy).toMatch(/\p{Script=Han}/u);
		expect(copy).toContain("~");
		expect(copy).toContain("留空");
	});
});

describe("describeUserSkillsDirProblem", () => {
	it("says nothing about a usable folder, in either spelling", () => {
		for (const t of [en, zh]) {
			expect(describeUserSkillsDirProblem("~/Documents/skills", t)).toBeUndefined();
			expect(describeUserSkillsDirProblem("/home/me/skills", t)).toBeUndefined();
			expect(describeUserSkillsDirProblem("C:\\Users\\me\\skills", t)).toBeUndefined();
		}
	});

	it("treats an empty field as no extra folder rather than a mistake", () => {
		// The chat folder reverts to a default when emptied, so there an empty
		// field is worth naming. Here it is the shipped state of the setting.
		for (const t of [en, zh]) {
			expect(describeUserSkillsDirProblem("", t)).toBeUndefined();
			expect(describeUserSkillsDirProblem("   ", t)).toBeUndefined();
		}
	});

	it("rejects a relative path and says what is loaded instead, not just the rule", () => {
		// The failure this guards: a reader told "must be absolute" still does not
		// know whether their typed folder is being read.
		const copy = describeUserSkillsDirProblem("skills", en);

		expect(copy).toContain("full path");
		expect(copy).toContain("no extra folder is loaded");
	});

	it("rejects every shape the rules refuse", () => {
		for (const bad of ["skills", "./skills", "../skills", "Documents/skills", "~user/skills", "C:"]) {
			expect(describeUserSkillsDirProblem(bad, en)).toBeDefined();
		}
	});

	it("rejects the same paths in Chinese, with a translated reason", () => {
		for (const bad of ["skills", "./skills", "~user/skills"]) {
			const copy = describeUserSkillsDirProblem(bad, zh);

			expect(copy).toBeDefined();
			expect(copy).toMatch(/\p{Script=Han}/u);
		}
	});

	it("accepts the placeholder it shows, so the example cannot contradict the field", () => {
		for (const t of [en, zh]) {
			expect(describeUserSkillsDirProblem(USER_SKILLS_DIR_PLACEHOLDER, t)).toBeUndefined();
		}
	});
});

describe("userSkillsSearchedDescription", () => {
	it("says an uncreated folder is not a fault, so the list does not read as breakage", () => {
		expect(userSkillsSearchedDescription(en)).toContain("nothing is wrong");
	});

	it("also says a folder that exists should report its skills, which is the actual bug", () => {
		// Reassurance alone would bury the defect this section exists to expose:
		// a folder the user created, going unread, looking exactly like one they
		// never made.
		const copy = userSkillsSearchedDescription(en);

		expect(copy).toContain("did create");
		expect(copy).toContain("not the one you meant");
	});

	it("keeps both halves in Chinese", () => {
		const copy = userSkillsSearchedDescription(zh);

		expect(copy).toMatch(/\p{Script=Han}/u);
		expect(copy).toContain("不是故障");
		expect(copy).toContain("不是你想要的");
	});
});

describe("searchedReadingBadge", () => {
	it("reports a missing folder as a fact, with no verdict attached", () => {
		const { label: copy, tone } = searchedReadingBadge({ found: false, loaded: 0 }, en);

		// The framing lives once, above the list. Repeating it per row would
		// either nag or reassure, and reassurance is what hides the defect.
		expect(copy).toBe("Not found");
		expect(tone).toBe("untested");
		expect(copy.toLowerCase()).not.toContain("error");
		expect(copy.toLowerCase()).not.toContain("wrong");
	});

	it("distinguishes a folder that was read and holds nothing from one that is absent", () => {
		// The case a two-state message would misreport. A user staring at an empty
		// skills list needs to know the folder was reached, because that moves the
		// question from the path to its contents.
		const empty = searchedReadingBadge({ found: true, loaded: 0 }, en).label;
		const missing = searchedReadingBadge({ found: false, loaded: 0 }, en).label;

		expect(empty).not.toBe(missing);
		expect(empty).toBe("Empty");
	});

	it("makes a working folder unmistakable by saying how many skills it gave", () => {
		expect(searchedReadingBadge({ found: true, loaded: 4 }, en)).toEqual({ label: "4 skills", tone: "neutral" });
	});

	it("keeps the singular readable rather than saying 1 skills", () => {
		expect(searchedReadingBadge({ found: true, loaded: 1 }, en).label).toBe("1 skill");
	});

	it("does not report an unchecked folder as absent", () => {
		// found === undefined means the check itself failed — permissions, an
		// unreachable filesystem. Saying "no folder" there would send a reader
		// whose skills exist looking for a mistake in a path that is fine.
		const unknown = searchedReadingBadge({ found: undefined, loaded: 0 }, en);
		const missing = searchedReadingBadge({ found: false, loaded: 0 }, en);

		expect(unknown.label).not.toBe(missing.label);
		expect(unknown).toEqual({ label: "Cannot check", tone: "warn" });
	});

	it("keeps the unknown state distinct in Chinese too", () => {
		const unknown = searchedReadingBadge({ found: undefined, loaded: 0 }, zh).label;

		expect(unknown).toMatch(/\p{Script=Han}/u);
		expect(unknown).not.toBe(searchedReadingBadge({ found: false, loaded: 0 }, zh).label);
	});

	it("keeps the counts intact in Chinese, and still separates the three outcomes", () => {
		const missing = searchedReadingBadge({ found: false, loaded: 0 }, zh).label;
		const empty = searchedReadingBadge({ found: true, loaded: 0 }, zh).label;
		const loaded = searchedReadingBadge({ found: true, loaded: 4 }, zh).label;

		for (const copy of [missing, empty, loaded]) {
			expect(copy).toMatch(/\p{Script=Han}/u);
		}
		expect(new Set([missing, empty, loaded]).size).toBe(3);
		expect(loaded).toContain("4");
		expect(searchedReadingBadge({ found: true, loaded: 1 }, zh).label).toContain("1");
	});
});
