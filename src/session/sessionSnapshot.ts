import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Storage } from "@earendil-works/pi-durable";
import type { PiemSession } from "./PiemSession";
import type { LogItem, OperationRecord } from "./sessionTypes";
import { normalizeLegacyJsonlContent } from "./ObsidianSessionFileSystem";
import { parseMutationFromObject, scanDiskLines } from "./sessionMutationLine";

export interface SessionSnapshot {
	log: LogItem[];
	lanes: Array<{ lane: string; leafId: string | null }>;
	legacyValues: Record<string, JsonValue>;
}
export async function snapshotSession(session: PiemSession): Promise<SessionSnapshot> {
	return { log: await session.getLog(), lanes: await session.getLanes(), legacyValues: await session.getLegacyValues() };
}

/** One-time import of the earlier durable wrapper; no legacy tree is used at runtime. */
export async function readPreviousDurableSnapshot(storage: Storage): Promise<SessionSnapshot> {
	try {
		const doc = await storage.findDocument({ kind: "piem.session", scope: { kind: "session" } }, "current", BACKGROUND_CONTEXT);
		if (!doc) return { log: [], lanes: [{ lane: "main", leafId: null }], legacyValues: {} };
		const state = (await storage.document(doc.id, "current", BACKGROUND_CONTEXT))!.value as {
			name: { seq: number; value: string | null };
			labels: Record<string, { seq: number; value: string | null }>;
			lanes: Record<string, { seq: number; leafId: string | null }>;
			records: Record<string, JsonValue>;
			legacyValues: Record<string, JsonValue>;
		};
		const root = (await storage.scanConversations({}, 1, undefined, BACKGROUND_CONTEXT)).items[0]!;
		const log: LogItem[] = [];
		let cursor;
		do {
			const page = await storage.scanEntries({ conversationId: root.id }, 512, cursor, BACKGROUND_CONTEXT);
			for (const record of page.items) {
				const entry = record.data as unknown as import("./sessionTypes").Entry;
				log.push({ kind: "entry", seq: entry.seq, entry });
			}
			cursor = page.next;
		} while (cursor);
		if (state.name.seq) log.push({ kind: "fact", seq: state.name.seq, fact: "name", name: state.name.value ?? undefined });
		for (const [targetId, label] of Object.entries(state.labels)) log.push({ kind: "fact", seq: label.seq, fact: "label", targetId, label: label.value ?? undefined });
		for (const [lane, pointer] of Object.entries(state.lanes)) if (pointer.seq && !log.some(item => item.seq === pointer.seq)) log.push({ kind: "lane", lane, ...pointer });
		for (const raw of Object.values(state.records)) { const record = raw as unknown as OperationRecord; log.push({ kind: "record", seq: record.seq, record }); }
		return { log: log.sort((a, b) => a.seq - b.seq), lanes: Object.entries(state.lanes).map(([lane, pointer]) => ({ lane, leafId: pointer.leafId })), legacyValues: state.legacyValues };
	} finally { await storage.close(BACKGROUND_CONTEXT); }
}

/** Read the historical wire format once; new transactions never use this codec. */
export function readLegacySnapshot(content: string): SessionSnapshot {
	const lines = normalizeLegacyJsonlContent(content).split("\n");
	const snapshot: SessionSnapshot = { log: [], lanes: [], legacyValues: {} };
	const operationResults = new Map<string, { seq: number; value: Record<string, unknown> }>();
	for (const [index, line] of lines.entries()) {
		if (index === 0 || !line.trim()) continue;
		let parsed: unknown;
		try { parsed = JSON.parse(line); }
		catch (error) {
			if (index === lines.length - 1 && !content.endsWith("\n")) break;
			throw new Error(`Unreadable legacy session line ${index + 1}`, { cause: error });
		}
		for (const raw of Array.isArray(parsed) ? parsed : [parsed]) {
			if (!raw || typeof raw !== "object") throw new Error(`Invalid legacy session line ${index + 1}`);
			const item = parseMutationFromObject(raw as Record<string, unknown>);
			if (!item) throw new Error(`Unsupported legacy session record at line ${index + 1}`);
			if (item.kind === "entry") {
				const entry = item.entry;
				const time: unknown = entry.timestamp;
				entry.timestamp = typeof time === "string" ? Date.parse(time) : typeof time === "number" ? time : 0;
				snapshot.log.push({ kind: "entry", seq: entry.seq, entry });
			} else if (item.kind === "fact" || item.kind === "lane") snapshot.log.push(item);
			else if (item.kind === "record") snapshot.log.push({ ...item, record: item.record as unknown as OperationRecord });
			else if (item.kind === "value") {
				const key = `${item.namespace}/${item.key}`;
				if (item.op === "delete") delete snapshot.legacyValues[key];
				else snapshot.legacyValues[key] = item.value as JsonValue;
				if (item.namespace === "pi.session.name") snapshot.log.push({ kind: "fact", seq: item.seq, fact: "name", name: typeof item.value === "string" ? item.value : undefined });
				if (item.namespace === "pi.entry.label") snapshot.log.push({ kind: "fact", seq: item.seq, fact: "label", targetId: item.key, label: typeof item.value === "string" ? item.value : undefined });
				if (item.namespace === "pi.operation.result" && item.value && typeof item.value === "object") operationResults.set(item.key, { seq: item.seq, value: item.value as Record<string, unknown> });
			} else if (item.kind === "list") {
				const key = `list:${item.namespace}/${item.key}`;
				if (item.op === "delete") delete snapshot.legacyValues[key];
				else snapshot.legacyValues[key] = [...(snapshot.legacyValues[key] as JsonValue[] | undefined ?? []), item.value as JsonValue];
			} else snapshot.legacyValues[`usage/${item.id}`] = item.usage as JsonValue;
		}
	}
	for (const [key, value] of Object.entries(snapshot.legacyValues)) {
		if (!key.startsWith("pi.operation.meta/") || !value || typeof value !== "object" || Array.isArray(value)) continue;
		const id = key.slice("pi.operation.meta/".length);
		const meta = value as Record<string, JsonValue>;
		const result = operationResults.get(id);
		const seq = result?.seq ?? snapshot.log.reduce((max, item) => Math.max(max, item.seq), 0) + 1;
		const record = result ? { ...result.value, id, runId: id, type: "operation_finished", outcome: result.value.status, lane: meta.lane, seq }
			: { id, runId: id, type: "operation_started", lane: meta.lane, sourceLeafId: meta.sourceTipId, intent: meta.intent, timestamp: meta.startedAt, seq };
		snapshot.log.push({ kind: "record", seq, record: record as unknown as OperationRecord });
	}
	const disk = scanDiskLines(lines);
	snapshot.lanes = [...disk.laneLeaves].map(([lane, leafId]) => ({ lane, leafId }));
	return snapshot;
}
