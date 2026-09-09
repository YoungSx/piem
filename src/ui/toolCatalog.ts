import type { IconName } from "obsidian";
import type { Translator } from "../i18n";

/**
 * A dotted path into the copy tree.
 *
 * Derived from the translator rather than spelled as a string, so a mistyped
 * key in the table below fails the build instead of rendering the key itself.
 * Same local alias `traceFold.ts` takes for the same reason.
 */
type CopyKey = Parameters<Translator["t"]>[0];

/**
 * Everything the transcript needs to know about a tool, in one table.
 *
 * There used to be two: a copy table in `traceSummary.ts` and a category table
 * in `traceFold.ts`, each keyed on the same tool ids. Twenty-six ids written
 * twice is twenty-six chances to write them once — and the failure was silent
 * both ways round, because every lookup falls back to something plausible. A
 * tool missing from the copy table renders as a monospace `spawn_subagent`; a
 * tool missing from the category table lands in `other` and quietly stops being
 * counted as the write it was. Neither shows up as a broken build.
 *
 * So the ids live here once, and the three surfaces that ask about a tool —
 * its name, its fold category, its glyph — each read one column.
 * `toolCatalog.test.ts` builds the real tool sets and asserts every id in them
 * is present, which is what makes "the table has not been taught this tool" a
 * red test rather than a degraded row.
 *
 * Free of React and DOM imports so the rules stay unit-testable without a
 * renderer; `IconName` is a type-only import and erases at compile time.
 */

/**
 * What kind of work a tool does, in the reader's terms.
 *
 * Deliberately coarser than the tool list: the fold line exists to be skimmed,
 * and a category per tool would just re-list the rows it replaced. `other` is
 * the honest bucket — an MCP tool this build has never seen, a screen tool, a
 * task query — and it is a real answer rather than a gap: `read_skill` belongs
 * there because a skill is not a note, so folding it into "read 5 notes" would
 * be a miscount rather than a summary.
 */
export type ToolCategory = "write" | "web" | "subagent" | "read" | "search" | "other";

/** The three things a transcript row asks about the tool it is drawing. */
export interface ToolFacts {
	/** i18n key for the reader-facing name. */
	copyKey: CopyKey;
	/** Which bucket a folded run counts this tool toward. */
	category: ToolCategory;
	/**
	 * The glyph a settled, successful row wears.
	 *
	 * Only that row: a call still running shows a spinner and a failed one shows
	 * the warning triangle, because "still going" and "it broke" are worth the
	 * icon slot in a way that "it worked" never was — the row already says
	 * "Wrote a note", so a tick beside those words is the same fact twice while
	 * *which kind of work* goes unsaid.
	 */
	icon: IconName;
}

/**
 * The tool table.
 *
 * Icon choices worth their reasoning, since the rest are self-evident:
 *
 * - `eye` covers both tools that read a note's body — the whole content, and
 *   whatever the user currently has open. Reading prose is what an eye does,
 *   and the pair sharing one glyph is the point: their rows differ in the
 *   sentence beside it ("Read a note" / "Checked the open note"), not in what
 *   kind of act they were. The tools that read a note's *structure* rather than
 *   its words keep their own glyphs (`link`, `table-properties`), which is the
 *   line worth drawing here.
 *
 * - The three ways of looking for something are three visibly different
 *   glyphs, because the reader's question is which one ran: `folder-open` for
 *   listing one folder, `file-search` for hunting by filename, `text-search`
 *   for hunting inside the prose. Their copy already distinguished them; the
 *   glyphs did not.
 *
 * - `open_note` wears `panel-top` — a tab: a bar across the top with content
 *   under it. That is literally what the tool does (`getLeaf("tab")`, or
 *   `revealLeaf` on the tab already holding the note). The obvious pick,
 *   `external-link`, is wrong twice over: nothing here is a link, and nothing
 *   leaves Obsidian.
 *
 * - `open_side_panel` wears the side-neutral `columns-2` rather than a
 *   `panel-right`, because it opens on either side: vault search defaults to
 *   the left, backlinks and outgoing links to the right, and the caller can
 *   override any of them. A glyph naming one side would be wrong half the time.
 */
