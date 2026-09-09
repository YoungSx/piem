import { describe, expect, it } from "bun:test";
import { createReadSkillTool } from "./skillTools";

describe("read_skill", () => {
	const skill = {
		name: "summarize",
		description: "Summarize a note",
		content: "Read the active note, then summarize it.",
		filePath: "/Piem/builtin-skills/summarize/SKILL.md",
	};

	it("returns the complete loaded content from the loaded file snapshot", async () => {
		const result = await createReadSkillTool(() => [skill]).execute("call-1", { name: "summarize" });

		const content = result.content[0];
		expect(content?.type).toBe("text");
		expect(content?.type === "text" ? content.text : undefined).toBe(skill.content);
		expect(result.details).toEqual({ name: "summarize", filePath: skill.filePath });
	});

	it("rejects a name that is not in the current loaded set", async () => {
		expect(createReadSkillTool(() => [skill]).execute("call-1", { name: "missing" })).rejects.toThrow("Unknown skill: missing");
	});
});
