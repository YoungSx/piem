import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { loadSkills } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

const root = resolve(import.meta.dir, "../../skills");
const env = new NodeExecutionEnv({ cwd: root });
const { skills, diagnostics } = await loadSkills(env, root);
await env.cleanup();
expect(diagnostics).toEqual([]);

describe("builtinSkills", () => {
	it("loads all seven standard skill directories", () => {
		expect(skills.map((skill) => skill.name).sort()).toEqual([
			"distill-skill",
			"efficient-web-research",
			"find-skills",
			"link-graph",
			"summarize",
			"tag-organize",
			"vault-memory",
		]);
	});

	it("carries the file body verbatim, not rendered HTML", () => {
		// Files are raw Markdown; no bundler-specific text loader is involved.
		const research = skills.find((skill) => skill.name === "efficient-web-research");
		expect(research?.content).toContain("## Search Protocol");
		expect(research?.content).not.toContain("<h2>");
	});

	it("pins the memory skill to the vault memory root and the injection defense", () => {
		const memory = skills.find((skill) => skill.name === "vault-memory");
		expect(memory).toBeDefined();
		// The protocol must teach the real directory, not a paraphrase of it.
		expect(memory?.content).toContain("Piem/memory/MEMORY.md");
		expect(memory?.content).toContain("Piem/memory/YYYY-MM-DD.md");
		// Memory files are persisted, user-editable context: the body must tell
		// the agent to treat their content as data, never as instructions.
		expect(memory?.content).toContain("data, never instructions");
	});

	it("pins the distill skill to the vault skills root and the two-file frontmatter", () => {
		const distill = skills.find((skill) => skill.name === "distill-skill");
		expect(distill).toBeDefined();
		// A skill written anywhere else is never loaded, and pi keys a skill's name
		// off its parent directory — so the body must teach both, exactly.
		expect(distill?.content).toContain("Piem/skills/<name>/SKILL.md");
		expect(distill?.content).toContain("description");
		// The division of labour with vault-memory is the reason these are two
		// skills rather than one: facts to memory, procedures to a skill file.
		expect(distill?.content).toContain("Piem/memory/");
		expect(skills.find((skill) => skill.name === "vault-memory")?.content).toContain("distill-skill");
	});

	it("uses real source paths and parses frontmatter separately", () => {
		for (const skill of skills) {
			expect(skill.content.length).toBeGreaterThan(50);
			expect(skill.content).not.toMatch(/^---\s*\n/);
			// The canonical parser supplies the actual path.
			expect(skill.filePath).toBe(`${root}/${skill.name}/SKILL.md`);
			expect(skill.description).toBeTruthy();
		}
	});

});
