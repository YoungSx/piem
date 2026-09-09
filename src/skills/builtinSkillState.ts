import { isSha256, isSkillName, isSkillResourcePath } from "./builtinSkillPackage";

/** Ownership survives reloads; unknown files are never owned merely by their path. */
export interface BuiltinSkillState {
	schema: 1;
	version: string;
	digest: string;
	complete: boolean;
	files: Record<string, string>;
	removed: string[];
}

export interface BuiltinSkillProblem {
	path: string;
	reason: "modified" | "unowned" | "read" | "write" | "retired";
	message?: string;
}

export interface BuiltinSkillReport {
	status: "idle" | "preparing" | "ready" | "issues" | "failed" | "newer";
	problems: BuiltinSkillProblem[];
	removed: string[];
	modified: string[];
	error?: string;
}

export function emptyBuiltinSkillReport(): BuiltinSkillReport {
	return { status: "idle", problems: [], removed: [], modified: [] };
}

/** Reject the entire record if any ownership evidence is malformed. */
export function normalizeBuiltinSkillState(input: unknown): BuiltinSkillState | undefined {
	if (!input || typeof input !== "object") return undefined;
	const value = input as Record<string, unknown>;
	if (value.schema !== 1 || typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value.version)
		|| !isSha256(value.digest) || typeof value.complete !== "boolean"
		|| !value.files || typeof value.files !== "object" || Array.isArray(value.files)
		|| !Array.isArray(value.removed) || !value.removed.every(isSkillName)) return undefined;
	const files: Record<string, string> = {};
	for (const [path, hash] of Object.entries(value.files)) {
		if (!isSkillResourcePath(path) || !isSha256(hash)) return undefined;
		files[path] = hash;
	}
	return { schema: 1, version: value.version, digest: value.digest, complete: value.complete, files, removed: [...new Set(value.removed)] };
}

/** Official releases have three numeric fields; a stable release outranks its prerelease. */
export function isNewerSkillVersion(installed: string, target: string): boolean {
	const left = installed.split("-")[0]?.split(".").map(Number) ?? [];
	const right = target.split("-")[0]?.split(".").map(Number) ?? [];
	for (let index = 0; index < 3; index++) {
		if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0);
	}
	return !installed.includes("-") && target.includes("-");
}
