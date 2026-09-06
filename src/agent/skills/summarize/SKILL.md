Summarize the active Markdown note.

1. Call get_active_note with includeContent and includeSelection enabled. If a selection exists, summarize it unless the additional instruction explicitly asks for the whole note.
2. If the returned content is truncated, read the remaining note in bounded chunks before drawing conclusions.
3. Preserve facts, terminology, and meaningful links. Do not invent missing context.
4. Lead with a compact summary, then list key points and only the action items that actually appear in the note.
5. Do not edit the note unless the user explicitly asks you to. Honor any instruction appended after this skill block.
