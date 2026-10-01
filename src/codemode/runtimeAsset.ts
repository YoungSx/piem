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
 * either way, and a URL costs no more while letting `fetch` own the decode.
 * Measured in a real Obsidian: 3.8 ms to compile the result, 21.5 ms to decode the
 * URL's base64 — once, since {@link ./sandbox} caches the compiled module.
 */
export const QUICKJS_WASM_URL: string = "";