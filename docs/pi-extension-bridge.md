# Pi extension bridge

[← Extending Piem](extending.md) · [简体中文](pi-extension-bridge.zh-CN.md)

Piem compiles reviewed, original Pi factories into its release bundle. A shared
host runs the bookmark adapter and the community adapter against the existing
agent and Vault-backed session store. It is a reusable host for supported
contracts, not a full Node environment or a sandbox for arbitrary code.

## Contracts

| Surface | Implemented behavior |
| --- | --- |
| Loading | Original `loadExtensionFromFactory`, static sources only |
| Execution | Original `ExtensionRunner` and tool wrapper; tools run sequentially |
| Registration | Commands, tools, context handlers, private event bus; unsupported registrations and duplicate names fail |
| Context | Original `context` pipeline, in order; a failed handler aborts the request |
| Session | Read views supplied by the adapter; bookmark labels use the existing log |
| Models | Configured, credentialed, unambiguous models; keys never enter extension callbacks |
| Messages | Command-scoped `sendMessage` with `triggerTurn` and `followUp`; at most 16 per command |
| UI | `notify` becomes the chat notice; terminal UI is unavailable and `hasUI` is false |
| Node | Virtual path/URL/environment, EventEmitter, immutable UTF-8 package resources |
| Lifetime | One host per agent lifetime; disposal invalidates captured APIs and clears event subscriptions |

`fs` does not access the Vault. Unknown paths return `ENOENT` (or false for
`existsSync`); writes, watches and processes fail explicitly. Upstream optional
configuration is absent by design. A future writable resource needs an awaited
Vault adapter with ownership and cancellation, not global state or a synchronous
shadow of the vault. Desktop user skills keep their separate existing Node path.

The adapters deliberately supply different session read views: bookmark scans the
whole authoritative log, matching upstream; community commands read the active
agent transcript. Synchronous Pi actions are captured by the adapter and awaited
by the service before success is reported. Model changes are recorded, clamped
for thinking support, and applied through Pi's `prepareNextTurn` hook.

## Adding an extension

1. Audit its package source, transitive imports, registration, file paths, network,
   UI and lifetime. Choose a mobile-compatible factory with explicit licensing.
2. Pin its npm version with Bun and add all compiled source hashes and a virtual
   root to `scripts/pi-extension-packages.json`. The build refuses unaudited source
   inside registered packages and unknown external dependencies from them.
3. Add the original entry to `communityFactories.mjs` and its declaration; register
   it in `communityHost.ts`. Add a capability to the host only with a real adapter,
   keeping unsupported operations explicit. The browser libraries are reviewed
   dependencies from `bun.lock`; they do not receive general Node capabilities.
4. Preserve upstream notices in `licenses/pi-extension-bridge.txt`. Add bilingual
   user documentation and a statement in settings for user-visible effects.
5. Verify original execution, failure/cancellation, two-session ownership, reload,
   and no Node access. Build, lint, individual tests and the full suite must pass.
   Run `scripts/smoke-community-obsidian.mjs` against a disposable real Obsidian
   vault, on desktop and with official mobile emulation.

The smoke uses a local deterministic model endpoint to exercise the real protocol,
model switch and context. It is not a live-model quality evaluation. Mobile
emulation and a permanently Node-free VM cover the restricted host contract;
iOS/Android hardware, OS backgrounding and their WebViews need device testing.
