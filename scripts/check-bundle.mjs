/**
 * Static gate over the built `main.js`.
 *
 * Obsidian does not load a plugin as a module. It reads `main.js` and evaluates
 * it as a CommonJS function body, so the bundle runs in a context with no owning
 * script and no import map. Constructs a bundler happily emits can therefore
 * fail only at runtime, inside `onload`, where the sole user-visible symptom is
 * "Failed to load plugin".
 *
 * 0.1.0-alpha.3 shipped `await import("electron")`, which Chromium rejects with
 * `TypeError: Failed to resolve module specifier 'electron'`.
 *
 * Import detection runs through esbuild's parser rather than a regex: the
 * bundle is minified third-party-heavy output, and dependencies embed strings
 * like "set globalThis.File to `import('node:buffer').File`" in error messages.
 * A regex flags those; a parser sees them for what they are, plain text.
 *
 * Composition is checked separately, against the build's metafile, because the
 * byte count cannot see it: a large dependency creeping back in while something
 * else shrinks reads as no change at all.
 */
import { readFileSync, statSync } from "node:fs";
import process from "node:process";
import esbuild from "esbuild";

const BUNDLE = process.argv[2] ?? "main.js";

/** Module breakdown esbuild wrote beside the bundle. */
const METAFILE = `${BUNDLE}.meta.json`;

/**
 * Hard ceiling on the shipped bundle, in bytes.
 *
 * Obsidian evaluates `main.js` in full on every launch, phones included, so
 * weight here is start-up latency the user pays for on every single app open.
 * Nothing else in the suite notices it: a bundle that doubles in size still
 * parses, still loads, still passes every test.
 *
 * The number is anchored to measurement, not taste, and it has moved fifteen
 * times:
 *
 * 1. Trimming pi-ai's provider catalog from 39 providers to nine took the bundle
 *    from ~1.83 MiB to ~1.47 MiB, and the ceiling to 1.75 MiB.
 * 2. The skills feature (URL import, the manager, its settings UI, and bilingual
 *    copy) spent that headroom back up to ~1.67 MiB, leaving the ceiling alone.
 * 3. Dropping the remaining nine providers took it to ~1.51 MiB — 183 KiB, of
 *    which 164 KiB was catalog JSON that Obsidian parsed on every launch (see
 *    {@link ../src/net/builtinCatalog.ts}). The ceiling followed to 1.59 MiB.
 * 4. Multi-device session sync (sessionMerge, sessionMutationLine, and the
 *    manager/draft work riding with it) spent the last of that headroom at
 *    ~1.592 MiB. The ceiling follows to 1.60 MiB.
 * 5. The suggestion-model advanced section (its settings row, the
 *    `testSuggestionConnection` probe, and the bilingual copy for both) spent
 *    the last of that headroom at ~1.600 MiB — 74 bytes over the line. The
 *    ceiling follows to 1.61 MiB.
 * 6. The `vault-memory` and `distill-skill` builtins took the bundle past the
 *    1.61 line by 1999 bytes. The ceiling follows to 1.62 MiB.
 *
 *    Bundled skill bodies count against this budget rather than being exempt
 *    from it: the `.md` text loader inlines each `SKILL.md` as a string literal
 *    in `main.js`, so Obsidian parses all of them on every launch. Excluding a
 *    body from this gate would cost the same start-up time with nothing left
 *    measuring it. Making them free means changing the mechanism — shipping
 *    them as vault files read on demand — not the ruler. For scale, the seven
 *    bodies together are ~21 KiB against react-dom's 128 KiB and the MCP
 *    client's 171 KiB, so they are not where start-up time is spent.
 * 7. Replacing NodeHomeEnv with Pi's public NodeExecutionEnv entry and a lazy
 *    bridge took 1,692,093 B to 1,728,334 B (+36,241 B). The ceiling follows
 *    to 1.66 MiB: the public entry costs ~35 KiB but retires the duplicated
 *    filesystem implementation without a private upstream import.
 * 8. The original Pi bookmark, loader/runner, limited platform bridge, native
 *    dialogs and license notices took 1,720,434 B to 1,783,412 B (+62,978 B).
 *    The ceiling follows to 1.71 MiB. Dynamic loading, terminal UI and syntax
 *    highlighting stay excluded and have their own composition bans below.
 *
 * 9. The shared host and three original community factories measured 1,822,186 B
 *    with all notices. The ceiling follows to 1.74 MiB; no filesystem image,
 *    terminal, provider catalog or dynamic installer was added.
 * 10. Native extension dialogs, composer completion and lifecycle/model adapters
 *     measured 1,853,307 B. The ceiling follows to 1.77 MiB. The metafile still
 *     contains no terminal runtime; the added bytes implement native host UI.
 *
 * 11. Generic component factories, scoped shortcuts and public completion
 *     compatibility measured 1,879,729 B; the ceiling followed to 1.80 MiB.
 *     No new community extension, terminal runtime or test fixture is shipped.
 * 12. Search, clarify and context, integrated with the native UI/lifecycle
 *     bridge and the generic compat layer, raise the measured size again; the
 *     ceiling follows to 1.88 MiB.
 * 13. Per-extension writable configuration — a namespaced store in plugin
 *     settings standing in for the agent directory that does not exist on a
 *     phone — measured 1,973,012 B. The ceiling follows to 1.89 MiB. What the
 *     bytes buy is the removal of a hardcoded path comparison that only ever
 *     answered `clarify.json`: ownership is now structural, so a second
 *     extension needs no edit here. No filesystem image, no vault mirror.
 * 14. Holding a new chat in memory until its first message (pi's in-memory
 *     session storage, deep-imported beside the JSONL codec it shares)
 *     measured 1,975,900 B on top of the namespaced config store. The ceiling
 *     follows to 1.90 MiB: the blank sheet needs the storage class at runtime,
 *     so the bytes are the feature. No new dependency; the storage sits in the
 *     same module tree the durable session already pulls in.
 * 15. Generic scoped dependency graphs, provider/compaction events and bounded
 *     background resources measured 2,002,780 B including license notices
 *     after synchronizing the default branch.
 *     The ceiling follows to 1.91 MiB. No OTel extension or SDK is bundled;
 *     unused Buffer and crypto implementations remain tree-shaken out.
 *
 * Direct session opening, pending-selection cleanup and the memoized transcript
 * bring the combined build to 1,884,024 B (+4,295 B over the generic bridge).
 * The existing 1.80 MiB ceiling still fits; no new dependency was introduced.
 *
 * The ceiling moves one 0.01 MiB notch past the measured size, which is what
 * bumps 4 and 5 actually did — they left 8.4 KiB and ~10 KiB of headroom, not
 * the 80 KiB an earlier draft of this comment claimed. A notch is enough that
 * a rounding-level change does not trip the gate, and tight enough that a
 * regression of catalog size — or anything else of that order — lands above
 * the line and gets caught here rather than on a user's phone. Re-opening a
 * large margin for a small feature would retire the ruler: a ratchet left
 * slack stops measuring anything.
 */
