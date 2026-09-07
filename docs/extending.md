# Extending Piem

[← Back to README](../README.md) · [简体中文](extending.zh-CN.md)

Two ways to teach Piem something new: **skills**, which are instructions it can
follow, and **MCP servers**, which are tools it can call.

## Skills

A skill is a reusable instruction the agent can follow, and that you can invoke
directly by typing `/` in the composer. Piem folds them from three sources, with
later tiers shadowing earlier ones:

1. **Bundled** — `summarize`, `link-graph`, `tag-organize`, and `find-skills`.
   Localized, and available before you create a single file. They have no vault
   file at all; `read_skill` serves their content from memory.
2. **Vault** — `Piem/skills/<name>/SKILL.md` inside your vault. The folder is
   visible in Obsidian's file explorer, so you can open, search, link, and sync
   your skills like any other note.
3. **User-level** — `~/.pi/agent/skills` and `~/.agents/skills`, the same
   directories pi itself reads. Skills you already wrote for pi work here
   unchanged.

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

In **Extensions**, badges beside skill names show **Imported**, **Handwritten**,
**Single note**, or **External file**. Imported skills keep their source URL below
the name. Problems appear below the affected section, with a count beside its
heading; **Reload** in the Skills heading rereads the files and updates the report.
The folder search report distinguishes an empty folder, a missing folder, and one
that could not be checked.

### Importing from GitHub

**Settings → Piem → Extensions** imports skills straight from a GitHub URL:
pick a repo or a subfolder, review the plan, and Piem writes the `SKILL.md`
files into `Piem/skills/` along with a provenance sidecar. That sidecar is what
lets the **Update** button refetch later.

Imports are markdown-only. Nothing executable comes down the wire.

## Prompt templates

Prompt templates live in `.piem/prompts` inside your vault and appear in the
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
