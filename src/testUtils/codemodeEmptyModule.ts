/**
 * The empty constants the codemode build specifiers resolve to under a test.
 *
 * A real build replaces these two modules with the QuickJS IIFE and the base64
 * data URL (`scripts/codemode-runtime.mjs`); there is no build in a test run, so
 * they stand empty with the shape the source expects. That keeps
 * {@link ../codemode/workerSource} importable — its ordering and syntax are worth
 * asserting — without pretending the sandbox can run here.
 */
export const QUICKJS_IIFE_SOURCE = "";
/**
 * A function to match the shape the build emits: the point of the function is
 * that the string is materialized on first call rather than at load.
 */
export function quickJsWasmUrl(): string {
	return "";
}