const MAX_BUNDLE_BYTES = Math.round(1.91 * 1024 * 1024);

/**
 * Dynamic imports with a non-literal specifier that today's bundle still has.
 *
 * A ratchet rather than a ban, because the one left is inherited, unreachable in
 * practice, and non-fatal: `auth/context.js` reaches for a node builtin inside
 * `fileExists` through a variable specifier, so browser bundlers cannot follow
 * it — but the call is already wrapped in try/catch and returns false, which is
 * the browser answer anyway.
 *
 * Two others were here until the provider factories went (see
 * {@link ../src/net/builtinCatalog.ts}), and both were worse than this one:
 *
 * - `env-api-keys.js` fired `node:fs`/`node:os`/`node:path` at *module scope*.
 *   Under Obsidian each rejected with nothing awaiting them, so every launch
 *   raised unhandled rejections. It was reachable only through a factory's
 *   `envApiKeyAuth`, so dropping the factories dropped the file.
 * - `auth/oauth/load.js`, the OAuth flow loader, arrived the same way via
 *   `lazyOAuth` and was never called.
 *
 * So the number is what the bundle measurably has, and the gate's job is to stop
 * it from growing: a *new* opaque import is the dangerous case, because the code
 * that adds one intends the module to load, and under Obsidian's eval it never
 * will. If a change removes one, the count drops and the gate fails too —
 * deliberately, so the improvement gets recorded here instead of leaving room to
 * silently regress.
 */
const KNOWN_OPAQUE_DYNAMIC_IMPORTS = 1;

