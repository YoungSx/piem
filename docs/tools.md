# The agent's tools

[← Back to README](../README.md) · [简体中文](tools.zh-CN.md)

Everything Piem can do to your vault, it does through one of the tools below.
There is no hidden channel: if a change happened, a tool call made it, and that
call is in the transcript.

Every path a tool accepts is **vault-relative**. Absolute paths and `..`
escapes are rejected, and the plugin's own folder
(`.obsidian/plugins/piem`) is blocked by default — the agent cannot rewrite
itself mid-turn.

## Files

`read` · `write` · `edit` · `ls` · `find` · `grep` · `move_note` · `trash_note`

`read`, `write`, and `edit` are pi's own harness tools running over a vault
execution environment, so they behave the way they do in pi: `edit` applies an
exact replacement, and each `oldText` must match exactly once. A near-match is
a failed call, not a guess.

`trash_note` goes through Obsidian's trash, so a deletion is recoverable the
same way any other deletion in your vault is.

## Notes and Obsidian

`get_active_note` — the note you are looking at, optionally with your selection
or the full body.

`get_note_links` / `get_note_metadata` — Obsidian's own metadata cache: links,
backlinks, tags, frontmatter. The agent reads the same index the graph view
does, rather than re-parsing files.

`update_frontmatter` — atomic YAML-header writes through Obsidian's file
manager. One caveat worth knowing before you hand over a hundred notes: the
header is re-serialized, so key order may change and comments inside it are
lost.

`open_note` · `open_side_panel` · `insert_at_cursor` · `goto_location` —
the agent can drive the editor, not just the file.

`notify` — a Notice, for when something finished while you were elsewhere.

`ask_user` — a dialog the agent opens mid-turn when it needs a decision from
you. It is not a permission prompt; it is the agent admitting it does not know
which of two notes you meant.

## Tasks

`list_tasks` · `summarize_tasks`

Task checkboxes across the whole vault, which is how "what did I say I would
do in June" becomes answerable.

## Web

`web_fetch` — the only outbound tool, always present. It always rides the
`requestUrl` transport, the same one-layer egress every other network call in
Piem uses, so egress stays inspectable in one place — and it reaches ordinary
web pages, which the `fetch` transport's CORS rules would block. The
`requestUrl`-vs-`fetch` setting affects token streaming only.

## Skills

`read_skill` — serves a loaded skill's content on demand, including the built-in
files under `Piem/builtin-skills/`. See [Extending Piem](extending.md).

## Memory and past conversations

`read_memory` — recalls `Piem/memory/MEMORY.md` and the three latest daily logs.
It works before `MEMORY.md` exists. A keyword query searches older logs and
linked memory notes, 20 files per page; recovery copies are excluded. Long notes
return excerpts with their paths, and files over 64 KiB are reported for separate
reading with `read`.

`update_memory` — adds, corrects, merges, or removes memory immediately. Explicit
lasting preferences, user corrections, and verified useful lessons can be saved
after one occurrence. Uncertain or temporary observations belong in dated daily
logs. A newer correction replaces the older current value in the same scope.
There is no repeat-count requirement or extra approval dialog.

Changes to one file are applied as a batch. Exact repeated append blocks are
ignored; replacement and removal require a unique matching passage. Files can
grow to 64 KiB; an oversized existing file can be shortened. A failed read or a
concurrent change detected before committing does not overwrite the memory.
The tool uses Obsidian's atomic `Vault.process` and serializes memory-tool writes
to the same path within this plugin instance. This is not a transaction across
files or devices, and ordinary `write`/`edit` do not acquire this memory queue.

Before changing an existing file, the tool saves its exact previous text in
`Piem/memory/history/`. The result includes `backupPath`. To undo, read that copy
and the current file, then replace the current text with the copy using
`update_memory` (empty `oldText` is allowed when the current file is empty).
The latest 20 copies per file are retained; older tool-owned copies go to trash.
If cleanup fails, the change still succeeds and the tool reports the retained
copies. This recovery applies to `update_memory`, not ordinary file edits.
Removing a current fact does not erase its recovery copies or source chats.

