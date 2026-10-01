import { plugin } from "bun";
import path from "node:path";
import { readFileSync } from "node:fs";
import { CODEMODE_ALIASES } from "../../scripts/codemode-runtime.mjs";

/**
 * Bun has no idea esbuild's aliases exist.
 *
 * `bun test` evaluates every source file directly, and five of this feature's
 * imports are names only the build resolves: `@earendil-works/pi-codemode/
 * declarations`, `/source` and `/identifier` are aliased to their `dist` files,
 * `/prelude` to the prelude's source, and `/quickjs-wasm` plus
 * `/quickjs-wasm-url` to the two values the runtime plugin inlines. A test
 * importing any of them fails to resolve — with an error that has nothing to do
 * with what it is checking.
 *
 * Bun's `build.module` returns `contents`, not a path, so these are served as
 * text. That breaks the one relative import inside the package
 * (`declarations.js` → `identifier.js`): a virtual module has no directory for
 * `./identifier.js` to resolve against. So the three entry files are concatenated
 * here in dependency order with that import line dropped, which is why this is a
 * hand-written list rather than a loop over the alias table.
 *
 * Everything else is read from {@link CODEMODE_ALIASES} or derived from it, so a
 * test and the bundle cannot drift onto different files — the failure that
 * produces is a green suite and a broken build, because the divergence would sit
 * in a path only esbuild ever resolves.
 *
 * The two inlined values resolve to {@link ./codemodeEmptyModule}: a test run has
 * no build to inline them, and a worker with no VM in it is still a worker whose
 * source parses and whose ordering can be asserted. What needs a real VM builds
 * the sources itself ({@link ../codemode/sandbox.test.ts}).
 */
const PACKAGE_DIST = path.resolve("node_modules/@earendil-works/pi-codemode/dist");
const EMPTY_MODULE = path.resolve("src/testUtils/codemodeEmptyModule.ts");

/**
 * `identifier.js` first: `declarations.js` imports from it, and that import is
 * the line dropped below.
 */
const DIST = [
	{ file: path.join(PACKAGE_DIST, "identifier.js"), drop: [] as RegExp[] },
	{
		file: path.join(PACKAGE_DIST, "declarations.js"),
		// Both lines come out. The import is unresolvable — a virtual module has no
		// directory for `./identifier.js` — and the re-export would collide with the
		// same function the file above already declares.
		drop: [
			/^import \{ toCodemodeIdentifier \} from "\.\/identifier\.js";\n/m,
			/^export \{ toCodemodeIdentifier \};\n/m,
		],
	},
	{ file: path.join(PACKAGE_DIST, "source.js"), drop: [] as RegExp[] },
];

/** Served whole, because each has nothing left to resolve on its own. */
const VERBATIM: Record<string, string> = {
	"@earendil-works/pi-codemode/types": CODEMODE_ALIASES["@earendil-works/pi-codemode/types"]!,
	"@earendil-works/pi-codemode/prelude": path.join(PACKAGE_DIST, "runtime/prelude-source.js"),
};

function inline(entry: { file: string; drop: RegExp[] }): string {
	let text = readFileSync(entry.file, "utf8");
	for (const pattern of entry.drop) text = text.replace(pattern, "");
	return text;
}

plugin({
	name: "piem-codemode-build-specifiers",
	setup(build) {
		build.module("@earendil-works/pi-codemode/identifier", () => ({
			contents: readFileSync(path.join(PACKAGE_DIST, "identifier.js"), "utf8"),
			loader: "js",
		}));
		build.module("@earendil-works/pi-codemode/source", () => ({
			contents: readFileSync(path.join(PACKAGE_DIST, "source.js"), "utf8"),
			loader: "js",
		}));
		build.module("@earendil-works/pi-codemode/identifier", () => ({
			contents: readFileSync(path.join(PACKAGE_DIST, "identifier.js"), "utf8"),
			loader: "js",
		}));
		build.module("@earendil-works/pi-codemode/source", () => ({
			contents: readFileSync(path.join(PACKAGE_DIST, "source.js"), "utf8"),
			loader: "js",
		}));
		build.module("@earendil-works/pi-codemode/declarations", () => ({
			contents: DIST.map(inline).join("\n"),
			loader: "js",
		}));
		for (const [specifier, file] of Object.entries(VERBATIM)) {
			build.module(specifier, () => ({
				contents: readFileSync(file, "utf8"),
				loader: file.endsWith(".ts") ? "ts" : "js",
			}));
		}
		for (const specifier of ["@earendil-works/pi-codemode/quickjs-wasm", "@earendil-works/pi-codemode/quickjs-wasm-url"]) {
			build.module(specifier, () => ({ contents: readFileSync(EMPTY_MODULE, "utf8"), loader: "ts" }));
		}
	},
});
