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
| Registration | Commands, tools, shortcuts, handlers and private event bus; unsupported events and conflicting names skip that extension; ignored renderers/Markdown transformers are logged; flags retain registered defaults |
| Context | Original `context` pipeline, in order; a failed handler aborts the request |
| Tool interception | Original `tool_call` / `tool_result` emitters through pi's own agent hooks; a blocked call does not run, in-place `input` patches reach the tool, and a failed handler becomes that one call's error |
| Session | Read views refreshed from the owning Vault session and lane; custom entries and labels flush before success and summary branches publish through an awaited Vault adapter |
| Models | Configured, credentialed, unambiguous models; registry and imported `complete` use Piem's transport; real keys and authentication headers never enter callbacks, and audited search/clarify factories additionally resolve their current provider's auth |
| Messages | Operation-scoped `sendMessage` with `triggerTurn` and `followUp`; at most 16 pending messages; private `/acm` stays inside the host |
| UI | Native Obsidian dialogs, supported component factories, composer text, widgets/status, autocomplete and shortcut actions; `rpc`/`hasUI:true` with a panel, `print`/`false` without one |
| Node | Virtual path/URL/environment, EventEmitter, browser Buffer, Web Crypto randomness, synchronous SHA-256, immutable UTF-8 package resources |
| Lifetime | One host per conversation; stop invalidates pending work, reload invalidates old APIs, and owned timers and requests are tracked to completion |

`fs` does not access the Vault. Audited scoped factories can read, write and delete
their own JSON configuration under `/extensions/config`, saved through plugin
settings before an operation succeeds. The host maps `clarify.json` and
`/clarify model` to the same settings writer. Arbitrary filesystem paths, watches
and processes fail explicitly. Other optional upstream files remain absent.
Desktop user skills keep their separate Node path.

`pi-scoped-factories.mjs` compiles each reviewed graph at build time and closes its
platform imports over a per-host object. Shared pure imports stay static. There is
no runtime evaluation, global `fetch`/timer swap or downloaded extension code. The
Bun test preload uses the same compiler for source tests run individually.

Search uses Obsidian `requestUrl`; rewrite uses Piem's configured model transport.
The platform races cancellation for callers and tracks owned asynchronous work.
A native `requestUrl` already sent cannot be aborted; its late result cannot write
to the composer or start a continuation. Summary navigation reserves an entry ID,
stages the entry on one reusable lane and publishes the selected pointer last.
An already-started Vault write may commit after Stop; no stale rollback runs, and
the runtime adopts the saved result. Failed staging leaves the old branch selected.

The adapters deliberately supply different session read views: bookmark scans the
whole authoritative log, matching upstream; community extensions can read stored
entries and the owning lane's current branch. Synchronous Pi actions are captured by the adapter and awaited
by the service before success is reported. Model changes are recorded, clamped
for thinking support, and applied through Pi's `prepareNextTurn` hook.

`pi.appendEntry(customType, data)` stores JSON extension state as a `custom`
entry. The same handler can immediately read it through `getEntries`, `getBranch`
and `getLeafEntry`. It does not enter the model context or the transcript; custom
messages use a separate API. The host waits for entry writes at command, startup,
event and tool boundaries, and reports write failures. Stop cancels queued writes;
an already-started Vault write can finish and is awaited during cleanup.
A blank conversation keeps entries in memory until its first message saves the
session, matching the session's lazy persistence. Leaving an unsent blank chat
can discard this temporary state.

`registerFlag` retains Pi's declared default, which `getFlag` returns. An unknown
flag, or one without a value, returns `undefined`; Obsidian supplies no CLI
arguments. Message/entry renderers and Markdown transformers are currently
registered but not rendered, with a diagnostic in the extension load report.

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
only the audited per-extension JSON configuration described above is writable.
It grants no general filesystem access.

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
`message_start`, `message_update`, `message_end`, the three
`tool_execution_*` events, `tool_call` and `tool_result`, plus `context`, `input`,
`model_select`, `thinking_level_select`, `before_provider_request`, `after_provider_response`, `session_tree`, `session_compact`, `session_compact_failed`,
`session_before_fork` and `session_before_switch`. Startup happens once on first panel
attachment or execution. The original Runner orders handlers and combines
their results. A `before_agent_start` system prompt applies to that run; custom
messages and `message_end` replacements follow the existing persistence path.
`agent_settled` waits for queued continuations and automatic compaction. Streaming
deltas do not read the Vault; unused events do no handler work.

