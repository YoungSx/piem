# Pi extension bridge

[← Extending Piem](extending.md) · [简体中文](pi-extension-bridge.zh-CN.md)

Piem compiles reviewed, original Pi factories into its release bundle. A shared
host runs the bookmark adapter and the community adapter against the existing
agent and Vault-backed session store. It is a reusable host for supported
contracts, not a full Node environment or a sandbox for arbitrary code.

The generic compatibility layer adds host capabilities only. It installs no new
community extension, including `pi-suggest`, and adds no default model requests.
Existing Quick actions keep their generation and click-to-send behavior.

## Contracts

| Surface | Implemented behavior |
| --- | --- |
| Loading | Original `loadExtensionFromFactory`, static sources only |
| Execution | Original `ExtensionRunner` and tool wrapper; tools run sequentially |
| Registration | Commands, tools, shortcuts, lifecycle and context handlers, private event bus; unsupported registrations and duplicate names fail |
| Context | Original `context` pipeline, in order; a failed handler aborts the request |
| Session | Read views refreshed from the owning Vault session and lane; labels use the existing log |
| Models | Configured, credentialed, unambiguous models; registry and imported `complete` use Piem's transport; real keys and authentication headers never enter callbacks |
| Messages | Command-scoped `sendMessage` with `triggerTurn` and `followUp`; at most 16 per command |
| UI | Native Obsidian dialogs, supported component factories, composer text, widgets/status, autocomplete and shortcut actions; `rpc`/`hasUI:true` with a panel, `print`/`false` without one |
| Node | Virtual path/URL/environment, EventEmitter, immutable UTF-8 package resources |
| Lifetime | One host per agent lifetime; disposal invalidates captured APIs and clears event subscriptions |

`fs` does not access the Vault. Unknown paths return `ENOENT` (or false for
`existsSync`); writes, watches and processes fail explicitly. Upstream optional
configuration is absent by design. A future writable resource needs an awaited
Vault adapter with ownership and cancellation, not global state or a synchronous
shadow of the vault. Desktop user skills keep their separate existing Node path.

The adapters deliberately supply different session read views: bookmark scans the
whole authoritative log, matching upstream; community extensions can read stored
entries and the owning lane's current branch. Synchronous Pi actions are captured by the adapter and awaited
by the service before success is reported. Model changes are recorded, clamped
for thinking support, and applied through Pi's `prepareNextTurn` hook.

## Package imports

Audited community sources may keep root imports from either `@earendil-works`
or the earlier `@mariozechner` namespace. Both resolve to the same browser
compatibility entrypoints at build time. Extension functions are not rewritten;
unsupported exports or package subpaths fail the build.

| Package root, under either namespace | Runtime exports |
| --- | --- |
| `pi-ai` | `complete` |
| `pi-tui` | `Container`, `Text`, `SelectList`, `Key`, `matchesKey`, `parseKey`, `getKeybindings`, `visibleWidth`, `truncateToWidth` |
| `pi-coding-agent` | `BorderedLoader`, `DynamicBorder`, `theme`, `getSelectListTheme`, `getAgentDir` |

These are explicit subsets. `stream`, `completeSimple`, arbitrary CLI helpers
and a terminal engine are not included. `getAgentDir()` returns a virtual path;
it does not make synchronous configuration files readable or writable. The
resource-only `fs` behavior above still applies.

## Native UI and lifecycle

The bridge maps intent to Obsidian UI: `select`, `confirm`, `input` and `editor`
open native modals; `getEditorText`, `setEditorText` and `pasteToEditor` address
the current conversation's draft. Paste replaces the selected text. Each
conversation allows one dialog at a time; caller cancellation, a finite timeout,
Stop, panel closure and conversation changes dismiss pending dialogs. Timed
dialogs display a countdown and release their timer when closed.

`setWidget` accepts text lines or a supported component factory above or below
the composer. `setStatus` displays text beneath it. `addAutocompleteProvider`
wraps native completion data; users can type or select **Show suggestions**,
then choose with touch or the keyboard.
Suggestions fill the draft; they do not send it. Existing slash commands and Tab
focus navigation are preserved. Reopening a panel restores its extension text
and completion providers without repeating `session_start`.

Factories using the compatibility `Container`, `Text`, `SelectList`,
`DynamicBorder` and `BorderedLoader` map to native layout, text, selectable
options, borders and cancellable progress. `ctx.ui.custom(factory)` opens them
in an Obsidian modal; `done(value)` returns the result and native dismissal
returns `null`. Both touch and keyboard selection use the component's own
callbacks. A loader exposes its abort signal without creating a spinner
interval. Closing or replacing a surface retires its callbacks and resources;
retained widget factories remount when the panel returns.

Standard component renders carry their native structure with the returned line
array. A wrapper such as `render: width => container.render(width)` preserves
that structure. Copying the array or reformatting its lines loses the structure;
arbitrary render strings remain plain text, never HTML or inferred buttons.
Custom dialogs with input handlers but no supported interactive components are rejected.
The bridge does not forward raw keyboard data to arbitrary terminal handlers.

