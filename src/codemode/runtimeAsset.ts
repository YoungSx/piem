/** Build-time asset seam. scripts/codemode-runtime.mjs embeds the real runtime. */
export const QUICKJS_IIFE_SOURCE: string = "";

/** Keep the bundled wasm literal lazy until the first script needs it. */
export function quickJsWasmUrl(): string { return ""; }
