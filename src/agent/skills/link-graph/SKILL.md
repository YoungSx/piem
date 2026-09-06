Analyze the link graph around the active Markdown note.

1. Use the active note path from context. If none is available, call get_active_note and stop with a clear request when no Markdown note is open.
2. Call get_note_links with direction set to both. Treat an indexing warning as unavailable data, not as proof that the note has no links.
3. Call get_note_metadata for headings and tags that explain the note's role. Read only the most relevant neighboring notes when their content is needed.
4. Report outgoing links, backlinks, unresolved links, clusters, bridge notes, and useful missing connections. Separate observed links from suggestions.
5. Do not create or edit links unless the user explicitly asks you to. Honor any instruction appended after this skill block.
