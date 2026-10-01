import { plugin } from "bun";
import path from "node:path";
import { readFileSync } from "node:fs";
import { CODEMODE_ALIASES } from "../../scripts/codemode-runtime.mjs";

/**
 * Bun has no idea esbuild's aliases exist.
 *
 * `bun test` evaluates every source file directly, and three of this feature's
 * imports are build-time-only names that esbuild rewrites:
 * `@earendil-works/pi-codemode/prelude` becomes the prelude's dist file,
 * `/quickjs-wasm` the QuickJS IIFE, `/quickjs-wasm-url` the base64 data URL. A
 * test importing the worker source would fail to resolve the first one, with an
 * error that has nothing to do with what it is checking.
 *
 * This redirects them the way the build does. The host-side aliases come from
 * {@link CODEMODE_ALIASES} rather than being repeated here, so a test and the
 * bundle cannot drift onto different files — the failure that produces is a
 * green suite and a broken build, because the divergence would be in a path only
 * esbuild ever resolves.
 *
 * The two inlined values resolve to {@link ./codemodeEmptyModule}: under a test
 * there is no build to inline them, and a worker with no VM in it is still a
 * worker whose source parses and whose ordering can be asserted. Anything that
 * needs a real VM builds the sources itself ({@link ../codemode/sandbox.test.ts}).
 */
plugin({
	name: "piem-codemode-build-specifiers",
	setup(build) {
		for (const [specifier, file] of Object.entries(CODEMODE_ALIASES)) {
			build.module(specifier, () => ({ contents: readFileSync(file, "utf8"), loader: "ts" }));
		}
		build.module("@earendil-works/pi-codemode/prelude", () => ({
			contents: readFileSync(path.resolve("node_modules/@earendil-works/pi-codemode/dist/runtime/prelude-source.js"), "utf8"),
			loader: "js",
		}));
		for (const specifier of ["@earendil-works/pi-codemode/quickjs-wasm", "@earendil-works/pi-codemode/quickjs-wasm-url"]) {
			build.module(specifier, () => ({
				contents: readFileSync(path.resolve("src/testUtils/codemodeEmptyModule.ts"), "utf8"),
				loader: "ts",
			}));
		}
	},
});
