<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/icon.png">
    <img src="assets/icon-onlight.webp" width="120" alt="">
  </picture>
</p>

<h1 align="center">Piem</h1>

<p align="center">
  <b>Hand over the vault chore you keep putting off.</b>
</p>

<p align="center">
  An AI coding agent that lives in an Obsidian side panel and actually edits your notes.<br>
  Not a chat box that hands you text to paste back.
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FYoungSx%2Fpiem%2Fmaster%2Fmanifest.json&query=%24.version&label=version&color=7c3aed">
  <img alt="Minimum Obsidian version" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FYoungSx%2Fpiem%2Fmaster%2Fmanifest.json&query=%24.minAppVersion&label=Obsidian&prefix=%E2%89%A5&color=7c3aed">
  <img alt="Mobile is first class" src="https://img.shields.io/badge/mobile-first%20class-7c3aed">
  <img alt="License" src="https://img.shields.io/github/license/YoungSx/piem?color=7c3aed">
</p>

<p align="center">
  English · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="assets/screenshots/errand-desktop.webp" alt="Obsidian with the example note on the left and Piem on the right, showing a hardware table, buying advice, and beginner steps.">
</p>

<p align="center">
  <sub>Your note on the left, the agent on the right. Reconstructed demo, real plugin file operations; UI shown in Simplified Chinese.</sub>
</p>

---

## ▶️ One errand, start to finish

You have a clipped article open. Saved months ago, never acted on. You type into
the side panel:

> **Based on this note, recommend a beginner's hardware list with buying advice.**

<p align="center">
  <img src="assets/screenshots/errand-trace.webp" width="620" alt="Piem's transcript: two expanded groups combine three thinking steps with read, write and edit tool receipts; the edit shows a plus-four-minus-zero diff, followed by the reply.">
</p>

*Current UI captured in an isolated Obsidian demo vault. The conversation is scripted;
the plugin's read, write and edit tools actually ran.*

It read the note. Wrote a new one beside it — hardware table, buying
advice, beginner steps. Then went back to the original and added a
`[[wikilink]]` pointing at the new note, so the graph knows they belong
together.

Two files touched: **a hardware checklist saved, a backlink added (+4 −0 on the
original).** Thinking and tool calls share folded groups; open one to see each
step. The reply names the notes it changed.

You never opened a file. You read the receipt and got on with your day.

That is the whole idea. Piem has hands — [two dozen vault tools](docs/tools.md) —
and it uses them.

## ☕ If it just saved you an afternoon

Piem is free, MIT licensed, and staying that way. It is one person's
evenings-and-weekends project. If it just did an hour of work you had been
dreading, coffee is a fair trade.

<p align="center">
  <a href="https://ko-fi.com/shangxin"><img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="Support the author on Ko-fi"></a>
</p>

<p align="center"><sub>疯狂星期四，V 我 50。🍗</sub></p>

## 🧰 What else it has in hand

