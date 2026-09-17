import type { DataAdapter } from "obsidian";
import { err, FileError, ok, type FileInfo, type FileSystem, type Result } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-agent-core";
import { normalizeVaultPath } from "../vault/path";
import { parseMutationLine, SessionLogRepairNet, type SessionDriftEvent } from "./sessionMutationLine";
import "./sessionCompat";

function signalFrom(contextOrSignal?: Context | AbortSignal): AbortSignal | undefined {
	if (!contextOrSignal) return undefined;
	if (contextOrSignal instanceof AbortSignal) return contextOrSignal;
	if ("signal" in contextOrSignal && contextOrSignal.signal instanceof AbortSignal) return contextOrSignal.signal;
	return undefined;
}

function normalizeHeaderLine(line: string): string {
	try {
		const parsed = JSON.parse(line) as Record<string, unknown>;
		if (parsed && typeof parsed === "object") {
			if (parsed.kind === "header" && parsed.v === 4 && typeof parsed.storageVersion === "number" && parsed.storageVersion >= 1) {
				return line;
			}
			// Only normalize known legacy headers (version 3 or pre-0.85 version 4)
			const isLegacyHeader =
				(parsed.kind === "header" && (parsed.version === 4 || parsed.version === 3 || parsed.v === 3)) ||
				(parsed.type === "session" && parsed.version === 3);
			if (isLegacyHeader) {
				const normalized = {
					v: 4,
					kind: "header",
					storageVersion: 1,
					id: parsed.id,
					createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : (typeof parsed.createdAt === "string" ? Date.parse(parsed.createdAt) : Date.now()),
					cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
					...(typeof parsed.parentSessionId === "string" ? { parentSessionId: parsed.parentSessionId } : {}),
					...(typeof parsed.legacyParentSessionPath === "string" ? { legacyParentSessionPath: parsed.legacyParentSessionPath } : {}),
				};
				return JSON.stringify(normalized);
			}
		}
		return line;
	} catch {
		return line;
	}
}

