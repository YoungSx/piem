/**
 * runtimeAsset.ts — the two strings the worker needs, inlined at build time.
 *
 * Declared as empty constants because `tsc` and `bun test` both evaluate this
 * module without esbuild. The build replaces each body (see
 * `scripts/codemode-runtime.mjs`), so in a real build these hold the QuickJS IIFE
 * and the in-VM prelude.
 */

/** esbuild replaces this module with the browser build of `quickjs-wasi`, as IIFE text. */
export const QUICKJS_IIFE_SOURCE: string = "";

/**
 * esbuild replaces this module with a `data:` URL carrying `quickjs.wasm`.
 *
 * A URL rather than the bytes, because the whole binary is 637 KB and the bundle
 * already has to hold it: inlining it as base64 text costs 850 KB of `main.js`
 * either way. Measured in a real Obsidian: 21.5 ms to decode, 3.8 ms to compile,
 * once.
 *
 * A **function**, not a constant, and that is the point. The build emits the
 * string literal inside this body rather than as a top-level initializer: a
 * top-level initializer runs while `main.js` is evaluated, so the ~850 KB string
 * would be allocated on every Obsidian launch whether or not the tool was ever
 * switched on. Parse time is zero either way — which is all the bundle gate
 * measures — but resident memory is not, and the tool ships off. Inside the
 * function the literal is materialized on first call, which is the first
 * `codemode` invocation.
 */
export function quickJsWasmUrl(): string {
	return "";
}