|  |  |
| --- | --- |
| **Two dozen vault tools** | read, search, write, edit, move, trash, walk links, rewrite frontmatter, sweep tasks, drive the editor — [see them all](docs/tools.md) |
| **Subagents, in parallel** | hand off a self-contained task; isolated transcript, capped at three levels by construction, not by a check — [how they work](docs/tools.md#subagents) |
| **MCP servers** | remote tools merge into the agent's own tool set, name-spaced so a transcript never lies about where a tool came from — [connect one](docs/extending.md#mcp-servers) |
| **Skills** | reusable instructions from bundled, from your vault, or from the `~/.pi` folders you already use with pi. Type <kbd>/</kbd> — [write one](docs/extending.md#skills) |
| **Context that follows you** | the note you have open — path and body — rides along with every turn, and the conversation compacts itself when the window fills |
| **Actions where you need them** | an empty panel offers first moves shaped by your open note; every reply offers copy, insert at cursor, append to the note, or ask again in place |
| **Your endpoint, your key** | any OpenAI-compatible or Anthropic-messages base URL, sixteen presets to start from, capabilities auto-filled — [configure it](docs/settings.md#models) |
| **Images** | paste or drop them into the composer and they ride along |
| **English & 简体中文** | follows Obsidian's own language, with an override when you want otherwise |

## ⏱️ Up and running in five minutes

**1. Install it.** Easiest path is [BRAT](https://github.com/TfTHacker/obsidian42-brat):
install BRAT from Obsidian's community plugins, then **Add beta plugin** →
`YoungSx/piem`. It handles updates for you.

Prefer to do it by hand? Grab `main.js`, `manifest.json`, and `styles.css` from
[the latest release](https://github.com/YoungSx/piem/releases/latest), drop them
into `<vault>/.obsidian/plugins/piem/`, reload Obsidian, and enable **Piem**
under **Settings → Community plugins**.

**2. Give it a brain.** Open **Settings → Piem → Models**, add a provider and an
API key. DeepSeek is the default suggestion; anything OpenAI-compatible or
Anthropic-messages works, and the **Test** button probes your endpoint over the
same transport your chats will use.

**3. Ask it something.** Command palette → **Piem: Open chat**. Then say the
thing you have been avoiding. <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Enter</kbd>
sends — or switch it to plain <kbd>Enter</kbd> in **General**.

Building from source instead? [CONTRIBUTING.md](CONTRIBUTING.md) has the five
commands.

## 📱 Your phone counts as a real computer

<p align="center">
  <img src="assets/screenshots/mobile-empty.webp" width="290" alt="Piem on a phone, empty panel: three suggested first actions and the composer, with the active note chip above it.">
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="assets/screenshots/mobile-done.webp" width="290" alt="Piem in Obsidian's official phone emulation after the reconstructed errand, showing the saved checklist and backlinks.">
</p>

<p align="center">
  <sub>Left: an earlier capture on a phone. Right: the updated demo in Obsidian's official phone emulation.</sub>
</p>

Piem ships with `isDesktopOnly: false` and means it. Tools, subagents, skills,
images — all of it works on a phone. So does streaming, once you turn it on.

That commitment costs something, and it is worth knowing what.

**MCP servers are remote only.** A stdio transport would spawn child processes
and a phone cannot. A capability that cannot exist on mobile gets refused for
everyone rather than shipped as a desktop-only surprise.

**Token-by-token streaming is off by default.** Obsidian's `requestUrl` is the
only request path free of CORS on every platform, and it has no incremental
read at all — a reply lands whole, when it finishes. Real streaming means the
browser's own `fetch`, which most endpoints do accept; it is one setting away
(Models → Network → Network transport). It stays the non-default because
whether it works is the endpoint's call rather than ours, and a locally hosted
model usually has to be told to allow it.

## 🔓 Before you install: it edits without asking

**There is no confirmation step before `write` or `edit`.** No dialog, no diff
to approve. You ask, and your notes change.

That is deliberate, and it is the deal: an agent that asks permission twelve
times is an agent you stop using. What it asks of you in return:

- point it at a vault you are willing to have changed, and to have **sent to
  your model provider** — a search that touches a file sends that file;
- read the transcript afterwards. Every change came from a tool call, and every
  tool call is right there, in the open;
- keep the vault in version control, or lean on Obsidian's file recovery.
  `trash_note` goes through Obsidian's trash, so deletions come back the
  ordinary way.

Your API keys are sealed with your OS keychain on desktop, and stored in
plaintext on mobile — because there is nothing to seal with there, and saying so
is better than implying otherwise. Release builds carry
[signed provenance](https://github.com/YoungSx/piem/attestations), so the bytes
you downloaded can be traced back to this repo.

Error reports and performance data go to Piem's maintainers by default; you can
turn sharing off in **Extensions**. Content capture is off, but error messages may
include note text. [Security and privacy](docs/security.md) explains what is sent.

## 📚 Go deeper

| | |
| --- | --- |
| [**The agent's tools**](docs/tools.md) | Every tool, what it cannot do, and how subagents work |
| [**Extending Piem**](docs/extending.md) | Skills, prompt templates, MCP servers |
| [**Settings**](docs/settings.md) | Providers and models, chat behavior, commands, where sessions live |
| [**Security and privacy**](docs/security.md) | What leaves your vault, where keys live, the capabilities Obsidian's review flags |

Contributing? [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow,
[AGENTS.md](AGENTS.md) for the conventions.

## 🙏 Standing on shoulders

Piem runs on [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi-mono),
the pi agent runtime — which is why the skills you already wrote for pi work
here unchanged.

It grew from [`lhr0909/pi-obsidian`](https://github.com/lhr0909/pi-obsidian).
Thank you for that starting point.

MIT licensed. Third-party notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
