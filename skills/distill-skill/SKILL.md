---
name: distill-skill
description: "Turn a procedure you just completed into a reusable skill under Piem/skills/, once it has proven itself and the user approves the draft."
compatibility: Requires Piem's Obsidian vault tools.
---

# Distill Skill

Turn a procedure you just carried out into a reusable skill in the vault, so the
next conversation starts from it instead of rediscovering it. Memory records
*facts*; a skill records a *procedure*. Keep them apart: a fact that fits on one
line belongs in `Piem/memory/`, and only a repeatable sequence of steps earns a
file here.

## When a procedure has earned a skill

All three must hold. If one is missing, log the lesson to memory instead.

1. **It ran to completion at least twice**, or once with the user asking to keep
   it. A procedure you have performed a single time is a story, not a method.
2. **Rediscovering it is expensive** — it took several dead ends, a specific
   ordering, or a non-obvious constraint to get right.
3. **It generalizes past this instance.** Strip the note names, the dates, the
   one-off paths: if nothing is left, there was no procedure.

Never distill on your own initiative in the middle of the task it came from.
Finish the work first, then propose.

## Propose before writing

1. Retrace the actual run. Name the steps that were load-bearing and the ones
   that were noise — a wrong turn that had to be undone is not a step.
2. Show the user, in your own reply: the skill name, the one-line description,
   and the numbered steps. Nothing longer than a screen.
3. Ask for approval with `ask_user` — one call per turn, so several proposals
   ride as several questions inside it.
4. Only on approval, write the file.

## Write it

The file goes at `Piem/skills/<name>/SKILL.md`. Name the directory and the
frontmatter `name` identically — a mismatch loads under the frontmatter's name,
so the folder the user reaches for is the one that stops working. The name is
lowercase letters, digits, and single hyphens, no leading or trailing hyphen.

```
---
name: weekly-review
description: One line naming the task and when to reach for this. Required.
---

# Weekly Review

1. …
```

- `description` is what a future model matches against to decide whether to read
  the body at all. Write it as the trigger — the task and its occasion — not as
  a title. It is required and it is the one hard failure: a file without one is
  skipped in silence, no warning anywhere.
- Check the name against the skills already listed in `<available_skills>`. A
  vault skill silently replaces a bundled one of the same name — nothing warns,
  and the bundled instructions become unreachable. Pick a free name, or say
  plainly that you intend to replace that skill and get approval for it.
- The body is instructions, in the imperative, addressed to whoever runs it next.
  Number the steps in execution order.
- State what must **not** happen: the dead end you hit, the step that cannot be
  reordered, the thing to confirm before touching a file.
- Refuse to write secrets, absolute host paths, or anything specific to one note.
- Overwriting an existing skill needs its own approval. Read the current file
  first and show the user what changes.

The vault folder is re-read on every message, so a skill you just wrote is
listed for the next turn without reloading the plugin. Confirm it by name in
`<available_skills>`; if it is missing, the frontmatter is what failed.

## Keep them honest

A skill that no longer matches how the task is done is worse than no skill: it
is read with confidence and followed off a cliff. When you notice one has gone
stale — it names a tool that is gone, a folder that moved, a step the user has
since overruled — say so and propose the correction or its removal. Never
rewrite or delete a vault skill without approval.

## What does not become a skill

- A one-line fact, a preference, a correction: that is `Piem/memory/`, and the
  `vault-memory` skill owns how it gets written.
- A summary of a note, or of the vault. Link the note.
- A restatement of a tool's own description.
- Anything you have not actually run to completion.
