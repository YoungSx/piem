import type { PromptTemplate } from "../skills/piResources";

/**
 * Prompt templates shipped with the plugin.
 *
 * These are plain constants, not run through `loadPromptTemplates`: the loader
 * reads files from an {@link ExecutionEnv}, and the vault env has no writable
 * temp space to stage builtins in. Constants are simpler, need no diagnostics,
 * and keep the builtin set auditable in one place. The vault's own
 * `Piem/prompts` folder is where user-defined templates live; builtins are the
 * floor that ships regardless.
 *
 * Template `content` is the English prompt sent to the model, not UI copy — it
 * does not go through i18n. A user who wants it in another language defines
 * their own in `Piem/prompts`.
 */
export const BUILTIN_PROMPT_TEMPLATES: PromptTemplate[] = [
	{
		name: "summarize",
		description: "Summarize the active note concisely.",
		content: "Summarize the active note concisely. $ARGUMENTS",
	},
];
