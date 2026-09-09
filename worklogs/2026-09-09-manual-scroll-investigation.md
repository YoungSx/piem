# Manual chat scrollbar investigation

Status: unresolved. This change provides an opt-in evidence recorder, not a
scrolling fix. No plugin behavior or release artifact is changed.

## User's confirmed symptom

After two turns, the right scrollbar thumb stops partway down its track. Releasing
and grabbing it again still stops at the same position. **Latest reaches the true
bottom.** The original screenshot shows second-turn content below the first turn;
it is not evidence that the content disappeared. It is also not merely a failure
to follow streaming output automatically.

The initial investigation reproduced a separate automatic-follow defect during
asynchronous Markdown rendering and proposed a hook/CSS rewrite. Those changes
were not demonstrated to repair this manual-drag failure and have been removed
from this branch. Their local patch and files are retained outside the repository
for a separate, accurately scoped follow-up.

## What was tested

The published Piem 1.0.67 bundle was loaded into isolated synthetic vaults. Its
stylesheet matched baseline `46234cc` by SHA-256. Real Markdown rendering and
real plugin/service paths were exercised with a local in-memory model stream;
no external model service or user's vault was involved.

| Runtime | System | Result |
| --- | --- | --- |
| Obsidian 1.13.7, Electron 43.3.0, Chromium 150.0.7871.212 | Linux / Xvfb | System mouse dragging via xdotool and CDP dragging reached the bottom at 100% and 125% app zoom. |
| Obsidian 1.13.7 app package with the older installer from 1.8.10, Electron 34.5.2, Chromium 132.0.6834.210 | Linux / Xvfb | System mouse dragging reached the bottom at both zoom levels; persistent halfway clamping was not reproduced. |

Message-component fixtures also covered tool-status rows, continuous content
growth, growth stopping, viewport changes, and plain-text-to-Markdown replacement.
They did not reproduce a manual limit persisting across a second grab. Some
synthetic drags missed their intended thumb when the app zoom or layout changed;
these were rejected as harness errors, not counted as reproductions.

The user's screenshot is from Windows. Linux results do not validate that
environment. The installer version, theme, display scaling and an event/geometry
recording from the failing state are still needed.

## Source and API findings

- Baseline `MessageList`'s scroll handler reads offsets and changes follow state;
  it does not clamp the thumb or write a stored maximum offset. Position writes
  are limited to automatic follow and the Latest button.
- `PiemChatView` mounts React on `ItemView.contentEl` and unmounts it on close,
  matching [Obsidian's documented React pattern](https://docs.obsidian.md/Plugins/Getting+started/Use+React+in+your+plugin).
- [MarkdownRenderer.render](https://docs.obsidian.md/Reference/TypeScript+API/MarkdownRenderer/render)
  appends asynchronously. This matters to follow behavior but does not establish
  why dragging would be limited while script scrolling still works.
- `overflow: clip` on the transcript and `container-type: inline-size` on the
  shell remain candidates for targeted layout/painting experiments. Neither has
  been proven to cause this report. Removing a property without reproducing the
  failure would not establish a clean fix.
- [Installer updates](https://help.obsidian.md/updates) are separate from app
  updates. A current app version alone does not identify its Chromium version.
- Chromium's themed scrollbar has an asynchronous injected-delta path:
  [MoveThumb and InjectGestureScrollUpdateForThumbMove](https://github.com/chromium/chromium/blob/150.0.7871.212/third_party/blink/renderer/core/scroll/scrollbar.cc).
  Source review did not find an exact matching upstream defect. The historical
  [361600661](https://issues.chromium.org/issues/361600661) geometry fix and
  [1175210](https://issues.chromium.org/issues/1175210) drag-jitter fix are leads,
  not diagnoses; their published conditions and outcomes differ from this report.

## Next evidence and validation boundary

`scripts/diagnose-chat-scroll.js` records bounded input events and geometry before
and after the user selects Latest. It never scrolls, changes CSS, reads message
text, sends data, or writes to the vault. It stops on the main scroller's
`scrollend`, a short post-click deadline, an explicit `stop()`, or 60 seconds.
Its bilingual instructions explain that reading layout itself may alter timing.

Tests cover sensitive-content omission, bounded event storage, absence of layout
reads on pointer moves, observer/listener cleanup, startup rollback, duplicate
injection, pop-out document selection, ambiguous panels and descendant scrollend.
A real Obsidian smoke recorded a Latest transition from 150 to 1760 px and
stopped at `latest-scrollend`. This verifies the **recorder**, not the reported
manual-scrollbar bug.

All test application/browser processes were owned by bounded launchers and
terminated/reaped. Generated applications, screenshots and diagnostic reports are
kept outside version control. The PR stays draft until the original failure has
been reproduced or sufficiently captured and a corresponding fix verified.
