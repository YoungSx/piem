import { extensionResources } from "./resources";
import { unavailable } from "./unavailable";
import { fileURLToPath } from "./url";
import { resolve } from "./path";

function key(path: string | URL): string {
	return resolve(typeof path === "string" ? path : fileURLToPath(path));
}
function missing(path: string): Error {
	return Object.assign(new Error(`No bundled resource: ${path}`), { code: "ENOENT", path });
}
export const constants = Object.freeze({ F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 });
export function existsSync(path: string | URL): boolean {
	return Object.prototype.hasOwnProperty.call(extensionResources, key(path));
}
export function readFileSync(path: string | URL, encoding: string): string {
	if (encoding !== "utf8" && encoding !== "utf-8") return unavailable("non-UTF-8 resource reads");
	const name = key(path);
	const content = extensionResources[name];
	if (!Object.prototype.hasOwnProperty.call(extensionResources, name)) throw missing(name);
	if (content === undefined) throw missing(name);
	return content;
}
export function accessSync(path: string | URL, mode = constants.F_OK): void {
	if ((mode & (constants.W_OK | constants.X_OK)) !== 0) unavailable("writable or executable resources");
	if (!existsSync(path)) throw missing(key(path));
}
export function realpathSync(path: string | URL): string {
	accessSync(path);
	return key(path);
}
export const statSync = (): never => unavailable("fs.statSync");
export const readdirSync = (): never => unavailable("fs.readdirSync");
export const watch = (): never => unavailable("fs.watch");
export const readFile = (): never => unavailable("fs.readFile");
export const writeFileSync = (): never => unavailable("fs.writeFileSync");
export const mkdirSync = (): never => unavailable("fs.mkdirSync");
export const unlinkSync = (): never => unavailable("fs.unlinkSync");
export default { constants, existsSync, readFileSync, accessSync, realpathSync, statSync, readdirSync, watch, readFile, writeFileSync, mkdirSync, unlinkSync };
