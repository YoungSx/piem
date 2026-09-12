# Screenshots

Captures from Obsidian, used by both READMEs. Not HTML renders: the preview
harness in `scripts/preview-visual.mjs` produces measurement pages (three panel
widths side by side, no Obsidian chrome), which is the right tool for checking
layout and the wrong one for showing someone what the plugin is.

For the native typography update on 2026-09-12, three transcript images were
retaken in a disposable vault. They reconstructed the earlier Pico 2 W /
DualSense example: *"based on this note, recommend a beginner's hardware list
with buying advice."* The prose was a fixture, not a new model response; the
installed plugin's real read, write and edit tools created the notes and their
receipts, loaded through the native session manager and ChatApp. The model picker
labels that reconstruction. The desktop overview and finished phone image were
retaken again after the shared input-frame change, using the same scripted
example and real tool receipts. `mobile-empty.webp` now shows the draft before
sending: a skill card and the source note reference inside that input frame.
Its historical filename is retained so existing documentation links keep working.

`errand-trace.webp` was replaced later on 2026-09-12 with a separate example in
an isolated demo vault using the current plugin's mixed activity groups. Its
conversation text is scripted; the shipped `read`,
`write` and `edit` tools actually ran against the notes, and both files were read
back to verify their contents. It is a real Obsidian capture of that example,
not a replay of either earlier conversation or a new model response. Two groups
are open to show three thinking steps alongside the tool receipts, including
the original note's `+4 −0` edit. Both READMEs disclose the source beside the image.

| File | Shows | Captured at |
| --- | --- | --- |
| `errand-desktop.webp` | Full window: the reconstructed note on the left, hardware table and buying advice on the right | 1400px wide, light theme |
| `errand-trace.webp` | The transcript: two open groups combining thinking with read/write/edit calls, the `+4 −0` diff, and the reply | 754px wide, light theme |
| `mobile-empty.webp` | Before sending: a skill card and note reference inside the text input | 390px viewport, light theme |
| `mobile-done.webp` | Reconstructed errand finished, in Obsidian's official phone emulation | 390px viewport, light theme |

The phone emulation is desktop Obsidian in its native mobile mode, not an
iOS/Android hardware test. No phone status bar or controls were composited into
the capture. The old byte count is not carried forward: it belonged to the old
session, and the new receipts come from the operations actually executed.

The UI is in Simplified Chinese, which the English README notes in a caption —
it follows Obsidian's own language, so a Chinese capture is evidence the
bilingual UI is real rather than a claim in a feature table.

## Retaking one

A UI change that makes one of these a lie is not finished until the capture is
retaken. Shoot at the same widths, same theme, from a vault with real notes in
it — a screenshot of an empty vault or `Untitled 1.md` undoes the whole reason
these are here.

Then convert. PNG from a screenshot tool is several times the size of WebP at
the same visual quality, and these ship in a git repository forever:

```bash
ffmpeg -i shot.png -vf scale=1400:-1:flags=lanczos -c:v libwebp -quality 88 \
  -compression_level 6 assets/screenshots/errand-desktop.webp
```

Keep the whole folder well under a megabyte. Check the small Chinese glyphs in
the result before committing — they are the first thing to smear if the quality
setting is too low.
