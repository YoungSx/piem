import { createScanningSessionSearch, err, FileError, JsonlSessionRepo, ok, type Result } from "@earendil-works/pi-agent-core";
import type { SessionRepoFileSystem } from "./ObsidianSessionFileSystem";
import { makeSnippet, projectSessionEntryText, type StoredSessionSearchHit, type StoredSessionSearchPage, type StoredSessionSearchPageOptions } from "./sessionSearch";
import { throwIfAborted } from "../tools/toolResult";

const PAGE_FILES = 20;
const FILE_BYTES = 2 * 1024 * 1024;
const PAGE_BYTES = 8 * 1024 * 1024;

/**
 * Pi owns the JSONL format, directory naming, and search projection. This
 * adapter bounds its listing before any header is read: Obsidian has no
 * streaming read, so even reading a header otherwise loads the whole log.
 * The same cached text backs header and entry reads. Write methods refuse
 * Pi's automatic torn-tail repair, keeping search strictly read-only.
 */
export async function searchStoredSessions(
	fs: SessionRepoFileSystem,
	sessionsRoot: string,
	cwd: string,
	text: string,
	options: StoredSessionSearchPageOptions = {},
): Promise<StoredSessionSearchPage> {
	const query = text.trim();
	if (!query) throw new Error("Pass a non-empty conversation search query.");
	const offset = options.offset ?? 0;
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer.");
	throwIfAborted(options.signal);
	const result: StoredSessionSearchPage = { hits: [], nextOffset: null, scanned: 0, skipped: [] };
	const skipped = new Set<string>();
	const selected = new Set<string>();
	const cache = new Map<string, string>();
	let bytes = 0;
	const read = async (path: string): Promise<Result<string, FileError>> => {
		throwIfAborted(options.signal);
		const cached = cache.get(path);
		if (cached !== undefined) return ok(cached);
		if (!selected.has(path)) return err(new FileError("permission_denied", "Path is outside this search page.", path));
		const info = await fs.fileInfo(path, options.signal);
		throwIfAborted(options.signal);
		if (!info.ok) return info;
		if (info.value.size > FILE_BYTES || bytes + info.value.size > PAGE_BYTES) {
			return err(new FileError("invalid", "Session exceeds this search page's read budget.", path));
		}
		const readResult = await fs.readTextFile(path, options.signal);
		throwIfAborted(options.signal);
		if (readResult.ok) {
			const size = new TextEncoder().encode(readResult.value).byteLength;
			bytes += size;
			if (size > FILE_BYTES || bytes > PAGE_BYTES) return err(new FileError("invalid", "Session grew beyond the read budget.", path));
			cache.set(path, readResult.value);
		}
		return readResult;
	};
	const refuseWrite = (path: string): Promise<Result<never, FileError>> =>
		Promise.resolve(err(new FileError("permission_denied", "Conversation search never repairs or writes log files.", path)));
	const bounded: SessionRepoFileSystem = {
		cwd: fs.cwd,
		absolutePath: (path) => fs.absolutePath(path, options.signal),
		joinPath: (parts) => fs.joinPath(parts, options.signal),
		fileInfo: (path) => fs.fileInfo(path, options.signal),
		exists: (path) => fs.exists(path, options.signal),
		listDir: async (path) => {
			throwIfAborted(options.signal);
			const listing = await fs.listDir(path, options.signal);
			throwIfAborted(options.signal);
			if (!listing.ok) return listing;
			const files = listing.value.filter((file) => file.kind === "file" && file.name.endsWith(".jsonl"))
				.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
			const page = [];
			let plannedBytes = 0;
			for (const file of files.slice(offset, offset + PAGE_FILES)) {
				if (file.size <= FILE_BYTES && plannedBytes + file.size > PAGE_BYTES) break;
				result.scanned += 1;
				if (file.size > FILE_BYTES) {
					skipped.add(file.path);
					continue;
				}
				plannedBytes += file.size;
				selected.add(file.path);
				page.push(file);
			}
			result.nextOffset = offset + result.scanned < files.length ? offset + result.scanned : null;
			return ok(page);
		},
		readTextFile: read,
		readTextLines: async (path, readOptions) => {
			const content = await read(path);
			if (!content.ok) {
				skipped.add(path);
				return ok([]);
			}
			return ok(content.value.split("\n").slice(0, readOptions?.maxLines));
		},
		writeFile: refuseWrite,
		appendFile: refuseWrite,
		renameFile: refuseWrite,
		createDir: refuseWrite,
		remove: refuseWrite,
	};
	const repo = new JsonlSessionRepo({ fs: bounded, sessionsRoot });
	const metadata = await repo.list({ cwd });
	throwIfAborted(options.signal);
	for (const path of selected) {
		if (!metadata.some((entry) => entry.path === path)) skipped.add(path);
	}
	for (const entry of metadata) {
		throwIfAborted(options.signal);
		try {
			const session = await repo.open(entry);
			const search = createScanningSessionSearch([session], {
				projectText: projectSessionEntryText,
				createHit: (meta, candidate): StoredSessionSearchHit => ({
					sessionId: meta.id, path: meta.path, entryId: candidate.entryId,
					entryType: candidate.type, timestamp: candidate.timestamp, snippet: makeSnippet(candidate.text, query, 500),
				}),
			});
			for await (const hit of search.search(query, { limit: 1, signal: options.signal })) result.hits.push(hit);
		} catch {
			skipped.add(entry.path);
		}
	}
	throwIfAborted(options.signal);
	return { ...result, skipped: [...skipped] };
}
