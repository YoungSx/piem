# Security and privacy

[← Back to README](../README.md) · [简体中文](security.zh-CN.md)

Piem hands your notes to a model provider and lets an agent edit them. Both of
those are the point, and both deserve to be stated plainly rather than found in
a settings tab.

## What leaves your vault

Sent to the model provider you configured:

- your prompts and the conversation history;
- **the note you have open** — path and full body — on every single turn, whether
  or not your question is about it;
- vault content returned by tools — note bodies, search results, file listings,
  frontmatter;
- tool results, including anything `web_fetch` brought back;
- image attachments you staged.

Sent to an MCP server, additionally: the arguments of any tool that server
exposes. Each MCP tool's description says so in its own text, so the model knows
it too.

Built-in skill preparation sends a GET request to GitHub for the resource belonging
to the installed plugin version. GitHub and its download hosts receive the resource
URL (including that version), the device's IP address and ordinary request metadata.
No vault notes, conversation content or provider keys accompany this download.
The resource is checksum-verified Markdown, written under `Piem/builtin-skills/`;
no scripts execute and it never follows a newer release independently of the plugin.

There is no telemetry, analytics, crash reporter or Piem-operated backend.

The practical consequence: **point Piem at a vault you are willing to send to
your model provider.** A search that touches a file lists that file, and the
model sees the listing.

## There is no confirmation step

The agent can `write`, `edit`, `move_note`, and `trash_note` immediately. No
dialog, no diff to approve, no "are you sure".

This is a deliberate product decision, not a missing feature. What to do about
it:

- Use Piem on vaults you are willing to have changed.
- Read the transcript after each turn — every change came from a tool call and
  every tool call is there.
- Keep your vault in version control, or lean on Obsidian's file recovery.
  `trash_note` goes through Obsidian's trash, so deletions are recoverable the
  ordinary way.

## Where your keys live

API keys and MCP bearer tokens are stored with Obsidian plugin data.

- **Desktop:** sealed with Electron `safeStorage` before being written to
  `data.json` — DPAPI on Windows, Keychain on macOS, libsecret on Linux.
- **Mobile, and desktops with no keyring:** plaintext in `data.json`. There is
  nothing to seal with, and pretending otherwise would be worse than saying so.

A sealed key only decodes on the device that sealed it. Vault sync therefore
does **not** carry usable keys between devices: enter each key once per device.
That is a feature more than a limitation, but it does mean the "why is my key
empty on my phone" answer is here.

Prefer restricted or low-limit keys. The plugin cannot enforce that for you.

## Capabilities Obsidian's review flags

Piem is an agent plugin, so doing its job requires capabilities that Obsidian's
community-plugin review reports explicitly. They are listed here in that same
vocabulary. None is a defect or a workaround — each is load-bearing for a
feature, and none sends anything anywhere beyond what is described above.

**Direct filesystem access.** On desktop the plugin reaches Node `fs` through
Electron's `require`, bypassing the vault API. This is how user-level skill
folders are read and written (`~/.pi/agent/skills`, `~/.agents/skills`): the
vault API cannot see outside the vault. There is no shell execution and no
probing of arbitrary paths — the paths touched are your home directory and the
skill folders beneath it. On mobile, where the host exposes no `require`, this
degrades to "unavailable" rather than failing the plugin.

**Vault enumeration.** Search and task tools call `vault.getFiles` /
`vault.getMarkdownFiles`, which list every file in the vault with its full path.
The model sees those listings whenever a search or task query touches them. That
is inherent to "search my vault".

**Clipboard access.** Outgoing only: message replies, log lines, and a
copy-secret affordance in settings call `navigator.clipboard.writeText`. Piem
never reads the clipboard. Pasted images arrive through the editor's own paste
event, not a clipboard read.

**Base64 encoding at runtime.** Image attachments are encoded with `btoa` before
being sent as model content. That is the entire use — nothing anywhere decodes an
obfuscated payload.

**Network requests.** Roughly twenty call sites, all through one transport layer:
model provider streams, the connection test, the models.dev catalog suggestion,
remote MCP servers, skill imports, built-in skill preparation, and the `web_fetch` tool. Your
`requestUrl`-vs-`fetch` choice steers the requests where streaming matters —
model streams and the connection test; the catalog, skill imports, built-in
skill preparation, and `web_fetch` always ride `requestUrl`, because they fetch whole responses and
must reach hosts that send no CORS headers. Egress stays inspectable in one
place rather than scattered across the codebase.

Built-in preparation stops waiting after 15 seconds and does not loop on failure.
Unloading cancels the preparation and prevents late responses from starting file
writes. Obsidian's `requestUrl` cannot physically cancel a request already sent;
the underlying request may finish after the plugin stops waiting. Existing files
remain usable offline. The **Retry preparation** and **Restore missing files**
actions in Extensions are explicit recovery paths.

## Reporting something

Found a way to make Piem do something the above does not describe? Open an issue
at [`YoungSx/piem`](https://github.com/YoungSx/piem/issues). If it is sensitive,
say so in the first line and leave the details out until someone replies.
