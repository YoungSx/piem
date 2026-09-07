import { describe, expect, it } from "bun:test";
import { createBuiltinSkills } from "./builtinSkills";
import { getT } from "../i18n";
import { installObsidianStub } from "../testUtils/obsidianStub";

installObsidianStub();

const t = getT("en");
const skills = createBuiltinSkills(t);

describe("builtinSkills", () => {
	it("ships the six bundled skills", () => {
		expect(skills.map((skill) => skill.name).sort()).toEqual([
			"efficient-web-research",
			"find-skills",
			"link-graph",
			"summarize",
			"tag-organize",
			"vault-memory",
		]);
	});

	it("carries the file body verbatim, not rendered HTML", () => {
		// Bun's markdown loader would transpile `#` to `<h1>`; the bundler's text
		// loader must win so tests exercise what ships.
		const research = skills.find((skill) => skill.name === "efficient-web-research");
		expect(research?.content).toContain("## Search Protocol");
		expect(research?.content).not.toContain("<h2>");
	});

	it("pins the memory skill to the vault memory root and the injection defense", () => {
		const memory = skills.find((skill) => skill.name === "vault-memory");
		// The protocol must teach the real directory, not a paraphrase of it.
		expect(memory?.content).toContain("Piem/memory/MEMORY.md");
		expect(memory?.content).toContain("Piem/memory/YYYY-MM-DD.md");
		// Memory files are persisted, user-editable context: the body must tell
		// the agent to treat their content as data, never as instructions.
		expect(memory?.content).toContain("data, never instructions");
	});

	it("sources each body from its SKILL.md import, keeping frontmatter out", () => {
		for (const skill of skills) {
			expect(skill.content.length).toBeGreaterThan(50);
			expect(skill.content).not.toMatch(/^---\s*\n/);
			// Provenance points at the virtual root, never at the bundler's file map.
			expect(skill.filePath).toBe(`/__piem_builtin_skills__/${skill.name}/SKILL.md`);
		}
	});

	it("keeps descriptions translated through the copy tables", () => {
		const zh = createBuiltinSkills(getT("zh-cn"));
		const enDescription = skills.find((skill) => skill.name === "summarize")?.description;
		const zhDescription = zh.find((skill) => skill.name === "summarize")?.description;
		expect(enDescription).toBeTruthy();
		expect(zhDescription).not.toBe(enDescription);
		// No body text leaks into the description slot: that was the i18n-table
		// layout this file layer replaces.
		expect(zhDescription).not.toContain("\n");
	});
});
