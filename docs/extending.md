# Extending Piem

[← Back to README](../README.md) · [简体中文](extending.zh-CN.md)

Two ways to teach Piem something new: **skills**, which are instructions it can
follow, and **MCP servers**, which are tools it can call.

## Skills

A skill is a reusable instruction the agent can follow, and that you can invoke
by typing `/` in the composer. Piem combines three sources in this order, with
later sources overriding earlier skills of the same name:

1. **Built-in** — standard files under `Piem/builtin-skills/<name>/SKILL.md`.
   Includes `summarize`, `link-graph`, `tag-organize`, `find-skills`,
   `efficient-web-research`, `vault-memory`, and `distill-skill`.
2. **User-level** — on desktop, `~/.pi/agent/skills` and `~/.agents/skills`, plus
   the optional extra directory in settings. These keep their existing priority
   within the user-level source.
3. **Vault** — your own or imported files under `Piem/skills/<name>/SKILL.md`.
   A vault skill overrides both other sources.

`vault-memory` teaches recall and autonomous maintenance of useful facts;
`distill-skill` teaches saving a useful, verified procedure as a vault skill.
Their workflows live entirely in `SKILL.md` and use ordinary vault file tools.
One successful run can be enough. The agent can create or improve a skill
without asking you to approve each draft, preferring an existing skill over a
near duplicate. Newer user corrections replace outdated steps in place.
An unverified attempt remains a dated observation, not a claimed working recipe.
New and edited skills load on the next user turn; saving does not execute them.
See [Memory and past conversations](tools.md#memory-and-past-conversations).

### Built-in files and updates

Piem downloads the built-in Markdown resource from the GitHub release matching
its installed version, verifies the checksum pinned in the plugin, and creates
real files in your vault. The folder is visible in Obsidian: open, search and sync
it like your other notes. Descriptions come from each file, so the shipped English
descriptions do not change with the interface language.

**First installation needs a connection to GitHub.** Preparation runs after the
workspace is ready and does not block chat. A failed download leaves existing
skills usable offline. **Settings → Piem → Extensions → Built-in skill files**
shows the outcome and offers **Retry preparation**. It makes no background retry
loop, and ordinary messages never trigger downloads.

An update replaces only files that still match their recorded installed content.
Your edits and pre-existing files are kept, with any conflicts listed in settings.
Deleting a built-in skill keeps it removed; **Restore missing files** recreates
missing files without overwriting edited ones or re-enabling disabled skills.
Files retired by a release are kept for you to review. Sync and update operations
are not a cross-device transaction; inconsistent ownership evidence preserves
files instead of overwriting them.

To customize a default while continuing to receive official updates, copy its
folder into `Piem/skills/` and keep the same skill name. Your copy takes priority.
The built-in skill resource contains Markdown only; it does not install or execute
scripts. See [Security and privacy](security.md) for download disclosure.

### Writing one

A `SKILL.md` needs frontmatter with two fields:

```markdown
---
name: weekly-review
description: Collects the week's daily notes and drafts a review from them.
---

Read every daily note from the last seven days. Pull out anything tagged
#decision or #blocked. Draft a review in Reviews/ using the template in
Templates/Weekly.md.
```

- `name` — lowercase letters, digits, and hyphens only, and it must match the
  folder name.
- `description` — what the model reads when deciding whether the skill applies.
  Write it for the model, not for yourself.

Piem uses Pi's skill loader and prompt formatter for the
[Agent Skills format](https://agentskills.io/specification). The model first sees
a catalog of skill names, descriptions and locations. When one applies, it calls
`read_skill` for the instructions; typing `/name` provides them directly.
Referenced files are read separately when needed. This is
**progressive disclosure**: caching the skill bodies in memory does not add them
all to the model's context.

Skills are read fresh from disk before each new user turn: editing or adding one
takes effect on your **next message**, with no plugin reload. Disabled skills are
excluded; `disable-model-invocation: true` hides a skill from the model's catalog
while keeping explicit invocation available.

`read_skill` returns up to 50 KiB per page and tells the model how to continue
without splitting a character. Continuations carry a content fingerprint: if the
file changed, the model starts again instead of mixing two versions. The same tool
reads a referenced UTF-8 text file by skill name and relative path, including
desktop user-level skills. Resources must stay inside that skill's directory,
contain no hidden path segments, and be at most 1 MiB; symlinks cannot escape the
directory. Vault images remain available through `read`. Piem provides no shell
for bundled scripts.

Instructions already loaded through `read_skill` or `/name` survive conversation
compaction verbatim, including loaded reference pages. Repeated pages are kept
once, and a newly loaded version replaces the older retained copy. This works for
subagents and reopened chats too; preserved copies do not add duplicate chat rows.
Unactivated skills still contribute only their catalog entries.

In **Extensions**, badges show **Built-in**, **Global**, or **Vault**. Built-in
and vault files have an **Open** button; imported vault skills also keep their
source URL and update/delete controls. Problems appear beside the relevant
source. **Reload** rereads local files; it does not download or restore them.
The folder search report distinguishes empty, missing, and unreadable folders.
A running conversation keeps its current skill snapshot until the next message.

### Importing from GitHub

**Settings → Piem → Extensions** imports skills straight from a GitHub URL:
pick a repo or a subfolder, review the plan, and Piem writes the `SKILL.md`
files into `Piem/skills/` along with a provenance sidecar. That sidecar is what
lets the **Update** button refetch later.

Folder URLs import `SKILL.md` together with its Markdown references, whether the
URL points at one skill or a collection. Single-file URLs import only that file.
Scripts and other non-Markdown files are skipped before downloading. Imports are
limited to 10 skills, 40 Markdown files and 256 KiB per file; an oversized package
fails rather than silently losing Markdown resources. Failed writes are reported
without claiming a successful installation.

For an older single-folder import that is missing references, select **Update**.
Piem checks the file set even when the upstream tree has not changed and keeps
the existing installation directory. Local modifications still cause a conflict.

## Prompt templates

Prompt templates live in `Piem/prompts` inside your vault and appear in the
same `/` autocomplete, labelled with their source.

If a template and a skill share a name, the template keeps priority and the
skill stays reachable as `/skill:name`. Selecting it in the autocomplete inserts
the disambiguated form for you.

## MCP servers

Piem connects to remote MCP (Model Context Protocol) servers over Streamable
HTTP and merges their tools into the agent's own tool set. Configure them in
**Settings → Piem → Extensions**: each server is an http(s) URL, an optional
bearer token, and an enable switch.

- Tools appear to the model as `mcp_<server>_<tool>`, so a reader can tell
  remote tools from vault ones in every transcript. Name collisions with
  existing tools are resolved with a numeric suffix.
- Each server's name has a status badge: **Connected** with its tool count,
  **Connecting**, **Connection failed**, **Not connected**, or **Disabled**. The
  enable switch controls whether Piem should connect; the badge reports the
  result. Connection errors stay below the name.
- Saving settings connects enabled servers, even before you open a chat. A
  server already connected with the same URL and token is left alone; an edited
  or failed server reconnects. **Connect** beside a pending server and **Retry
  connection** beside a failed one let you try again immediately. A new message
  also refreshes the tool set; there is no periodic background retry.
- **Test** in the server editor probes the draft configuration without saving it.
- Bearer tokens follow the same sealed-at-rest lifecycle as provider API keys.
  See [Security and privacy](security.md#where-your-keys-live).
- Timeouts are bounded: 15 s to connect and list tools, 120 s per tool call,
  with tool output truncated to the same byte budget as every other tool.

### Why remote only

No stdio transport. It would launch child processes, and that is off-limits on
mobile — where this plugin is first-class, not an afterthought. A capability
that cannot exist on a phone is refused for everyone rather than shipped as a
desktop-only surprise.

There is no OAuth flow either. A static bearer token covers the servers a
personal vault realistically talks to, and the flow it replaces would be a
browser round-trip Obsidian is not well placed to host.

## Built-in Pi extensions

Piem includes Pi's original **bookmark** extension. Open a conversation, then use
Obsidian's command palette:

- **Piem: Bookmark the latest reply** — enter a label of 1–160 characters.
- **Piem: Remove latest bookmark** — remove the label from the last labelled entry.
- **Piem: View conversation bookmarks** — search labels and reply excerpts, then
  select one to read it. Long replies show their first 4,000 characters.

The extension uses the existing conversation file. Labels survive reloads and
travel with that file through vault sync. A fork carries labels whose replies
are included in the copy. A save belongs to the conversation in which you opened
the dialog, even if you switch chats before saving. Piem reports success only
after the write completes; a failed write leaves the label available to retry.
Wait for a conversation's reply, retry or compaction to finish before using these
commands.

Selection follows Pi's original rule: **the last appended assistant reply in the
whole conversation log**, including replies retained after a rewind. It can differ
from the last reply currently displayed. Removing a bookmark likewise walks all
entries backwards; it does not use the time at which a label was assigned.
Synchronizing simultaneous edits to the same label follows the existing session
merge rule: the arriving file wins. Sync is not a cross-device transaction.

Bookmarks work offline. Seven community extensions are also bundled. The first
six are active by default; telemetry exports only after you configure a collector:

| Extension | What it does | How to use it |
| --- | --- | --- |
| `pi-assistant-provenance` | Tells a model when earlier replies came from a different model | Automatic, in request context only |
| `pi-model-switch` | Lists, searches and switches configured models | Ask the agent to use `switch_model` |
| `pi-invisible-continue` | Continues the current task without adding prompt text for the model | `/continue`, or **Piem: Continue current task** |
| `pi-web-search` | Searches with the current provider and returns source links | Ask the agent to use `web_search` |
| `pi-clarify` | Rewrites a rough request into an editable draft | `/clarify <idea>`, or **Piem: Rewrite a draft before sending** |
| `pi-context` | Saves checkpoints, inspects the timeline and continues from a summary branch | Ask the agent to use `context_checkpoint`, `context_timeline` or `context_compact` |
| [`b1tank/pi-otel`](https://github.com/b1tank/pi-otel) | Exports traces, metrics and logs to your collector | Set **OpenTelemetry collector URL** in **Extensions**, then reload Piem |

Switching is limited to unambiguous configured models with API keys. It changes the
next model request in that conversation and saves the default choice. The newly
selected provider receives the conversation through Piem's existing transport;
pricing shown as zero by upstream means unknown, not free. A failed save is reported
as a failed tool call. Requests already in progress in other chats keep their model.

`/continue` sends an ordinary model request with the existing conversation and
Piem's normal note context. While a reply is running, it waits in the conversation's
queue; Stop removes it. Its empty marker is saved with the chat but filtered from
provider requests, including after reopening. `/continue status` and
`/continue help` show the upstream diagnostics. If a template or skill shares its
name, that existing command keeps the short name; use `/extension:continue` or select the extension from the slash menu.

`web_search` reuses the current model's credential. Its endpoint must support native
search through OpenAI Responses or Anthropic Messages; an ordinary Chat Completions
endpoint cannot search just because it can chat. Search can cost extra. The query
and any supplied URLs go to that provider, without an extra copy of the chat history.
Unsupported providers fail explicitly. Piem does not pick a different provider.
The upstream Gemini-only `url_context` tool is absent with Piem's configured protocols;
use `web_fetch` to read a known URL.

`/clarify <idea>` rewrites the supplied words; the command-palette action rewrites
the current composer draft. Adding `-clarify` to a request also returns a draft.
You can edit it and choose when to send. Stop, closing the panel or switching chats
prevents a late result from replacing another draft. If you edit while waiting, your
new words stay and the unused rewrite appears in the error message. Rewriting uses
only that draft and the upstream rewrite instructions, not your chat history or
active note. The original instructions preserve language and intent but emphasize
technical terminology, so review the result for ordinary note-writing requests.

By default, rewriting uses the conversation model. `/clarify model <provider> <model>`
pins an already configured, credentialed model; `/clarify model reset` restores the
default. The choice is saved in plugin settings and survives reload. A pinned
provider receives the draft even when the chat uses another provider.

`context_checkpoint` saves a label before reporting success. `context_compact` saves
a summary branch, selects it, and makes a new model request to continue the task.
The old branch stays in the conversation file; vault notes and external changes
are never rolled back. Stop cancels pending continuation. A Vault write already in
progress can finish; the displayed history then follows the saved result. `/context`
or **Piem: Show conversation context usage** opens Piem's existing context readout,
replacing the upstream terminal-only screen.

If a skill or template shares an extension command's name, it keeps the short name;
use `/extension:clarify` or `/extension:context` to select the extension explicitly.

`b1tank/pi-otel` is installed from its pinned Git commit and bundled through the
same reviewed factory loader as the other extensions. Its source is not copied or
ported into Piem, and it is not the npm package with the same name. Configure its
collector in [Settings](settings.md#extensions); there is no Piem-hosted backend.
It exports OTLP/HTTP JSON. Content capture is off, though model error messages can
contain note text; see [Security and privacy](security.md#opentelemetry-export).
Its events cover the main conversation, not every internal subagent model call.

These extensions ship in `main.js` and change only with a normal plugin release.
Piem does not download or execute JS/TS extensions from the vault or a URL. Upstream
configuration files such as `aliases.json` and provenance `config.json` are not
mounted; these extensions use their default behavior.

For maintainers, [the bridge guide](pi-extension-bridge.md) describes its supported
contracts, source audit and validation. Pi's original factory loader, runner, event
bus and tool wrapper are reused. Both the bookmark adapter and community adapter
use this host; the existing Pi agent and session store remain authoritative.
See [third-party notices](../THIRD_PARTY_NOTICES.md) for attribution.

## Developing built-in skills

The repository's `skills/<name>/SKILL.md` is the source of truth. Add a valid
folder with `name` and `description` frontmatter; the build discovers it without
a TypeScript registration. Markdown references and templates travel with their
skill, keeping relative paths. Build validation rejects missing metadata, unsafe
paths, scripts, symlinks, and missing linked resources.

`npm run build` writes `dist/builtin-skills.json` and pins its digest in `main.js`;
`npm run check:skills` verifies both against the source. The release workflow
publishes and attests the resource alongside the standard plugin files.

`npm run dev` watches additions, edits and removals, and writes the same JSON
beside `main.js`. Copy both files to the development plugin folder and reload
Piem; the development bundle reads the local JSON instead of an unpublished
release. Production bundles always use the release matching the installed version.
