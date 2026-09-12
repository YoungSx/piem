import { splitPromptCommand, type CommandEntry } from "../agent/promptTemplates";
import { parseSkillInvocation, type SkillInvocation } from "../agent/skillInvocation";

export type SkillPreview = Pick<SkillInvocation, "name" | "location" | "body">;

export interface ComposerDraft {
	/** The only text the textarea edits. The stored draft remains prefix + text. */
	text: string;
	prefix: string;
	skill?: SkillPreview;
}

/** Pure view of the stored prompt: no parallel selected-skill state. */
export function projectComposerDraft(input: string, commands: readonly CommandEntry[]): ComposerDraft {
	const expanded = parseSkillInvocation(input);
	if (expanded) {
		const prefix = input.slice(0, expanded.promptOffset);
		return { skill: expanded, prefix, text: input.slice(expanded.promptOffset) };
	}
	const command = splitPromptCommand(input);
	// A space completes a typed name; do not fold a prefix the user is still typing.
	if (!command || !/\s$/.test(command.prefix)) return { text: input, prefix: "" };
	const selected = commands.find(entry => entry.kind === "skill" && (
		command.name.startsWith("skill:") ? entry.name === command.name.slice(6) : entry.invocation === command.name
	));
	if (!selected) return { text: input, prefix: "" };
	return { text: command.text, prefix: command.prefix,
		skill: { name: selected.name, location: selected.skill?.filePath ?? "", body: selected.skill?.content ?? selected.description } };
}

/** A bare saved skill expansion needs its native separator when adding a question. */
export function withComposerText(draft: ComposerDraft, text: string): string {
	const separator = draft.prefix && text && !/\s$/.test(draft.prefix) ? "\n\n" : "";
	return draft.prefix + separator + text;
}

/** Keep programmatic writes and completion carets in the same projected space. */
export function syncComposerEditor(editor: HTMLTextAreaElement, input: string, commands: readonly CommandEntry[], cursor = input.length): void {
	const draft = projectComposerDraft(input, commands);
	editor.value = draft.text;
	const offset = Math.max(0, Math.min(draft.text.length, cursor - draft.prefix.length));
	editor.setSelectionRange(offset, offset);
}
