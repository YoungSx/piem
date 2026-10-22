import type { App, TFile } from "obsidian";
import { normalizeFolderPath } from "../vault/path";

/** Search pages use code-unit ordering, independent of the host locale. */
export function compareSearchPaths(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function searchScope(app: App, path: string | undefined): string {
	const root = normalizeFolderPath(path ?? "");
	if (root && !app.vault.getFileByPath(root) && !app.vault.getFolderByPath(root)) {
		throw new Error(`File or folder not found: ${root}`);
	}
	return root;
}

export function filesInSearchScope(files: TFile[], root: string): TFile[] {
	return files
		.filter((file) => !root || file.path === root || file.path.startsWith(`${root}/`))
		.sort((left, right) => compareSearchPaths(left.path, right.path));
}

export function searchInteger(value: number, name: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
	}
	return value;
}
