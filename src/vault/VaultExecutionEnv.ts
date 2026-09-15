import { TFile, TFolder, type App } from "obsidian";
import {
	err,
	ExecutionError,
	FileError,
	ok,
	type ExecutionEnv,
	type FileInfo,
	type Result,
	type ShellExecOptions,
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

	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return this.run(path, async () => ok(toEnvironmentPath(path)));
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return this.run(parts.join("/"), async () => ok(toEnvironmentPath(parts.filter((part) => part !== "").join("/"))));
	}

	async readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		return this.run(path, async () => {
			const failure = abortedFailure(abortSignal, path);
			if (failure) {
				return failure;
			}
			const abstract = this.requireFile(path);
			if (!abstract.ok) {
				return abstract;
			}
			const text = await this.vault.read(abstract.value.file);
			return ok(text);
		});
	}

	async readTextLines(
		path: string,
		options?: { maxLines?: number; abortSignal?: AbortSignal },
	): Promise<Result<string[], FileError>> {
		return this.run(path, async () => {
			const read = await this.readTextFile(path, options?.abortSignal);
			if (!read.ok) {
				return read;
			}
			const lines = read.value.split(/\r?\n/);
			const maxLines = options?.maxLines;
			return ok(maxLines === undefined ? lines : lines.slice(0, Math.max(0, maxLines)));
		});
	}

	async readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
		return this.run(path, async () => {
			const failure = abortedFailure(abortSignal, path);
			if (failure) {
				return failure;
			}
			const abstract = this.requireFile(path);
			if (!abstract.ok) {
				return abstract;
			}
			const buffer = await this.vault.readBinary(abstract.value.file);
			return ok(new Uint8Array(buffer));
		});
	}

	async writeFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>> {
		return this.run(path, async () => {
			const failure = abortedFailure(abortSignal, path);
			if (failure) {
				return failure;
			}
			const inner = toVaultRelative(path);
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
		abortSignal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		return this.run(path, async () => {
			const failure = abortedFailure(abortSignal, path);
			if (failure) {
				return failure;
			}
			const existing = this.vault.getAbstractFileByPath(toVaultRelative(path));
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

	async appendFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>> {
		return this.run(path, async () => {
			const failure = abortedFailure(abortSignal, path);
			if (failure) {
				return failure;
			}
			if (typeof content !== "string") {
				return err(new FileError("not_supported", "Appending binary content is not supported.", path));
			}
			const inner = toVaultRelative(path);
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

	async renameFile(sourcePath: string, destinationPath: string, abortSignal?: AbortSignal): Promise<Result<void, FileError>> {
		return this.run(sourcePath, async () => {
			const failure = abortedFailure(abortSignal, sourcePath);
			if (failure) {
				return failure;
			}
			const sourceInner = toVaultRelative(sourcePath);
			const destinationInner = toVaultRelative(destinationPath);
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

	async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
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
			return err(new FileError("not_found", `File not found: ${absolute}`, absolute));
		});
	}

	async listDir(path: string): Promise<Result<FileInfo[], FileError>> {
		return this.run(path, async () => {
			const absolute = toEnvironmentPath(path);
			const inner = toVaultRelative(absolute);
			const folder = inner === "" ? this.vault.getRoot() : this.vault.getFolderByPath(inner);
			if (!folder) {
				if (this.vault.getFileByPath(inner)) {
					return err(new FileError("not_directory", `Not a folder: ${absolute}`, absolute));
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

	async canonicalPath(path: string): Promise<Result<string, FileError>> {
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

	async exists(path: string): Promise<Result<boolean, FileError>> {
		return this.run(path, async () => ok(await this.pathExists(toVaultRelative(path))));
	}

	async createDir(path: string, options?: { recursive?: boolean; abortSignal?: AbortSignal }): Promise<Result<void, FileError>> {
		return this.run(path, async () => {
			const failure = abortedFailure(options?.abortSignal, path);
			if (failure) {
				return failure;
			}
			const inner = toVaultRelative(path);
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
	): Promise<Result<void, FileError>> {
		return this.run(path, async () => {
			const failure = abortedFailure(options?.abortSignal, path);
			if (failure) {
				return failure;
			}
			const inner = toVaultRelative(path);
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

	async createTempDir(prefix?: string): Promise<Result<string, FileError>> {
		return Promise.resolve(err(new FileError("not_supported", `Temp directories are not supported${prefix ? ` (prefix ${prefix})` : ""}.`)));
	}

	async createTempFile(options?: { prefix?: string; suffix?: string }): Promise<Result<string, FileError>> {
		return Promise.resolve(err(new FileError("not_supported", "Temp files are not supported.")));
	}

	async cleanup(): Promise<void> {
		// Nothing to release: every call goes straight through the vault API.
	}

	async exec(
		command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
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

	private requireFile(path: string): Result<{ file: TFile }, FileError> {
		const inner = toVaultRelative(path);
		const existing = this.vault.getAbstractFileByPath(inner);
		if (existing instanceof TFolder) {
			return err(new FileError("is_directory", `Path is a folder: ${path}`, path));
		}
		if (existing instanceof TFile) {
			return ok({ file: existing });
		}
		return err(new FileError("not_found", `File not found: ${path}`, path));
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

function abortedFailure(abortSignal: AbortSignal | undefined, path: string): Result<never, FileError> | null {
	if (abortSignal?.aborted) {
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
