import type { AgentTool, Skill } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { textResult, throwIfAborted } from "./toolResult";

const ReadSkillParameters = Type.Object({
	// Deliberately undescribed. Not a path, so no vault-path rule applies, and the
	// only other constraint — exact name rather than file location — the tool's own
	// description already states. A second copy here would cost bundle bytes to
	// repeat what the model reads immediately above it.
	name: Type.String(),
});

/** Reads the same file snapshot the current prompt lists, across every source. */
export function createReadSkillTool(getSkills: () => readonly Skill[]): AgentTool<typeof ReadSkillParameters> {
	return {
		name: "read_skill",
		label: "Read skill",
		// A lookup in the in-memory skill set — no vault access at all.
		executionMode: "parallel",
		description:
			"Read the complete instructions for a skill listed in <available_skills>. Use the exact skill name instead of reading its location as a vault file.",
		parameters: ReadSkillParameters,
		execute: async (_toolCallId, params, signal) => {
			throwIfAborted(signal);
			const skill = getSkills().find((candidate) => candidate.name === params.name);
			if (!skill) {
				throw new Error(`Unknown skill: ${params.name}`);
			}
			return textResult(skill.content, { name: skill.name, filePath: skill.filePath });
		},
	};
}