/**
 * Dependencies removed on purpose, which no import may bring back.
 *
 * Each of these was reachable only transitively, so nothing in `src/` names it
 * and no test notices its return — the sole symptom is a bundle that quietly
 * grew again. Keyed by the `node_modules` path segment esbuild records, matched
 * as a substring so a nested or pnpm-style layout is caught too.
 */
const BANNED_MODULES = new Map([
	["scripts/fixtures/", "Contract fixtures are opt-in test inputs and must never enter a release."],
	["src/testUtils/", "Source-test and preview loaders must never enter the shipped plugin."],
	["scripts/pi-scoped-factories.mjs", "Scoped extensions compile at build time. The source compiler must not ship."],
	["node_modules/typescript/", "The extension source compiler is build tooling, not a mobile runtime dependency."],
	["node_modules/jiti/", "Built-in Pi extensions are statically bundled. The dynamic JS/TS loader must stay unreachable."],
	["node_modules/@earendil-works/pi-tui/", "The bookmark uses Obsidian dialogs. Pi's terminal runtime must not enter the mobile bundle."],
	["node_modules/highlight.js/", "Terminal syntax highlighting is unused by the built-in bookmark."],
	["node_modules/cross-spawn/", "The limited extension bridge refuses subprocess execution. No process launcher belongs in this graph."],
	[
		"node_modules/@earendil-works/pi-ai/dist/providers/",
		"283 KiB that Obsidian parses on every launch, 164 KiB of it catalog JSON. Every provider entrypoint imports its own `X_MODELS` at module scope and names it inside `createProvider`, so a factory cannot be taken without its data and esbuild cannot shake the data loose — importing one provider costs its whole model list. Nothing needs them: the builtin fallback is a literal in src/net/builtinCatalog.ts, dispatch goes through createConfiguredProvider in src/net/streamFn.ts, connection details for known vendors live in src/net/providerPresets.ts, and capability hints come from the live models.dev index. If this appears, an import reached for a provider or a `*.models` entrypoint (or a barrel that re-exports one, such as `providers/all`).",
	],
	[
		"node_modules/@google/genai/",
		"270 KiB of unreachable code: the adapter behind it throws on any fetch that is not globalThis.fetch, and every request here passes one to reach Obsidian's requestUrl. It returns through a provider factory in src/net/builtinCatalog.ts — import neither googleProvider nor GOOGLE_MODELS (see issue #91).",
	],
	[
		"node_modules/openai/",
		"~138 KiB minified that every Obsidian startup would evaluate: esbuild must alias it to src/net/shims/openaiSdk.ts, which reproduces the exact client surface pi-ai's openai-completions.js and openai-responses.js touch (see issue #92). If this appears, an import path bypassed the alias.",
	],
	[
		"node_modules/@anthropic-ai/sdk/",
		"~92 KiB minified that every Obsidian startup would evaluate: esbuild must alias it to src/net/shims/anthropicSdk.ts, which reproduces the exact client surface pi-ai's anthropic-messages.js touches (see issue #92). If this appears, an import path bypassed the alias.",
	],
]);

/**
 * The public pi-agent-core/node barrel leaves one empty lazy initializer for
 * faux.js after tree shaking: 17 bytes, with every faux export removed. Allow
 * only that exact file and budget; importing even fauxText exceeds it. Every
 * other provider remains banned, including zero-byte entries if one appears.
 */
const EMPTY_FAUX_INITIALIZER = "node_modules/@earendil-works/pi-ai/dist/providers/faux.js";
const EMPTY_FAUX_INITIALIZER_BYTES = 17;

/**
 * Pi implementations the bundle must contain, including internal files reached
 * by relative path and the public Node execution environment.
 *
 * src/vault/editDiff.ts imports pi's edit/diff engine through its location
 * under node_modules because it is not in the package's exports map (see that
 * file's header). TypeScript resolves the relative path through its own
 * resolution, which does not read `exports`, so a broken path survives
 * `tsc --noEmit` and only surfaces at bundle time or runtime. A missing input
 * here means the path broke — most likely a package-manager layout change or a
 * pi renaming the non-public file. Matched as a substring, like
 * {@link BANNED_MODULES}, so a nested or pnpm-style layout is caught too.
 */