`thinking_level_select` reports the previous and newly applied effective level
after it is saved. A selection made during a run waits for that run to settle;
choosing the original level again retracts the pending change. Model capability
clamps use the same event, and a failed write or rolled-back model switch emits
no success event. Events belong to their conversation, including background chats.

`before_provider_request` runs at Pi's native serialized-body hook, and the
Runner chains replacements and in-place changes before HTTP starts. The body is
detached from retained extension references after dispatch. A failure or Stop
prevents the request. `after_provider_response` carries the HTTP status and
response headers when the response arrives, before its stream is consumed; it
does not mean generation has finished. Neither event receives request headers
or provider credentials. Callbacks keep their original request's cancellation
signal across Stop and resend. These hooks cover normal Agent model requests;
extra compaction and `ctx.modelRegistry.complete` calls are separate paths.

`session_compact` fires after manual or threshold compaction has been saved.
Its `compactionEntry` contains the real saved ID, summary, token count, ISO
timestamp and Piem's `retainedTail`. Piem has no CLI `firstKeptEntryId` cursor:
reading that member throws explicitly, while serializing the entry includes
only real stored fields. An observer failure cannot undo a saved compaction.
Both compaction outcomes dispatch after the single-flight slot is released, so
an observer can start another compaction without waiting on itself.

`session_compact_failed` covers failed or cancelled manual and threshold
compactions. Cancellations set `aborted:true` without an error message. Piem has no
overflow-recovery or extension-supplied compaction, so `willRetry` and
`fromExtension` are false. `ctx.compact({onError})` receives actual failures;
success events, `session_before_compact`, custom instructions and result callbacks
remain unsupported because their full compaction contract needs a real log cut.

`session_tree` follows a saved extension summary navigation, retry or edit-resend,
with real old/new leaf IDs and the saved summary when one was created. Failed
navigation emits no success event. `session_before_fork` runs before a reply is
copied (`position:"at"`); `session_before_switch` runs before creating or opening
a chat (`reason:"new"` or `"resume"`). Returning `{cancel:true}` or throwing
prevents that operation. A later user selection supersedes a waiting handler.
These hooks do not enable general `ctx.fork`, `ctx.switchSession`, `ctx.newSession`
or `session_before_tree`; summary navigation remains restricted to its prepared ID.

`tool_call` and `tool_result` intercept rather than observe, so they run through
the agent's own tool-call path instead of the event stream the `tool_execution_*`
trio uses. A `tool_call` handler returning `{ block: true, reason }` stops the
tool from executing and the reason becomes that call's error result, which the
model reads and can react to; the rest of the run continues. Mutating
`event.input` in place patches the arguments the tool receives, as upstream
documents — the object handed to handlers is the per-call copy Pi passes to the
tool, so the conversation still records the call the model actually made. Nothing
is re-validated against the tool's schema after a mutation, matching upstream;
the vault tools re-check their own paths regardless, so a patched path cannot
leave the vault. A `tool_result` handler's `content`, `details`, `isError` and
`usage` each replace that field of the executed result outright; there is no deep
merge. A handler that throws fails its own call rather than letting it through:
an extension installed to vet a tool call has approved nothing when it crashes.
Neither event refreshes the Vault before each call. A handler that writes custom
entries or labels waits for those writes before returning; a read-only handler
adds no storage work.

Stop and new prompts cancel unfinished extension work. Captured capabilities
from a cancelled handler remain invalid; completed startup callbacks can keep
serving later turns in the same conversation. Shared `pi.sendMessage`,
`pi.appendEntry`, `pi.setLabel` and `pi.setModel` mutations must begin before the handler's first
`await`; asynchronous native UI/model work uses captured `ctx` capabilities.
The statically audited research factories use an exclusive per-conversation
operation that also owns their deferred timers, allowing their upstream asynchronous
`pi.*` actions while retaining the same cancellation boundary. Other factories
keep the stricter captured-context contract.
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

### Static dependencies and background work

A scoped audit declares `entry`, `version`, `virtualRoot` and the SHA-256 of
each source file in `files`. Its optional `dependencies` map names exact npm
packages with the same audit shape. Optional `exports` maps exact `./subpaths`
to files already listed in that dependency's `files`; undeclared subpaths fail.
Optional `browser` maps exact package-relative `./source.js` selectors to
`./browser/source.js` files already in that package's `files`. It applies to
entries, declared exports and relative imports. A selector need not include the
Node source in the audit; its target must pass the same hash and path checks.
Cross-package mappings, wildcard mappings and `false` replacements are rejected.
`package.json` main/browser/exports cannot select unaudited files. Relative
imports also resolve dotted basenames such as `./lodash.merge` to an audited
`lodash.merge.js`, with code-file extensions checked before directory indexes.
Package versions, every listed source file and filesystem boundaries are checked
before compilation.

