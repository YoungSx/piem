import { unavailable } from "./unavailable";
import { fileURLToPath } from "./url";
/** All executable imports are bundled statically. No runtime require is admitted. */
export function createRequire(url: string | URL): ((id: string) => never) & { resolve(id: string): never } {
	fileURLToPath(url);
	return Object.assign((id: string): never => unavailable(`require(${id})`), {
		resolve: (id: string): never => unavailable(`require.resolve(${id})`),
	});
}
export const builtinModules: readonly string[] = [];
