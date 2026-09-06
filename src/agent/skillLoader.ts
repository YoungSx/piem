import type { PromptTemplateDiagnostic, SkillDiagnostic, Skill } from "@earendil-works/pi-agent-core";
import { formatSkillInvocation, formatSkillsForSystemPrompt, loadSkills } from "@earendil-works/pi-agent-core";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
// Type-only, and it must stay that way: `../skills/userSkills` reaches the node
// filesystem through `NodeHomeEnv`, and `src/subagent/` is allowed to import
// this module. A value import here would pull a `require` into that bundle.
import type { UserSkillsLoad } from "../skills/userSkills";

/**
 * Folder user-authored skills live in, relative to the vault root.
 *
 * Deliberately visible: Obsidian does not index dot-directories, so the
 * `.piem/skills` location an early sketch pointed at would be unreadable by
 * the vault API {@link loadSkills} drives and invisible to the user — they
 * could not create, edit, or version a skill without leaving the app. The
 * chat logs made the same move once already (`sessionDir.ts`), and skills
 * are the same kind of user-authored content: keep them where the user can
 * open, search, and sync them.
 */
export const DEFAULT_SKILLS_DIR = "Piem/skills";

/**
 * Loads vault-authored skills and folds them into the system prompt.
 *
 * pi's {@link loadSkills} walks the directory recursively for `SKILL.md`
 * files, reads root `.md` files with skill frontmatter, honors ignore files,
 * and reports malformed ones as diagnostics. Missing directories are the
 * ordinary state of a vault that defines no skills: they load as an empty
 * set, which {@link formatSkillsForSystemPrompt} renders as an empty string,
 * so the prompt is byte-identical to the pre-skills constant.
 *
 * Diagnostics are warnings, not failures — a skill with a bad name still
 * loads under its directory name — so they are flattened into one line per
 * problem for the panel's notice banner rather than raised as an error.
 */
export async function loadVaultSkills(
	env: ExecutionEnv,
	skillsDir: string = DEFAULT_SKILLS_DIR,
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
	return loadSkills(env, `/${skillsDir}`);
}

/**
 * Where a merged skill came from.
 *
 * The settings panel splits rows by layer because the layers' consequences
 * differ — a vault row can be opened in the editor, a user-level one only
 * named, a builtin one exists only inside the plugin — so the merge has to
 * record which layer won, not merely emit the winner.
 */
export type SkillSource = "builtin" | "user" | "vault";

/** One merged skill plus the layer it survived from. */
export interface SkillCatalogEntry {
	skill: Skill;
	source: SkillSource;
}

/**
 * {@link mergeSkills} with provenance: the same last-layer-wins merge, but each
 * emitted skill remembers which layer it came from, so a vault skill that
 * overrides a builtin is catalogued as `vault` — and the builtin it replaced
 * does not appear anywhere, matching the prompt listing it fed.
 */
export function mergeSkillsWithSource(...layers: Skill[][]): SkillCatalogEntry[] {
	const emitted = new Set<string>();
	const merged: SkillCatalogEntry[] = [];
	for (let i = 0; i < layers.length; i++) {
		const layer = layers[i];
		if (!layer) {
			continue;
		}
		// Names any later layer claims: this layer's copies are shadowed.
		const overridden = new Set<string>();
		for (let j = i + 1; j < layers.length; j++) {
			const later = layers[j] ?? [];
			for (const skill of later) {
				overridden.add(skill.name);
			}
		}
		for (const skill of layer) {
			if (overridden.has(skill.name) || emitted.has(skill.name)) {
				continue;
			}
			emitted.add(skill.name);
			merged.push({ skill, source: layerIndexToSource(i) });
		}
	}
	return merged;
}

/**
 * Maps a layer's position to its source label. Callers pass layers in the
 * fixed ascending-precedence order — builtins, user-level, vault — so the
 * index is the source; anything past the vault layer is a caller bug and
 * degrades to `vault`, the most user-actionable reading.
 */
function layerIndexToSource(index: number): SkillSource {
	if (index === 0) return "builtin";
	if (index === 1) return "user";
	return "vault";
}