export function normalizeLegacyJsonlContent(content: string): string {
	if (!content.trim()) return content;
	const rawLines = content.split("\n");
	const endsWithNewline = content.endsWith("\n");
	if (rawLines.at(-1) === "") {
		rawLines.pop();
	}
	if (rawLines.length === 0) return content;

	let needsNormalization = false;
	const firstLineNormalized = normalizeHeaderLine(rawLines[0]!);
	if (firstLineNormalized !== rawLines[0]) {
		needsNormalization = true;
	}

	const normalizedLines: string[] = [firstLineNormalized];
	let lastEntryId: string | null = null;
	let maxSeq = 0;
	let hasAnyBranchTip = false;

	for (let i = 1; i < rawLines.length; i++) {
		const line = rawLines[i]!;
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (typeof parsed !== "object" || parsed === null) {
				normalizedLines.push(line);
				continue;
			}
			if (Array.isArray(parsed)) {
				for (const item of parsed) {
					if (typeof item === "object" && item !== null) {
						const seq = typeof (item as Record<string, unknown>).seq === "number" ? (item as Record<string, unknown>).seq as number : 0;
						if (seq > maxSeq) maxSeq = seq;
						if ((item as Record<string, unknown>).kind === "value" && (item as Record<string, unknown>).namespace === "pi.branch.tip") {
							hasAnyBranchTip = true;
						}
						if ((item as Record<string, unknown>).kind === "entry") {
							const entryId = typeof (item as Record<string, unknown>).id === "string"
								? (item as Record<string, unknown>).id as string
								: (((item as Record<string, unknown>).entry as Record<string, unknown> | undefined)?.id as string | undefined);
							if (entryId) {
								lastEntryId = entryId;
							}
						}
					}
				}
				normalizedLines.push(line);
				continue;
			}
			const parsedObj = parsed as Record<string, unknown>;
			const seq = typeof parsedObj.seq === "number" ? parsedObj.seq : 0;
			if (seq > maxSeq) maxSeq = seq;

			if (parsedObj.kind === "lane") {
				needsNormalization = true;
				const lane = typeof parsedObj.lane === "string" ? parsedObj.lane : "main";
				const leafId = typeof parsedObj.leafId === "string" ? parsedObj.leafId : null;
				hasAnyBranchTip = true;
				normalizedLines.push(JSON.stringify({
					kind: "value",
					op: "set",
					seq,
					namespace: "pi.branch.tip",
					key: lane,
					value: leafId,
				}));
				continue;
			}

			if (parsedObj.kind === "fact") {
				needsNormalization = true;
				if (parsedObj.fact === "name") {
					normalizedLines.push(JSON.stringify({
						kind: "value",
						op: "set",
						seq,
						namespace: "pi.session.name",
						key: "",
						value: parsedObj.name,
					}));
				} else if (parsedObj.fact === "label" && typeof parsedObj.targetId === "string") {
					normalizedLines.push(JSON.stringify({
						kind: "value",
						op: "set",
						seq,
						namespace: "pi.entry.label",
						key: parsedObj.targetId,
						value: parsedObj.label,
					}));
				}
				continue;
			}

			if (parsedObj.kind === "record") {
				needsNormalization = true;
				if (parsedObj.type === "usage") {
					normalizedLines.push(JSON.stringify({
						kind: "usage",
						seq,
						id: parsedObj.id,
						usage: parsedObj.usage,
					}));
				}
				// Ephemeral records (operation_started, operation_finished) are omitted
				continue;
			}

			if (parsedObj.kind === "value") {
				if (parsedObj.namespace === "pi.branch.tip") {
					hasAnyBranchTip = true;
				}
				normalizedLines.push(line);
				continue;
			}

			if (parsedObj.kind === "entry") {
				const entryId = typeof parsedObj.id === "string" ? parsedObj.id : ((parsedObj.entry as Record<string, unknown> | undefined)?.id as string | undefined);
				if (entryId) {
					lastEntryId = entryId;
				}
				normalizedLines.push(line);
				continue;
			}

			normalizedLines.push(line);
		} catch {
			normalizedLines.push(line);
		}
	}

	// If there are entries but no branch tip was explicitly stored, synthesize main
	if (!hasAnyBranchTip && lastEntryId) {
		needsNormalization = true;
		normalizedLines.push(JSON.stringify({
			kind: "value",
			op: "set",
			seq: maxSeq + 1,
			namespace: "pi.branch.tip",
			key: "main",
			value: lastEntryId,
		}));
	}

	if (!needsNormalization) {
		return content;
	}
	return `${normalizedLines.join("\n")}${endsWithNewline ? "\n" : ""}`;
}

/**
 * The slice of pi's `FileSystem` that `JsonlSessionRepo` actually calls.
 */
export type SessionRepoFileSystem = FileSystem;

/**
 * Backs pi's `JsonlSessionRepo` with Obsidian's `DataAdapter` so chat logs are
 * stored and branched by pi rather than by hand-written JSONL code.
 *
 * Path space: vault-relative with no leading slash (`Piem/chats/….jsonl`), and
 * `cwd` is `""`.
 */
export class ObsidianSessionFileSystem implements SessionRepoFileSystem {
	readonly cwd = "";

	private readonly adapter: DataAdapter;
	private readonly trash: (path: string) => Promise<void>;
	private readonly repairNet: SessionLogRepairNet;

	constructor(adapter: DataAdapter, trash?: (path: string) => Promise<void>, onDrift?: (event: SessionDriftEvent) => void) {
		this.adapter = adapter;
		this.trash = trash ?? ((path) => trashSessionFile(adapter, path));
		this.repairNet = new SessionLogRepairNet(onDrift);
	}

	async absolutePath(path: string, context?: Context | AbortSignal): Promise<Result<string, FileError>> {
		return this.run(path, context, async () => ok(this.normalize(path)));
	}

