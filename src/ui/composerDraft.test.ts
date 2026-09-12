import { describe, expect, it } from "bun:test";
import { projectComposerDraft, withComposerText } from "./composerDraft";
import { parsePromptCommand, type CommandEntry } from "../agent/promptTemplates";
import { parseSkillInvocation } from "../agent/skillInvocation";

const skill = { name: "review", description: "Review notes", content: "Look for gaps.", filePath: "/Piem/skills/review/SKILL.md" };
const commands: CommandEntry[] = [
	{ name: "review", invocation: "review", kind: "template", description: "Template" },
	{ name: "review", invocation: "skill:review", kind: "skill", description: skill.description, skill },
];

describe("composer draft projection", () => {
	it("uses the dispatch catalog without folding incomplete, unknown or shadowing commands", () => {
		for (const text of ["/review question", "/skill:review", "/missing question", "A plain /review mention"]) {
			expect(projectComposerDraft(text, commands)).toEqual({ text, prefix: "" });
		}
		const raw = "  /skill:review  保留空格\n继续";
		const draft = projectComposerDraft(raw, commands);
		expect(draft.skill).toEqual({ name: skill.name, location: skill.filePath, body: skill.content });
		expect(draft.text).toBe(" 保留空格\n继续");
		expect(withComposerText(draft, draft.text)).toBe(raw);
		expect(parsePromptCommand(withComposerText(draft, "New question"))?.name).toBe("skill:review");
	});

	it("keeps the exact skill wrapper when editing a restored question", () => {
		const wrapper = '<skill name="old" location="/old/SKILL.md">\nFrozen body.\n</skill>';
		for (const raw of [wrapper, wrapper + "\n\n  Existing question  "]) {
			const draft = projectComposerDraft(raw, commands);
			expect(draft.skill?.body).toBe("Frozen body.");
			expect(withComposerText(draft, draft.text)).toBe(raw);
			expect(parseSkillInvocation(withComposerText(draft, "Edited question"))?.trailing).toBe("Edited question");
		}
	});
});