const REQUIRED_MODULES = new Map([
	["pi-scoped-extension:pi-web-search", "The audited original web-search graph must ship in a per-host factory."],
	["pi-scoped-extension:pi-clarify", "The audited original clarify graph must ship in a per-host factory."],
	["pi-scoped-extension:pi-context", "The audited original context graph must ship in a per-host factory."],
	["node_modules/@earendil-works/pi-coding-agent/dist/core/tools/truncate.js", "Search output must use Pi's original bounded truncation helper."],
	["node_modules/pi-assistant-provenance/extensions/assistant-provenance/index.ts", "The original provenance extension must ship."],
	["node_modules/pi-model-switch/index.ts", "The original model-switch extension must ship."],
	["node_modules/pi-invisible-continue/continue.ts", "The original invisible-continue extension must ship."],
	["node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/wrapper.js", "Extension tools must use the original Pi wrapper."],
	["node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js", "The bundled bookmark must use Pi's original factory loader."],
	["node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js", "The bundled bookmark must use Pi's original extension runner."],
	["node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js", "The bundled extension must use Pi's original event bus."],
	["node_modules/@earendil-works/pi-coding-agent/examples/extensions/bookmark.ts", "The original bookmark example must be present, not a local reimplementation."],
	[
		"node_modules/@earendil-works/pi-agent-core/dist/harness/env/nodejs.js",
		"User skills must use the bundled public NodeExecutionEnv implementation. A missing input means the bridge no longer reaches Pi's filesystem or Pi was incorrectly externalized.",
	],
	[
		"node_modules/@earendil-works/pi-agent-core/dist/harness/tools/edit-diff.js",
		"src/vault/editDiff.ts reaches this file by relative path because it is not in pi's exports map. A missing input means the path broke — likely a package-manager layout change or a pi rename. See that file's header.",
	],
	[
		"node_modules/@earendil-works/pi-agent-core/dist/harness/session/jsonl/codec.js",
		"src/session/sessionMutationLine.ts reaches this file by relative path because it is not in pi's exports map. A missing input means the path broke — likely a package-manager layout change or a pi rename. See that file's header.",
	],
]);

