import { dirname } from "pathe";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createFactory } from "pi-resource-factory";
import { resourceSnapshot } from "./resourceSnapshot";

export interface Skill { name: string; description: string; content: string; filePath: string; disableModelInvocation?: boolean }
export interface PromptTemplate { name: string; description?: string; content: string }
export interface SkillDiagnostic { type: "warning"; code: "file_info_failed" | "list_failed" | "read_failed" | "parse_failed" | "invalid_metadata"; message: string; path: string }
export type PromptTemplateDiagnostic = SkillDiagnostic;

export async function loadSkills(env: ExecutionEnv, paths: string | string[], context: Context): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
	const roots = Array.isArray(paths) ? paths : [paths];
	const snapshot = await resourceSnapshot(env, roots, context);
	const native = createFactory(snapshot.platform);
	const skills: Skill[] = [];
	const diagnostics: SkillDiagnostic[] = [];
	for (const root of roots) {
		const resolved = await env.absolutePath(root, context);
		if (!resolved.ok) { diagnostics.push({ type: "warning", code: "file_info_failed", path: root, message: resolved.error.message }); continue; }
		const loaded = await snapshot.load(() => native.loadSkillsFromDir({ dir: resolved.value, source: "project" }));
		for (const skill of loaded.skills) {
			const { body } = native.parseFrontmatter(snapshot.platform.readFileSync(skill.filePath));
			skills.push({ name: skill.name, description: skill.description, content: body, filePath: skill.filePath, ...(skill.disableModelInvocation ? { disableModelInvocation: true } : {}) });
		}
		diagnostics.push(...loaded.diagnostics.map(diagnostic => ({ type: "warning" as const, code: [...snapshot.errors.values()].some(error => error.message === diagnostic.message) ? "read_failed" as const : /parse|yaml|frontmatter/i.test(diagnostic.message) ? "parse_failed" as const : "invalid_metadata" as const, path: diagnostic.path ?? root, message: diagnostic.message })));
	}
	return { skills, diagnostics };
}

export async function loadSourcedSkills<TSource, TSkill extends Skill = Skill>(env: ExecutionEnv, inputs: Array<{ path: string; source: TSource }>, map: ((skill: Skill, source: TSource, context: Context) => TSkill) | undefined, context: Context) {
	const skills: Array<{ skill: TSkill; source: TSource }> = [];
	const diagnostics: Array<SkillDiagnostic & { source: TSource }> = [];
	for (const input of inputs) {
		const loaded = await loadSkills(env, input.path, context);
		skills.push(...loaded.skills.map(skill => ({ skill: map ? map(skill, input.source, context) : skill as TSkill, source: input.source })));
		diagnostics.push(...loaded.diagnostics.map(diagnostic => ({ ...diagnostic, source: input.source })));
	}
	return { skills, diagnostics };
}

export async function loadPromptTemplates(env: ExecutionEnv, paths: string | string[], context: Context) {
	const roots = Array.isArray(paths) ? paths : [paths];
	const snapshot = await resourceSnapshot(env, roots, context);
	const native = createFactory(snapshot.platform);
	const resolved = await Promise.all(roots.map(path => env.absolutePath(path, context)));
	const loaded = await snapshot.load(() => native.loadPromptTemplates({ cwd: env.cwd, agentDir: "/pi", includeDefaults: false, promptPaths: resolved.flatMap(path => path.ok ? [path.value] : []) }));
	return { promptTemplates: loaded.templates, diagnostics: loaded.diagnostics.map(diagnostic => ({ type: "warning" as const, code: "parse_failed" as const, path: diagnostic.path ?? roots[0] ?? "", message: diagnostic.message })) };
}

const formatting = createFactory({
	constants: { F_OK: 0, R_OK: 4 }, existsSync: () => false,
	readFileSync: () => { throw Object.assign(new Error("Resource loading requires a Vault snapshot"), { code: "ENOENT" }); },
	statSync: () => { throw Object.assign(new Error("Resource loading requires a Vault snapshot"), { code: "ENOENT" }); },
	readdirSync: () => [], realpathSync: (path: string) => path, accessSync: () => {},
});
export const parseCommandArgs = formatting.parseCommandArgs;
export function formatPromptTemplateInvocation(template: PromptTemplate, args: string[] = []): string { return formatting.substituteArgs(template.content, args); }
export function formatSkillsForSystemPrompt(skills: Skill[]): string {
	return formatting.formatSkillsForPrompt(skills.map(skill => ({ ...skill, baseDir: dirname(skill.filePath), disableModelInvocation: skill.disableModelInvocation ?? false, sourceInfo: { path: skill.filePath, baseDir: dirname(skill.filePath), source: "local", scope: "project", origin: "top-level" } })));
}
/** Composer expansion; matches the command block consumed by Piem's transcript. */
export function formatSkillInvocation(skill: Skill, additionalInstructions?: string): string {
	const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${dirname(skill.filePath)}.\n\n${skill.content}\n</skill>`;
	return additionalInstructions ? `${block}\n\n${additionalInstructions}` : block;
}
