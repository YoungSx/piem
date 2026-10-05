import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, EntryId, EntryRecord, Storage } from "@earendil-works/pi-durable";
import type { DataAdapter } from "obsidian";
import { uuidv7 } from "@earendil-works/pi-ai";
import { DurableVaultStorage } from "./DurableVaultStorage";
import { NATIVE_SESSION_FORMAT } from "./sessionMetadata";
import type { SessionMetadata } from "./sessionTypes";
import { normalizeFolderPath } from "../vault/path";

/** A separate file format: the legacy repository must never rebuild this graph. */
export function nativeSessionHeader(metadata: SessionMetadata & { cwd: string }): string {
	return `${JSON.stringify({ kind: "header", v: NATIVE_SESSION_FORMAT, id: metadata.id, cwd: metadata.cwd, createdAt: metadata.createdAt,
		storageVersion: metadata.storageVersion, ...(metadata.parentSessionId ? { parentSessionId: metadata.parentSessionId } : {}) })}\n`;
}

export type NativeHistoryEntry = Omit<EntryRecord, "id"> & { id: string; entryId: EntryId };

/** Read-only projection; no copied transcript, guessed timestamp or Piem sequence. */
export async function readNativeHistory(storage: Storage, sessionId: string, conversationId: ConversationId, context: Context = BACKGROUND_CONTEXT): Promise<NativeHistoryEntry[]> {
	const records: NativeHistoryEntry[] = [];
	let cursor;
	do {
		const page = await storage.scanEntries({ conversationId }, 512, cursor, context);
		for (const record of page.items) {
			records.push({ ...record, entryId: record.id, id: legacyEntryId(record) ?? `native:${encodeURIComponent(sessionId)}:${record.id}` });
		}
		cursor = page.next;
	} while (cursor);
	// Pi scans newest first, including inherited fork ancestry and its cutoff.
	return records.reverse();
}

/** Preserve earlier Piem links only for its complete, recognizable identity envelope. */
function legacyEntryId(record: EntryRecord): string | undefined {
	const data = record.data;
	if (!data || typeof data !== "object" || Array.isArray(data)) return;
	if (typeof data.type !== "string" || !["message", "compaction", "branch_summary", "model_change", "thinking_level_change", "custom"].includes(data.type)) return;
	if (typeof data.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.id)) return;
	if (data.parentId !== null && typeof data.parentId !== "string") return;
	if (typeof data.seq !== "number" || !Number.isSafeInteger(data.seq) || data.seq < 1) return;
	if (typeof data.timestamp !== "number" || !Number.isFinite(data.timestamp)) return;
	return data.id;
}

type RecoveryAdapter = Pick<DataAdapter, "read" | "write" | "append" | "stat">;

/**
 * Salvage only an incomplete final append into a new file. Keep the source as
 * evidence; replay the original complete commits, never import a task snapshot.
 * createNew must use Vault.create, which rejects an existing file. DataAdapter's
 * exists+write is not an exclusive create. Failed copies remain as evidence;
 * never delete a path that sync could have replaced during verification.
 */
export async function recoverNativeSessionCopy(adapter: RecoveryAdapter, source: string, createNew: (path: string, content: string) => Promise<unknown>): Promise<string> {
	source = normalizeFolderPath(source, { allowPluginInternals: true });
	const storage = await DurableVaultStorage.open(adapter, source);
	try {
		if (storage.format !== NATIVE_SESSION_FORMAT) throw new Error("Expected a native Harness session");
		if (!storage.needsRecovery) throw new Error("Native session has no incomplete final commit");
		const original = await adapter.read(source);
		if (!storage.matchesContent(original)) throw new Error("Native session changed during recovery");
		const prefix = original.slice(0, original.lastIndexOf("\n") + 1);
		const target = `${source}.recovered-${uuidv7()}.jsonl`;
		try {
			await createNew(target, prefix);
			if (await adapter.read(target) !== prefix) throw new Error("Native recovery verification failed");
			const recovered = await DurableVaultStorage.open(adapter, target);
			await recovered.close();
			if (await adapter.read(source) !== original) throw new Error("Native session changed during recovery");
			return target;
		} catch (error) {
			throw new Error(`Native recovery failed at ${target}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
	} finally { await storage.close(); }
}
