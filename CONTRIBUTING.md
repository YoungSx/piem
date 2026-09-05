# Contributing to Piem

Thanks for helping. This file covers the two things that bite new
contributors: how to verify a change, and why `bun.lock` must not be
regenerated casually. Broader project conventions (file layout, manifest
rules, PR expectations) live in [AGENTS.md](AGENTS.md).

## Environment

- **Runtime: Bun** — this project is bun-first. Node.js current LTS also
  works for the esbuild bundle step.
- **Package manager: bun** — `bun.lock` is the committed lockfile.
- **Tests: `bun test`** — tests use `bun:test`, not Vitest or Jest.

## Verify a change

```bash
bun install          # once, or after pulling lockfile changes
bun test             # unit + structural gates (happy-dom)
npm run build        # tsc + esbuild → main.js
npm run lint         # eslint with the same rules the official scanner runs
npm run verify       # build + bundle/copy/css/version gates + bun test + lint
```

`npm run verify` is what CI runs; verify locally first so CI is a
confirmation, not a discovery. The bundle-size gate (`check:bundle`) fails
the build over 1.75 MiB — if your change pushed it over, shrink the change or
trim a dependency rather than raising the ceiling; the ceiling only moves with
an Obsidian-mandated artifact change, deliberately.

The CSS gate (`check:css`) fails on an `animation` naming keyframes nothing
defines, and on keyframes nothing names. Neither is a CSS error — the rule
parses and the element just never moves — so a half-finished rename passes every
other check and even looks right in a screenshot, because a still frame of a
paused animation and a still frame of a running one are the same picture.

Lint parity matters: the local `eslint` flat config is kept identical to the
official community-plugin scanner's. Do not disable a rule for one path to
turn a check green — the scanner will disagree, as it did before the configs
were aligned.

## Editing dependencies: lock surgery

`bun install` refreshes the **whole** lockfile, not just the package you
added. Two known failure modes, both hit before:

1. **Install-then-edit drift.** Installing one package bumps unrelated pinned
   deps (TypeScript jumped several versions at once, breaking lint) and
   double-bundles a dependency, blowing the bundle gate. The safe sequence:

   ```bash
   git checkout master -- bun.lock   # start from the committed lock
   # edit bun.lock / package.json by hand for exactly the change you need
   bun install                       # node_modules now matches your edit
   npm run verify                    # prove it
   ```

2. **Edit-then-forget-install.** Hand-editing the lock without running
   `bun install` leaves `node_modules` stale; nothing fails until
   `check:bundle`, far from the cause. If a bundle-gate failure follows a
   dependency edit, check whether install was skipped before suspecting your
   code.

If your dependency change is not strictly necessary, prefer not making it.

## Pull requests

- Mergeable without conflicts against the default branch: rebase and resolve
  before opening or marking ready.
- CI fully green before the PR is considered done — do not hand it back while
  checks are failing or still running.
- Commit as you go. Uncommitted work can be swept by a parallel session in a
  shared worktree; small committed steps are cheap insurance.

## Testing in a vault

Copy `main.js`, `manifest.json`, and `styles.css` to
`<Vault>/.obsidian/plugins/piem/`, then reload Obsidian and enable the plugin
under **Settings → Community plugins**.