The compiler binds bare and supported explicit global references to fetch,
process, Buffer and timers to the factory's own platform, including dependency
code. In background factories, `globalThis`, `window`, `self` and `global`,
including aliases and computed property access, refer to the same private object.
SDK registrations under `Symbol.for` stay on that object; they do not alter the
host or another factory. It exposes selected Web/JavaScript primitives and the
owned fetch, process and timer APIs, with no fallback to ambient host properties.
Unknown imports and runtime loading remain build errors. A foreground-only
factory cannot acquire this background global view. This is a reviewed static
graph, not a JavaScript security sandbox; arbitrary code and shared built-in
prototypes still require source review.

Browser SDKs retain real page lifecycle notifications through a limited owned
`document`: `visibilityState`, `visibilitychange` and `pagehide`. Event targets
refer to this view rather than the host DOM. Listener identity, capture, once and
abort signals are respected; at most 64 registrations are allowed per view.
Shutdown removes listeners immediately, including after a failed factory or a
timed out shutdown handler. Removing an already-retired listener remains safe.
Other DOM access is unavailable. Direct fetch/timer factories do not instantiate
these global or document views.

A host may register `{ id, createFactory }` for a reviewed background factory.
It receives a private writable virtual environment and PID, not the operating
system's environment or process identity. Environment data is bounded to 64
keys, 4096 UTF-8 bytes per value and 16 KiB total. It can list only its own flat
JSON configuration namespace. Buffer comes from the browser `buffer` package;
crypto supports synchronous `randomBytes`, `randomUUID` and SHA-256 hashing.
Other algorithms, asynchronous random-byte callbacks and crypto options fail
explicitly; there is no native Node fallback.

Background fetch and timers belong to the conversation rather than a chat
operation, so they do not keep the composer busy and Stop does not destroy
them. HTTP(S) requests use Obsidian `requestUrl`, have a 15-second caller
deadline, and share at most four outstanding physical requests per agent
service, including across replaced conversations. Aborted native IO retains
its slot until it finishes; `requestUrl` cannot cancel physical IO.

Each factory has at most 64 timer/pending-callback slots. Timeout and interval
handles are numbers; Node timer-object methods such as `unref` are unsupported.
Async interval callbacks run without overlap. `timers/promises.setTimeout`
supports a cancellation signal and accepts `ref` without a process-liveness
effect in a WebView. Shutdown stops intervals, allows the existing one-second
cleanup window for a final request, then revokes remaining timers, delays,
requests and environment access. A failed factory's resources are retired
while other extensions remain available. This adds no telemetry extension or
automatic outbound request to the release.

During shutdown, session ID/file/name, model, thinking level and other safe
metadata use the last valid snapshot. The service may already have retired the
owning conversation; shutdown does not reopen it or expose credentials. Old
contexts and all mutation capabilities remain invalid. History/tree reads are
not retained as a second copy of the vault session.

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
   Run `scripts/smoke-community-obsidian.mjs` and
   `scripts/smoke-research-extensions-obsidian.mjs` against a disposable real
   Obsidian vault, on desktop and with official mobile emulation.

`scripts/smoke-extension-ui-obsidian.mjs` exercises native dialogs, composer
completions, lifecycle and model requests with a local test factory in the
shipped service. Use `scripts/smoke-generic-bridge-obsidian.mjs` to verify the
generic imports, component widgets, custom selection, cancellation, shortcut
actions and imported model completion. Its local contract fixture lives in
`scripts/fixtures/native-extension-contract.mjs`; the fixture is not registered
as a production extension. These checks verify host contracts, not compatibility
with every community package.

`scripts/smoke-background-bridge-obsidian.mjs` adds a test-only static factory to
a disposable vault's copy of the production bundle and restores it afterwards.
It checks dependency imports, actual requestUrl traffic, two conversations,
periodic work, provider hooks, final shutdown requests and resource retirement.

The smoke uses a local deterministic model endpoint to exercise the real protocol,
model switch and context. It is not a live-model quality evaluation. Mobile
emulation and a permanently Node-free VM cover the restricted host contract;
iOS/Android hardware, OS backgrounding and their WebViews need device testing.