	async joinPath(parts: string[], context?: Context | AbortSignal): Promise<Result<string, FileError>> {
		const joined = parts.filter((part) => part !== "").join("/");
		return this.run(joined, context, async () => ok(this.normalize(joined)));
	}

	async readTextFile(path: string, context?: Context | AbortSignal): Promise<Result<string, FileError>> {
		return this.run(path, context, async () => {
			const target = this.normalize(path);
			const raw = await this.adapter.read(target);
			return ok(target.endsWith(".jsonl") ? normalizeLegacyJsonlContent(raw) : raw);
		});
	}

	async readTextLines(
		path: string,
		optionsOrContext?: { maxLines?: number; abortSignal?: AbortSignal } | Context | AbortSignal,
		context?: Context | AbortSignal,
	): Promise<Result<string[], FileError>> {
		const isCtx = optionsOrContext instanceof AbortSignal || (typeof optionsOrContext === "object" && optionsOrContext !== null && "value" in optionsOrContext);
		const options = isCtx ? undefined : optionsOrContext;
		const ctx = isCtx ? optionsOrContext : (options?.abortSignal ?? context);
		return this.run(path, ctx, async () => {
			const target = this.normalize(path);
			const content = await this.adapter.read(target);
			const normalized = target.endsWith(".jsonl") ? normalizeLegacyJsonlContent(content) : content;
			const lines = normalized.split("\n");
			if (lines.at(-1) === "") {
				lines.pop();
			}
			return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
		});
	}

	async readBinaryFile(path: string, context?: Context | AbortSignal): Promise<Result<Uint8Array, FileError>> {
		return this.run(path, context, async () => {
			const target = this.normalize(path);
			const buffer = await this.adapter.readBinary(target);
			return ok(new Uint8Array(buffer));
		});
	}

	async writeFile(path: string, content: string | Uint8Array, context?: Context | AbortSignal): Promise<Result<void, FileError>> {
		return this.run(path, context, async () => {
			const target = this.normalize(path);
			await this.ensureParentDirectory(target);
			await this.adapter.write(target, toText(content));
			await this.repairNet.refresh(target, () => this.statRaw(target));
			return ok(undefined);
		});
	}

