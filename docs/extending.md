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
One successful run can be enough. The agent can create or improve a skill
without asking you to approve each draft, preferring an existing skill over a
near duplicate. Newer user corrections replace outdated steps in place.
An unverified attempt remains a dated observation, not a claimed working recipe.
Nothing runs just because a skill was saved. See [Memory and past conversations](tools.md#memory-and-past-conversations).

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

At the start of every turn Piem lists each loaded skill in the system prompt, so
the model knows they exist without you naming them. Skills are read fresh from
disk on every turn: editing or adding one takes effect on your **next message**,
with no plugin reload.

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

Imports are markdown-only. Nothing executable comes down the wire.

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
