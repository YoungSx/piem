import { TFile, TFolder, type App } from "obsidian";
import type { Context } from "@earendil-works/chord";
import {
	err,
	ExecutionError,
	FileError,
	ok,
	type ExecutionEnv,
	type FileInfo,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
} from "@earendil-works/pi-agent-core";
import { getParentPath, normalizeVaultPath } from "./path";
import { trashOrDelete } from "./trash";

/**
 * Exposes an Obsidian vault as pi's {@link ExecutionEnv} so the native
 * harness tools (`createReadTool` / `createWriteTool` / `createEditTool`)
 * can operate on vault notes without touching disk paths.
 *
 * Path space: pi addresses files with absolute paths, so this environment uses
 * `/`-prefixed vault-relative paths (`/Notes/Idea.md`) and reports `cwd` as `/`.
 * Every method funnels through {@link toVaultRelative}, which reuses
 * {@link normalizeVaultPath} — the same traversal (`..`) and plugin-internals
 * guards our hand-written tools enforce.
 *
 * Config directory, read-only: Obsidian indexes neither the config directory
 * (`.obsidian`) nor dot-folders, so `getFileByPath` answers null for files the
 * adapter reads without complaint — which made `read` fail on the settings the
 * user can see in their own file manager. Reads fall back to the adapter
 * ({@linkcode readOutsideIndex}); every mutation refuses a config path outright
 * ({@linkcode refuseMutation}). The agent may inspect settings, hotkeys and
 * plugin data, and it may never rewrite them.
 *
 * Failure contract: the FileSystem interface requires that operations never
 * throw; every failure, including backend surprises, comes back as a
 * {@link Result} carrying a {@link FileError}. Abort signals are honored
 * between steps because vault calls themselves cannot be cancelled.
 *
 * Deliberate stubs:
 * - {@linkcode exec} returns `shell_unavailable`; an Obsidian plugin has no
 *   process environment to run commands in.
 * - {@linkcode createTempDir}/{@linkcode createTempFile} return
 *   `not_supported`; only pi's bash tool consumes them, for spilling oversized
 *   command output, and that tool cannot run here anyway.
 */
export class VaultExecutionEnv implements ExecutionEnv {
	readonly cwd = "/";

	private readonly app: App;

	constructor(app: App) {
		this.app = app;
	}

	private get vault(): App["vault"] {
		return this.app.vault;
	}

	async absolutePath(path: string, _context?: Context): Promise<Result<string, FileError>> {
		return this.run(path, async () => ok(toEnvironmentPath(path)));
	}

	async joinPath(parts: string[], _context?: Context): Promise<Result<string, FileError>> {
		return this.run(parts.join("/"), async () => ok(toEnvironmentPath(parts.filter((part) => part !== "").join("/"))));
	}

	async readTextFile(path: string, contextOrSignal?: Context | AbortSignal): Promise<Result<string, FileError>> {
		return this.run(path, async () => {
			const failure = abortedFailure(contextOrSignal, path);
			if (failure) {
				return failure;
			}
			const inner = toVaultRelative(path);
			const file = this.vault.getFileByPath(inner);
			if (file) {
				return ok(await this.vault.read(file));
			}
			return this.readOutsideIndex(inner, path, (target) => this.vault.adapter.read(target));
		});
	}

	async readTextLines(
		path: string,
		options?: { maxLines?: number; abortSignal?: AbortSignal },
		contextOrSignal?: Context | AbortSignal,
	): Promise<Result<string[], FileError>> {
		return this.run(path, async () => {
			const signal = options?.abortSignal ?? signalFrom(contextOrSignal);
			const read = await this.readTextFile(path, signal);
			if (!read.ok) {
				return read;
			}
			const lines = read.value.split(/\r?\n/);
			const maxLines = options?.maxLines;
			return ok(maxLines === undefined ? lines : lines.slice(0, Math.max(0, maxLines)));
		});
	}

	async readBinaryFile(path: string, contextOrSignal?: Context | AbortSignal): Promise<Result<Uint8Array, FileError>> {
		return this.run(path, async () => {
			const failure = abortedFailure(contextOrSignal, path);
			if (failure) {
				return failure;
			}
			const inner = toVaultRelative(path);
			const file = this.vault.getFileByPath(inner);
			if (file) {
				return ok(new Uint8Array(await this.vault.readBinary(file)));
			}
			return this.readOutsideIndex(
				inner,
				path,
				async (target) => new Uint8Array(await this.vault.adapter.readBinary(target)),
			);
		});
	}

