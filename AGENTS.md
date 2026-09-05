# Obsidian community plugin

## Project overview

- Target: Obsidian Community Plugin (TypeScript → bundled JavaScript).
- Entry point: `main.ts` compiled to `main.js` and loaded by Obsidian.
- Required release artifacts: `main.js`, `manifest.json`, and optional `styles.css`.

## Environment & tooling

- Runtime: Bun (this project is bun-first). Node.js current LTS also works for the esbuild bundle step.
- **Package manager: bun** — install deps with `bun install`; `bun.lock` is the committed lockfile.
- **Test runner: bun test** — tests use `bun:test`, not Vitest or Jest.
- **Bundler: esbuild** (required for this sample - `esbuild.config.mjs` and build scripts depend on it). Alternative bundlers like Rollup or webpack are acceptable for other projects if they bundle all external dependencies into `main.js`.
- Types: `obsidian` type definitions.

**Note**: `build` and `lint` stay as npm scripts because they shell out to `tsc`, `esbuild`, and `eslint`; dependency install and tests go through bun.

### Install

```bash
bun install
```

### Dev (watch)

```bash
npm run dev
```

### Production build

```bash
npm run build
```

### Test

```bash
bun test
```

### Rendered layout check (opt-in, needs Chromium)

`bun test` runs on happy-dom, which does no layout: it can assert that a rule
*declares* `text-overflow: ellipsis`, never that the right span is the one that
truncates in a 300px sidebar. For CSS whose correctness is a layout consequence,
four `preview`/`measure` pairs answer that in a real engine:

```bash
node scripts/preview-command-menu.mjs   # writes .preview/command-menu.html
node scripts/measure-command-menu.mjs   # measures it, exits non-zero on regressions

node scripts/preview-transcript.mjs     # writes .preview/transcript.html
node scripts/measure-transcript.mjs     # asserts the message column never scrolls sideways

node scripts/preview-ask-user.mjs       # writes .preview/ask-user.html
node scripts/measure-ask-user.mjs       # asserts marker centring, one text column, contrast floors

node scripts/preview-visual.mjs         # writes one page per scenario + visual-manifest.json
node scripts/measure-visual.mjs         # screenshots every page the manifest names
```

They split into two kinds, and the difference matters when you add one. The first
three extract their rules *from* `styles.css` rather than restating them, and
restate the *markup* — so the styling cannot drift from what ships, and the guards
in each script cross-check every class the pictures depend on against the component
that emits it. `preview-visual.mjs` gives up nothing to drift at all: it mounts the
shipped React components in happy-dom and loads the whole shipped stylesheet, so a
spacing defect in a component is a defect in the page. It pays for that with
scenario setup — a scenario has to drive the real service — and it screenshots
rather than asserts, so it is for looking, not for gating.

None of them are part of `npm run verify` — Chromium is not a project dependency —
so the invariants worth keeping green in CI are mirrored as structural gates in
`src/ui/panelA11y.test.ts` and `src/ui/transcriptOverflow.test.ts`. Motion needs
one of those mirrors more than most: a still frame cannot tell a paused animation
from a running one, so `check:css` reads the stylesheet for an `animation` whose
keyframes do not exist (and for keyframes nothing names) — the half-done rename
that silently stopped `.piem-chat__subagents-button--running` from breathing. Override the
browser with `CHROME=` (`CHROMIUM_BIN=` for `measure-visual.mjs`); a snap-packaged
Chromium cannot read a checkout under a dotted path (`~/.paseo/...`), which
`PREVIEW_DIR=` works around.

The transcript harness renders three panel widths (300px sidebar, 390px phone,
560px wide leaf) and asserts two things that have to hold together: the message
column never scrolls horizontally, *and* every construct wider than the column
still has a reachable scrollbar of its own. Only the pair is meaningful —
clipping the column alone would pass the first check while silently truncating
tables. Its fixtures are deliberately pathological (96-character tokens, a
1400px image), because a construct that merely might overflow proves nothing
about the case `pre-wrap` fails on.

## Linting

