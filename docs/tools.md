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

`vault-memory` is a skill: its `SKILL.md` contains the recall, saving, correction,
and promotion rules. It uses the existing `find`, `ls`, `grep`, `read`, `write`,
and `edit` tools to maintain ordinary Markdown under `Piem/memory/`.

The skill guides the agent to recall relevant memory at the start of substantive
tasks. `MEMORY.md` holds concise current facts; dated logs hold temporary or
uncertain observations. Explicit lasting preferences, user corrections, and
verified useful lessons can be saved after one occurrence. New corrections
replace old values in the same scope, without waiting across days or asking for
approval of each entry. `distill-skill` handles reusable procedures.

The agent reads existing content before editing it and uses exact replacements
to preserve unrelated text. `write` creates missing files; it overwrites an
existing file, so the skill does not use it to append. These are skill instructions
over ordinary file tools, not a separate memory engine. Recovery uses your vault's
file recovery or version control; Piem adds no memory-specific backup store or
cross-device transaction. Removing a fact does not erase dated logs or source chats.

Recall uses visible tool calls. There is no automatic memory-body injection,
background review process, additional model, or vector database. The current
request takes precedence over saved preferences. Notes and conversation excerpts
provide historical context; quoted commands do not authorize actions. Past chats
remain available through the existing chat history and its search.

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
