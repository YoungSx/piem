import type { DataAdapter } from "obsidian";
import { err, FileError, ok, type FileInfo, type Result } from "@earendil-works/pi-agent-core";
import { normalizeVaultPath } from "../vault/path";
import { parseMutationLine, SessionLogRepairNet, type SessionDriftEvent } from "./sessionMutationLine";

/**
 * The slice of pi's `FileSystem` that `JsonlSessionRepo` actually calls.
 *
 * Declared here rather than imported as pi's `JsonlSessionRepoFileSystem`
 * because that type is not re-exported from the package root, and reaching into
 * `dist/harness/session/jsonl/types.js` fails the `exports` map. Structural
 * typing does the rest: the repo accepts anything with these twelve methods, so
 * a mismatch surfaces at the `new JsonlSessionRepo({ fs })` call site.
 */
export interface SessionRepoFileSystem {
	cwd: string;
	absolutePath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	joinPath(parts: string[], abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	readTextLines(path: string, options?: { maxLines?: number; abortSignal?: AbortSignal }): Promise<Result<string[], FileError>>;
	writeFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>>;
	appendFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>>;
	renameFile(sourcePath: string, destinationPath: string, abortSignal?: AbortSignal): Promise<Result<void, FileError>>;
	fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>>;
	listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>>;
	exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>>;
	createDir(path: string, options?: { recursive?: boolean; abortSignal?: AbortSignal }): Promise<Result<void, FileError>>;
	remove(path: string, options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal }): Promise<Result<void, FileError>>;
}

/**
 * Backs pi's `JsonlSessionRepo` with Obsidian's `DataAdapter` so chat logs are
 * stored and branched by pi rather than by hand-written JSONL code.
 *
 * Path space: vault-relative with no leading slash (`Piem/chats/….jsonl`), and
 * `cwd` is `""`. This is deliberately *not* `VaultExecutionEnv`'s `/`-prefixed
 * space even though that class already implements all twelve methods:
 *
 * - It routes every path through `normalizeVaultPath` without
 *   `allowPluginInternals`, so `.obsidian/plugins/piem/sessions/…` throws. That
 *   is where earlier releases kept chats, and `countSessionsIn` still has to
 *   read it to tell the Sessions tab how many were left behind.
 * - Its paths carry a leading slash, while `retention.ts` compares session paths
 *   against `activePath` by string equality. Mixing the two path spaces would
 *   quietly degrade the "never evict the active chat" guarantee.
 * - It reads through the vault index, which does not cover `.obsidian/`, so
 *   `listDir`/`fileInfo` would report not-found where `exists` reports true —
 *   an asymmetry that would send pi's branch resolution down the wrong path.
 * - Its writes go through `vault.*`, firing a vault event per appended message
 *   for every other plugin and the core index to observe.
 *
 * Failure contract: pi requires that these operations never throw. Every one
 * returns a {@link Result}, and unexpected backend failures are mapped onto
 * {@link FileError} by {@link toFileError}. Abort signals are checked between
 * steps because `DataAdapter` calls cannot themselves be cancelled.
 *
 * No path rewriting happens here. An earlier revision considered collapsing
 * pi's `--<cwd>--` directory level away to keep the chat folder flat; that was
 * ruled out, so this stays a straight translation layer and `repo.list()` works
 * without being handed a `cwd`.
 */
export class ObsidianSessionFileSystem implements SessionRepoFileSystem {
	readonly cwd = "";

	private readonly adapter: DataAdapter;
	private readonly trash: (path: string) => Promise<void>;

	private readonly repairNet: SessionLogRepairNet;

	/**
	 * `trash` is injected so the recoverability decision stays testable and in
	 * one place. It receives paths that are real session logs; temporary files
	 * never reach it (see {@link remove}).
	 *
	 * `onDrift` is the repair net's observability hook — every rewrite or skip
	 * it performs is reported, so the sync-underneath-us story is visible in
	 * the log rather than only in file shapes.
	 */
	constructor(adapter: DataAdapter, trash?: (path: string) => Promise<void>, onDrift?: (event: SessionDriftEvent) => void) {
		this.adapter = adapter;
		this.trash = trash ?? ((path) => trashSessionFile(adapter, path));
		this.repairNet = new SessionLogRepairNet(onDrift);
	}

