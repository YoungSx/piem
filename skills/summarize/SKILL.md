---
name: summarize
description: "Summarize the active note or selection without changing it. Use when the user asks for a summary, TL;DR, or overview of what they are reading."
compatibility: Requires Piem's Obsidian vault tools.
---

Summarize the active Markdown note.

1. Call get_active_note with includeContent and includeSelection enabled. If a selection exists, summarize it unless the additional instruction explicitly asks for the whole note.
2. If no note is open, say so and ask which note to summarize — do not guess from recent files.
3. If the returned content is truncated, read the remaining note in bounded chunks before drawing conclusions.
4. Reply in the language of the conversation, not the note's language.
5. Preserve facts, terminology, and meaningful links. Do not invent missing context.
6. Lead with a compact summary, then list key points and only the action items that actually appear in the note. Length scales with the note: a short note gets a short summary, not padded structure.
7. Do not edit the note unless the user explicitly asks you to. If they ask to save the summary, use insert_at_cursor or ask where to put it. Honor any instruction appended after this skill block.