	async writeFile(path: string, content: string | Uint8Array, contextOrSignal?: Context | AbortSignal): Promise<Result<void, FileError>> {
		return this.run(path, async () => {
			const failure = abortedFailure(contextOrSignal, path);
			if (failure) {
				return failure;
			}
			const inner = toVaultRelative(path);
			const refusal = this.refuseMutation(inner, path);
			if (refusal) {
				return refusal;
			}
			const existing = this.vault.getAbstractFileByPath(inner);
			if (existing instanceof TFolder) {
				return err(new FileError("is_directory", `Cannot write over folder: ${path}`, path));
			}
			await ensureParentFolders(this.vault, inner);
			if (typeof content === "string") {
				if (existing instanceof TFile) {
					// Read-modify-write in one vault call rather than a bare
					// `modify`, so Obsidian serializes the read+write against any
					// concurrent `process` on the same file (the CAS in
					// {@linkcode compareAndWriteFile} rides the same primitive).
					await this.vault.process(existing, () => content);
				} else {
					await this.vault.create(inner, content);
				}
				return ok(undefined);
			}
			const data = toArrayBuffer(content);
			if (existing instanceof TFile) {
				await this.vault.modifyBinary(existing, data);
			} else {
				await this.vault.createBinary(inner, data);
			}
			return ok(undefined);
		});
	}

	/**
	 * Compare-and-swap overwrite: replaces the file's text only if the vault's
	 * current content still equals `expected` — what the calling session last
	 * observed. The comparison runs inside {@link Vault.process}'s callback, so
	 * the read and the write are the same vault operation and no concurrent
	 * `process` can slip between them; a mismatch throws inside the callback
	 * and the file is left untouched.
	 *
	 * Returns an `invalid` {@link FileError} on mismatch (pi's error vocabulary
	 * is a closed union; the message carries the conflict semantics and tells
	 * the model to re-read), `not_found` when the file vanished since it was
	 * observed.
	 */
	async compareAndWriteFile(
		path: string,
		content: string,
		expected: string,
		contextOrSignal?: Context | AbortSignal,
	): Promise<Result<void, FileError>> {
		return this.run(path, async () => {
			const failure = abortedFailure(contextOrSignal, path);
			if (failure) {
				return failure;
			}
			const inner = toVaultRelative(path);
			const refusal = this.refuseMutation(inner, path);
			if (refusal) {
				return refusal;
			}
			const existing = this.vault.getAbstractFileByPath(inner);
			if (existing instanceof TFolder) {
				return err(new FileError("is_directory", `Cannot write over folder: ${path}`, path));
			}
			if (!(existing instanceof TFile)) {
				return err(new FileError("not_found", `File was removed after it was read: ${path}`, path));
			}
			try {
				await this.vault.process(existing, (data) => {
					if (data !== expected) {
						throw new WriteConflictError();
					}
					return content;
				});
			} catch (error) {
				if (error instanceof WriteConflictError) {
					return err(
						new FileError(
							"invalid",
							`Write conflict: ${path} changed since this session last read it. Re-read the file and merge your changes before writing again.`,
							path,
							error instanceof Error ? error : undefined,
						),
					);
				}
				throw error;
			}
			return ok(undefined);
		});
	}

	async appendFile(path: string, content: string | Uint8Array, contextOrSignal?: Context | AbortSignal): Promise<Result<void, FileError>> {
		return this.run(path, async () => {
			const failure = abortedFailure(contextOrSignal, path);
			if (failure) {
				return failure;
			}
			if (typeof content !== "string") {
				return err(new FileError("not_supported", "Appending binary content is not supported.", path));
			}
			const inner = toVaultRelative(path);
			const refusal = this.refuseMutation(inner, path);
			if (refusal) {
				return refusal;
			}
			const existing = this.vault.getAbstractFileByPath(inner);
			if (existing instanceof TFolder) {
				return err(new FileError("is_directory", `Cannot append to folder: ${path}`, path));
			}
			if (existing instanceof TFile) {
				await this.vault.append(existing, content);
				return ok(undefined);
			}
			await ensureParentFolders(this.vault, inner);
			await this.vault.create(inner, content);
			return ok(undefined);
		});
	}