	/**
	 * Identity, modulo normalization.
	 *
	 * pi treats the result as opaque and only feeds it back into `joinPath`, so
	 * "absolute" here means "canonical within the vault". Returning a
	 * `/`-prefixed path instead would leak a leading slash into
	 * `jsonlSessionDirectoryName` and into every stored `ActiveSessionInfo.path`.
	 */
	async absolutePath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		return this.run(path, abortSignal, async () => ok(this.normalize(path)));
	}

	async joinPath(parts: string[], abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		const joined = parts.filter((part) => part !== "").join("/");
		return this.run(joined, abortSignal, async () => ok(this.normalize(joined)));
	}

	async readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		return this.run(path, abortSignal, async () => ok(await this.adapter.read(this.normalize(path))));
	}

	/**
	 * Reads at most `maxLines` lines.
	 *
	 * `DataAdapter` has no streaming read, so the whole file is read and then
	 * sliced. pi uses this with `maxLines: 1` to pull a session header while
	 * listing, which means listing a folder of chats reads each one in full.
	 * Acceptable because the alternative is not available through this API, and
	 * the previous hand-written implementation read whole files too.
	 */
	async readTextLines(path: string, options: { maxLines?: number; abortSignal?: AbortSignal } = {}): Promise<Result<string[], FileError>> {
		return this.run(path, options.abortSignal, async () => {
			const content = await this.adapter.read(this.normalize(path));
			const lines = content.split("\n");
			// A trailing newline yields a final empty element that is not a line.
			if (lines.at(-1) === "") {
				lines.pop();
			}
			return ok(options.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
		});
	}

	async writeFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>> {
		return this.run(path, abortSignal, async () => {
			const target = this.normalize(path);
			await this.ensureParentDirectory(target);
			await this.adapter.write(target, toText(content));
			await this.repairNet.refresh(target, () => this.statRaw(target));
			return ok(undefined);
		});
	}

	/**
	 * The single choke point every pi append flows through — and therefore the
	 * place the sync-drift repair net lives.
	 *
	 * The vault sync plugin can land a whole-file version between two of our
	 * appends. pi's in-memory sequence would then write a seq the file already
	 * carries, and the next load would reject the file as invalid — the whole
	 * chat bricked. Before appending, the net compares the file's fingerprint
	 * against what our last write left; on drift it reads the disk and rewrites
	 * the incoming line to stay loadable (see `repairMutationLine`), dropping
	 * bookkeeping lines it cannot rescue. The in-memory view stays stale either
	 * way — recovering it is the merge layer's job, not this one's.
	 */
	async appendFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>> {
		return this.run(path, abortSignal, async () => {
			const target = this.normalize(path);
			const text = toText(content);
			const decision = await this.repairNet.prepare(target, text, {
				stat: () => this.statRaw(target),
				read: () => this.adapter.read(target),
			});
			if (decision.line === null) {
				const mutation = parseMutationLine(text);
				if (mutation?.kind === "fact" && mutation.fact === "label") {
					return err(new FileError("invalid", "The bookmarked reply is no longer on disk. Refresh the conversation and try again.", target));
				}
			}
			if (decision.line !== null) {
				await this.ensureParentDirectory(target);
				await this.adapter.append(target, decision.line);
			}
			await this.repairNet.refresh(target, () => this.statRaw(target), decision.appendedSeq);
			return ok(undefined);
		});
	}

	/**
	 * Rename, replacing the destination.
	 *
	 * `adapter.rename` rejects an existing destination but pi's contract requires
	 * replacement, so the target is removed first. The hard delete is correct
	 * here: pi only renames through `publishFileAtomically`, where the source is
	 * a `.tmp` file it just staged and the destination is the file being
	 * republished from that same content.
	 */
	async renameFile(sourcePath: string, destinationPath: string, abortSignal?: AbortSignal): Promise<Result<void, FileError>> {
		return this.run(sourcePath, abortSignal, async () => {
			const source = this.normalize(sourcePath);
			const destination = this.normalize(destinationPath);
			if (await this.adapter.exists(destination)) {
				await this.adapter.remove(destination);
			}
			await this.ensureParentDirectory(destination);
			await this.adapter.rename(source, destination);
			// A rename rewrites the destination wholesale, so its seq bookkeeping
			// is not inferable — the next append reads the disk once instead of
			// trusting a stale count. The source's baseline dies with the file.
			await this.repairNet.refresh(destination, () => this.statRaw(destination));
			this.repairNet.forget(source);
			return ok(undefined);
		});
	}

	async fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>> {
		return this.run(path, abortSignal, async () => {
			const target = this.normalize(path);
			const stat = await this.adapter.stat(target);
			if (!stat) {
				return err(new FileError("not_found", `File not found: ${target}`, target));
			}
			return ok(toFileInfo(target, stat.type, stat.size, stat.mtime));
		});
	}

	/**
	 * Direct children, with a `stat` per entry.
	 *
	 * pi needs `mtimeMs` to order sessions by recency, and `DataAdapter.list`
	 * returns bare paths, so each child is stat'd. An entry that disappears
	 * between the list and the stat is skipped rather than failing the listing:
	 * a folder of chats should still enumerate when one is being deleted
	 * concurrently.
	 */
	async listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
		return this.run(path, abortSignal, async () => {
			const target = this.normalize(path);
			if (!(await this.adapter.exists(target))) {
				return err(new FileError("not_found", `Directory not found: ${target}`, target));
			}
			const listed = await this.adapter.list(target);
			const infos: FileInfo[] = [];
			for (const child of [...listed.folders, ...listed.files]) {
				if (abortSignal?.aborted) {
					return err(new FileError("aborted", "Operation aborted", target));
				}
				const stat = await this.adapter.stat(child);
				if (!stat) {
					continue;
				}
				infos.push(toFileInfo(child, stat.type, stat.size, stat.mtime));
			}
			return ok(infos);
		});
	}

	async exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>> {
		return this.run(path, abortSignal, async () => ok(await this.adapter.exists(this.normalize(path))));
	}

	/**
	 * Creates a directory, and its parents when `recursive`.
	 *
	 * `adapter.mkdir` is not recursive, so segments are walked. Existing
	 * segments are skipped rather than letting `mkdir` fail, which also makes a
	 * concurrent creation of the same folder benign.
	 */
	async createDir(path: string, options: { recursive?: boolean; abortSignal?: AbortSignal } = {}): Promise<Result<void, FileError>> {
		return this.run(path, options.abortSignal, async () => {
			const target = this.normalize(path);
			if (target === "") {
				return ok(undefined);
			}
			if (options.recursive === false) {
				await this.mkdirIfMissing(target);
				return ok(undefined);
			}
			let current = "";
			for (const segment of target.split("/")) {
				current = current ? `${current}/${segment}` : segment;
				await this.mkdirIfMissing(current);
			}
			return ok(undefined);
		});
	}

	/**
	 * Removes a file, keeping real chat logs recoverable.
	 *
	 * The `.tmp` split is the reason this class cannot delegate to a generic
	 * vault filesystem. pi's `publishFileAtomically` removes its staging file on
	 * both the success and failure path, and torn-tail repair stages one too;
	 * routing those through the user's trash would drop debris there on every
	 * fork and every repaired session. A real session log is the only copy of a
	 * conversation, so it goes to trash instead — which is the guarantee
	 * `deleteSession` makes to the caller.
	 *
	 * `force` is honoured for missing paths only. pi passes `force: true` when
	 * removing staged files and when deleting a session, in both cases meaning
	 * "absent is fine", not "delete permanently".
	 */
	async remove(path: string, options: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal } = {}): Promise<Result<void, FileError>> {
		return this.run(path, options.abortSignal, async () => {
			const target = this.normalize(path);
			if (!(await this.adapter.exists(target))) {
				if (options.force === true) {
					return ok(undefined);
				}
				return err(new FileError("not_found", `File not found: ${target}`, target));
			}
			if (isTemporaryFile(target)) {
				await this.adapter.remove(target);
				return ok(undefined);
			}
			await this.trash(target);
			this.repairNet.forget(target);
			return ok(undefined);
		});
	}

	private normalize(path: string): string {
		// `allowPluginInternals` is what keeps the folder earlier releases used
		// readable: chats were stored under `.obsidian/plugins/piem/`, and the
		// Sessions tab still counts what was left there.
		return normalizeVaultPath(path, { allowPluginInternals: true });
	}

	/** Raw stat in the shape the repair net compares, or null when absent. */
	private async statRaw(target: string): Promise<{ mtime: number; size: number } | null> {
		const stat = await this.adapter.stat(target);
		return stat ? { mtime: stat.mtime, size: stat.size } : null;
	}

	private async ensureParentDirectory(target: string): Promise<void> {
		const index = target.lastIndexOf("/");
		if (index === -1) {
			return;
		}
		let current = "";
		for (const segment of target.slice(0, index).split("/")) {
			current = current ? `${current}/${segment}` : segment;
			await this.mkdirIfMissing(current);
		}
	}

	private async mkdirIfMissing(path: string): Promise<void> {
		if (await this.adapter.exists(path)) {
			return;
		}
		try {
			await this.adapter.mkdir(path);
		} catch (error) {
			// Losing a creation race is fine; anything else surfaces as the
			// caller's own write failure a moment later.
			if (!(await this.adapter.exists(path))) {
				throw error;
			}
		}
	}

	private async run<T>(
		path: string,
		abortSignal: AbortSignal | undefined,
		operation: () => Promise<Result<T, FileError>>,
	): Promise<Result<T, FileError>> {
		if (abortSignal?.aborted) {
			return err(new FileError("aborted", "Operation aborted", path));
		}
		try {
			return await operation();
		} catch (error) {
			return err(toFileError(error, path));
		}
	}
}

