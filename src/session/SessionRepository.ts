import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { uuidv7 } from "@earendil-works/pi-ai";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import type { ObsidianSessionFileSystem } from "./ObsidianSessionFileSystem";
import { normalizeFolderPath } from "../vault/path";
import { DurableVaultStorage } from "./DurableVaultStorage";
import { PiemSession } from "./PiemSession";
import { jsonEqual } from "./jsonEqual";
import { parseSessionHeaderMetadata, SESSION_FORMAT } from "./sessionMetadata";
import { readLegacySnapshot, readPreviousDurableSnapshot, snapshotSession, type SessionSnapshot } from "./sessionSnapshot";
import type { ForkOptions, JsonlSessionMetadata, SessionCreateOptions, SessionMetadata } from "./sessionTypes";

const fileOperations = new WeakMap<object, Map<string, Promise<void>>>();

export class VaultSessionRepository {
	private readonly fs: ObsidianSessionFileSystem;
	constructor(private readonly options: { fileSystem: ObsidianSessionFileSystem; sessionsRoot: string; now?: () => number }) { this.fs = options.fileSystem; }

	async create(options: SessionCreateOptions & { cwd: string }, context = BACKGROUND_CONTEXT): Promise<PiemSession<JsonlSessionMetadata>> {
		const id = options.id ?? uuidv7();
		const createdAt = (this.options.now ?? Date.now)();
		const cwdDir = `--${options.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const dir = `${this.options.sessionsRoot}/${cwdDir}`;
		getOrThrow(await this.fs.createDir(dir, { recursive: true }, context));
		const path = `${dir}/${new Date(createdAt).toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`;
		if (getOrThrow(await this.fs.exists(path, context))) throw new Error(`Session already exists: ${id}`);
		const metadata = { id, createdAt, cwd: options.cwd, path, modifiedAt: createdAt, storageVersion: 1, ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}) };
		await this.fs.adapter.write(path, header(metadata));
		return this.open(metadata, context);
	}

	async open(metadata: JsonlSessionMetadata, context = BACKGROUND_CONTEXT, options: { readOnly?: boolean } = {}): Promise<PiemSession<JsonlSessionMetadata>> {
		return this.withFile(metadata.path, () => this.openFile(metadata, context, options));
	}

	/** Listing must never migrate old conversations or rewrite their timestamps. */
	async readSnapshot(metadata: JsonlSessionMetadata): Promise<SessionSnapshot> {
		return this.withFile(metadata.path, async () => {
			await this.recoverFile(metadata.path);
			const raw = await this.fs.adapter.read(metadata.path);
			const first = JSON.parse(raw.split("\n", 1)[0]!) as { v?: unknown };
			if (first.v !== SESSION_FORMAT && first.v !== 5) return readLegacySnapshot(raw);
			const storage = await DurableVaultStorage.open(this.fs.adapter, metadata.path);
			if (first.v === 5) return readPreviousDurableSnapshot(storage);
			try {
				const session = await PiemSession.open(storage, metadata, BACKGROUND_CONTEXT, { readOnly: true });
				try { return await snapshotSession(session); }
				finally { await session.close(); }
			} finally { await storage.close(); }
		});
	}

	private async openFile(metadata: JsonlSessionMetadata, context = BACKGROUND_CONTEXT, options: { readOnly?: boolean } = {}): Promise<PiemSession<JsonlSessionMetadata>> {
		context.abortSignal?.throwIfAborted();
		await this.recoverFile(metadata.path);
		const raw = await this.fs.adapter.read(metadata.path);
		const first = JSON.parse(raw.split("\n", 1)[0]!) as { v?: unknown };
		if (first.v !== SESSION_FORMAT) {
			const snapshot = first.v === 5 ? await readPreviousDurableSnapshot(await DurableVaultStorage.open(this.fs.adapter, metadata.path)) : readLegacySnapshot(raw);
			await this.replaceFile(metadata, snapshot, raw);
		}
		const storage = await DurableVaultStorage.open(this.fs.adapter, metadata.path);
		try {
			if (storage.needsRecovery) {
				const existing = await storage.scanConversations({}, 1, undefined, context);
				const source = await PiemSession.open(existing.items.length ? storage : new MemoryStorage(), metadata, context, { readOnly: true });
				const snapshot = await snapshotSession(source);
				await source.close();
				await storage.close();
				await this.replaceFile(metadata, snapshot, raw);
				return this.openFile(metadata, context, options);
			}
			return await PiemSession.open(storage, metadata, context, options);
		}
		catch (error) { await storage.close(); throw error; }
	}

	/** Build and read back the complete replacement before publishing it. */
	async replace(metadata: JsonlSessionMetadata, snapshot: SessionSnapshot, original?: string, keepBackup = original !== undefined): Promise<void> {
		return this.withFile(metadata.path, () => this.replaceFile(metadata, snapshot, original, keepBackup));
	}

	private async replaceFile(metadata: JsonlSessionMetadata, snapshot: SessionSnapshot, original?: string, keepBackup = original !== undefined): Promise<void> {
		const path = metadata.path;
		const staged = `${path}.migrating.tmp`;
		await this.fs.adapter.write(staged, header(metadata));
		const storage = await DurableVaultStorage.open(this.fs.adapter, staged);
		const session = await PiemSession.open(storage, metadata);
		try {
			await session.restoreLog(snapshot.log, snapshot.lanes, snapshot.legacyValues);
			await session.restoreExecutions(snapshot.executions ?? {});
		}
		finally { await session.close(); }
		const verified = await PiemSession.open(await DurableVaultStorage.open(this.fs.adapter, staged), metadata);
		try {
			const restored = await snapshotSession(verified);
			const expectedEntries = snapshot.log.filter(item => item.kind === "entry").sort((a, b) => a.seq - b.seq);
			if (!jsonEqual(restored.log.filter(item => item.kind === "entry"), expectedEntries)) throw new Error("Conversation migration verification failed");
			if (!jsonEqual([...restored.lanes].sort((a, b) => a.lane.localeCompare(b.lane)), [...snapshot.lanes].sort((a, b) => a.lane.localeCompare(b.lane)))) throw new Error("Branch migration verification failed");
		} finally { await verified.close(); }
		if (original !== undefined && await this.fs.adapter.read(path) !== original) throw new Error("Conversation changed during migration");
		const backup = `${path}.replaced.tmp`;
		const exists = await this.fs.adapter.exists(path);
		if (exists) await this.fs.adapter.rename(path, backup);
		try { await this.fs.adapter.rename(staged, path); }
		catch (error) {
			if (exists && !(await this.fs.adapter.exists(path))) await this.fs.adapter.rename(backup, path);
			throw error;
		}
		if (exists) {
			if (keepBackup) await this.fs.adapter.rename(backup, `${path}.${uuidv7()}.legacy`);
			else getOrThrow(await this.fs.remove(backup));
		}
	}

	/** Restore the old file if a process stopped between the two publication renames. */
	async recover(path: string): Promise<void> {
		return this.withFile(path, () => this.recoverFile(path));
	}

	private async recoverFile(path: string): Promise<void> {
		const root = `${this.options.sessionsRoot}/`;
		if (!path.startsWith(root) || path.slice(root.length).split("/").length !== 2 || !path.endsWith(".jsonl")) return;
		if (normalizeFolderPath(path, { allowPluginInternals: true }) !== path) return;
		const backup = `${path}.replaced.tmp`;
		if (!(await this.fs.adapter.exists(backup))) return;
		if (!(await this.fs.adapter.exists(path))) await this.fs.adapter.rename(backup, path);
		else await this.fs.adapter.rename(backup, `${path}.${uuidv7()}.legacy`);
	}

	/** All repositories over one adapter share publication/recovery ownership. */
	private async withFile<T>(path: string, action: () => Promise<T>): Promise<T> {
		let operations = fileOperations.get(this.fs.adapter);
		if (!operations) { operations = new Map(); fileOperations.set(this.fs.adapter, operations); }
		const work = (operations.get(path) ?? Promise.resolve()).then(action);
		const settled = work.then(() => undefined, () => undefined);
		operations.set(path, settled);
		try { return await work; }
		finally { if (operations.get(path) === settled) operations.delete(path); }
	}

	async list(options?: { cwd?: string }, context = BACKGROUND_CONTEXT): Promise<JsonlSessionMetadata[]> {
		const root = await this.fs.listDir(this.options.sessionsRoot, context);
		if (!root.ok) { if (root.error.code === "not_found") return []; throw root.error; }
		const result: JsonlSessionMetadata[] = [];
		for (const directory of root.value.filter(item => item.kind === "directory")) {
			let files = getOrThrow(await this.fs.listDir(directory.path, context));
			const pending = files.filter(item => item.name.endsWith(".jsonl.replaced.tmp"));
			for (const item of pending) await this.recover(item.path.slice(0, -".replaced.tmp".length));
			if (pending.length) files = getOrThrow(await this.fs.listDir(directory.path, context));
			for (const file of files.filter(item => item.kind === "file" && item.name.endsWith(".jsonl"))) {
				const content = await this.fs.adapter.read(file.path);
				const metadata = parseSessionHeaderMetadata(content.split("\n", 1)[0]!, file.path, file.mtimeMs);
				if (metadata && (!options?.cwd || metadata.cwd === options.cwd)) result.push(metadata);
			}
		}
		return result.sort((a, b) => b.modifiedAt - a.modifiedAt);
	}
	async delete(metadata: JsonlSessionMetadata, context = BACKGROUND_CONTEXT): Promise<void> { getOrThrow(await this.fs.remove(metadata.path, undefined, context)); }
	async fork(source: JsonlSessionMetadata, options: ForkOptions, context = BACKGROUND_CONTEXT): Promise<PiemSession<JsonlSessionMetadata>> {
		const session = await this.open(source, context, { readOnly: true });
		try {
			const snapshot = await snapshotSession(session);
			const branch = await session.view(options.branch ?? options.lane ?? "main").findEntries();
			const target = options.entryId ?? options.targetEntryId ?? branch.at(-1)?.id;
			const index = branch.findIndex(entry => entry.id === target);
			if (index < 0) throw new Error(`Unknown fork entry: ${target}`);
			const selected = branch.slice(0, index + (options.position === "before" ? 0 : 1));
			const ids = new Set(selected.map(entry => entry.id));
			const fork = await this.create({ cwd: source.cwd, id: options.id, parentSessionId: source.id }, context);
			await fork.restoreLog(snapshot.log.filter(item => item.kind === "entry" ? ids.has(item.entry.id) : item.kind === "fact" && (item.fact === "name" || ids.has(item.targetId))), [{ lane: "main", leafId: selected.at(-1)?.id ?? null }], snapshot.legacyValues);
			return fork;
		} finally { await session.close(); }
	}
	async close(): Promise<void> { /* Live sessions own their storage lifetime. */ }
}

export class MemorySessionRepository {
	async create(options: SessionCreateOptions = {}, context = BACKGROUND_CONTEXT): Promise<PiemSession<SessionMetadata>> {
		return PiemSession.open(new MemoryStorage(), { id: options.id ?? uuidv7(), createdAt: Date.now(), storageVersion: 1, ...options }, context);
	}
}

export function header(metadata: JsonlSessionMetadata): string {
	return `${JSON.stringify({ kind: "header", v: SESSION_FORMAT, id: metadata.id, createdAt: metadata.createdAt, cwd: metadata.cwd, storageVersion: metadata.storageVersion, ...(metadata.parentSessionId ? { parentSessionId: metadata.parentSessionId } : {}) })}\n`;
}

export { VaultSessionRepository as JsonlSessionRepo, MemorySessionRepository as MemorySessionRepo };
