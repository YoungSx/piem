import type { AgentTool, Skill } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { throwIfAborted } from "./toolResult";
import { skillContentPage, type SkillContentDetails } from "../skills/skillContent";
import { readSkillResource } from "../skills/skillResources";

const ReadSkillParameters = Type.Object({
	name: Type.String(),
	path: Type.Optional(Type.String({ description: "Supporting UTF-8 text resource relative to this skill directory, up to 1 MiB. No absolute paths, hidden paths or '..'; symlinks must stay inside the directory. Omit for the skill instructions." })),
	offset: Type.Optional(Type.Integer({ minimum: 0, description: "Byte offset returned by the previous page. Omit or use 0 to begin. Each page contains up to 50 KiB without splitting a UTF-8 character." })),
	snapshot: Type.Optional(Type.String({ description: "Content snapshot returned by read_skill; required with a continuation offset. If the content changed, restart at offset 0." })),
});

/** Reads the same file snapshot the current prompt lists, across every source. */
export function createReadSkillTool(getSkills: () => readonly Skill[]): AgentTool<typeof ReadSkillParameters, SkillContentDetails> {
	return {
		name: "read_skill",
		label: "Read skill",
		executionMode: "parallel",
		description:
			"Read instructions for a skill listed in <available_skills>, or a referenced text file inside its directory. Use the exact skill name. Read every continuation page before following the instructions. Resources are read on demand and never executed.",
		parameters: ReadSkillParameters,
		execute: async (_toolCallId, params, signal) => {
			throwIfAborted(signal);
			const skill = getSkills().find((candidate) => candidate.name === params.name);
			if (!skill) {
				throw new Error(`Unknown skill: ${params.name}`);
			}
			const resource = params.path === undefined ? undefined : await readSkillResource(skill, params.path, signal);
			const result = await skillContentPage(resource?.text ?? skill.content, {
				name: skill.name,
				filePath: resource?.filePath ?? skill.filePath,
				...(params.path === undefined ? {} : { resource: params.path }),
			}, params);
			throwIfAborted(signal);
			return result;
		},
	};
}
