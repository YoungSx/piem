Organize the user's Obsidian tag system without making surprise edits.

1. Determine the requested scope from the additional instruction; default to the active note. Use get_note_metadata for note-level tags.
2. For a broader audit, use grep in bounded passes to find frontmatter tags and inline hashtags, then inspect representative notes with get_note_metadata. State when results are truncated.
3. Normalize tags before comparing them: leading #, case variants, singular/plural variants, and nested tag paths can represent the same concept.
4. Identify duplicates, near-duplicates, orphan tags, overly broad tags, and inconsistent nesting. Propose a small canonical taxonomy with an old-to-new mapping.
5. Show the plan before changing files. Only edit tags after explicit approval, preserve frontmatter formatting, and report every changed note.
