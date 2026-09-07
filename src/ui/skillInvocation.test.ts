import { describe, expect, it } from "bun:test";
import { parseSkillInvocation } from "./skillInvocation";

describe("parseSkillInvocation", () => {
	it("parses a bare expansion", () => {
		const parsed = parseSkillInvocation('<skill name="nlm-skill" location="C:\\skills\\nlm\\SKILL.md">\nReferences are relative to C:\\skills\\nlm.\n\nBody text.\n</skill>');
		expect(parsed).not.toBeNull();
		expect(parsed?.name).toBe("nlm-skill");
		// The formatter pads the body with its "References are relative to" line;
		// the pill shows whatever sits between the tags, padding included.
		expect(parsed?.body).toBe("References are relative to C:\\skills\\nlm.\n\nBody text.");
		expect(parsed?.trailing).toBe("");
	});

	it("keeps additional instructions outside the pill", () => {
		const text = '<skill name="a" location="/x/SKILL.md">\n\nBody.\n</skill>\n\nNow check the wording please';
		const parsed = parseSkillInvocation(text);
		expect(parsed?.name).toBe("a");
		expect(parsed?.trailing).toBe("Now check the wording please");
	});

	it("splits on the last closing tag when the body quotes one", () => {
		const text = '<skill name="a" location="/x">\n\nExample: </skill> inside docs.\n</skill>\n\nafter';
		const parsed = parseSkillInvocation(text);
		expect(parsed?.body).toBe("Example: </skill> inside docs.");
		expect(parsed?.trailing).toBe("after");
	});

	it("rejects text that merely mentions the tag later", () => {
		expect(parseSkillInvocation("hello world </skill>")).toBeNull();
		expect(parseSkillInvocation("see <skill name=\"x\"> doc")).toBeNull();
	});

	it("rejects an unclosed opening tag", () => {
		expect(parseSkillInvocation('<skill name="a" location="/x">\nbody without close')).toBeNull();
	});

	it("rejects a missing location attribute", () => {
		expect(parseSkillInvocation('<skill name="a">\nbody\n</skill>')).toBeNull();
	});

	it("rejects a missing name attribute", () => {
		expect(parseSkillInvocation('<skill location="/x">\nbody\n</skill>')).toBeNull();
	});

	it("trims the trailing run to prose", () => {
		const text = '<skill name="a" location="/x">\nbody\n</skill>\n\n   ';
		expect(parseSkillInvocation(text)?.trailing).toBe("");
	});

	it("keeps internal newlines in the body verbatim", () => {
		const body = "# Title\n\n- one\n- two";
		const parsed = parseSkillInvocation(`<skill name="a" location="/x">\n\n${body}\n</skill>`);
		expect(parsed?.body).toBe(body);
	});
});
