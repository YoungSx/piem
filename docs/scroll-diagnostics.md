# Capture a stuck chat scrollbar

[简体中文](scroll-diagnostics.zh-CN.md)

Use this when dragging the chat scrollbar stops partway down, including after
releasing and grabbing it again, but **Latest** still reaches the bottom. That
symptom is different from automatic following stopping. The cause is still under
investigation; this procedure collects evidence and does not install a fix.

## Capture once

1. Leave the chat at the stuck position. Open Obsidian's developer tools with
   **Ctrl+Shift+I** on Windows/Linux or **Cmd+Option+I** on macOS, then select
   **Console**. If opening the tools makes the problem disappear, report that;
   changing the window layout can affect this fault.
2. Copy the entire [diagnostic script](../scripts/diagnose-chat-scroll.js), paste
   it into the console and run it. Keep the chat panel visible. The script uses
   the focused Obsidian document, including a pop-out window.
3. Try dragging down, release, and try once more. Then select **Latest**. The
   console prints **Piem scroll report** after scrolling settles. If no report
   appears, run `piemScrollProbe.stop()`; it also stops automatically after
   60 seconds. Running `piemScrollProbe.stop()` again returns the same report.
4. Share the report and whether dragging still failed while recording. Include
   **Show debug info** from Obsidian's command palette, plus whether you changed
   Obsidian's zoom or the operating system's display scaling. Review the debug
   information before sharing; it is separate from this script's restricted
   report. A newer app version can still use an older installer and Electron:
   see [Obsidian's installer updates](https://help.obsidian.md/updates).

No plugin installation or rebuild is needed. Paste only the script linked above
after reviewing it; it does not download or execute additional code. This is
desktop developer tooling; it has not been validated in iOS or Android.

## What is recorded

The report includes browser/Electron versions, viewport size and scaling,
the chat scroller and at most seven ancestors' dimensions and relevant CSS,
scroll offsets, wheel input, navigation keys when the message viewport itself
has focus, pointer coordinates while dragging,
and counts of DOM changes and resize notifications. It keeps at most 240 events
plus 24 input boundaries. It never reads chat text, note names, paths, input
values, keys typed into the composer, credentials, or arbitrary DOM attributes.
It makes no network requests and does not write to the vault or clipboard.

The script does not scroll or alter the page. Stopping disconnects its observers,
removes its listeners, clears its timers and releases the sampled DOM references.
Pasting it again stops the previous recording before starting another one.

## Reading the evidence

- Compare `beforeLatest[0].scrollTop` with `final[0].scrollTop`: a farther final
  offset records movement after Latest. Wheel and recorded navigation-key events
  during the interval are listed too; do not assume the click was the sole cause.
  Navigation keys on a focused link or disclosure are not recorded.
- `scrollHeight - clientHeight` is the current script-visible range. A native
  drag that stops earlier, with Latest reaching farther, needs a drag/hit-test
  investigation rather than a missing-content diagnosis.
- Ancestor ranges and clipping/containment styles help distinguish the message
  scroller from an outer scrollbar. Arbitrary theme classes and note attributes
  are deliberately excluded.
- Missing pointer events do not prove the drag missed: browser scrollbar UI can
  consume them. A zero resize count does not prove content stayed the same size;
  image/font loading can change scroll height without resizing the viewport.
- The initial, pre-Latest and final snapshots read layout; those reads can cause
  a pending layout to complete. Mouse-move sampling avoids geometry reads, but
  even reading a scroll offset may affect timing. Report if recording itself
  makes the symptom disappear. This probe supplies evidence, not a diagnosis.

The script is not bundled into Piem and never starts automatically.
