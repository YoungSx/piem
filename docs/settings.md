# Settings

[← Back to README](../README.md) · [简体中文](settings.zh-CN.md)

Four pages under **Settings → Piem**: Models, Chat, Extensions, General.

## Models

This is the page you have to visit once. Everything else has a working default.

**Providers** are your own endpoints — Piem hosts nothing. A provider is a base
URL, an API key, and a wire protocol:

| Protocol | For |
| --- | --- |
| `openai-completions` | OpenAI-compatible `/chat/completions` endpoints |
| `openai-responses` | OpenAI's Responses API and compatible endpoints |
| `anthropic-messages` | Anthropic's Messages API and compatible endpoints |

**Presets.** Pick one of sixteen known services and the only thing left to enter
is its API key — the form drops the name, base URL and protocol rows, because the
preset settles all three. Anthropic, OpenAI, Google Gemini, DeepSeek, Groq,
Mistral, Moonshot, xAI, Z.ai, OpenRouter, MiniMax, Qwen, and the mainland-China
sites four of them run separately. Every option names the host it reaches, since
that is what tells a vendor's two services apart.

**Custom** leads the list and is where a new form opens. It is also how you take
a preset's endpoint over: switch to Custom and the three rows come back, still
holding what the preset put there, ready to edit. Typing a preset's own URL into
a Custom row selects that preset, and editing away from one drops back to
Custom — the label never describes an endpoint the form is not holding. Picking a
preset never touches your key.

Model ids are suggested by the endpoint itself, wherever it implements listing —
your own server is a better authority on what it will accept than anything this
plugin could ship, and the only one that knows about a private gateway. The field
takes any id you type either way.