/**
 * Trash rather than delete, preferring the system trash.
 *
 * Mirrors what `ObsidianSessionManager.deleteSession` did before sessions moved
 * to pi: the system trash is where users already look and it reports failure
 * (disabled by the OS or the user) instead of throwing, so the vault-local
 * `.trash` folder covers that case.
 */
async function trashSessionFile(adapter: DataAdapter, path: string): Promise<void> {
	if (!(await adapter.trashSystem(path))) {
		await adapter.trashLocal(path);
	}
}

/** pi stages atomic writes as `<name>.tmp` siblings; those are debris, not chats. */
function isTemporaryFile(path: string): boolean {
	return path.endsWith(".tmp");
}

function toFileInfo(path: string, type: "file" | "folder", size: number, mtimeMs: number): FileInfo {
	return {
		name: path.slice(path.lastIndexOf("/") + 1),
		path,
		kind: type === "folder" ? "directory" : "file",
		size,
		mtimeMs,
	};
}

function toText(content: string | Uint8Array): string {
	return typeof content === "string" ? content : new TextDecoder().decode(content);
}

/** Maps an unexpected backend failure onto the stable FileError vocabulary. */
function toFileError(error: unknown, path: string): FileError {
	if (error instanceof FileError) {
		return error;
	}
	const message = error instanceof Error ? error.message : String(error);
	if (/not found|missing file|does not exist|no such file/i.test(message)) {
		return new FileError("not_found", message, path);
	}
	if (/already exists/i.test(message)) {
		return new FileError("invalid", message, path);
	}
	// A path rejected by `normalizeVaultPath` is a caller mistake, not a
	// backend failure; `invalid` is what pi's callers can act on.
	if (/must be vault-relative|'\.\.' segments|plugin internals/i.test(message)) {
		return new FileError("invalid", message, path);
	}
	return new FileError("unknown", message, path);
}
