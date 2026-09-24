# Obsidian smoke rig

[← Extending Piem](extending.md) · [简体中文](obsidian-smoke-rig.zh-CN.md)

The `smoke-*-obsidian.mjs` scripts verify piem against a **real Obsidian
runtime** on a virtual desktop — the only layer that can see native dialogs,
the plugin sandbox, restricted mode, mobile emulation, and cold-start timing.
happy-dom previews and unit tests cannot stand in for it.

The setup ritual used to live in session scratch directories, so every new
session re-derived it and re-hit the same pitfalls. `scripts/obsidian-rig.py`
is now the one command that does it all:

```bash
# Run a full desktop + mobile smoke pass against a disposable rig
python3 scripts/obsidian-rig.py "$PWD" ~/piem-rig-smoke 9333 \
  --download \
  --smoke scripts/smoke-rpiv-todo-obsidian.mjs

# Bring the rig up and drive it manually over CDP (Ctrl-C tears it down)
python3 scripts/obsidian-rig.py "$PWD" ~/piem-rig-probe 9333 --download
```

The manager builds the plugin (esbuild production), deploys `main.js`,
`manifest.json`, and `styles.css` into a disposable vault, registers that
vault in a fresh profile so the app skips the picker, launches Xvfb and
Obsidian with CDP open, unlocks the community-plugins master switch, waits
for `agentService`, applies focus emulation, then runs the smoke's desktop
pass and — when the smoke supports `--expect-mobile`, detected from its
source — the official mobile-emulation pass at 390×844. Teardown kills the
whole process group and reaps strays through `/proc`.

## Options

| Option | Effect |
| --- | --- |
| `--smoke <script>` | Run this smoke after the rig is up; omit to hold for manual CDP driving |
| `--download` | Fetch the pinned aarch64 build (`obsidian-1.13.7-arm64.tar.gz`) into `<root>/runtime` when no runtime is found |
| `--obsidian <path>` | Use a specific Obsidian binary instead of the known-location search |
| `--skip-build` | Deploy the existing `main.js` instead of building; a fresh worktree has none, so build first |
| `--data <file>` | Seed the vault plugin's `data.json`; model-talking smokes need a provider row with `activeModelId` |
| `--display :N` | Xvfb display (default `:114`) |

Prerequisites: this host is aarch64 — the amd64 `.deb` cannot run here, use
the arm64 tarball. Xvfb and Node ≥ 22 must be installed. A fresh worktree
needs `node_modules` (hard-link from the main checkout — do not run a full
install, it rewrites the lockfile and upgrades TypeScript).

`scripts/run-smoke-proactive.py` predates the manager and drives the proactive
smoke with its own copy of the ritual; prefer the manager for anything new.

## Pitfalls the manager already handles — read this before debugging

Every item below once masqueraded as a product bug. All of them are rig
facts, not piem facts.

1. **CDP must target `index.html`.** `/json/list` can also serve
   `starter.html`, whose `window.app` is a plugin-less shim: every evaluate
   returns `{}` or times out. The manager locks on
   `url.startsWith('app://') && url.includes('index.html')`.
2. **A fresh profile needs `obsidian.json`** with the vault registered and
   `"open": true`, or the app boots into the vault picker and never loads a
   plugin.
3. **The plugin unlock is a two-gate, both silent.** The community-plugins
   master switch lives in localStorage; while it is off, `loadPlugin`
   silently no-ops. The manager runs `setEnable(true)` +
   `enablePluginAndSave('piem')`, then verifies `agentService` — not the
   plugin shell, whose presence without the service is the classic false
   green.
4. **Cold start is slow.** On a pristine vault the service can take >30s;
   the manager allows 90s. Don't shorten it.
5. **Xvfb windows are never focused**, and an unfocused renderer throttles
   timers and SSE settling until a reply lands tens of seconds late — which
   reads as a hung run. The manager applies
   `Emulation.setFocusEmulationEnabled` for you.
6. **`Emulation.setDeviceMetricsOverride` outlives `emulateMobile(false)`.**
   Going back to desktop needs an explicit `clearDeviceMetricsOverride`;
   the manager clears it at teardown.
7. **`Runtime.evaluate` rejects a bare `await`** — a syntax error swallowed by
   drivers. Wrap expressions in an async IIFE.
8. **Model mocks need CORS and a terminating chunk**: an OPTIONS preflight
   answered 204 + `Access-Control-Allow-Origin: *` on responses, and a final
   block with `finish_reason:"stop"` — without it pi-ai throws "Stream ended
   without finish_reason" and the panel shows a fake provider failure. Use
   `--data` to seed a provider with `activeModelId`; `normalizeSettings`
   silently drops custom providers that lack one.
9. **Never `pkill -f` this rig.** The pattern matches your own shell's
   command line and the kill lands on you (exit 144, output lost). Kill by
   PID or let the manager's `/proc`-based teardown do it.
10. **Build before judging.** A fresh worktree has no `main.js`; every
    bundleLoad test goes false-red until esbuild runs.
11. **The rig directory is disposable but the machine is shared.** Before
    killing anything on a pre-existing port/display, check whether another
    session is flying it: compare the plugin version reported in-app, PIDs,
    and file timestamps first.

## Smoke inventory

| Script | Covers |
| --- | --- |
| `smoke-community-obsidian.mjs` | Community extension bridge against shipped services |
| `smoke-research-extensions-obsidian.mjs` | Research/clarify extensions end-to-end |
| `smoke-extension-ui-obsidian.mjs` | Native dialogs, composer, lifecycle, model requests |
| `smoke-generic-bridge-obsidian.mjs` | Generic bridge contract |
| `smoke-background-bridge-obsidian.mjs` | Background factory bridge (production copy in test vault) |
| `smoke-session-obsidian.mjs` | Session store round-trip (desktop only) |
| `smoke-bookmark-obsidian.mjs` | Bookmark adapter |
| `smoke-rpiv-todo-obsidian.mjs` | `@juicesharp/rpiv-todo` bridge with Node-access negatives |
| `smoke-typography-obsidian.mjs` | Typography in real render (has `--baseline` instead of mobile) |
| `smoke-proactive-obsidian.mjs` | Proactive intelligence (use its dedicated `run-smoke-proactive.py`) |

For DOM-level visual work without Obsidian, use the preview harness instead
(`bun scripts/preview-visual.mjs` — bun, not node, because the stub uses
parameter properties; snap Chromium cannot read `/tmp`, keep probe pages
under `~/`).