**Capability suggestions.** For a known model id the form fills in whether it
accepts image input, its context window, and its max output, from a live
[models.dev](https://models.dev) index covering every provider it tracks.
Anything you set by hand outranks the suggestion and stops it from being
overwritten again, and every control has a working default when the index cannot
be reached.

**The connection test** probes the endpoint through the transport you selected
for provider requests — the same channel your chat will ride, not a convenient
substitute. A test that passes over `fetch` while your chats go through
`requestUrl` would be a test of the wrong thing.

**Prompt cache** decides how long a provider may hold the unchanging part of a
prompt — system instructions, tool definitions, skills, the note you have open —
so a follow-up reads it back at roughly a tenth of the price instead of paying in
full.

The default is **an hour**, and that is deliberately not what the underlying
agent library defaults to. Five minutes is the right span for a terminal agent
whose turns land seconds apart; it expires during the ten minutes you spend
writing between two questions, and then the whole prompt is billed fresh again.
An hour costs more to store — Anthropic charges twice base input for a one-hour
cache write against 1.25× for a five-minute one — and the second follow-up pays
that premium back. Pick **five minutes** if your sessions really are one question
long, and **off** for an endpoint that rejects cache markers.

Providers map the preference to whatever they support and ignore what they do
not, so nothing here depends on which model you selected. With **Show agent
details** on, the context ring's popover names the share written at the hour-long
rate whenever a provider reports it — which is the only proof the setting took,
since one that ignores it simply bills the cheaper way.

## Chat

Behavior on top, storage underneath.

Two things happen here without a switch, and both are worth knowing about. The
note you have open is injected into **every** turn — its path and its body — so
you never have to say "the note I'm looking at". And when the context window
fills, the conversation tidies itself; *Tidy earlier thoughts* in the
command palette does the same thing on demand, and the transcript records each
tidy as a seam you can open to read the summary it wrote.

- **Show agent details** — token counts, spend, and raw tool arguments in the
  chat panel. Off by default; turn it on when you want to see what the agent
  actually sent.
- **Open tool activity** — how much of the machine traffic starts open:
  thinking, tool calls, results. Everything is collapsed by default, and any row
  still opens by hand. In that mode two or more consecutive thoughts and tool
  calls fold into a single row that says what the run did — "read a note and
  thought it through" — with the original rows inside, in order. A failed call and an
  answered question stay outside the fold: neither should cost a click to see.
- **Mid-reply sends** — a message you send while Piem is still answering is not
  refused; it waits, and this is how long. *The whole answer is finished* is the
  default and the safe one: the reply completes its plan, then your message is
  read as the next question. *The current request is finished* is sooner — the
  message lands after this turn's tools and before Piem speaks again, which can
  redirect a long run of tool calls halfway through it. Neither setting
  interrupts: the **send** action on a waiting message does that, cutting the
  reply short so that one message goes out now.
- **Context tidying** — the reserve and retention budgets that decide when the
  conversation gets summarized to make room. Piem plans against the context
  window you configured for the model.
- **Chats to keep** — a retention limit. When you start a new chat past the
  limit, the oldest ones move to trash. Set it to unlimited and nothing is ever
  trashed.
- The session directory is shown here, so you always know which folder holds
  your transcripts.

## Extensions

MCP servers, skill imports, and built-in skill files. **Built-in skill files**
shows preparation status and any files kept because of local changes. **Retry
preparation** retries a failed download; **Restore missing files** restores deleted
built-in entries without overwriting edits. **Reload** rereads local skills.
See [Extending Piem](extending.md) for paths, priority, and update rules.

## General

- **Language** — English or Simplified Chinese. Follows Obsidian's own language
  by default; the override here is for when you want the plugin in a different
  language than the app.
- **Send shortcut** — `Enter` to send, or `Ctrl`/`⌘`+`Enter` to send with
  `Enter` inserting a newline. Pick whichever matches the muscle memory you
  already have.
- **Log level** and the **log viewer** — the log view opens as its own leaf and
  is the first place to look when a provider misbehaves.
- **About** — the running version (read from `manifest.json`, never restated),
  links, a summary of what leaves your vault, and how your keys are stored on
  this device.

## Commands

Everything Piem adds to the command palette, shown as *Piem: …*:

| Command | What it does |
| --- | --- |
| Open chat | Opens the chat side panel |
| Open log view | Opens the log leaf |
| New chat | Starts a fresh conversation |
| Stop response | Aborts the turn in flight |
| Tidy earlier thoughts | Compacts the conversation by hand |
| Focus chat input | Jumps the cursor into the composer |
| Ask about selection | Adds the selected text and note path to your draft |
| Ask about this note | Adds the current note's path to your draft |

All of them are bindable to your own hotkeys under **Settings → Hotkeys**.

### Ask from a context menu

Use **Ask about this file**, **Ask about this folder**, or **Ask about these
items** in Obsidian's file menus. The editor offers **Ask about selection** when
text is selected and **Ask about this note** otherwise. External HTTP/HTTPS links
provide **Ask about this link**.

Each action adds an expandable reference card inside the composer. Expand a card
to inspect its full path, URL, or captured selection; remove it to leave it out
of the next question. Your own words stay unchanged. Select **Send** when the
question is ready. Opening a menu or adding a card does not fetch a webpage or
start a model request.

Cards belong to the draft and survive closing the panel or switching chats.
The first reference saves a new chat's identity, so its unsent draft is also
reachable after restarting Obsidian. Opening an untouched blank chat saves nothing.
They travel with queued questions, return when you take a queued question back,
and appear inside the sent question's bubble, using the same disclosure style as
skill content. This grouping survives reloading the conversation. Pi's native
custom messages store the reference text for the model and separate metadata for
the cards. File and folder cards name paths; they do not claim their full contents
have already been read. Selection cards keep the passage as it was when selected.

A draft accepts up to 64 references and 20,000 characters of reference data.
Draft text keeps its existing persistence limit: the first 20,000 characters are
saved, while the open editor retains the full text. Repeated references are
merged. An over-budget addition is refused with an explanation, and unavailable
items are reported. Long selections are clipped to 2,000 Unicode characters with
a notice. The separate **Pin** control still supports up to eight lasting file
references; adding a one-question card does not consume a pin.

The input stays read-only while its saved draft loads. On mobile, adding a
reference opens a folded input and focuses the question. After sending,
`web_fetch` can request a linked page, subject to site access restrictions and
the tool's text limits. The active note's open editor supplies its latest text,
including unsaved edits; closed notes use the vault copy. Menu availability
follows Obsidian, so custom views and mobile gestures may expose different entries.

## Storage

Sessions are JSONL files under
`<vault config dir>/plugins/piem/sessions/`, written with a pi-compatible
version 3 header and tree-shaped entries (`id` / `parentId`) — the same shape pi
uses, so a transcript is not trapped in this plugin.

Unsent draft text and reference cards live in per-conversation `drafts/<session-id>.json`
files beside the logs. Closing the panel preserves both; older text-only drafts
remain readable.

Staged images are **never** persisted. The session log stores a placeholder
instead of the bytes, so a vault that syncs does not carry your screenshots
around.

## Versions

The running version lives in `manifest.json` and is shown in **About**.
Released versions and the minimum Obsidian version each one needs are listed in
[`versions.json`](../versions.json).
