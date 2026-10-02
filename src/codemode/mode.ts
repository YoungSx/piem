/**
 * mode.ts — what `codemode` is doing in a given conversation.
 *
 * The vocabulary is three values rather than a boolean because the three answers
 * are not a spectrum: `off` is the tool's absence, `on` leaves every tool callable
 * and teaches the model the script path, and `only` makes the script the only
 * path. `/codemode` moves between them, so they need names a reader can type.
 */
export type CodemodeSessionMode = "off" | "on" | "only";

/** What the vault setting asks for, before a conversation has an opinion. */
export type CodemodeVaultMode = "on" | "only";

/** What one `/codemode` invocation asks for. */
export type CodemodeDirective =
	| { kind: "report" }
	/** Drop the override and follow the vault setting again. */
	| { kind: "follow-vault" }
	| { kind: "set"; mode: CodemodeSessionMode }
	/** An argument that is not one of the words. Distinct from `report`, because
	 *  silently ignoring `only` and reporting success would leave the reader
	 *  believing a mode they did not ask for. */
	| { kind: "unknown"; argument: string };

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
 * to know where the conversation stands, and a command that changed something in
 * answer to a question would be the wrong kind of surprise.
 */
export function parseCodemodeArgument(argument: string | undefined): CodemodeDirective {
	const word = argument?.trim().toLowerCase();
	if (!word) return { kind: "report" };
	if (word === "vault" || word === "settings") return { kind: "follow-vault" };
	const mode = ARGUMENTS[word];
	return mode ? { kind: "set", mode } : { kind: "unknown", argument: word };
}

/** The words shown in the composer's help, in the order a reader would try them. */
export const CODEMODE_ARGUMENTS = ["on", "only", "off", "vault"] as const;
