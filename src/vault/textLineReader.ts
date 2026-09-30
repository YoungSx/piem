import { BACKGROUND_CONTEXT, err, FileError, ok, type Context, type FileSystem } from "@earendil-works/pi-agent-core";

type TextLineReader = Extract<Awaited<ReturnType<FileSystem["openTextLineReader"]>>, { ok: true }>["value"];

/** Obsidian reads whole files; consume lines lazily without allocating a second line array. */
export function textLineReader(content: string, path: string): TextLineReader {
	let offset = 0;
	let closed = false;
	return {
		readLine: async (context: Context = BACKGROUND_CONTEXT) => {
			if (context.abortSignal?.aborted) return err(new FileError("aborted", "Operation aborted", path));
			if (closed) return err(new FileError("invalid", "Text line reader is closed", path));
			if (offset >= content.length) return ok(undefined);
			const newline = content.indexOf("\n", offset);
			const terminated = newline !== -1;
			const text = content.slice(offset, terminated ? newline : content.length);
			offset = terminated ? newline + 1 : content.length;
			return ok({ text, terminated });
		},
		close: async () => {
			closed = true;
			content = "";
		},
	};
}
