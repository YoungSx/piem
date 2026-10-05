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
12. **A fresh vault raises the "trust author" modal, and it holds the app in
    restricted mode.** `enablePluginAndSave` force-loads the plugin, so
    `agentService` appears and looks healthy — but while the modal stands the
    vault stays untrusted, the chat view renders its "Connect a model to
    start" empty state, and seeded settings never reach it (the model switcher
    freezes on the builtin fallback). The manager clicks the modal's "Trust
    author" CTA on every unlock poll, idempotently. Tell-tale if it regresses:
    `getSnapshot()` is correct but the mounted view is stuck on the default
    model.

## Smoke inventory

| Script | Covers |
| --- | --- |
| `smoke-codemode-obsidian.mjs` | Code Mode with local model/MCP fixtures: provider declarations, real Vault calls, cancellation, output limits, branch store and mobile Node access |
| `smoke-community-obsidian.mjs` | Community extension bridge against shipped services |
| `smoke-research-extensions-obsidian.mjs` | Research/clarify extensions end-to-end |
| `smoke-extension-ui-obsidian.mjs` | Native dialogs, composer, lifecycle, model requests |
| `smoke-generic-bridge-obsidian.mjs` | Generic bridge contract |
| `smoke-background-bridge-obsidian.mjs` | Background factory bridge (production copy in test vault) |
| `smoke-session-obsidian.mjs` | Session store round-trip (desktop only) |
| `smoke-durable-obsidian.mjs` | Harness tasks: interrupted real writes, plugin reload/recovery, Stop, read-only queries, and Node negative controls through the official phone loader |
| `smoke-native-adapters-obsidian.mjs` | Production durable smoke followed by native model/tool/storage adapters in a separate test plugin; real Vault writes, recovery copies, committed partials and event backpressure |
| `smoke-native-chat-obsidian.mjs` | Native chat in the real shipped UI (preview build): official `submit` → `GenerationTask` → `ToolTask`, interrupted real write, read-only reopen, Continue, Stop, and routing that never rewrites a native file |
| `smoke-bookmark-obsidian.mjs` | Bookmark adapter |
| `smoke-rpiv-todo-obsidian.mjs` | `@juicesharp/rpiv-todo` bridge with Node-access negatives |
| `smoke-typography-obsidian.mjs` | Typography in real render (has `--baseline` instead of mobile) |
| `smoke-proactive-obsidian.mjs` | Proactive intelligence (use its dedicated `run-smoke-proactive.py`) |
| `smoke-model-icon-obsidian.mjs` | Composer model-switcher vendor mark: paints, tracks the active model, absent for unknown vendors |

The native-adapters smoke builds `scripts/native-adapters-fixture.ts` into a
disposable plugin and loads it through Obsidian's official plugin loader. It uses
the original Pi write tool directly and bridges the installed Piem metadata tool.
Production and fixture hashes are recorded separately: passing this fixture does
not mean the production chat has switched to native execution. The report records
append counts/bytes, concurrent appends, sampled whole-renderer heap usage, and
snapshot recovery after withholding more than 100 event batches. These are small
fixture observations, not a device benchmark or a measurement of production UI lag.

The native-chat smoke is the only one that needs a non-default build:
`PIEM_NATIVE_CHAT_PREVIEW=1 npm run build`, size-gated with
`node scripts/check-bundle.mjs --native-preview`. That flag is what registers the
new-chat command and lets the shipped view mount a native session; point the
script at an ordinary build and the chat never opens, which reads as a smoke
failure rather than a missing flag. There is no fixture plugin here — the
assertions drive the real `main.js`, the real chat view and the real composer —
so a pass covers the production UI behind the preview flag, on the preview track
only. `--expect-mobile` applies the same constrained phone contract as the
durable smoke below.

The durable smoke further constrains the plugin-visible `Platform` app flags:
official phone emulation still reports `isDesktopApp: true`. Its report records
both the native and constrained flags. Six negative controls must be denied by
the real scoped plugin loader; only the plugin's platform API view is replaced,
not its bundle or the host. This exercises a restricted mobile contract on
desktop Chromium, not iOS WebKit or an Android device.

For DOM-level visual work without Obsidian, use the preview harness instead
(`bun scripts/preview-visual.mjs` — bun, not node, because the stub uses
parameter properties; snap Chromium cannot read `/tmp`, keep probe pages
under `~/`).
