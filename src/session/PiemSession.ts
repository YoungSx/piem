import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, defineDoc, type ConversationId, type Session as DurableSession, type Storage, type Tx } from "@earendil-works/pi-durable";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BranchScan, Entry, EntryQuery, LaneConfiguration, LogItem, OperationRecord, SessionMetadata } from "./sessionTypes";
import { DurableVaultStorage } from "./DurableVaultStorage";

type Pointer = { seq: number; leafId: string | null };
type Label = { seq: number; value: string | null };
type State = {
	seq: number;
	name: Label;
	lanes: Record<string, Pointer>;
	labels: Record<string, Label>;
	records: Record<string, JsonValue>;
	legacyValues: Record<string, JsonValue>;
};
const SessionState = defineDoc<State>({
	kind: "piem.session", version: 1, scope: "session",
	initial: () => ({ seq: 0, name: { seq: 0, value: null }, lanes: { main: { seq: 0, leafId: null } }, labels: {}, records: {}, legacyValues: {} }),
});

/** Piem's UUID transcript and branch pointers over Pi's unmodified transaction kernel. */
export class PiemSession<TMetadata extends SessionMetadata = SessionMetadata> {
	readonly idGenerator = { next: uuidv7 };
	private constructor(readonly metadata: TMetadata, private readonly native: DurableSession, private readonly conversation: ConversationId, private readonly storage: Storage) {}
	get needsRecovery(): boolean { return this.storage instanceof DurableVaultStorage && this.storage.needsRecovery; }

	static async open<T extends SessionMetadata>(storage: Storage, metadata: T, context = BACKGROUND_CONTEXT): Promise<PiemSession<T>> {
		const native = createSession(storage);
		const conversation = await native.commit(async tx => {
			const existing = await tx.scanConversations({}, 1);
			if (existing.items[0]) return existing.items[0].id;
			const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
			await tx.doc(SessionState);
			return created.id;
		}, context);
		return new PiemSession(metadata, native, conversation, storage);
	}

