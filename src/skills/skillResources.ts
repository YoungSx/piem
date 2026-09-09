import { getOrThrow, type ExecutionEnv, type Skill } from "@earendil-works/pi-agent-core";

export const MAX_SKILL_RESOURCE_BYTES = 1024 * 1024;
type EnvAccess = <T>(read: (env: ExecutionEnv) => Promise<T>) => Promise<T>;
type ResourceReader = (path: string, signal?: AbortSignal) => Promise<{ text: string; filePath: string }>;

// Skill snapshots own these readers. Dropping a snapshot releases its binding;
// no open files, filesystem watchers, or lifetime-long Node environments.
const readers = new WeakMap<Skill, ResourceReader>();

export function validateSkillResourcePath(path: string): void {
	if (!path || /[\\\0:]/.test(path) || path.startsWith("/") || path.startsWith("~")
		|| path.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
		throw new Error("Use a relative resource path inside this skill directory; absolute paths, hidden paths and '..' are not allowed.");
	}
}

function normalized(path: string): string {
	const value = path.replace(/\\/g, "/").replace(/\/+$/, "");
	return /^[a-z]:/i.test(value) ? value.toLowerCase() : value;
}

function isInside(root: string, path: string): boolean {
	return normalized(path).startsWith(`${normalized(root)}/`);
}

/** Pin the canonical root at discovery so retargeting a symlink cannot widen access. */
export async function bindSkillResources(skill: Skill, env: ExecutionEnv, access: EnvAccess = (read) => read(env), vaultRoot?: string): Promise<void> {
	const directory = skill.filePath.replace(/[/\\][^/\\]+$/, "");
	const root = vaultRoot ?? getOrThrow(await env.canonicalPath(directory));
	readers.set(skill, async (path, signal) => {
		validateSkillResourcePath(path);
		signal?.throwIfAborted();
		return access(async (current) => {
			const currentRoot = getOrThrow(await current.canonicalPath(root));
			if (normalized(currentRoot) !== normalized(root)) throw new Error("Skill directory changed. Reload skills and try again.");
			const filePath = getOrThrow(await current.canonicalPath(getOrThrow(await current.joinPath([currentRoot, path]))));
			if (!isInside(root, filePath)) throw new Error("Skill resource escapes its directory.");
			const relative = filePath.replace(/\\/g, "/").slice(currentRoot.replace(/\\/g, "/").replace(/\/+$/, "").length + 1);
			validateSkillResourcePath(relative);
			const info = getOrThrow(await current.fileInfo(filePath));
			if (info.kind !== "file") throw new Error("Skill resource must be a file.");
			if (info.size > MAX_SKILL_RESOURCE_BYTES) throw new Error("Skill resource exceeds the 1 MiB limit.");
			signal?.throwIfAborted();
			const bytes = getOrThrow(await current.readBinaryFile(filePath, signal));
			if (bytes.byteLength > MAX_SKILL_RESOURCE_BYTES) throw new Error("Skill resource exceeds the 1 MiB limit.");
			signal?.throwIfAborted();
			try {
				const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
				if (text.includes("\0")) throw new Error("Binary content");
				return { text, filePath };
			} catch {
				throw new Error("read_skill resources must be UTF-8 text. Use the vault read tool for images inside the vault.");
			}
		});
	});
}

export async function readSkillResource(skill: Skill, path: string, signal?: AbortSignal): Promise<{ text: string; filePath: string }> {
	validateSkillResourcePath(path);
	const read = readers.get(skill);
	if (!read) throw new Error("Skill resource access is unavailable. Reload skills and try again.");
	return read(path, signal);
}