- Run the project's lint script: `npm run lint` (wraps `eslint .` with the flat config in `eslint.config.mts`).
- eslint will then create a report with suggestions for code improvement by file and line number.
- If your source code is in a folder, such as `src`, you can use eslint with this command to analyze all files in that folder: `eslint ./src/`

## File & folder conventions

- **Organize code into multiple files**: Split functionality across separate modules rather than putting everything in `main.ts`.
- Source lives in `src/`. Keep `main.ts` small and focused on plugin lifecycle (loading, unloading, registering commands).
- **Example file structure**:
  ```
  src/
    main.ts           # Plugin entry point, lifecycle management
    settings.ts       # Settings interface and defaults
    commands/         # Command implementations
      command1.ts
      command2.ts
    ui/              # UI components, modals, views
      modal.ts
      view.ts
    utils/           # Utility functions, helpers
      helpers.ts
      constants.ts
    types.ts         # TypeScript interfaces and types
  ```
- **Do not commit build artifacts**: Never commit `node_modules/`, `main.js`, or other generated files to version control.
- Keep the plugin small. Avoid large dependencies. Prefer browser-compatible packages.
- Generated output should be placed at the plugin root or `dist/` depending on your build setup. Release artifacts must end up at the top level of the plugin folder in the vault (`main.js`, `manifest.json`, `styles.css`).

- **`README.md` is a showcase; `docs/` is the manual.** The README exists to make a
  new reader want the plugin: one real errand shown start to finish, screenshots,
  the tip jar high on the page, a five-minute setup, and links out. Reference
  material lives in `docs/` — `tools`, `extending`, `settings`, `security` — split
  by what a reader came to find out. When you are tempted to add a paragraph of
  detail to the README, that paragraph belongs in `docs/`; the README earned its
  length back once and will lose it again one honest paragraph at a time.
- **Both languages ship together.** `README.md` / `README.zh-CN.md` and every
  `docs/<name>.md` / `docs/<name>.zh-CN.md` are a pair. A change to one is not
  finished until the other matches — the Chinese side is a peer document, not a
  translation queue. Cross-links between docs use the reader's own language
  (`tools.zh-CN.md` links to `security.zh-CN.md`), and anchors differ per
  language, so check both after renaming a heading.
- **Screenshots are real, and they go stale.** `assets/screenshots/` holds real
  captures from a real vault, not renders; see its own README for what each one
  shows and how to retake it. A UI change that makes one of them a lie is not
  done until the capture is retaken.

## Manifest rules (`manifest.json`)

- Must include (non-exhaustive):  
  - `id` (plugin ID; for local dev it should match the folder name)  
  - `name`  
  - `version` (Semantic Versioning `x.y.z`)  
  - `minAppVersion`  
  - `description`  
  - `isDesktopOnly` (boolean)  
  - Optional: `author`, `authorUrl`, `fundingUrl` (string or map)
- Never change `id` after release. Treat it as stable API.
- Keep `minAppVersion` accurate when using newer APIs.
- Canonical requirements are coded here: https://github.com/obsidianmd/obsidian-releases/blob/master/.github/workflows/validate-plugin-entry.yml

## Testing

- Manual install for testing: copy `main.js`, `manifest.json`, `styles.css` (if any) to:
  ```
  <Vault>/.obsidian/plugins/<plugin-id>/
  ```
- Reload Obsidian and enable the plugin in **Settings → Community plugins**.

## Pull requests

- A PR must be **mergeable without conflicts** against the default branch. If
  the target branch has moved, rebase onto it and resolve before the PR is
  opened or marked ready.
- A PR must have **CI fully green** before being considered done. Do not
  hand the PR back while checks are failing or still running; fix and push
  until every check passes.
- Verify locally first (`npm run build`, `npm run lint`, `bun test`) so CI is
  a confirmation, not a discovery.

## Commands & settings

- Any user-facing commands should be added via `this.addCommand(...)`.
- If the plugin has configuration, provide a settings tab and sensible defaults.
- Persist settings using `this.loadData()` / `this.saveData()`.
- Use stable command IDs; avoid renaming once released.

## Versioning & releases