	async getMetadata(): Promise<TMetadata> { return this.metadata; }
	async close(context = BACKGROUND_CONTEXT): Promise<void> { await this.native.close(context); }
	private async state(context = BACKGROUND_CONTEXT): Promise<Readonly<State>> {
		return (await this.native.snapshot(SessionState, context))!;
	}
	private async entries(tx: Tx): Promise<Entry[]> {
		const entries: Entry[] = [];
		let cursor;
		do {
			const page = await tx.scanEntries({ conversationId: this.conversation }, 512, cursor);
			for (const record of page.items) {
				if (record.kind === "piem.transcript") entries.push(record.data as unknown as Entry);
			}
			cursor = page.next;
		} while (cursor);
		return entries.sort((a, b) => a.seq - b.seq);
	}
	async findEntries(query: EntryQuery = {}, context = BACKGROUND_CONTEXT): Promise<Entry[]> {
		return this.native.commit(async tx => select(await this.entries(tx), query), context);
	}
	async findEntry(query: EntryQuery = {}, context = BACKGROUND_CONTEXT): Promise<Entry | undefined> {
		return (await this.findEntries({ ...query, limit: 1 }, context))[0];
	}
	async getEntry(id: string, context = BACKGROUND_CONTEXT): Promise<Entry | undefined> {
		return (await this.findEntries({}, context)).find(entry => entry.id === id);
	}
	async getEntries(ids: string[], context = BACKGROUND_CONTEXT): Promise<Map<string, Entry>> {
		const wanted = new Set(ids);
		return new Map((await this.findEntries({}, context)).filter(entry => wanted.has(entry.id)).map(entry => [entry.id, entry]));
	}
	async getStats() { return { messageCount: (await this.findEntries({ type: "message" })).length }; }
	async getName(): Promise<string | undefined> { return (await this.state()).name.value ?? undefined; }
	async setName(name: string | undefined): Promise<void> {
		await this.native.commit(async tx => { const state = await tx.doc(SessionState); state.name = { seq: ++state.seq, value: name ?? null }; }, BACKGROUND_CONTEXT);
	}
	async getLabel(id: string): Promise<string | undefined> { return (await this.state()).labels[id]?.value ?? undefined; }
	async setLabel(id: string, label: string | undefined): Promise<void> {
		await this.native.commit(async tx => {
			if (!(await this.entries(tx)).some(entry => entry.id === id)) throw new Error(`Unknown entry: ${id}`);
			const state = await tx.doc(SessionState);
			state.labels[id] = { seq: ++state.seq, value: label ?? null };
		}, BACKGROUND_CONTEXT);
	}
	async getLeafId(lane = "main"): Promise<string | null> { return (await this.state()).lanes[lane]?.leafId ?? null; }
	async getLanes(): Promise<Array<{ lane: string; leafId: string | null }>> {
		return Object.entries((await this.state()).lanes).map(([lane, pointer]) => ({ lane, leafId: pointer.leafId }));
	}
	async moveLane(lane: string, targetId: string | null): Promise<void> {
		await this.native.commit(async tx => {
			if (targetId !== null && !(await this.entries(tx)).some(entry => entry.id === targetId)) throw new Error(`Unknown entry: ${targetId}`);
			const state = await tx.doc(SessionState);
			state.lanes[lane] = { seq: ++state.seq, leafId: targetId };
		}, BACKGROUND_CONTEXT);
	}
	async createLane(lane: string, targetId: string | null): Promise<void> { await this.moveLane(lane, targetId); }
	async branch(lane: string, _context = BACKGROUND_CONTEXT) {
		return Object.prototype.hasOwnProperty.call((await this.state()).lanes, lane) ? this.view(lane) : undefined;
	}
	async createBranch(lane: string, at: string | null, _context = BACKGROUND_CONTEXT) {
		await this.createLane(lane, at);
		return this.view(lane);
	}
	view(lane = "main") {
		const find = async (query: BranchScan = {}, context = BACKGROUND_CONTEXT): Promise<Entry[]> => {
			return this.native.commit(async tx => {
				const entries = new Map((await this.entries(tx)).map(entry => [entry.id, entry]));
				const state = await tx.doc(SessionState);
				const path: Entry[] = [];
				const seen = new Set<string>();
				for (let id = query.fromId ?? state.lanes[lane]?.leafId; id; id = entries.get(id)?.parentId) {
					if (seen.has(id)) throw new Error("Conversation branch contains a cycle");
					seen.add(id);
					const entry = entries.get(id);
					if (!entry) throw new Error(`Missing branch entry: ${id}`);
					path.push(entry);
					if (id === query.stopAtId) break;
				}
				return select(path.reverse(), query);
			}, context);
		};
		return {
			getLeafId: () => this.getLeafId(lane), getTipId: () => this.getLeafId(lane),
			findEntries: find, findEntriesOnBranch: find,
			findEntry: async (query: BranchScan = {}, context = BACKGROUND_CONTEXT) => (await find({ ...query, limit: 1 }, context))[0],
			findEntryOnBranch: async (query: BranchScan = {}) => (await find({ order: "newestFirst", ...query, limit: 1 }))[0],
			appendMessage: (message: AgentMessage, _context = BACKGROUND_CONTEXT) => this.appendMessage(message, lane),
			appendCustomEntry: (customType: string, data?: JsonValue, _context = BACKGROUND_CONTEXT) => this.appendCustomEntry(customType, data, lane),
			appendEntry: (entry: { type: string; [key: string]: unknown }, _context = BACKGROUND_CONTEXT) => this.appendEntry(entry, lane),
		};
	}
	async findEntriesOnBranch(query?: BranchScan): Promise<Entry[]> { return this.view().findEntries(query); }
	async appendEntry(entry: { type: string; [key: string]: unknown }, lane = "main"): Promise<Entry> {
		return (await this.appendEntries([entry], lane))[0]!;
	}
	async appendEntries(drafts: Array<{ type: string; [key: string]: unknown }>, lane: string, options?: { expectedTip: string | null; assertCurrent(): void }): Promise<Entry[]> {
		return this.native.commit(async tx => {
			const known = new Set((await this.entries(tx)).map(entry => entry.id));
			const state = await tx.doc(SessionState);
			let parentId = state.lanes[lane]?.leafId ?? null;
			options?.assertCurrent();
			if (options && parentId !== options.expectedTip) throw new Error("Conversation changed before drafts were saved");
			const result: Entry[] = [];
			for (const draft of drafts) {
				const id = typeof draft.id === "string" ? draft.id : uuidv7();
				if (known.has(id)) throw new Error(`Duplicate entry: ${id}`);
				known.add(id);
				const entry = JSON.parse(JSON.stringify({ ...draft, id, parentId, seq: ++state.seq, timestamp: draft.timestamp ?? Date.now() })) as Entry;
				await tx.appendEntry(this.conversation, { kind: "piem.transcript", data: entry as unknown as JsonValue });
				result.push(entry);
				parentId = id;
			}
			state.lanes[lane] = { seq: state.seq, leafId: parentId };
			options?.assertCurrent();
			return result;
		}, BACKGROUND_CONTEXT);
	}
	async appendMessage(message: AgentMessage | string, lane = "main"): Promise<string> {
		const normalized = typeof message === "string" ? { role: "user", content: message, timestamp: Date.now() } : message;
		return (await this.appendEntries([{ type: "message", message: normalized }], lane))[0]!.id;
	}
	async appendCustomEntry(customType: string, data?: unknown, lane = "main"): Promise<string> {
		return (await this.appendEntry({ type: "custom", customType, data }, lane)).id;
	}
	async getConfiguration(lane = "main"): Promise<LaneConfiguration | undefined> {
		const entries = await this.view(lane).findEntries({ order: "newestFirst" });
		const model = entries.find(entry => entry.type === "model_change");
		const thinking = entries.find(entry => entry.type === "thinking_level_change");
		const legacy = (await this.state()).legacyValues[`pi.lane.config/${lane}`] as unknown as LaneConfiguration | undefined;
		return model?.type === "model_change" ? { model: { provider: model.provider, modelId: model.modelId }, thinkingLevel: thinking?.type === "thinking_level_change" ? thinking.thinkingLevel : legacy?.thinkingLevel ?? "off", activeToolNames: [] } : legacy;
	}
	async appendRecord(record: { type: string; [key: string]: unknown }): Promise<{ id: string }> {
		return this.native.commit(async tx => {
			const state = await tx.doc(SessionState);
			const id = typeof record.id === "string" ? record.id : uuidv7();
			state.records[id] = JSON.parse(JSON.stringify({ ...record, id, seq: ++state.seq, timestamp: record.timestamp ?? Date.now() })) as JsonValue;
			return { id };
		}, BACKGROUND_CONTEXT);
	}
	async findRecords(query?: { type?: string }): Promise<OperationRecord[]> {
		return Object.values((await this.state()).records).map(record => record as unknown as OperationRecord).filter(record => !query?.type || record.type === query.type);
	}
	async findOpenOperations(lane = "main") {
		const records = await this.findRecords();
		const finished = new Set(records.filter(record => record.type === "operation_finished").map(record => record.runId));
		return records.filter(record => record.type === "operation_started" && record.lane === lane && !finished.has(record.id))
			.map(record => ({ ...record, sourceLeafId: record.sourceLeafId ?? null, intent: record.intent ?? {} }));
	}
	async getLog(options?: { afterSeq?: number; limit?: number }): Promise<LogItem[]> {
		const entries = await this.findEntries();
		const state = await this.state();
		const log: LogItem[] = entries.map(entry => ({ kind: "entry", seq: entry.seq, entry }));
		if (state.name.seq) log.push({ kind: "fact", seq: state.name.seq, fact: "name", name: state.name.value ?? undefined });
		for (const [targetId, label] of Object.entries(state.labels)) log.push({ kind: "fact", seq: label.seq, fact: "label", targetId, label: label.value ?? undefined });
		for (const [lane, pointer] of Object.entries(state.lanes)) if (pointer.seq && !entries.some(entry => entry.seq === pointer.seq)) log.push({ kind: "lane", lane, ...pointer });
		for (const raw of Object.values(state.records)) { const record = raw as unknown as OperationRecord; log.push({ kind: "record", seq: record.seq, record }); }
		return log.sort((a, b) => a.seq - b.seq).filter(item => item.seq > (options?.afterSeq ?? -1)).slice(0, options?.limit);
	}