function formatSize(bytes) {
	return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

/**
 * Modules and their byte contributions, keyed by esbuild's input paths, or
 * undefined when no metafile sits beside the bundle.
 */
function readBundleInputs() {
	let meta;
	try {
		meta = JSON.parse(readFileSync(METAFILE, "utf8"));
	} catch {
		return undefined;
	}
	const output = meta.outputs?.[BUNDLE];
	return output?.inputs;
}

/**
 * Import kinds that Obsidian's eval-based loader cannot satisfy.
 *
 * `require-call` is fine — the desktop shell injects a real `require`, and
 * esbuild leaves the externals (obsidian, node builtins) as require calls by
 * design. A dynamic `import()` of any kind is not: it needs a module context
 * that an eval'd function body does not have.
 */
const FORBIDDEN_IMPORT_KINDS = new Map([
	[
		"dynamic-import",
		"Obsidian eval's main.js, so import() has no module context to resolve against and throws TypeError at load time. Use the host-injected require instead.",
	],
	["import-statement", "A static ESM import survives only in an ESM output; this bundle is evaluated as CommonJS."],
	["import-rule", "CSS @import in the JS bundle indicates the wrong output format."],
]);

/**
 * Collects every specifier esbuild parses as an import, with its kind.
 *
 * The bundle is fed through stdin so the entry point itself is not intercepted
 * by the hook. Everything is marked external, so nothing is actually read from
 * disk; this is a parse, not a real build.
 */
/**
 * Counts dynamic imports esbuild's resolver cannot see.
 *
 * `onResolve` only fires for a literal specifier, so `import("node:http")` is
 * reported while `import(variable)` is invisible — which is exactly the form
 * pi-ai's lazy OAuth loaders use, and exactly the form that throws under
 * Obsidian's eval.
 *
 * A regex alone cannot answer this: minified dependencies embed `import(` in
 * error-message strings, which is why the resolver was preferred in the first
 * place. So the count comes from a difference. The source is re-emitted with
 * `dynamic-import` marked unsupported, which makes esbuild lower every real
 * dynamic import — literal or not — to `require`, while leaving text inside
 * strings untouched. Whatever the token count drops by was genuinely a dynamic
 * import, and the parser decided that, not a pattern.
 */
const DYNAMIC_IMPORT_TOKEN = /(^|[^\w$.])import\s*\(/g;

function countImportTokens(code) {
	return (code.match(DYNAMIC_IMPORT_TOKEN) ?? []).length;
}

async function countDynamicImports(source) {
	const lowered = await esbuild.transform(source, {
		format: "cjs",
		supported: { "dynamic-import": false },
		logLevel: "silent",
	});
	return countImportTokens(source) - countImportTokens(lowered.code);
}

async function collectImports(source) {
	const imports = [];
	await esbuild.build({
		stdin: { contents: source, resolveDir: process.cwd(), sourcefile: BUNDLE, loader: "js" },
		bundle: true,
		write: false,
		logLevel: "silent",
		platform: "node",
		format: "cjs",
		plugins: [
			{
				name: "import-collector",
				setup(build) {
					build.onResolve({ filter: /.*/ }, (args) => {
						imports.push({ kind: args.kind, path: args.path });
						return { path: args.path, external: true };
					});
				},
			},
		],
	});
	return imports;
}

/** Syntax-level checks that do not depend on import graph shape. */
const TEXT_CHECKS = [
	{
		name: "import.meta reference",
		pattern: /\bimport\s*\.\s*meta\b/g,
		why: "import.meta is a syntax error outside a module, which takes the whole plugin down at load time.",
	},
	{
		name: "dynamic script element creation",
		pattern: /createElement\(\s*["'`]script["'`]\s*\)/g,
		why: "Obsidian's marketplace scanner fails a submission that builds <script> elements, under Code obfuscation: \"Dynamically injecting script elements can load and execute arbitrary external code.\" Nothing in src/ does this, so a hit here means a dependency brought it in. react-dom 19 is the known source — its createRoot implementation carries preinit/preinitModule and the hoistable <script async> path, all three unreachable for us and none of them tree-shakeable, because React reaches them through an internal dispatcher object. That is why react and react-dom are pinned to 18.3.1 (exact, no caret) in package.json: 18's client build contains no such call at all. Upgrading React is what trips this check.",
	},
];

function positionOf(source, index) {
	const upto = source.slice(0, index);
	return `${upto.split("\n").length}:${index - (upto.lastIndexOf("\n") + 1) + 1}`;
}

let source;
let sizeInBytes;
try {
	source = readFileSync(BUNDLE, "utf8");
	// Measured off the artifact rather than the decoded string: the on-disk byte
	// count is what Obsidian actually reads at launch.
	sizeInBytes = statSync(BUNDLE).size;
} catch (error) {
	console.error(`check-bundle: cannot read ${BUNDLE}: ${error.message}`);
	console.error("Run `npm run build` first.");
	process.exit(1);
}

const failures = [];

let imports;
try {
	imports = await collectImports(source);
} catch (error) {
	// A parse failure is itself a fatal defect: Obsidian would hit the same
	// syntax error while evaluating the bundle.
	console.error(`check-bundle: ${BUNDLE} does not parse as JavaScript`);
	console.error(error.message);
	process.exit(1);
}

for (const entry of imports) {
	const why = FORBIDDEN_IMPORT_KINDS.get(entry.kind);
	if (why) {
		failures.push({ name: `${entry.kind} of "${entry.path}"`, why, at: "-" });
	}
}

// The resolver above reports only the literal ones, so this is the count that
// decides. A variable specifier fails at load time exactly as a literal does,
// and until this check existed it reached production reported as clean.
let dynamicImportCount = 0;
try {
	dynamicImportCount = await countDynamicImports(source);
} catch (error) {
	console.error(`check-bundle: cannot re-emit ${BUNDLE} to count dynamic imports`);
	console.error(error.message);
	process.exit(1);
}
const literalDynamicImports = imports.filter((entry) => entry.kind === "dynamic-import").length;
const opaqueDynamicImports = dynamicImportCount - literalDynamicImports;
if (opaqueDynamicImports > KNOWN_OPAQUE_DYNAMIC_IMPORTS) {
	failures.push({
		name: `new dynamic import with a non-literal specifier (${opaqueDynamicImports} sites, ${KNOWN_OPAQUE_DYNAMIC_IMPORTS} known)`,
		why: `${FORBIDDEN_IMPORT_KINDS.get("dynamic-import")} A variable specifier is invisible to the resolver, which is why this form shipped unreported until it was counted separately. pi-ai's lazy OAuth loaders (auth/oauth/load.js) are the known source of new ones. Register the flow statically, or reach the module through the host-injected require.`,
		at: "-",
	});
}
if (opaqueDynamicImports < KNOWN_OPAQUE_DYNAMIC_IMPORTS) {
	failures.push({
		name: `stale dynamic-import baseline (${opaqueDynamicImports} sites, ${KNOWN_OPAQUE_DYNAMIC_IMPORTS} expected)`,
		why: "Fewer than recorded, which is progress that has to be locked in: lower KNOWN_OPAQUE_DYNAMIC_IMPORTS in this file to the new count, or the ratchet drifts back up unnoticed.",
		at: "-",
	});
}

for (const check of TEXT_CHECKS) {
	check.pattern.lastIndex = 0;
	for (const match of source.matchAll(check.pattern)) {
		failures.push({ name: check.name, why: check.why, at: positionOf(source, match.index) });
	}
}

// A bundle that exports nothing gives Obsidian no plugin class to construct,
// which fails identically to a syntax error from the user's point of view.
if (!/module\.exports\b/.test(source)) {
	failures.push({
		name: "missing CommonJS export",
		why: "Obsidian instantiates module.exports as the plugin class; without it the plugin cannot load.",
		at: "-",
	});
}

// Composition, from the metafile. Absent for a dev build, where the size and
// import checks above still apply; a production build always writes one.
const bundleInputs = readBundleInputs();
if (bundleInputs) {
	for (const input of Object.keys(bundleInputs)) {
		if (/\.md$/.test(input) && /(?:^|\/)skills\//.test(input)) failures.push({
			name: `bundled skill Markdown: ${input}`,
			why: "Skill bodies belong in the separate release resource.",
			at: "-",
		});
	}
	for (const [segment, why] of BANNED_MODULES) {
		const offenders = Object.entries(bundleInputs).filter(([input, contribution]) =>
			input.includes(segment) && !(input.endsWith(EMPTY_FAUX_INITIALIZER) && contribution.bytesInOutput === EMPTY_FAUX_INITIALIZER_BYTES),
		);
		if (offenders.length > 0) {
			failures.push({ name: `banned module in bundle: ${segment} (${offenders.length} file(s))`, why, at: "-" });
		}
	}
	for (const [segment, why] of REQUIRED_MODULES) {
		// The mirror of the ban: a relative path must keep resolving, and Pi's
		// public Node entry must be bundled rather than delegated to the host.
		if (!Object.entries(bundleInputs).some(([input, contribution]) => input.includes(segment) && contribution.bytesInOutput > 0)) {
			failures.push({ name: `required module missing from bundle: ${segment}`, why, at: "-" });
		}
	}
}

if (sizeInBytes > MAX_BUNDLE_BYTES) {
	failures.push({
		name: `bundle over size limit (${formatSize(sizeInBytes)} > ${formatSize(MAX_BUNDLE_BYTES)})`,
		why: `Every byte here is parsed on each Obsidian launch, on phones too. The usual cause is a newly imported module dragging in a large dependency; the known one is pi-ai's provider catalog, which any import under "@earendil-works/pi-ai/providers/" pulls in whole — the banned-module check above names it precisely and is the error you should be reading instead of this one.`,
		at: "-",
	});
}

if (failures.length > 0) {
	console.error(`check-bundle: ${failures.length} problem(s) in ${BUNDLE}\n`);
	for (const failure of failures) {
		console.error(`  ✗ ${failure.name}${failure.at === "-" ? "" : ` at ${failure.at}`}`);
		console.error(`    ${failure.why}\n`);
	}
	process.exit(1);
}

const kinds = [...new Set(imports.map((entry) => entry.kind))].sort().join(", ");
const headroom = formatSize(MAX_BUNDLE_BYTES - sizeInBytes);
// The tolerated count is printed rather than left implicit: it is inherited
// debt that fails under Obsidian's eval, and a silent "clean" would read as
// the bundle having none at all.
const opaque = opaqueDynamicImports > 0 ? `; ${opaqueDynamicImports} tolerated opaque dynamic import(s)` : "";
console.log(
	`check-bundle: ${BUNDLE} clean (${imports.length} imports, kinds: ${kinds || "none"}; ${formatSize(sizeInBytes)} of ${formatSize(MAX_BUNDLE_BYTES)}, ${headroom} headroom${opaque})`,
);
