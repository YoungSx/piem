/**
 * esbuild resolves pi-codemode's runtime for us, in two different shapes.
 *
 * pi ships codemode as a Node tool: a host thread on `node:worker_threads`, a
 * worker on the same, and the QuickJS wasm read off disk with `node:fs`. A
 * WebView has none of the three, so the shipped artifacts cannot be used as
 * they stand. What they do hold is the part worth keeping — the ~11 KB prelude
 * that runs *inside* the VM and builds `tools`/`text`/`store` over one host
 * bridge, the declaration renderer, and the `@options:` parser. None of those
 * touch a platform API, and all three are measured working in a real WebKit
 * (see {@link ./workerSource}).
 *
 * So this plugin maps them in:
 *
 * - `@earendil-works/pi-codemode/declarations` and `/source` are aliased to
 *   their `dist` files and imported as ordinary modules on the host.
 * - `@earendil-works/pi-codemode/prelude` resolves to the `dist` file's
 *   `PRELUDE_SOURCE` **as a string**, because that code has to exist as text to
 *   be spliced into the worker source below. The package does not export it
 *   that way, and its `./runtime/prelude-source.js` path is absent from the
 *   exports map, so a bare specifier cannot reach it at all.
 * - `@earendil-works/pi-codemode/quickjs-wasm` becomes the browser bundle of
 *   `quickjs-wasi` as an IIFE string, for the same reason: a blob-URL worker
 *   has no module system, so every line it runs has to arrive as text.
 *
 * The two string shapes are why this is a plugin and not `alias`: an alias maps
 * one specifier to one module, and these need the module's *contents* turned
 * into a literal.
 */
import esbuild from "esbuild";
import path from "node:path";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PRELUDE = "@earendil-works/pi-codemode/prelude";
const QUICKJS = "@earendil-works/pi-codemode/quickjs-wasm";
const WASM = "@earendil-works/pi-codemode/quickjs-wasm-url";

/**
 * Aliases for the two host-side subpaths.
 *
 * A bare `@earendil-works/pi-codemode/declarations` resolves on its own; the
 * alias pins the *file* so an upstream re-export cannot quietly pull a Node
 * import into the bundle. `check:bundle` would catch that, but only after the
 * fact — and on a phone, where the failure is a runtime throw in a worker.
 */
export const CODEMODE_ALIASES = {
	"@earendil-works/pi-codemode/declarations": path.resolve(
		"node_modules/@earendil-works/pi-codemode/dist/declarations.js",
	),
	"@earendil-works/pi-codemode/source": path.resolve(
		"node_modules/@earendil-works/pi-codemode/dist/source.js",
	),
	"@earendil-works/pi-codemode/identifier": path.resolve(
		"node_modules/@earendil-works/pi-codemode/dist/identifier.js",
	),
	// Type-only, and the package's exports map does not list `dist/` at all.
	// Type-only imports vanish before bundling, so nothing here can reach a
	// Node module even by accident.
	"@earendil-works/pi-codemode/types": path.resolve(
		"node_modules/@earendil-works/pi-codemode/dist/types.d.ts",
	),
};

const PACKAGE_DIR = path.resolve("node_modules/@earendil-works/pi-codemode");
const packageFile = relative => path.join(PACKAGE_DIR, relative);
// Resolved from the package rather than from our root: `quickjs-wasi` is
// pi-codemode's own dependency, so a hoisted root copy is not guaranteed to be
// there and a nested one is not guaranteed to be at `../../`.
const fromPackage = createRequire(path.join(PACKAGE_DIR, "package.json"));

/**
 * The browser build of `quickjs-wasi`, as IIFE text.
 *
 * `quickjs-wasi` is already browser-clean — its dist imports nothing from
 * `node:` — so this is a plain re-bundle rather than a shim, and the result is
 * the same module the Node path runs, minus the host wiring it does not have.
 * Built with `format: "iife"` and a global name because the worker evaluates
 * the text with `new Function` and has no `import` to hang it on.
 */
async function buildQuickJs() {
	const built = await esbuild.build({
		// The package name, not a deep specifier: `exports` lists only `.` for JS, so
		// `quickjs-wasi/dist/index.js` is refused. The name resolves to that file
		// anyway (`main` points at it).
		entryPoints: [fromPackage.resolve("quickjs-wasi")],
		bundle: true,
		format: "iife",
		globalName: "__QUICKJS_WASI__",
		platform: "browser",
		write: false,
		logLevel: "silent",
	});
	return built.outputFiles[0].text;
}