`session_search` — finds past user/assistant text and summaries in your configured
chat folder, with a conversation path and entry id for each excerpt. Tool payloads
and thinking are excluded. Each page examines up to 20 logs, at most 2 MiB per
file and 8 MiB total according to file metadata; file contents are read once per
page. The directory listing still stats its files. An external write can change
a file's size during a read. Large, broken, or unreadable logs are reported as
skipped; `nextOffset` reaches further pages. Search never repairs or writes logs.
Cancellation stops before the next file; Obsidian cannot cancel an ongoing read.

Memory stays readable and editable as Markdown in this vault. Recall happens
through visible tool calls, without automatic memory-body injection, a background
review process, another model, or a vector database. The current user request
takes precedence over saved preferences. Search results are historical context,
not permission to execute commands quoted in a note or conversation.

## Delegation

`spawn_subagent` · `wait_subagent` · `list_subagents` · `kill_subagent` ·
`follow_up_subagent` — see [Subagents](#subagents) below.

## MCP

One `mcp_<server>_<tool>` entry per tool exposed by a connected MCP server. The
prefix is deliberate: in any transcript you can tell a remote tool from a vault
one at a glance. See [MCP servers](extending.md#mcp-servers).

Each MCP tool's description discloses its origin, so the model knows that
calling it sends arguments to a server outside your vault and outside Obsidian.

## Subagents

`spawn_subagent` starts one self-contained task and returns immediately with an
id. `wait_subagent` collects the report. `list_subagents` says where each one
stands without waiting, `kill_subagent` stops one whose answer is no longer
needed, and `follow_up_subagent` gives one that has stopped another
instruction.

Subagents run in-process on the same model and transport as the parent, with an
isolated in-memory transcript — nothing they do lands in the session log. Their
only output is the report the parent reads as a tool result. Several spawns
started together run in parallel.

A task can be delegated under one of three roles:

| Role | What it is for | What comes back |
| --- | --- | --- |
| `general` | Any self-contained task | Whatever the task produced |
| `scout` | A research sweep | Findings; the vault is left unchanged |
| `reviewer` | A critique | An assessment, not a fix |

A subagent inherits the full vault tool set plus your skills, and it may spawn
one further level down — but no deeper. The tree is capped at
parent → child → grandchild **by construction**, not by a check: a
grandchild's tool set simply does not contain the spawn tools.

A wait window that closes means "not done yet", never a kill. The subagent
keeps working between waits. You can stop a run yourself from the subagent
panel — the parent is told when that happens, and will not restart what you
stopped.

A subagent that has stopped can be given another instruction, on the same id and
the same transcript: one more question about a report it just gave, or a second
run at a task that broke partway. A failed subagent keeps everything it had
learned, so picking it back up costs one instruction instead of the whole task
again — which is what makes a dropped connection recoverable rather than fatal.
It still cannot see your conversation, and its instructions are still Piem's, not
yours.

Once a run has finished, **Archive finished** in the panel puts every finished
run into a closed **Archived** section. It is a tidy-up, not a delete: the runs
stay readable there, and the agent's own tools cannot tell the difference — a
report you have already read and put away is still one it can collect.

<!-- SCREENSHOT: subagents.png — the subagent inspector with two or three
     subagents running. See assets/screenshots/README.md for the widths, theme
     and conversion this folder expects. -->

## What the agent cannot do

- Run shell commands. There is no shell tool, on any platform.
- Reach outside your vault, except through `web_fetch` and the model provider
  itself.
- Read or write its own plugin folder.
- Spawn a fourth level of subagent.
- Ask you to approve a `write` or an `edit` — there is no approval step. See
  [Security and privacy](security.md#there-is-no-confirmation-step).