	async renameFile(sourcePath: string, destinationPath: string, contextOrSignal?: Context | AbortSignal): Promise<Result<void, FileError>> {
		return this.run(sourcePath, async () => {
			const failure = abortedFailure(contextOrSignal, sourcePath);
			if (failure) {
				return failure;
			}
			const sourceInner = toVaultRelative(sourcePath);
			const destinationInner = toVaultRelative(destinationPath);
			const refusal = this.refuseMutation(sourceInner, sourcePath) ?? this.refuseMutation(destinationInner, destinationPath);
			if (refusal) {
				return refusal;
			}
			const source = this.vault.getAbstractFileByPath(sourceInner);
			if (!(source instanceof TFile) && !(source instanceof TFolder)) {
				return err(new FileError("not_found", `File not found: ${sourcePath}`, sourcePath));
			}
			// The FileSystem contract replaces an existing destination, while
			// `vault.rename` refuses; trash the destination first to match. Using
			// `trashFile` respects the user's deletion preference (`.trash/` or OS
			// trash) and keeps the operation reversible. Note this loses the
			// link-updates `FileManager.renameFile` would perform.
			const destination = this.vault.getAbstractFileByPath(destinationInner);
			if (destination instanceof TFile || destination instanceof TFolder) {
				await this.trash(destination);
			}
			await this.vault.rename(source, destinationInner);
			return ok(undefined);
		});
	}

	async fileInfo(path: string, _context?: Context): Promise<Result<FileInfo, FileError>> {
		return this.run(path, async () => {
			const absolute = toEnvironmentPath(path);
			const inner = toVaultRelative(absolute);
			if (inner === "") {
				return ok({ name: "", path: absolute, kind: "directory", size: 0, mtimeMs: 0 });
			}
			const file = this.vault.getFileByPath(inner);
			if (file) {
				return ok({ name: file.name, path: absolute, kind: "file", size: file.stat.size, mtimeMs: file.stat.mtime });
			}
			const folder = this.vault.getFolderByPath(inner);
			if (folder) {
				return ok({ name: folder.name, path: absolute, kind: "directory", size: 0, mtimeMs: 0 });
			}
			const stat = await this.vault.adapter.stat(inner);
			if (!stat) {
				return err(new FileError("not_found", `File not found: ${absolute}`, absolute));
			}
			return ok(childInfo(inner, stat.type === "folder" ? "directory" : "file", stat));
		});
	}

	async listDir(path: string, _context?: Context): Promise<Result<FileInfo[], FileError>> {
		return this.run(path, async () => {
			const absolute = toEnvironmentPath(path);
			const inner = toVaultRelative(absolute);
			const folder = inner === "" ? this.vault.getRoot() : this.vault.getFolderByPath(inner);
			if (!folder) {
				if (this.vault.getFileByPath(inner)) {
					return err(new FileError("not_directory", `Not a folder: ${absolute}`, absolute));
				}
				const stat = await this.vault.adapter.stat(inner);
				if (stat?.type === "folder") {
					return ok(await this.listOutsideIndex(inner));
				}
				return err(new FileError("not_found", `Folder not found: ${absolute}`, absolute));
			}
			const entries = folder.children.map<FileInfo>((child) => ({
				name: child.name,
				path: toEnvironmentPath(child.path),
				kind: child instanceof TFolder ? "directory" : "file",
				size: child instanceof TFile ? child.stat.size : 0,
				mtimeMs: child instanceof TFile ? child.stat.mtime : 0,
			}));
			return ok(entries.sort((left, right) => left.name.localeCompare(right.name)));
		});
	}

	async canonicalPath(path: string, _context?: Context): Promise<Result<string, FileError>> {
		return this.run(path, async () => {
			// The vault namespace has no symlinks, so the canonical form of an
			// existing path is the path itself. Missing paths report not_found,
			// which pi's file mutation queue treats as "queue on the literal path".
			const absolute = toEnvironmentPath(path);
			if (await this.pathExists(toVaultRelative(absolute))) {
				return ok(absolute);
			}
			return err(new FileError("not_found", `File not found: ${absolute}`, absolute));
		});
	}

	async exists(path: string, _context?: Context): Promise<Result<boolean, FileError>> {
		return this.run(path, async () => ok(await this.pathExists(toVaultRelative(path))));
	}

