import type { Skill } from "@earendil-works/pi-agent-core";
import type { Translator } from "../i18n";
import efficientWebResearch from "./skills/efficient-web-research/SKILL.md";
import findSkills from "./skills/find-skills/SKILL.md";
import linkGraph from "./skills/link-graph/SKILL.md";
import summarize from "./skills/summarize/SKILL.md";
import tagOrganize from "./skills/tag-organize/SKILL.md";

/**
 * Virtual location used only as provenance in pi's skill metadata.
 *
 * Builtins have no vault file to read: `read_skill` serves their content from
 * memory, while explicit slash invocation injects it through pi's
 * `formatSkillInvocation`. Keeping the location out of `Piem/skills` is
 * deliberate, so bundled defaults never masquerade as or overwrite user files.
 */
const BUILTIN_SKILLS_ROOT = "/__piem_builtin_skills__";

/**
 * Bundled skills available before the user creates any SKILL.md.
 *
 * Bodies live as real `SKILL.md` files (inlined by the bundler's text loader)
 * rather than in the i18n tables: a skill body is a prompt payload read by the
 * agent, not UI copy rendered for a person, and the bilingual fallback machinery
 * bought nothing for it. Only the description — the one line a human sees in
 * slash autocomplete and the settings panel — is translated. Skill bodies are
 * English-only by that same reasoning: the agent reads them, and answers in the
 * user's language regardless of the payload's language.
 */
export function createBuiltinSkills(t: Translator): Skill[] {
	return [
		createSkill("efficient-web-research", t.t("builtinSkills.efficientWebResearch.description"), efficientWebResearch),
		createSkill("find-skills", t.t("builtinSkills.findSkills.description"), findSkills),
		createSkill("link-graph", t.t("builtinSkills.linkGraph.description"), linkGraph),
		createSkill("summarize", t.t("builtinSkills.summarize.description"), summarize),
		createSkill("tag-organize", t.t("builtinSkills.tagOrganize.description"), tagOrganize),
	];
}

function createSkill(name: string, description: string, content: string): Skill {
	return {
		name,
		description,
		content,
		filePath: `${BUILTIN_SKILLS_ROOT}/${name}/SKILL.md`,
	};
}
