# Screenshots

Captures from Obsidian, used by both READMEs. Not HTML renders: the preview
harness in `scripts/preview-visual.mjs` produces measurement pages (three panel
widths side by side, no Obsidian chrome), which is the right tool for checking
layout and the wrong one for showing someone what the plugin is.

The three transcript images were retaken on 2026-09-12 in a disposable vault
after the native typography change. They reconstruct the earlier Pico 2 W /
DualSense example: *"based on this note, recommend a beginner's hardware list
with buying advice."* The prose is a fixture, not a new model response; the
installed plugin's real read, write and edit tools created the notes and their
receipts, loaded through the native session manager and ChatApp. The model picker
labels the reconstruction. The empty state remains the earlier phone capture.

| File | Shows | Captured at |
| --- | --- | --- |
| `errand-desktop.webp` | Full window: the reconstructed note on the left, hardware table and buying advice on the right | 1400px wide, light theme |
| `errand-trace.webp` | The transcript: real write/edit receipts and links to the resulting notes | 754px wide, light theme |
| `mobile-empty.webp` | Phone, empty panel: quick actions shaped by the open note | 640px wide, light theme |
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