	async createDir(
		path: string,
		options?: { recursive?: boolean; abortSignal?: AbortSignal },
		contextOrSignal?: Context | AbortSignal,
	): Promise<Result<void, FileError>> {
		return this.run(path, async () => {
			const signal = options?.abortSignal ?? signalFrom(contextOrSignal);
			const failure = abortedFailure(signal, path);
			if (failure) {
				return failure;
			}
			const inner = toVaultRelative(path);
			const refusal = this.refuseMutation(inner, path);
			if (refusal) {
				return refusal;
			}
			if (inner === "" || (await this.pathExists(inner))) {
				return ok(undefined);
			}
			if (options?.recursive === false && !this.parentExists(inner)) {
				return err(new FileError("not_found", `Parent folder does not exist: ${getParentPath(inner)}`, path));
			}
			await ensureParentFolders(this.vault, inner);
			return ok(undefined);
		});
	}

	async remove(
		path: string,
		options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
		contextOrSignal?: Context | AbortSignal,
	): Promise<Result<void, FileError>> {
		return this.run(path, async () => {
			const signal = options?.abortSignal ?? signalFrom(contextOrSignal);
			const failure = abortedFailure(signal, path);
			if (failure) {
				return failure;
			}
			const inner = toVaultRelative(path);
			const refusal = this.refuseMutation(inner, path);
			if (refusal) {
				return refusal;
			}
			if (inner === "") {
				return err(new FileError("permission_denied", "Refusing to remove the vault root.", path));
			}
			const existing = this.vault.getAbstractFileByPath(inner);
			if (!(existing instanceof TFile) && !(existing instanceof TFolder)) {
				if (options?.force) {
					return ok(undefined);
				}
				return err(new FileError("not_found", `File not found: ${path}`, path));
			}
			// Send to trash (recoverable) via `FileManager.trashFile` when
			// available — respects the user's "delete to .trash/ or OS trash"
			// preference. Falls back to `vault.delete` with the recursive/force
			// flag only when `fileManager` is absent (test stubs, edge mobile).
			await this.trash(existing, options?.recursive === true || options?.force === true);
			return ok(undefined);
		});
	}

	async createTempDir(prefix?: string, _context?: Context): Promise<Result<string, FileError>> {
		return Promise.resolve(err(new FileError("not_supported", `Temp directories are not supported${prefix ? ` (prefix ${prefix})` : ""}.`)));
	}

	async createTempFile(options?: { prefix?: string; suffix?: string }, _context?: Context): Promise<Result<string, FileError>> {
		return Promise.resolve(err(new FileError("not_supported", "Temp files are not supported.")));
	}

	async cleanup(_context?: Context): Promise<void> {
		// Nothing to release: every call goes straight through the vault API.
	}

	async exec(
		command: string,
		options?: ShellExecOptions,
		_context?: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		void options;
		return Promise.resolve(err(new ExecutionError("shell_unavailable", `Shell is not available in Obsidian (command rejected: ${truncateCommand(command)}).`)));
	}

	private async pathExists(inner: string): Promise<boolean> {
		if (inner === "") {
			return true;
		}
		return this.vault.adapter.exists(inner);
	}

	private parentExists(inner: string): boolean {
		const parent = getParentPath(inner);
		return parent === "" || this.vault.getFolderByPath(parent) !== null;
	}

	/**
	 * Reads a file the vault index does not know about.
	 *
	 * Obsidian indexes neither the config directory nor dot-folders, so
	 * `.obsidian/app.json` is invisible to `getFileByPath` while the adapter
	 * reads it without complaint. The `stat` is what distinguishes a file from a
	 * folder here — `adapter.exists` answers true for both.
	 */
	private async readOutsideIndex<T>(
		inner: string,
		path: string,
		read: (inner: string) => Promise<T>,
	): Promise<Result<T, FileError>> {
		const stat = await this.vault.adapter.stat(inner);
		if (stat?.type === "folder") {
			return err(new FileError("is_directory", `Path is a folder: ${path}`, path));
		}
		if (!stat) {
			return err(new FileError("not_found", `File not found: ${path}`, path));
		}
		return ok(await read(inner));
	}

	/** Direct children of a folder the vault index does not track. */
	private async listOutsideIndex(inner: string): Promise<FileInfo[]> {
		const listing = await this.vault.adapter.list(inner);
		const entries: FileInfo[] = listing.folders.map((path) => childInfo(path, "directory", null));
		for (const path of listing.files) {
			entries.push(childInfo(path, "file", await this.vault.adapter.stat(path)));
		}
		return entries.sort((left, right) => left.name.localeCompare(right.name));
	}

