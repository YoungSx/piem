import { describe, expect, it } from "bun:test";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { err, FileError, getOrThrow, ok, type FileInfo, type FileSystem } from "@earendil-works/pi-durable/env";
import { openSnapshotBinaryReader, openSnapshotDirReader } from "./snapshotReaders";

const info: FileInfo = { name: "note.md", path: "/note.md", kind: "file", size: 0, mtimeMs: 123 };
function source(text: string): Pick<FileSystem, "fileInfo" | "readBinaryFile"> {
	return { fileInfo: async () => ok(info), readBinaryFile: async () => ok(new TextEncoder().encode(text)) };
}
const aborted = () => withAbortSignal(AbortSignal.abort(), context);

describe("snapshot readers for Pi's file tools", () => {
	it("uses Pi's byte/line contract for BOM, Unicode, CRLF and an empty last line", async () => {
		const reader = getOrThrow(await openSnapshotBinaryReader(source("\uFEFF你好\r\nworld\n"), info.path));
		expect(getOrThrow(await reader.info(context))).toEqual({ ...info, size: 17 });
		const first = getOrThrow(await reader.scanLines({ startLine: 0, endLine: 1 }, context));
		expect(first).toMatchObject({ newlines: 2, start: 0, end: 10, selectedBytes: 7, firstLineBytes: 7 });
		const second = getOrThrow(await reader.scanLines({ startLine: 1, endLine: 2 }, context));
		expect(second).toMatchObject({ start: 11, end: 16, selectedBytes: 5 });
		expect(new TextDecoder().decode(getOrThrow(await reader.read(second.start, second.end - second.start, context)))).toBe("world");
		expect(getOrThrow(await reader.scanLines({ startLine: 20 }, context))).toMatchObject({ start: 17, end: 17, selectedBytes: 0 });
		expect(getOrThrow(await reader.read(0, Number.MAX_SAFE_INTEGER, context))).toHaveLength(17);
		expect(getOrThrow(await reader.read(100, 10, context))).toHaveLength(0);
		await reader.close(context);
	});

	it("owns its reads, validates ranges, and rejects aborted or closed operations", async () => {
		const reader = getOrThrow(await openSnapshotBinaryReader(source("abc"), info.path));
		getOrThrow(await reader.read(0, 3, context)).fill(0);
		expect(new TextDecoder().decode(getOrThrow(await reader.read(0, 3, context)))).toBe("abc");
		for (const [offset, length] of [[-1, 1], [0, -1], [0.5, 1], [0, Infinity]]) {
			expect(await reader.read(offset!, length!, context)).toMatchObject({ ok: false, error: { code: "invalid" } });
		}
		expect(await reader.scanLines({ startLine: 1, endLine: 0 }, context)).toMatchObject({ ok: false, error: { code: "invalid" } });
		expect(await reader.read(0, 1, aborted())).toMatchObject({ ok: false, error: { code: "aborted" } });
		await reader.close(context); await reader.close(context);
		for (const result of [await reader.info(context), await reader.read(0, 1, context), await reader.scanLines({ startLine: 0 }, context)]) {
			expect(result).toMatchObject({ ok: false, error: { code: "invalid" } });
		}
	});

	it("preserves failed opens and does not claim symlink guarantees Obsidian cannot provide", async () => {
		const file = source("data");
		expect(await openSnapshotBinaryReader(file, info.path, undefined, aborted())).toMatchObject({ ok: false, error: { code: "aborted" } });
		expect(await openSnapshotBinaryReader(file, info.path, { noFollow: true })).toMatchObject({ ok: false, error: { code: "not_supported" } });
		expect(await openSnapshotBinaryReader({ ...file, fileInfo: async () => ok({ ...info, kind: "directory" }) }, "/dir")).toMatchObject({ ok: false, error: { code: "is_directory" } });
		const missing = err<never, FileError>(new FileError("not_found", "Missing", info.path));
		expect(await openSnapshotBinaryReader({ ...file, fileInfo: async () => missing }, info.path)).toBe(missing);
	});

	it("pages a directory and rejects invalid, aborted and closed reads", async () => {
		const entries = [info, { ...info, name: "other.md" }];
		const fs: Pick<FileSystem, "listDir"> = { listDir: async () => ok(entries) };
		const reader = getOrThrow(await openSnapshotDirReader(fs, "/"));
		expect(await reader.next(0, context)).toMatchObject({ ok: false, error: { code: "invalid" } });
		expect(await reader.next(1, aborted())).toMatchObject({ ok: false, error: { code: "aborted" } });
		expect(getOrThrow(await reader.next(1, context))).toEqual({ entries: [info], done: false });
		expect(getOrThrow(await reader.next(10, context))).toEqual({ entries: entries.slice(1), done: true });
		expect(getOrThrow(await reader.next(1, context))).toEqual({ entries: [], done: true });
		await reader.close(context); await reader.close(context);
		expect(await reader.next(1, context)).toMatchObject({ ok: false, error: { code: "invalid" } });
		expect(await openSnapshotDirReader(fs, "/", aborted())).toMatchObject({ ok: false, error: { code: "aborted" } });
	});
});
