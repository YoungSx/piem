/**
 * mode.ts — what `codemode` is doing, vault-wide.
 *
 * The vocabulary is three values rather than a boolean because the three answers
 * are not a spectrum: `off` is the tool's absence, `on` leaves every tool callable
 * and teaches the model the script path, and `only` makes the script the only
 * path. `/codemode` moves between them, so they need names a reader can type.
 *
 * There is one source of truth: the vault settings. The settings page and
 * `/codemode` are two surfaces over the same two fields, so a mode change is
 * global — every conversation, including the one that asked, reads the same
 * answer on its next request.
 */
export type CodemodeSessionMode = "off" | "on" | "only";

/** What one `/codemode` invocation asks for. */
export type CodemodeDirective =
	| { kind: "report" }
	| { kind: "set"; mode: CodemodeSessionMode }
	/** An argument that is not one of the words. Distinct from `report`, because
	 *  silently ignoring `only` and reporting success would leave the reader
	 *  believing a mode they did not ask for. */
	| { kind: "unknown"; argument: string };

/**
 * Whether a stored or DOM-sourced value names a mode. The settings reader and
 * the settings page both validate with this rather than restating the three
 * words, so a mode added here is accepted everywhere at once.
 */
export function isCodemodeSessionMode(value: unknown): value is CodemodeSessionMode {
	return value === "off" || value === "on" || value === "only";
}

const ARGUMENTS: Record<string, CodemodeSessionMode> = {
	on: "on",
	both: "on",
	only: "only",
	scripts: "only",
	off: "off",
	none: "off",
};

/**
 * Parses `/codemode`'s argument.
 *
 * No argument means *report*, not *guess*: a reader who typed `/codemode` wants
 * to know where things stand, and a command that changed something in
 * answer to a question would be the wrong kind of surprise.
 */
export function parseCodemodeArgument(argument: string | undefined): CodemodeDirective {
	const word = argument?.trim().toLowerCase();
	if (!word) return { kind: "report" };
	const mode = ARGUMENTS[word];
	return mode ? { kind: "set", mode } : { kind: "unknown", argument: word };
}
