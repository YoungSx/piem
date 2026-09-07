/**
 * Reading a skill invocation back out of a user turn.
 *
 * `/name` never reaches the transcript as typed: `expandSkill` replaces it with
 * pi-agent-core's `formatSkillInvocation` output — the whole SKILL.md wrapped in
 * `<skill name="…" location="…">` — and *that* is what the user message carries.
 * The pill folds it back to a one-line chip; this module is the fold's eyes.
 *
 * Parsing is render-side and best-effort by design. The tag shape belongs to the
 * upstream package, so the parse is pinned to exactly what today's formatter
 * emits and anything else — a future format change, a hand-typed look-alike that
 * doesn't quite match — falls through to the plain text the transcript has always
 * drawn. A failed fold costs nothing.
 */

/** One folded skill expansion, split into what the pill shows and what stays out. */
export interface SkillInvocation {
	/** The skill's own name, from the tag's `name` attribute. */
	name: string;
	/** The path the tag records; surfaced only in the pill's title, if at all. */
	location: string;
	/** The SKILL.md body between the tags, trimmed of the formatter's padding. */
	body: string;
	/**
	 * The user's own words after the closing tag — `/skill:name plus this` keeps
	 * `plus this` visible as ordinary prose, never folded into the pill.
	 */
	trailing: string;
}

const OPENER = /^<skill name="([^"]*)" location="([^"]*)">\n/;
const CLOSER = "\n</skill>";

/**
 * Splits a user text block into a skill invocation and its remainder, or `null`
 * when the text is not one.
 *
 * The split point is the *last* `\n</skill>` whose remainder is either empty or
 * starts with the blank line that separates additional instructions — the shape
 * the formatter always emits. Taking the last such occurrence is what lets a
 * SKILL.md that documents the tag itself (a fenced example, say) still fold
 * whole: its own earlier `</skill>` is followed by more body, not by the end or
 * the instruction break, so it never qualifies as the split.
 */
export function parseSkillInvocation(text: string): SkillInvocation | null {
	const opener = OPENER.exec(text);
	if (!opener) {
		return null;
	}
	const name = opener[1] ?? "";
	const location = opener[2] ?? "";
	const rest = text.slice(opener[0].length);
	let cut = -1;
	let from = 0;
	for (;;) {
		const found = rest.indexOf(CLOSER, from);
		if (found === -1) {
			break;
		}
		const after = rest.slice(found + CLOSER.length);
		if (after === "" || after.startsWith("\n\n")) {
			cut = found;
		}
		from = found + 1;
	}
	if (cut === -1) {
		return null;
	}
	return {
		name,
		location,
		body: rest.slice(0, cut).trim(),
		trailing: rest.slice(cut + CLOSER.length).trim(),
	};
}