- **Release with `npm run release -- patch` (or `minor` / `major` / an explicit `1.2.3`).** It is the whole flow: bump, gates, commit, tag, push. Add `--dry-run` to stop before the commit and see what it would do.
- The bump is committed to `master` **before** the tag is cut, and the tag points at that commit. This ordering is the point, not an implementation detail: Obsidian's plugin-store bot reads the version out of the *default branch's* `manifest.json` and looks for a release tagged exactly that. The retired tag-only flow stamped the version inside CI's throwaway checkout and never wrote it back, so `master` sat at `0.1.0-alpha.9` while thirty-odd releases shipped past it — every one of them invisible to the store.
- Tags carry **no leading `v`**; Obsidian matches the manifest's version verbatim. The script writes the tag, so this cannot be got wrong by hand. Legacy `v*` tags stay on GitHub; don't add more.
- **The version lives in `manifest.json` and nowhere else.** `package.json` and `versions.json` are stamped from it; everything else must read it at runtime — `this.manifest.version` in a `Plugin` subclass, or a constructor argument for a module that is not one (see `McpManager`'s `pluginVersion`). `npm run check:version` fails the build on a hardcoded version anywhere under `src/`, in any markdown at the repo root, or anywhere under `docs/` — it enumerates the *roots* prose lives in rather than a list of files, so splitting a doc out never smuggles a version literal past it. `worklogs/` is deliberately out of scope: an entry there records what a release looked like the day it was written. Runs in both CI workflows.
- Why that gate exists: `src/mcp/mcpManager.ts` reported `{ name: "piem", version: "1.0.0" }` to every MCP server for two releases after 1.0.0, and both READMEs called a shipped 1.0.x plugin "early alpha (`0.1.0-alpha.x`)". Neither could fail any other gate, because nothing reads those strings back. The old `scripts/stamp-version.mjs` stamped a hardcoded list of three files, so a version in a fourth place was invisible to it by construction — which is why the gate enumerates where the version *may* live rather than where it must be written.

## Agent capability

This plugin's value is what the agent can actually do. A capability the user has
to find and switch on is a capability the agent does not have: the model reasons
about pages it cannot fetch and files it cannot reach, and the user reads the
result as the plugin being weak rather than as a setting being off.

So the default is capable:

- **Ship capabilities on.** A tool that is useful is registered and available. Do
  not add a setting whose only purpose is to withhold it.
- **Disclose instead of gating.** State what the capability does where the model
  and the user each meet it: the tool's own `description`, and a settings row that
  reads as a statement rather than a permission prompt.
- **Reserve toggles for the genuinely destructive**, and default those *on* too.
  A toggle is for the user who wants to narrow the agent, not a gate the agent
  must pass to be useful.
- **Guard, don't ask.** Where an operation must be bounded, enforce the bound in
  code and state it in the parameter's schema `description` so the model knows
  before it calls — see `src/tools/parameters.ts`. A refusal the model can predict
  costs nothing; one it discovers by calling costs a turn.

The bounds that stay absolute, because they protect the user's data rather than
restrict the agent's usefulness:

- Never execute remote code, fetch and eval scripts, or auto-update plugin code
  outside of normal releases.
- Stay inside the vault. Obsidian's Vault API is the address space; do not reach
  around it to the filesystem.
- No hidden telemetry. Nothing about the user's vault is collected for us.
- Clearly disclose external services used, data sent, and risks.
- Avoid deceptive patterns, ads, or spammy notifications.
- Register and clean up all DOM, app, and interval listeners using the provided
  `register*` helpers so the plugin unloads safely.

### Divergence from Obsidian's published guidance

Obsidian's **Developer Policies** and **Plugin Guidelines** ask for explicit
opt-in before a plugin calls a third-party service, written for plugins where the
network is incidental. Here it is the product: the agent is a model behind an API,
so a user who has configured a provider key has already opted into outbound
requests, and gating individual tools behind a second consent adds friction
without adding a decision.

This is a deliberate divergence, decided in #52 when `web_fetch`'s off-by-default
toggle was removed. Every other clause above is followed as written. If the
community-catalog review objects, the answer is better disclosure, not a return to
gating.

## UX & copy guidelines (for UI text, commands, settings)

- Prefer sentence case for headings, buttons, and titles.
- Use clear, action-oriented imperatives in step-by-step copy.
- Use **bold** to indicate literal UI labels. Prefer "select" for interactions.
- Use arrow notation for navigation: **Settings → Community plugins**.
- Keep in-app strings short, consistent, and free of jargon.

## Performance

- Keep startup light. Defer heavy work until needed.
- Avoid long-running tasks during `onload`; use lazy initialization.
- Batch disk access and avoid excessive vault scans.
- Debounce/throttle expensive operations in response to file system events.

## Coding conventions

- TypeScript with `"strict": true` preferred.
- **Keep `main.ts` minimal**: Focus only on plugin lifecycle (onload, onunload, addCommand calls). Delegate all feature logic to separate modules.
- **Split large files**: If any file exceeds ~200-300 lines, consider breaking it into smaller, focused modules.
- **Use clear module boundaries**: Each file should have a single, well-defined responsibility.
- Bundle everything into `main.js` (no unbundled runtime deps).
- Avoid Node/Electron APIs if you want mobile compatibility; set `isDesktopOnly` accordingly.
- Prefer `async/await` over promise chains; handle errors gracefully.

## Mobile

- Where feasible, test on iOS and Android.
- Don't assume desktop-only behavior unless `isDesktopOnly` is `true`.
- Avoid large in-memory structures; be mindful of memory and storage constraints.

## Agent do/don't

**Do**
- Add commands with stable IDs (don't rename once released).
- Provide defaults and validation in settings.
- Write idempotent code paths so reload/unload doesn't leak listeners or intervals.
- Use `this.register*` helpers for everything that needs cleanup.

**Don't**
- Add a setting whose only effect is to withhold a working capability from the
  agent. Disclose it instead — see **Agent capability**.
- Introduce network calls without an obvious user-facing reason and documentation.
- Store or transmit vault contents beyond the provider serving the active model.

## Common tasks

### Organize code across multiple files

**main.ts** (minimal, lifecycle only):
```ts
import { Plugin } from "obsidian";
import { MySettings, DEFAULT_SETTINGS } from "./settings";
import { registerCommands } from "./commands";

export default class MyPlugin extends Plugin {
  settings: MySettings;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    registerCommands(this);
  }
}
```

**settings.ts**:
```ts
export interface MySettings {
  enabled: boolean;
  apiKey: string;
}

export const DEFAULT_SETTINGS: MySettings = {
  enabled: true,
  apiKey: "",
};
```

**commands/index.ts**:
```ts
import { Plugin } from "obsidian";
import { doSomething } from "./my-command";

export function registerCommands(plugin: Plugin) {
  plugin.addCommand({
    id: "do-something",
    name: "Do something",
    callback: () => doSomething(plugin),
  });
}
```

### Add a command

```ts
this.addCommand({
  id: "your-command-id",
  name: "Do the thing",
  callback: () => this.doTheThing(),
});
```

### Persist settings

```ts
interface MySettings { enabled: boolean }
const DEFAULT_SETTINGS: MySettings = { enabled: true };

async onload() {
  this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  await this.saveData(this.settings);
}
```

### Register listeners safely

```ts
this.registerEvent(this.app.workspace.on("file-open", f => { /* ... */ }));
this.registerDomEvent(window, "resize", () => { /* ... */ });
this.registerInterval(window.setInterval(() => { /* ... */ }, 1000));
```

## Troubleshooting

- Plugin doesn't load after build: ensure `main.js` and `manifest.json` are at the top level of the plugin folder under `<Vault>/.obsidian/plugins/<plugin-id>/`. 
- Build issues: if `main.js` is missing, run `npm run build` or `npm run dev` to compile your TypeScript source code.
- Commands not appearing: verify `addCommand` runs after `onload` and IDs are unique.
- Settings not persisting: ensure `loadData`/`saveData` are awaited and you re-render the UI after changes.
- Mobile-only issues: confirm you're not using desktop-only APIs; check `isDesktopOnly` and adjust.

## References

- Obsidian sample plugin: https://github.com/obsidianmd/obsidian-sample-plugin
- API documentation: https://docs.obsidian.md
- Developer policies: https://docs.obsidian.md/Developer+policies
- Plugin guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- Style guide: https://help.obsidian.md/style-guide