`ctx.ui.theme` and the exported theme accept supported Pi color names and text
formatters such as `fg`, `bg` and `bold`; they return plain text. Native controls
inherit Obsidian's colors and styling. `tui.requestRender()` refreshes the native
surface; terminal cursor operations, theme switching, custom editors, raw
terminal input and overlay positioning/handles remain unsupported. An `overlay`
flag still opens a native modal. `hasUI` alone does not establish compatibility.

Registered shortcuts appear in a collapsible **Extension actions** menu below
the composer, so they remain reachable on touch screens. Explicit modified keys
also work while the composer has focus. Typing, composition, Enter, Tab,
navigation and standard edit shortcuts retain their existing behavior.
Normalized duplicate shortcut keys fail registration; actions from an inactive
panel and concurrent shortcut invocations are rejected.

Supported events are `session_start`, `session_shutdown`, `before_agent_start`,
`agent_start`, `agent_end`, `agent_settled`, `turn_start`, `turn_end`,
`message_start`, `message_update`, `message_end`, and the three
`tool_execution_*` events, plus `context`. Startup happens once on first panel
attachment or execution. The original Runner orders handlers and combines
their results. A `before_agent_start` system prompt applies to that run; custom
messages and `message_end` replacements follow the existing persistence path.
`agent_settled` waits for queued continuations and automatic compaction. Streaming
deltas do not read the Vault; unused events do no handler work.

Stop and new prompts cancel unfinished extension work. Captured capabilities
from a cancelled handler remain invalid; completed startup callbacks can keep
serving later turns in the same conversation. Shared `pi.sendMessage`,
`pi.setLabel` and `pi.setModel` mutations must begin before the handler's first
`await`; asynchronous native UI/model work uses captured `ctx` capabilities.
Disposal immediately retires old capabilities and subscriptions, allowing at
most one second for `session_shutdown` cleanup.

Cancellation covers handlers, factories, dialogs and model requests that the
host manages and awaits. Standard component selection/cancel callbacks are
synchronous `void` callbacks. If an extension starts its own asynchronous task
there, the extension must cancel it through its component's `dispose()` and an
`AbortController`; the browser bridge cannot track arbitrary promises or
closures. A successful `session_start` context intentionally survives reopening
the same conversation's panel. It is not a guarantee that every late write from
extension-owned background work is blocked. Ownership checks still isolate
different conversations.

## Model requests

`ctx.modelRegistry` exposes `getAvailable`, `getAll`, `find`, `hasConfiguredAuth`,
`complete`, `getApiKey` and `getApiKeyAndHeaders`. An extension can keep the usual
imported `complete(model, context, options)` call, passing the `apiKey` and
`headers` returned by its registry. Successful `getApiKeyAndHeaders` returns
`{ ok: true, apiKey, headers }`; an unconfigured model returns
`{ ok: false, error }`, and `getApiKey` returns `undefined` for it.

The returned key is an opaque host capability and the headers are empty. Real
provider secrets stay inside Piem. A capability binds the owning conversation,
model and captured callback scope; it keeps that scope across `await`. Model
metadata can be read again or shallow-copied: only provider/id selects the model,
and the host resolves the configured endpoint and credentials again. A known
snapshot from another conversation, another model, a revoked capability or
arbitrary header overrides fails explicitly. There is no global current-host
fallback and no direct provider request path.

Cancellation retires the affected callback's capabilities. Stop, panel attachment
changes and disposal clear all of that host's capabilities. Successful callbacks
may retain them; at most 128 distinct callback/model capabilities can be retained
per conversation. Repeated reads in one callback reuse its capability; reaching
the limit fails explicitly rather than evicting a live one.

Both completion forms use the same transport as chat and include returned usage
in the owning conversation. Supported options are `signal`, `maxTokens`,
`temperature`, `reasoningEffort`,
`cacheRetention`, `sessionId` and string `toolChoice`. Unknown options fail rather
than bypassing the host's routing.

Each conversation allows two outstanding completion requests with a 60-second
deadline. Output defaults to the configured model's limit, or 4096 tokens when
no usable limit exists; a caller can choose a smaller limit. Obsidian's
`requestUrl` cannot cancel physical network IO: Stop releases the caller
immediately, but the outstanding request retains its slot until the network
settles. No polling or permanent timers are added.

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

`scripts/smoke-extension-ui-obsidian.mjs` exercises native dialogs, composer
completions, lifecycle and model requests with a local test factory in the
shipped service. Use `scripts/smoke-generic-bridge-obsidian.mjs` to verify the
generic imports, component widgets, custom selection, cancellation, shortcut
actions and imported model completion. Its local contract fixture lives in
`scripts/fixtures/native-extension-contract.mjs`; the fixture is not registered
as a production extension. These checks verify host contracts, not compatibility
with every community package.

The smoke uses a local deterministic model endpoint to exercise the real protocol,
model switch and context. It is not a live-model quality evaluation. Mobile
emulation and a permanently Node-free VM cover the restricted host contract;
iOS/Android hardware, OS backgrounding and their WebViews need device testing.
