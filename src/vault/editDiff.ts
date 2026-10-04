/**
 * Bridge to pi's edit/diff engine (`dist/harness/tools/edit-diff.js`).
 *
 * pi-agent-core 0.84.3 implements the whole exact+fuzzy matching pipeline and
 * the display diff inside that module, but none of it is exported from the
 * package root: the `exports` map only admits ".", "./node" and
 * "./session/testing", so the canonical
 * `@earendil-works/pi-durable/dist/tools/edit-diff.js` specifier is
 * rejected by Bun and esbuild at runtime even though TypeScript resolves it.
 * Importing the emitted file through its real location under `node_modules/`
 * works in every toolchain this repo uses (verified against
 * `tsc --noEmit --strict`, `bun test`, and an esbuild bundle) and hands us the
 * exact, battle-tested implementation pi's own edit tool executes rather than
 * a hand-ported copy that could drift.
 *
 * Every consumer imports from this module so the workaround lives in exactly
 * one place; if a future pi release exports these helpers from the root,
 * delete this file and point the imports at the package specifier.
 */
export {
	applyEditsToNormalizedContent,
	detectLineEnding,
	generateDiffString,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "../../node_modules/@earendil-works/pi-durable/dist/tools/edit-diff.js";
export type { AppliedEditsResult, Edit } from "../../node_modules/@earendil-works/pi-durable/dist/tools/edit-diff.js";
