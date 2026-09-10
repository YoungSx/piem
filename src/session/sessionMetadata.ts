import type { JsonlSessionMetadata } from "@earendil-works/pi-agent-core";
import { metadataFromHeader, parseHeader } from "../../node_modules/@earendil-works/pi-agent-core/dist/harness/session/jsonl/codec.js";
import type { SessionRepoFileSystem } from "./ObsidianSessionFileSystem";

/**
 * Resolves a known log without listing every conversation in the vault.
 *
 * Pi's public repo only opens metadata, not paths. Its own codec constructs
 * that metadata here, just as `repo.list` does: ids come from the header, so a
 * hand-renamed file and a chat under an older cwd directory both still work.
 * The codec is already used by `sessionMerge`; it is not re-exported from the
 * package root in our pinned Pi version.
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
	const header = parseHeader(firstLine);
	return header.ok ? metadataFromHeader(header.value, path, file.value.mtimeMs) : undefined;
}
