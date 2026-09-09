import { basename, dirname, extname, isAbsolute, join, normalize, sep, resolve as resolvePath, relative as relativePath } from "pathe";
import { cwd } from "./process";

/** Keep relative paths in the virtual workspace even in a desktop Node host. */
export * from "pathe";
export const resolve = (...parts: string[]): string => resolvePath(cwd(), ...parts);
export const relative = (from: string, to: string): string => relativePath(resolve(from), resolve(to));
export default { basename, dirname, extname, isAbsolute, join, normalize, sep, resolve, relative };
