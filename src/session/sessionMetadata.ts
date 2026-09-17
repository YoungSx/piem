import type { JsonlSessionMetadata } from "@earendil-works/pi-agent-core";
import type { SessionRepoFileSystem } from "./ObsidianSessionFileSystem";

export function parseSessionHeaderMetadata(line: string, path: string, modifiedAt: number): JsonlSessionMetadata | undefined {
	try {
		const parsed = JSON.parse(line) as Record<string, unknown>;
		if (typeof parsed !== "object" || parsed === null) return undefined;

		// 0.85.1 format 4 or legacy 0.84 format 4
		if (parsed.kind === "header" && (parsed.v === 4 || parsed.version === 4)) {
			if (typeof parsed.id !== "string" || typeof parsed.cwd !== "string") return undefined;
			const createdAt = typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now();
			const storageVersion = typeof parsed.storageVersion === "number" ? parsed.storageVersion : 1;
			return {
				id: parsed.id,
				createdAt,
				storageVersion,
				cwd: parsed.cwd,
				path,
				modifiedAt,
				...(typeof parsed.parentSessionId === "string" ? { parentSessionId: parsed.parentSessionId } : {}),
				...(typeof parsed.legacyParentSessionPath === "string" ? { legacyParentSessionPath: parsed.legacyParentSessionPath } : {}),
			};
		}

		// legacy v3
		if (parsed.type === "session" && parsed.version === 3) {
			if (typeof parsed.id !== "string" || typeof parsed.cwd !== "string" || typeof parsed.timestamp !== "string") return undefined;
			const createdAt = Date.parse(parsed.timestamp);
			return {
				id: parsed.id,
				createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
				storageVersion: 1,
				cwd: parsed.cwd,
				path,
				modifiedAt,
				...(typeof parsed.parentSession === "string" ? { parentSessionId: parsed.parentSession } : {}),
			};
		}

		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolves a known log without listing every conversation in the vault.
 *
 * Pi's public repo only opens metadata, not paths. Its own codec constructs
 * that metadata here, just as `repo.list` does: ids come from the header, so a
 * hand-renamed file and a chat under an older cwd directory both still work.
 *
 * Keep the same boundary as Pi's listing: one cwd directory below the current
 * sessions root, then a `.jsonl` file. A direct read must not broaden which
 * paths the manager accepts merely because a caller knows their names.
 */
export async function readSessionMetadata(
	fs: SessionRepoFileSystem,
	sessionsRoot: string,
	path: string,
): Promise<JsonlSessionMetadata | undefined> {
	const prefix = sessionsRoot ? `${sessionsRoot}/` : "";
	if (!path.startsWith(prefix)) return undefined;
	const parts = path.slice(prefix.length).split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]?.endsWith(".jsonl")) return undefined;

	const file = await fs.fileInfo(path);
	if (!file.ok) {
		if (file.error.code === "not_found") return undefined;
		throw file.error;
	}
	if (file.value.kind === "directory") return undefined;
	const lines = await fs.readTextLines(path, { maxLines: 1 });
	if (!lines.ok) throw lines.error;
	const firstLine = lines.value[0];
	if (!firstLine) return undefined;
	return parseSessionHeaderMetadata(firstLine, path, file.value.mtimeMs);
}
