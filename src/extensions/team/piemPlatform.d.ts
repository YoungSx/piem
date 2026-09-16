/**
 * The build-time platform specifier the scoped compiler extracts into each
 * factory closure (`pi-scoped-factories.mjs` closeOverPlatform). No runtime
 * module with this name exists in piem's graph: the import is external at
 * bundle time and becomes a destructuring of the host's per-factory platform.
 * Declared as an ambient module — this file deliberately has no top-level
 * imports, so the declaration stays global rather than a module augmentation —
 * with inline `import()` types so the bridge typechecks inside piem's tsc pass.
 */
declare module "piem:extension-platform" {
	export function createMemberSession(
		spec: import("./memberTypes").MemberSessionSpec,
	): Promise<import("./memberTypes").MemberSessionHandle>;
	export function getAgentDir(): string;
}