	/**
	 * Refuses any mutation under the config directory.
	 *
	 * That directory (`.obsidian` unless the vault renamed it) holds the user's
	 * settings, hotkeys, workspace layout and every installed plugin's data —
	 * this plugin's included. The agent may read all of it (see
	 * {@linkcode readOutsideIndex}) and may write none of it: a stray edit there
	 * is a configuration the user repairs by hand.
	 *
	 * Checked per method rather than in one choke point because the mutators do
	 * not share one — `write` and `append` reach the adapter path, `rename`
	 * only its destination.
	 */
	private refuseMutation(inner: string, path: string): Result<never, FileError> | null {
		const configDir = this.vault.configDir;
		if (!configDir || (inner !== configDir && !inner.startsWith(`${configDir}/`))) {
			return null;
		}
		return err(
			new FileError(
				"permission_denied",
				`Refusing to modify ${path}: the Obsidian configuration directory (${configDir}) is read-only for the agent.`,
				path,
			),
		);
	}

	private async trash(target: TFile | TFolder, force = false): Promise<void> {
		await trashOrDelete(this.app, target, { force });
	}

	private async run<T>(path: string, operation: () => Promise<Result<T, FileError>>): Promise<Result<T, FileError>> {
		try {
			return await operation();
		} catch (error) {
			return err(toFileError(error, path));
		}
	}
}

function signalFrom(contextOrSignal?: Context | AbortSignal): AbortSignal | undefined {
	if (!contextOrSignal) return undefined;
	if ("abortSignal" in contextOrSignal) return contextOrSignal.abortSignal;
	if (contextOrSignal instanceof AbortSignal) return contextOrSignal;
	return undefined;
}

function abortedFailure(contextOrSignal: Context | AbortSignal | undefined, path: string): Result<never, FileError> | null {
	const signal = signalFrom(contextOrSignal);
	if (signal?.aborted) {
		return err(new FileError("aborted", "Operation aborted", path));
	}
	return null;
}

/** Thrown inside the `vault.process` callback when the CAS expectation fails. */
class WriteConflictError extends Error {}

function truncateCommand(command: string): string {
	return command.length > 60 ? `${command.slice(0, 57)}...` : command;
}

/** Maps an unexpected backend failure onto the stable FileError vocabulary. */
function toFileError(error: unknown, path: string): FileError {
	if (error instanceof FileError) {
		return error;
	}
	const message = error instanceof Error ? error.message : String(error);
	if (/not found|does not exist/i.test(message)) {
		return new FileError("not_found", message, path);
	}
	if (/already exists/i.test(message)) {
		return new FileError("invalid", message, path);
	}
	return new FileError("unknown", message, path);
}

function toEnvironmentPath(path: string): string {
	return `/${normalizeVaultPath(stripLeadingSlash(path.trim()))}`;
}

/**
 * One listing row for a path the adapter reported.
 *
 * The path is prefixed rather than run through {@linkcode toEnvironmentPath}
 * because it came off the filesystem, not from a model argument — re-running the
 * plugin-internals guard over it would abort the whole listing of
 * `.obsidian/plugins` on our own folder's row.
 */
function childInfo(inner: string, kind: "file" | "directory", stat: { size: number; mtime: number } | null): FileInfo {
	return {
		name: baseName(inner),
		path: `/${inner}`,
		kind,
		size: kind === "file" ? stat?.size ?? 0 : 0,
		mtimeMs: kind === "file" ? stat?.mtime ?? 0 : 0,
	};
}

function baseName(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? path : path.slice(index + 1);
}

function toVaultRelative(path: string): string {
	return normalizeVaultPath(stripLeadingSlash(path.trim()));
}

function stripLeadingSlash(path: string): string {
	return path.startsWith("/") ? path.slice(1) : path;
}

async function ensureParentFolders(vault: App["vault"], inner: string): Promise<void> {
	let current = "";
	for (const segment of getParentPath(inner).split("/")) {
		if (!segment) {
			continue;
		}
		current = current ? `${current}/${segment}` : segment;
		if (vault.getFolderByPath(current)) {
			continue;
		}
		try {
			await vault.createFolder(current);
		} catch (error) {
			// Concurrent creation races are benign; anything else surfaces later
			// as the write's own failure.
			if (!vault.getFolderByPath(current)) {
				throw error;
			}
		}
	}
}

function toArrayBuffer(content: Uint8Array): ArrayBuffer {
	return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
}
