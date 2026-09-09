import { sha256Hex } from "./skillHash";

export const BUILTIN_SKILLS_DIR = "Piem/builtin-skills";
export const MAX_SKILL_PACKAGE_BYTES = 1024 * 1024;
export const MAX_SKILL_FILE_BYTES = 256 * 1024;
export const MAX_SKILL_FILES = 64;

export interface BuiltinSkillAsset {
	sha256: string;
	bytes: number;
	names: string[];
}

export interface BuiltinSkillFile {
	path: string;
	content: string;
}

export interface BuiltinSkillPackage {
	schema: 1;
	version: string;
	files: BuiltinSkillFile[];
}

export function isSkillName(value: unknown): value is string {
	return typeof value === "string" && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

export function isSkillResourcePath(value: unknown): value is string {
	return typeof value === "string" && /^[a-z0-9-]+\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.md$/.test(value)
		&& isSkillName(value.split("/")[0]);
}

export function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** Validate all bytes and destinations before any Vault mutation. */
export async function readBuiltinSkillPackage(text: string, asset: BuiltinSkillAsset, version: string): Promise<BuiltinSkillPackage> {
	const bytes = new TextEncoder().encode(text).byteLength;
	if (bytes !== asset.bytes || bytes > MAX_SKILL_PACKAGE_BYTES || await sha256Hex(text) !== asset.sha256) {
		throw new Error("Built-in skill package failed its size or checksum check.");
	}
	const data: unknown = JSON.parse(text);
	if (!data || typeof data !== "object") throw new Error("Invalid skill package.");
	const record = data as Record<string, unknown>;
	if (record.schema !== 1 || record.version !== version || !Array.isArray(record.files)
		|| !record.files.length || record.files.length > MAX_SKILL_FILES) throw new Error("Invalid skill package version or file list.");
	const files: BuiltinSkillFile[] = [];
	const paths = new Set<string>();
	for (const entry of record.files) {
		if (!entry || typeof entry !== "object") throw new Error("Invalid skill file.");
		const file = entry as Record<string, unknown>;
		if (!isSkillResourcePath(file.path) || typeof file.content !== "string" || paths.has(file.path)
			|| !asset.names.includes(file.path.split("/")[0] ?? "")
			|| new TextEncoder().encode(file.content).byteLength > MAX_SKILL_FILE_BYTES) throw new Error("Invalid skill file path or content.");
		paths.add(file.path);
		files.push({ path: file.path, content: file.content });
	}
	if (!asset.names.every((name) => isSkillName(name) && paths.has(`${name}/SKILL.md`))) throw new Error("Missing skill entry.");
	return { schema: 1, version, files };
}