/**
 * Combines skill layers, the last layer winning per name.
 *
 * Layers are passed in ascending precedence — builtins, then user-level, then
 * vault — so a user file can replace a builtin and a vault skill can replace
 * either. This keeps the two-layer contract the plugin already had (vault
 * beats builtin) and slots user-level between them. The winner is emitted at
 * its own layer's position, matching the old behavior where a vault skill that
 * overrode a builtin appeared with the vault set; skills with fresh names keep
 * layer order, so the prompt listing stays stable as layers are added.
 */
export function mergeSkills(...layers: Skill[][]): Skill[] {
	return mergeSkillsWithSource(...layers).map((entry) => entry.skill);
}

/** Exact, case-sensitive lookup, matching prompt-template command routing. */
export function findSkill(skills: Skill[], name: string): Skill | undefined {
	return skills.find((skill) => skill.name === name);
}

/** Injects the complete skill plus the caller's optional extra instruction. */
export function expandSkill(skill: Skill, additionalInstructions?: string): string {
	return formatSkillInvocation(skill, additionalInstructions);
}

/**
 * What one skill load produced, kept split by layer.
 *
 * The layers stay apart all the way to the settings panel because their
 * consequences differ, not merely their location. A vault warning is about a
 * file the user can open from the row beside it; a user-level one is about a
 * folder on the host that only the operating system can explain, and whose
 * message is raw filesystem text. Merging them — which an earlier revision did,
 * joining every message into one string for the chat banner — produced a block
 * of text in which neither kind could be acted on.
 *
 * The user half is the loader's whole return value rather than its diagnostics
 * alone. That is what lets the panel report the folders consulted, the skills
 * that reached the prompt, and the problems from **one** load: the panel used to
 * run its own, and two loads a moment apart can disagree — a network folder that
 * reattaches between them leaves the panel reporting clean while the prompt was
 * built without those skills.
 *
 * Builtins contribute nothing here: they are constants, so only the two layers
 * read off disk can fail.
 */
export interface SkillLoadReport {
	/** Warnings from the vault's own skills folder. */
	vault: SkillDiagnostic[];
	/** The user-level load in full: skills, warnings, and the folders consulted. */
	user: UserSkillsLoad;
	/**
	 * Warnings from the vault's prompt-template folder.
	 *
	 * Here rather than in a report of their own because templates and skills share
	 * the `/name` command namespace, load together on every configuration refresh,
	 * and are reported on as one thing: a reader whose `/weekly` does not resolve
	 * cannot know which kind it was, so a surface that made them guess first would
	 * be the wrong shape. Two separate getters would also let one screen show a
	 * skill report from load N beside a template report from load N±1.
	 *
	 * `PromptTemplateDiagnostic` is structurally identical to
	 * {@link SkillDiagnostic} — same `type`, `code`, `message`, `path`, with a
	 * narrower code union — so one renderer serves both.
	 */
	templates: PromptTemplateDiagnostic[];
}

/**
 * The report before anything has been loaded.
 *
 * Every list empty, `searched` included: no folder has been consulted yet, and a
 * report listing folders would claim a look that never happened — the same
 * distinction {@link UserSkillsSearchEntry.found} draws between "absent" and
 * "nobody asked".
 */
export function emptySkillLoadReport(): SkillLoadReport {
	return { vault: [], user: { skills: [], diagnostics: [], searched: [] }, templates: [] };
}

/**
 * Appends the skill listing to the base system prompt.
 *
 * Kept here rather than at the call site so the base prompt and the skills
 * block have exactly one join point: `formatSkillsForSystemPrompt` returns
 * an empty string for no skills, in which case the base prompt is passed
 * through untouched.
 */
export function composeSystemPrompt(basePrompt: string, skills: readonly Skill[]): string {
	// pi's formatter types its parameter mutable; the copy keeps callers free to
	// hold read-only skill lists (the subagent runner does).
	const formatted = formatSkillsForSystemPrompt([...skills]);
	if (!formatted) {
		return basePrompt;
	}
	return `${basePrompt}\n\n${formatted}\n\nIn Piem, use the read_skill tool with the listed name to read a skill's complete instructions. Do not pass a skill location to the vault read tool.`;
}
