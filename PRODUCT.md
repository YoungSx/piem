# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary — the vault keeper.** A heavy Obsidian user whose vault has outgrown
manual upkeep: duplicate notes, broken links, inconsistent frontmatter, a
reading list nobody has reconciled in a year. They do not write code and do not
want to write a script. They sit inside Obsidian with the side panel open and
want something that will *do the edit*, not describe it.

**Secondary — the terminal-agent user.** Someone already running Claude Code,
Codex, or pi in a terminal who wants the same working style pointed at their
notes, with the same skill folders (`~/.pi/agent/skills`, `~/.agents/skills`)
already in place.

Confirmed 2026-09-02: both audiences are in scope, and the vault keeper leads.
Mechanism detail (subagents, MCP, tool inventory) is second-position material,
not the opening claim.

## Product Purpose

Put a coding agent that actually edits inside an Obsidian side panel, working
the vault through vault-scoped tools — read, search, write, edit, move, trash,
link-walk, frontmatter — instead of handing back text for the user to paste.

Success is one shape: the user hands over a chore they had been avoiding, comes
back, and reviews a diff rather than redoing the work.

## Positioning

Not a chat box with vault context stuffed into the prompt — an agent with a
tool set and the authority to use it. What a neighboring plugin could not
truthfully copy today:

- **Parallel subagents** with isolated transcripts, capped by construction at
  parent → child → grandchild (the grandchild's tool set simply omits the spawn
  tools).
- **Remote MCP servers** whose tools merge into the agent's own tool set,
  namespaced `mcp_<server>_<tool>` so a transcript reader can always tell
  remote from local.
- **Three-tier skills** — bundled, vault (`Piem/skills/`), and user-level pi
  directories — later tiers shadowing earlier ones, read fresh from disk each
  turn.
- **Mobile as a first-class target** (`isDesktopOnly: false`), which is *why*
  stdio MCP is refused: it would spawn child processes.
- Built on `@earendil-works/pi-agent-core`, so it shares pi's skill format and
  session-log shape rather than inventing private ones.

## Operating Context

- Runs as an Obsidian community plugin, desktop (Electron) and mobile, in a
  right side panel next to the note being worked on.
- The active note's path and body are injected into every turn; the agent also
  reaches the editor (cursor insert, goto location, open note, side panel).
- The user brings their own provider endpoint and key — any OpenAI-compatible
  (completions or responses) or Anthropic-messages base URL. DeepSeek is the
  default suggestion, not a hosted service.
- Sessions persist as pi-compatible JSONL under the plugin's config dir; unsent
  composer drafts survive panel close and conversation switch.
- Two UI languages, English and Simplified Chinese, following Obsidian's own
  language with a manual override.

## Capabilities and Constraints

- Chat side panel: streaming, mid-turn abort, thinking-level and model switching
  in the header, context-window gauge, multiple conversations, per-chat drafts,
  image attachments, reply actions, quick actions, `/` skill and template
  autocomplete.
- Automatic compaction when the context window fills, plus a manual tidy command.
- **No confirmation step before `write`/`edit`.** The agent modifies notes
  immediately. This is a product fact, not a gap to hide; the user reviews the
  transcript afterward. (Ruled out of scope as a feature request; see the
  project memory on the approval gate.)
- Tool paths are vault-relative; absolute paths, `..` escapes, and the plugin's
  own folder are rejected.
- Keys are sealed with Electron `safeStorage` on desktop, plaintext on mobile
  and keyring-less desktops; sealed keys do not survive vault sync to another
  device.
- Capabilities Obsidian's community review reports explicitly — direct
  filesystem access for user-level skills, vault enumeration, outgoing
  clipboard, runtime base64, ~20 network call sites through one transport —
  are documented in the project's own words and must stay findable in the repo.
- The version lives in `manifest.json` and nowhere else; `npm run check:version`
  fails the build on a version literal in the docs.

## Brand Commitments

- Name **Piem**. Icon at `assets/icon.png` — glowing white hair on transparency.
- MIT licensed. Grew from `lhr0909/pi-obsidian`; that acknowledgement stays.
- English README with a Simplified Chinese mirror (`README.zh-CN.md`), and any
  doc split from them mirrors the same way.
- **Voice, confirmed 2026-09-02:** warm and human, never dry. Emoji and badges
  are welcome in measured amounts. The reader should not feel like they are
  reading a spec sheet.
- **The tip jar sits high and visible**, not buried at the bottom, and keeps its
  joke in Chinese (疯狂星期四，V 我 50). Confirmed 2026-09-02.

## Evidence on Hand

- **Real rendered UI, no photography needed:** `scripts/preview-visual.mjs`
  mounts the shipped React components against the shipped `styles.css` and
  writes standalone pages; `scripts/measure-visual.mjs` screenshots them with
  Chromium. Between them they cover the empty screen, a conversation, trace
  rows, streaming, a failed turn, a panel blocked on a missing key, an armed
  edit, the context popover, the three `ask_user` states, both subagent
  surfaces, and the tidying seam. The list itself lives in that script's
  `SCENARIOS` and is deliberately not copied here — a second copy goes stale
  the first time someone adds one. Caveat: most pages render three panel
  widths side by side for measurement and carry no Obsidian chrome (no ribbon,
  no tab bar), so they read as diagnostics rather than product shots; the
  `tidy-seam` page is the exception, a contact sheet across one row's states,
  both languages and both themes.
- **Four real captures, from a real vault** (`assets/screenshots/`, embedded in
  both READMEs): one errand carried out on desktop and again on a phone, plus
  the transcript alone. Decided 2026-09-02 and shot since. Still absent: a demo
  video, install counts, user numbers, and a capture of the subagent inspector —
  `docs/tools.md` carries a labelled placeholder for that one.
- Must not be invented: download or user counts, benchmarks, latency figures,
  named users, comparative claims against other plugins, or any capability the
  tool list does not contain.

## Product Principles

1. **The agent acts; the transcript is the receipt.** Every claim about what
   Piem does should be something a reader could verify in a transcript.
2. **Mobile is not a degraded mode.** A capability that cannot exist on mobile
   is refused for everyone rather than shipped as a desktop-only surprise.
3. **Name every destination.** Models use the user's endpoint and key. Error and
   performance reports go to Piem's fixed gateway by default, with an immediate
   off switch and the data disclosure in `docs/security.md`.
4. **Say the sharp part out loud.** No approval gate, vault enumeration, and
   plaintext keys on mobile are disclosed in the product's own voice rather
   than left for a reviewer to find.
5. **Warmth is not decoration.** The writing carries a person; that is a
   product property, held to the same standard as the code.

## Accessibility & Inclusion

- Copy is gated: `npm run check:copy` walks the AST and fails on a user-visible
  string literal outside the i18n tables — including `aria-label`s, which is
  the defect class that motivated the gate.
- The chat panel is exercised at 300px sidebar, 390px phone, and 560px wide-leaf
  widths; the message column must never scroll sideways while every oversized
  construct keeps a scrollbar of its own.