	/** Import only into an empty session. UUIDs and branch ancestry survive numeric ID allocation. */
	async restoreLog(log: LogItem[], lanes: Array<{ lane: string; leafId: string | null }>, legacyValues: Record<string, JsonValue> = {}): Promise<void> {
		await this.native.commit(async tx => {
			if ((await this.entries(tx)).length) throw new Error("Import requires an empty conversation");
			const state = await tx.doc(SessionState);
			const entries = log.flatMap(item => item.kind === "entry" ? [item.entry] : []);
			const known = new Set(entries.map(entry => entry.id));
			if (known.size !== entries.length) throw new Error("Imported conversation has duplicate entry IDs");
			for (const entry of entries) {
				if (entry.parentId !== null && !known.has(entry.parentId)) throw new Error(`Missing parent of imported entry: ${entry.id}`);
				await tx.appendEntry(this.conversation, { kind: "piem.transcript", data: entry as unknown as JsonValue });
			}
			for (const item of log) {
				state.seq = Math.max(state.seq, item.seq);
				if (item.kind === "fact" && item.fact === "name") state.name = { seq: item.seq, value: item.name ?? null };
				if (item.kind === "fact" && item.fact === "label") state.labels[item.targetId] = { seq: item.seq, value: item.label ?? null };
				if (item.kind === "record") state.records[item.record.id] = item.record as unknown as JsonValue;
			}
			for (const { lane, leafId } of lanes) {
				if (leafId !== null && !known.has(leafId)) throw new Error(`Missing imported branch tip: ${lane}`);
				state.lanes[lane] = { seq: 0, leafId };
			}
			state.legacyValues = legacyValues;
		}, BACKGROUND_CONTEXT);
	}
	async getLegacyValues(): Promise<Record<string, JsonValue>> { return { ...(await this.state()).legacyValues }; }
}

function select(entries: Entry[], query: EntryQuery): Entry[] {
	let result = entries.filter(entry => (!query.type || entry.type === query.type) && (!query.customType || entry.customType === query.customType));
	if (query.order === "desc" || query.order === "newestFirst") result.reverse();
	return result.slice(0, query.limit);
}

export { PiemSession as Session };
