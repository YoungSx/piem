import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { StorageRejected, type Seq, type StorageWrite } from "@earendil-works/pi-durable";
import { sha256 } from "@noble/hashes/sha2.js";
import type { DataAdapter } from "obsidian";
import { normalizeFolderPath } from "../vault/path";
import { SESSION_FORMAT } from "./sessionMetadata";
import { parseDurableWrites, validateDurableReferences } from "./durableCommit";

type StorageAdapter = Pick<DataAdapter, "read" | "write" | "append" | "stat">;
type Fingerprint = { mtime: number; size: number };

export class SessionChangedError extends StorageRejected {
	constructor(readonly path: string) {
		super(`Conversation changed on disk: ${path}`);
	}
}

/**
 * Pi owns validation, transactions and state. This adapter only persists its
 * prepared commits through the Vault API, in one syncable JSONL file.
 * A Session serializes commits; direct concurrent callers are serialized too.
 */
export class DurableVaultStorage extends MemoryStorage {
	private fingerprint: Fingerprint | null = null;
	private poisoned = false;
	private queue: Promise<unknown> = Promise.resolve();
	private readonly digest = sha256.create();
	get needsRecovery(): boolean { return this.poisoned; }
	private constructor(private readonly adapter: StorageAdapter, readonly path: string) { super(); }

	static async open(adapter: StorageAdapter, path: string): Promise<DurableVaultStorage> {
		const storage = new DurableVaultStorage(adapter, normalizeFolderPath(path, { allowPluginInternals: true }));
		const before = await adapter.stat(storage.path);
		const content = await adapter.read(storage.path);
		const after = await adapter.stat(storage.path);
		if (!sameFile(before, after)) throw new SessionChangedError(storage.path);
		const lines = content.split("\n");
		const header = JSON.parse(lines.shift() ?? "") as { kind?: unknown; v?: unknown };
		if (header.kind !== "header" || header.v !== 5 && header.v !== SESSION_FORMAT) throw new Error("Expected a Piem durable session header");
		let previousSeq = 0;
		for (const [index, line] of lines.entries()) {
			if (line === "" && index === lines.length - 1) continue;
			// A complete newline is the commit marker. Ignore a torn final write;
			// opening does not rewrite another device's file.
			if (index === lines.length - 1 && !content.endsWith("\n")) {
				storage.poisoned = true;
				break;
			}
			const record = JSON.parse(line) as { kind?: unknown; seq?: unknown; writes?: unknown };
			if (record.kind !== "durable_commit" || !Number.isSafeInteger(record.seq) || (record.seq as number) <= previousSeq || !Array.isArray(record.writes)) {
				throw new Error(`Invalid durable commit at line ${index + 2}`);
			}
			const seq = record.seq as Seq;
			const writes = parseDurableWrites(record.writes);
			await validateDurableReferences(writes, storage);
			storage.prepareCommit(writes, seq).apply();
			previousSeq = seq;
		}
		storage.fingerprint = after;
		storage.digest.update(new TextEncoder().encode(content));
		return storage;
	}

	override commit(writes: readonly StorageWrite[], context: Context): Promise<Seq> {
		const work = this.queue.then(() => this.persist(writes, context));
		this.queue = work.catch(() => undefined);
		return work;
	}

	private async persist(writes: readonly StorageWrite[], context: Context): Promise<Seq> {
		if (this.poisoned) throw new Error("Conversation storage needs recovery before another write");
		context.abortSignal?.throwIfAborted();
		const observed = await this.adapter.stat(this.path);
		if (!sameFile(this.fingerprint, observed)) {
			// Sync may rewrite identical bytes with a new mtime. Verify them once;
			// ordinary appends retain the inexpensive stat-only path.
			const current = sha256(new TextEncoder().encode(await this.adapter.read(this.path)));
			const expected = this.digest.clone().digest();
			if (!current.every((byte, index) => byte === expected[index])) throw new SessionChangedError(this.path);
			this.fingerprint = observed;
		}
		let prepared;
		try { prepared = this.prepareCommit(writes); }
		catch (error) { throw new StorageRejected(error instanceof Error ? error.message : String(error), { cause: error }); }
		const line = `${JSON.stringify({ kind: "durable_commit", seq: prepared.seq, writes: prepared.writes })}\n`;
		try {
			await this.adapter.append(this.path, line);
		} catch (error) {
			// A rejected append may have written nothing, part, or the whole frame.
			// Read back before classifying it: only exact unchanged bytes justify
			// StorageRejected, which lets Pi discard the transaction and continue.
			let actual: Uint8Array | undefined;
			try { actual = sha256(new TextEncoder().encode(await this.adapter.read(this.path))); } catch { /* Unknown outcome. */ }
			if (actual && equalDigest(actual, this.digest.clone().digest())) {
				throw new StorageRejected(error instanceof Error ? error.message : String(error), { cause: error });
			}
			const committed = this.digest.clone().update(new TextEncoder().encode(line)).digest();
			if (!actual || !equalDigest(actual, committed)) {
				this.poisoned = true;
				throw error;
			}
		}
		// Once the frame is stored, cancellation/stat failure must not turn its
		// successful transaction into an error. Pi adopts the confirmed bytes.
		const seq = prepared.apply();
		this.digest.update(new TextEncoder().encode(line));
		try { this.fingerprint = await this.adapter.stat(this.path); } catch { this.fingerprint = null; }
		return seq;
	}

	override async close(context: Context = BACKGROUND_CONTEXT): Promise<void> {
		await this.queue;
		await super.close(context);
	}
}

function equalDigest(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameFile(a: Fingerprint | null, b: Fingerprint | null): boolean {
	return a !== null && b !== null && a.mtime === b.mtime && a.size === b.size;
}