	async appendFile(path: string, content: string | Uint8Array, context?: Context | AbortSignal): Promise<Result<void, FileError>> {
		return this.run(path, context, async () => {
			const target = this.normalize(path);
			const text = toText(content);
			const decision = await this.repairNet.prepare(target, text, {
				stat: () => this.statRaw(target),
				read: () => this.adapter.read(target),
			});
			if (decision.line === null) {
				const mutation = parseMutationLine(text);
				if ((mutation?.kind === "fact" && mutation.fact === "label") || (mutation?.kind === "value" && mutation.namespace === "pi.entry.label")) {
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

	async renameFile(sourcePath: string, destinationPath: string, context?: Context | AbortSignal): Promise<Result<void, FileError>> {
		return this.run(sourcePath, context, async () => {
			const source = this.normalize(sourcePath);
			const destination = this.normalize(destinationPath);
			if (await this.adapter.exists(destination)) {
				await this.adapter.remove(destination);
			}
			await this.ensureParentDirectory(destination);
			await this.adapter.rename(source, destination);
			await this.repairNet.refresh(destination, () => this.statRaw(destination));
			this.repairNet.forget(source);
			return ok(undefined);
		});
	}

	async fileInfo(path: string, context?: Context | AbortSignal): Promise<Result<FileInfo, FileError>> {
		return this.run(path, context, async () => {
			const target = this.normalize(path);
			const stat = await this.adapter.stat(target);
			if (!stat) {
				return err(new FileError("not_found", `File not found: ${target}`, target));
			}
			return ok(toFileInfo(target, stat.type, stat.size, stat.mtime));
		});
	}

	async listDir(path: string, context?: Context | AbortSignal): Promise<Result<FileInfo[], FileError>> {
		return this.run(path, context, async () => {
			const target = this.normalize(path);
			if (!(await this.adapter.exists(target))) {
				return err(new FileError("not_found", `Directory not found: ${target}`, target));
			}
			const listed = await this.adapter.list(target);
			const infos: FileInfo[] = [];
			const abortSignal = signalFrom(context);
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

	async canonicalPath(path: string, context?: Context | AbortSignal): Promise<Result<string, FileError>> {
		return this.absolutePath(path, context);
	}

	async exists(path: string, context?: Context | AbortSignal): Promise<Result<boolean, FileError>> {
		return this.run(path, context, async () => ok(await this.adapter.exists(this.normalize(path))));
	}

	async createDir(
		path: string,
		optionsOrContext?: { recursive?: boolean; abortSignal?: AbortSignal } | Context | AbortSignal,
		context?: Context | AbortSignal,
	): Promise<Result<void, FileError>> {
		const isCtx = optionsOrContext instanceof AbortSignal || (typeof optionsOrContext === "object" && optionsOrContext !== null && "value" in optionsOrContext);
		const options = isCtx ? undefined : optionsOrContext;
		const ctx = isCtx ? optionsOrContext : (options?.abortSignal ?? context);
		return this.run(path, ctx, async () => {
			const target = this.normalize(path);
			if (target === "") {
				return ok(undefined);
			}
			if (options?.recursive === false) {
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

	async remove(
		path: string,
		optionsOrContext?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal } | Context | AbortSignal,
		context?: Context | AbortSignal,
	): Promise<Result<void, FileError>> {
		const isCtx = optionsOrContext instanceof AbortSignal || (typeof optionsOrContext === "object" && optionsOrContext !== null && "value" in optionsOrContext);
		const options = isCtx ? undefined : optionsOrContext;
		const ctx = isCtx ? optionsOrContext : (options?.abortSignal ?? context);
		return this.run(path, ctx, async () => {
			const target = this.normalize(path);
			if (!(await this.adapter.exists(target))) {
				if (options?.force === true) {
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

	async createTempDir(prefix = "tmp-", context?: Context | AbortSignal): Promise<Result<string, FileError>> {
		return this.run(".tmp", context, async () => {
			const id = Math.random().toString(36).slice(2, 10);
			const path = this.normalize(`.tmp/${prefix}${id}`);
			await this.createDir(path, { recursive: true }, context);
			return ok(path);
		});
	}

	async createTempFile(options?: { prefix?: string; suffix?: string }, context?: Context | AbortSignal): Promise<Result<string, FileError>> {
		return this.run(".tmp", context, async () => {
			const prefix = options?.prefix ?? "";
			const suffix = options?.suffix ?? "";
			const id = Math.random().toString(36).slice(2, 10);
			const path = this.normalize(`.tmp/${prefix}${id}${suffix}`);
			await this.writeFile(path, "", context);
			return ok(path);
		});
	}

	async cleanup(_context?: Context | AbortSignal): Promise<void> {
		// Best-effort cleanup
	}

	private normalize(path: string): string {
		return normalizeVaultPath(path, { allowPluginInternals: true });
	}

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
			if (!(await this.adapter.exists(path))) {
				throw error;
			}
		}
	}

	private async run<T>(
		path: string,
		contextOrSignal: Context | AbortSignal | undefined,
		operation: () => Promise<Result<T, FileError>>,
	): Promise<Result<T, FileError>> {
		const abortSignal = signalFrom(contextOrSignal);
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

async function trashSessionFile(adapter: DataAdapter, path: string): Promise<void> {
	if (!(await adapter.trashSystem(path))) {
		await adapter.trashLocal(path);
	}
}

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
	if (/must be vault-relative|'\.\.' segments|plugin internals/i.test(message)) {
		return new FileError("invalid", message, path);
	}
	return new FileError("unknown", message, path);
}