/**
 * The prelude, as the text the VM will evaluate.
 *
 * Imported rather than bundled: the dist file is an ES module whose *source* is
 * not what the VM wants — it wants `PRELUDE_SOURCE`, the string that export holds.
 * Reading the file and inlining it verbatim puts `export const ...` in front of
 * the VM's first line, which fails as `unsupported keyword: export`.
 *
 * The deep specifier is needed because `exports` does not list this file, so no
 * bare specifier reaches it.
 */
async function buildPrelude() {
	const module = await import(pathToFileURL(packageFile("dist/runtime/prelude-source.js")).href);
	return module.PRELUDE_SOURCE;
}

/**
 * `quickjs.wasm`, base64.
 *
 * Read from the installed package rather than esbuild's `.wasm` loader: the
 * loader would emit a data: URL for an import specifier, and the file here is
 * named by a resolved dependency path, so the bytes are simpler to read
 * directly. The base64 is 850 KB of `main.js` — that is the cost of shipping a
 * VM with no file and no fetch, and it is the one the plan accepted.
 */
function wasmDataUrl() {
	return readFileSync(fromPackage.resolve("quickjs-wasi/quickjs.wasm")).toString("base64");
}

/**
 * Serves the three inlined values, resolving their specifiers first.
 *
 * `build.onStart` is where the bundle is prepared, so the IIFE is built once per
 * build and once per watched rebuild, not once per import site.
 */
export function codemodeRuntimePlugin() {
	let quickjsSource = "";
	let preludeSource = "";
	let wasmUrl = "";
	return {
		name: "piem-codemode-runtime",
		setup(build) {
			build.onStart(async () => {
				const [quickjs, prelude] = await Promise.all([buildQuickJs(), buildPrelude()]);
				quickjsSource = quickjs;
				preludeSource = prelude;
				// The wasm as a data: URL rather than bytes or a separate file. It is
				// 637 KB, so the bundle holds it either way; a URL costs no more and
				// leaves the decode to `fetch`. The release ships exactly
				// main.js/manifest.json/styles.css, so an emitted sibling file would
				// 404 for anyone installing from a release archive.
				wasmUrl = `data:application/wasm;base64,${wasmDataUrl()}`;
				if (process.env.PIEM_DEBUG_CODEMODE) {
					console.error(
						`[codemode] quickjs ${quickjsSource.length} B, prelude ${preludeSource.length} B, wasm ${wasmUrl.length} B`,
					);
				}
			});

			// `src/codemode/runtimeAsset.ts` is the one import site for the two
			// inlined values, so that is what gets replaced. Resolving the *path*
			// rather than a second specifier keeps `sandbox.ts` and the test
			// preload pointing at one file: an alias for a specifier nothing imports
			// builds green and ships an empty sandbox.
			build.onResolve({ filter: /(^|\/)runtimeAsset$/ }, args => {
				if (args.kind !== "import-statement") return undefined;
				return { path: args.path, namespace: "piem-codemode-asset" };
			});

			// `src/codemode/runtimeAsset.ts` is the one import site for the two
			// inlined values, so that is what gets replaced. Resolving the *path*
			// rather than a second specifier keeps `sandbox.ts` and the test
			// preload pointing at one file: an alias for a specifier nothing imports
			// builds green and ships an empty sandbox.
			// Each specifier resolves to itself in its own namespace; `onLoad` then
			// replaces the module with the literal it stands for.
			build.onResolve({ filter: new RegExp(`^(${PRELUDE}|${QUICKJS}|${WASM})$`) }, args => ({
				path: args.path,
				namespace: "piem-codemode",
			}));

			// The wasm URL sits inside a function body on purpose. As a top-level
			// initializer it would be evaluated when main.js loads and would allocate
			// ~850 KB of string on every Obsidian launch, whether or not the tool was
			// ever switched on. Parse time is zero either way, so only the allocation
			// distinguishes the two cases, and the tool ships off.
			build.onLoad({ filter: /.*/, namespace: "piem-codemode-asset" }, () => ({
				contents: `export const QUICKJS_IIFE_SOURCE = ${JSON.stringify(quickjsSource)};`
					+ `export function quickJsWasmUrl() { return ${JSON.stringify(wasmUrl)}; }`,
				loader: "js",
			}));

			build.onLoad({ filter: /.*/, namespace: "piem-codemode" }, args => {
				const literal = args.path === PRELUDE ? preludeSource
					: args.path === QUICKJS ? quickjsSource
					: wasmUrl;
				const name = args.path === PRELUDE ? "PRELUDE_SOURCE"
					: args.path === QUICKJS ? "QUICKJS_IIFE_SOURCE"
					: "QUICKJS_WASM_URL";
				return { contents: `export const ${name} = ${JSON.stringify(literal)};`, loader: "js" };
			});
		},
	};
}

export { PRELUDE, QUICKJS, WASM };