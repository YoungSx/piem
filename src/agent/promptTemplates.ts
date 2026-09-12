import {
	formatPromptTemplateInvocation,
	loadPromptTemplates,
	parseCommandArgs,
	type ExecutionEnv,
	type PromptTemplate,
	type PromptTemplateDiagnostic,
	type Skill,
} from "@earendil-works/pi-agent-core";

/**
 * Prompt-template loading and command parsing, built on pi's native functions.
 *
 * Nothing here touches React, Obsidian, or the agent service: it is a thin,
 * unit-testable layer over `loadPromptTemplates` / `parseCommandArgs` /
 * {@link formatPromptTemplateInvocation}. The service wires the results in;
 * the composer reads the parsed shape to drive autocomplete.
 */

/**
 * Directory inside the vault where user-defined prompt templates live.
 *
 * Visible, not `.piem/prompts`, and the dot path it replaces was not a working
 * feature. Obsidian does not index dot-directories, so `getFolderByPath` — which
 * is what {@link import("../vault/VaultExecutionEnv").VaultExecutionEnv}
 * resolves every path through — returned null for it. pi's loader treats that as
 * `not_found` and skips the path *without a diagnostic*, by design: a missing
 * folder is the ordinary state of a vault that defines no templates. The two
 * behaviours composed into silence. No template ever loaded, no warning was ever
 * produced, and the notice this plugin raised about template warnings was
 * unreachable code.
 *
 * {@link import("./skillLoader").DEFAULT_SKILLS_DIR} reached the same conclusion
 * for skills and moved for the same three reasons, one release earlier: the API
 * cannot read a dot-directory, the user cannot see or edit one from inside
 * Obsidian, and `sessionDir.ts` had already set the precedent for content the
 * user authors. Templates are the same category — hand-written `.md` with
 * frontmatter — and were simply never revisited.
 *
 * Nothing needs migrating. A template under the old path was unreadable, so no
 * vault can be relying on one.
 */
export const VAULT_PROMPT_TEMPLATES_DIR = "/Piem/prompts";

/** One command catalog serves dispatch, completion, and draft skill previews. */
export interface CommandEntry {
	name: string;
	description: string;
	kind: "template" | "skill" | "extension";
	invocation: string;
	/** The already-loaded skill used by dispatch; no second body cache. */
	skill?: Skill;
}

/** Templates plus the diagnostics their loading produced. */
export interface LoadedTemplates {
	templates: PromptTemplate[];
	diagnostics: PromptTemplateDiagnostic[];
}

/**
 * Loads user-defined prompt templates from the vault's `Piem/prompts` folder.
 *
 * A missing folder is not an error: pi's `loadPromptTemplates` skips paths
 * whose `fileInfo` reports `not_found`, so an empty vault simply yields no
 * templates and no diagnostics — the same shape as an empty folder.
 */
export async function loadVaultPromptTemplates(env: ExecutionEnv): Promise<LoadedTemplates> {
	const { promptTemplates, diagnostics } = await loadPromptTemplates(env, VAULT_PROMPT_TEMPLATES_DIR);
	return { templates: promptTemplates, diagnostics };
}

/** A parsed `/name args` invocation, or null when `input` is not a command. */
export interface ParsedPromptCommand {
	/** Command name without the leading `/`. */
	name: string;
	/** Positional arguments, shell-style parsed. */
	args: string[];
	/** The unparsed text after the command name, for skill instructions. */
	additionalInstructions: string;
}

/**
 * Parses a `/name args` command from the start of `input`.
 *
 * Returns null unless `input` begins with `/`, so ordinary messages pass
 * through untouched. The name is the token up to the first whitespace; the rest
 * is split by pi's {@link parseCommandArgs}, which honours single and double
 * quotes — `/echo hello "world foo"` yields `["hello", "world foo"]`.
 *
 * A bare `/` or `/name` with nothing after it still parses, with an empty arg
 * list; whether that is worth acting on is the caller's call, not the parser's.
 */
export function parsePromptCommand(input: string): ParsedPromptCommand | null {
	const parts = splitPromptCommand(input);
	const text = parts?.text.trimStart() ?? "";
	return parts ? { name: parts.name, args: parseCommandArgs(text), additionalInstructions: text } : null;
}

/** Lossless prefix/text split, shared by dispatch and the composer projection. */
export function splitPromptCommand(input: string): { name: string; prefix: string; text: string } | null {
	const match = /^(\s*\/([^\s]*)(?:\s|$))/.exec(input);
	return match ? { name: match[2]!, prefix: match[1]!, text: input.slice(match[1]!.length) } : null;
}

/**
 * Expands a template invocation into the text sent to the model.
 *
 * Thin wrapper over pi's {@link formatPromptTemplateInvocation} so callers do
 * not import the pi surface directly; the expansion is the model-facing prompt
 * body with `$1` / `$@` / `$ARGUMENTS` filled in.
 */
export function expandPromptTemplate(template: PromptTemplate, args: string[]): string {
	return formatPromptTemplateInvocation(template, args);
}

/**
 * Finds the template named by a parsed command, if any.
 *
 * Name matching is exact and case-sensitive, matching how templates are stored:
 * the file name (minus `.md`) is the command name, and file systems the vault
 * adapters front are case-sensitive on Linux and case-insensitive elsewhere —
 * so an exact match keeps behaviour predictable on every host.
 */
export function findPromptTemplate(templates: PromptTemplate[], name: string): PromptTemplate | undefined {
	return templates.find((template) => template.name === name);
}