export const TOOL_CATALOG: Readonly<Record<string, ToolFacts>> = {
	// Reading a note.
	read: { copyKey: "traceTool.read", category: "read", icon: "eye" },
	get_active_note: { copyKey: "traceTool.getActiveNote", category: "read", icon: "eye" },
	get_note_links: { copyKey: "traceTool.noteLinks", category: "read", icon: "link" },
	get_note_metadata: { copyKey: "traceTool.noteMetadata", category: "read", icon: "table-properties" },

	// Looking for a note.
	ls: { copyKey: "traceTool.ls", category: "search", icon: "folder-open" },
	find: { copyKey: "traceTool.find", category: "search", icon: "file-search" },
	grep: { copyKey: "traceTool.grep", category: "search", icon: "text-search" },

	// Changing the vault. `insert_at_cursor` rides the editor rather than the
	// vault API, which is why the plugin files it with the screen tools — but
	// what it does to the reader's note is write to it.
	write: { copyKey: "traceTool.write", category: "write", icon: "file-plus" },
	edit: { copyKey: "traceTool.edit", category: "write", icon: "file-pen" },
	update_frontmatter: { copyKey: "traceTool.updateFrontmatter", category: "write", icon: "file-cog" },
	insert_at_cursor: { copyKey: "traceTool.insertAtCursor", category: "write", icon: "text-cursor-input" },
	move_note: { copyKey: "traceTool.moveNote", category: "write", icon: "folder-input" },
	trash_note: { copyKey: "traceTool.trashNote", category: "write", icon: "trash-2" },

	// Moving the reader's screen.
	open_note: { copyKey: "traceTool.openNote", category: "other", icon: "panel-top" },
	open_side_panel: { copyKey: "traceTool.openSidePanel", category: "other", icon: "columns-2" },
	goto_location: { copyKey: "traceTool.gotoLocation", category: "other", icon: "crosshair" },

	// Talking to the reader. `ask_user` draws no call row of its own (the
	// question renders in full in the stream), but it keeps its entry: under
	// agent details the row comes back, and the fold planner reads this table.
	notify: { copyKey: "traceTool.notify", category: "other", icon: "bell" },
	ask_user: { copyKey: "traceTool.askUser", category: "other", icon: "circle-help" },

	// Reading a skill, which is not a note — hence `other`, not `read`.
	read_skill: { copyKey: "traceTool.readSkill", category: "other", icon: "book-open" },

	// Tasks, which are a query over the vault's checkboxes rather than a read of
	// any one note.
	list_tasks: { copyKey: "traceTool.listTasks", category: "other", icon: "list-checks" },
	summarize_tasks: { copyKey: "traceTool.summarizeTasks", category: "other", icon: "clipboard-list" },

	// The one tool that leaves the vault.
	web_fetch: { copyKey: "traceTool.webFetch", category: "web", icon: "globe" },

	// Delegation. One family, so a turn that spent itself on children reads as one
	// shape: a person joins, the roster, a person leaves, another word to one of
	// them, the wait. The follow-up borrows the composer's own send glyph rather
	// than a fifth `user-*`: dispatching an instruction is what that arrow already
	// means everywhere else in the plugin, and only the recipient differs.
	spawn_subagent: { copyKey: "traceTool.spawnSubagent", category: "subagent", icon: "user-plus" },
	list_subagents: { copyKey: "traceTool.listSubagents", category: "subagent", icon: "users" },
	kill_subagent: { copyKey: "traceTool.killSubagent", category: "subagent", icon: "user-x" },
	follow_up_subagent: { copyKey: "traceTool.followUpSubagent", category: "subagent", icon: "send" },
	wait_subagent: { copyKey: "traceTool.waitSubagent", category: "subagent", icon: "hourglass" },
};

/**
 * Tool use in general, when the row cannot say which kind.
 *
 * Two rows wear it, for one reason. A tool this table has not been taught — an
 * MCP tool, a build newer than this table — because a wrench is the honest
 * answer where a guessed verb would not be. And a folded run, because mixed
 * traffic is exactly what a wrench means: several tools, no one of them the
 * subject. That second job is the one the glyph was miscast in before, when it
 * stood for a call whose result never came.
 */
export const GENERIC_TOOL_ICON: IconName = "wrench";

/** This tool's copy key, or `null` when the table has not been taught it. */
export function toolCopyKey(name: string): CopyKey | null {
	return TOOL_CATALOG[name]?.copyKey ?? null;
}

/** This tool's glyph, falling back to {@link GENERIC_TOOL_ICON}. */
export function toolIcon(name: string): IconName {
	return TOOL_CATALOG[name]?.icon ?? GENERIC_TOOL_ICON;
}

/** The category `name` counts toward; `other` for anything the table has not been taught. */
export function categorizeTool(name: string): ToolCategory {
	return TOOL_CATALOG[name]?.category ?? "other";
}
