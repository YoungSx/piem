import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { err, FileError, ok, type FileSystem } from "@earendil-works/pi-durable/env";
import { LineScanner } from "../../node_modules/@earendil-works/pi-durable/dist/env/line-scan.js";

function failure(path: string, closed: boolean, context: Context): FileError | undefined {
	if (context.abortSignal?.aborted) return new FileError("aborted", "Operation aborted", path);
	if (closed) return new FileError("invalid", "Reader is closed", path);
	return undefined;
}

/** Obsidian exposes whole-file reads; retain one snapshot across Pi's positional reads. */
export async function openSnapshotBinaryReader(
	fs: Pick<FileSystem, "fileInfo" | "readBinaryFile">,
	path: string,
	options?: { noFollow?: boolean },
	context: Context = BACKGROUND_CONTEXT,
): ReturnType<FileSystem["openBinaryReader"]> {
	const aborted = failure(path, false, context);
	if (aborted) return err(aborted);
	// Vault APIs cannot attest whether the final path component is a symlink.
	if (options?.noFollow) return err(new FileError("not_supported", "Obsidian cannot open files without following symlinks", path));
	const info = await fs.fileInfo(path, context);
	if (!info.ok) return info;
	if (info.value.kind !== "file") return err(new FileError(info.value.kind === "directory" ? "is_directory" : "invalid", "Expected a regular file", path));
	const read = await fs.readBinaryFile(path, context);
	if (!read.ok) return read;
	const afterRead = failure(path, false, context);
	if (afterRead) return err(afterRead);
	let content = read.value;
	const metadata = { ...info.value, size: content.byteLength };
	let closed = false;
	return ok({
		info: async context => {
			const error = failure(path, closed, context);
			return error ? err(error) : ok({ ...metadata });
		},
		read: async (offset, length, context) => {
			const error = failure(path, closed, context);
			if (error) return err(error);
			if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
				return err(new FileError("invalid", "Offset and length must be non-negative safe integers", path));
			}
			return ok(content.slice(offset, offset + length));
		},
		scanLines: async (options, context) => {
			const error = failure(path, closed, context);
			if (error) return err(error);
			try {
				const scanner = new LineScanner(options.startLine, options.endLine);
				scanner.push(content);
				return ok(scanner.finish());
			} catch {
				return err(new FileError("invalid", "Invalid line range", path));
			}
		},
		close: async () => { closed = true; content = new Uint8Array(); },
	});
}

/** Page the same directory snapshot until the reader is closed. */
export async function openSnapshotDirReader(
	fs: Pick<FileSystem, "listDir">,
	path: string,
	context: Context = BACKGROUND_CONTEXT,
): ReturnType<FileSystem["openDirReader"]> {
	const aborted = failure(path, false, context);
	if (aborted) return err(aborted);
	const listing = await fs.listDir(path, context);
	if (!listing.ok) return listing;
	const afterRead = failure(path, false, context);
	if (afterRead) return err(afterRead);
	let entries = listing.value;
	let offset = 0;
	let closed = false;
	return ok({
		next: async (maxEntries, context) => {
			const error = failure(path, closed, context);
			if (error) return err(error);
			if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) return err(new FileError("invalid", "Page size must be a positive safe integer", path));
			const page = entries.slice(offset, offset + maxEntries);
			offset += page.length;
			return ok({ entries: page, done: offset === entries.length });
		},
		close: async () => { closed = true; entries = []; },
	});
}
