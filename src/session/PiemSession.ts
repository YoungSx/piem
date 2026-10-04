import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, defineDoc, AgentDoc, configure, type ConversationId, type EntryId, type Session as DurableSession, type Storage, type Tx } from "@earendil-works/pi-durable";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BranchScan, Entry, EntryQuery, LaneConfiguration, LogItem, OperationRecord, SessionMetadata } from "./sessionTypes";
import { DurableVaultStorage } from "./DurableVaultStorage";
import { appendTranscript, scanTranscript, transcriptEntry } from "./piTranscript";

type Pointer = { seq: number; conversationId: ConversationId };
type Label = { seq: number; value: string | null };
type State = {
	seq: number;
	entryIds: Record<string, EntryId>;
	name: Label;
	lanes: Record<string, Pointer>;
	labels: Record<string, Label>;
	records: Record<string, JsonValue>;
	legacyValues: Record<string, JsonValue>;
};
const SessionState = defineDoc<State>({
	kind: "piem.session", version: 1, scope: "session",
	initial: () => ({ seq: 0, entryIds: {}, name: { seq: 0, value: null }, lanes: {}, labels: {}, records: {}, legacyValues: {} }),
});

/** Piem's UUID transcript and branch pointers over Pi's unmodified transaction kernel. */
export class PiemSession<TMetadata extends SessionMetadata = SessionMetadata> {
	readonly idGenerator = { next: uuidv7 };
	private constructor(readonly metadata: TMetadata, private readonly native: DurableSession, private readonly storage: Storage) {}
	get needsRecovery(): boolean { return this.storage instanceof DurableVaultStorage && this.storage.needsRecovery; }

	static async open<T extends SessionMetadata>(storage: Storage, metadata: T, context = BACKGROUND_CONTEXT): Promise<PiemSession<T>> {
		const native = createSession(storage);
		await native.commit(async tx => {
			const state = await tx.doc(SessionState);
			if (!state.lanes.main) {
				const root = await tx.createConversation({ ownership: { kind: "ownerless" } });
				state.lanes.main = { seq: 0, conversationId: root.id };
			}
		}, context);
		return new PiemSession(metadata, native, storage);
	}

	async getMetadata(): Promise<TMetadata> { return this.metadata; }
	async close(context = BACKGROUND_CONTEXT): Promise<void> { await this.native.close(context); }
	private async state(context = BACKGROUND_CONTEXT): Promise<Readonly<State>> {
		return (await this.native.snapshot(SessionState, context))!;
	}
	private async entries(tx: Tx): Promise<Entry[]> {
		const state = await tx.doc(SessionState);
		const entries: Entry[] = [];
		for (const id of Object.values(state.entryIds)) entries.push(transcriptEntry((await tx.entry(id))!));
		return entries.sort((a, b) => a.seq - b.seq);
	}
	private async at(tx: Tx, uuid: string) {
		const id = (await tx.doc(SessionState)).entryIds[uuid];
		const record = id === undefined ? undefined : await tx.entry(id);
		if (!record) throw new Error(`Unknown entry: ${uuid}`);
		return record;
	}
	private async forkAt(tx: Tx, uuid: string | null): Promise<ConversationId> {
		if (uuid === null) return (await tx.createConversation({ ownership: { kind: "ownerless" } })).id;
		const at = await this.at(tx, uuid);
		return (await tx.forkConversation(at.conversationId, at.id, { ownership: { kind: "ownerless" } })).id;
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
			await this.at(tx, id);
			const state = await tx.doc(SessionState);
			state.labels[id] = { seq: ++state.seq, value: label ?? null };
		}, BACKGROUND_CONTEXT);
	}
	async getLeafId(lane = "main"): Promise<string | null> {
		return this.native.commit(async tx => this.leaf(tx, (await tx.doc(SessionState)).lanes[lane]?.conversationId), BACKGROUND_CONTEXT);
	}
	private async leaf(tx: Tx, conversationId?: ConversationId): Promise<string | null> {
		const last = conversationId === undefined ? undefined : (await tx.scanEntries({ conversationId }, 1)).items[0];
		return last ? transcriptEntry(last).id : null;
	}
	async getLanes(): Promise<Array<{ lane: string; leafId: string | null }>> {
		return this.native.commit(async tx => {
			const lanes = Object.entries((await tx.doc(SessionState)).lanes);
			return Promise.all(lanes.map(async ([lane, pointer]) => ({ lane, leafId: await this.leaf(tx, pointer.conversationId) })));
		}, BACKGROUND_CONTEXT);
	}
	async moveLane(lane: string, targetId: string | null): Promise<void> {
		await this.native.commit(async tx => {
			const state = await tx.doc(SessionState);
			state.lanes[lane] = { seq: ++state.seq, conversationId: await this.forkAt(tx, targetId) };
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
				const state = await tx.doc(SessionState);
				const from = query.fromId ? await this.at(tx, query.fromId) : undefined;
				const conversation = from?.conversationId ?? state.lanes[lane]?.conversationId;
				if (conversation === undefined) return [];
				const stop = query.stopAtId ? await this.at(tx, query.stopAtId) : undefined;
				const entries = await scanTranscript(tx, conversation, { maxEntryId: from?.id, minEntryId: stop?.id });
				return select(query.includeStopAt === false ? entries.filter(entry => entry.id !== query.stopAtId) : entries, query);
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
			const state = await tx.doc(SessionState);
			let conversation = state.lanes[lane]?.conversationId;
			const tail = conversation === undefined ? undefined : (await tx.scanEntries({ conversationId: conversation }, 1)).items[0];
			conversation ??= await this.forkAt(tx, null);
			let parentId = tail ? transcriptEntry(tail).id : null;
			options?.assertCurrent();
			if (options && parentId !== options.expectedTip) throw new Error("Conversation changed before drafts were saved");
			const result: Entry[] = [];
			for (const draft of drafts) {
				const id = typeof draft.id === "string" ? draft.id : uuidv7();
				if (state.entryIds[id] !== undefined) throw new Error(`Duplicate entry: ${id}`);
				const entry = JSON.parse(JSON.stringify({ ...draft, id, parentId, seq: ++state.seq, timestamp: draft.timestamp ?? Date.now() })) as Entry;
				state.entryIds[id] = (await appendTranscript(tx, conversation, entry)).id;
				result.push(entry);
				parentId = id;
			}
			state.lanes[lane] = { seq: state.seq, conversationId: conversation };
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
		const state = await this.state();
		const conversation = state.lanes[lane]?.conversationId;
		const agent = conversation === undefined ? undefined : await this.native.snapshot(AgentDoc, conversation, BACKGROUND_CONTEXT);
		return agent?.model ? { model: agent.model, thinkingLevel: agent.thinkingLevel ?? "off", activeToolNames: Array.isArray(agent.tools) ? [...agent.tools] : [] } : undefined;
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
		for (const [lane, pointer] of Object.entries(state.lanes)) if (pointer.seq && !entries.some(entry => entry.seq === pointer.seq)) log.push({ kind: "lane", lane, seq: pointer.seq, leafId: await this.getLeafId(lane) });
		for (const raw of Object.values(state.records)) { const record = raw as unknown as OperationRecord; log.push({ kind: "record", seq: record.seq, record }); }
		return log.sort((a, b) => a.seq - b.seq).filter(item => item.seq > (options?.afterSeq ?? -1)).slice(0, options?.limit);
	}

	/** Import only into an empty session. UUIDs and branch ancestry survive numeric ID allocation. */
	async restoreLog(log: LogItem[], lanes: Array<{ lane: string; leafId: string | null }>, legacyValues: Record<string, JsonValue> = {}): Promise<void> {
		if (Object.keys((await this.state()).entryIds).length) throw new Error("Import requires an empty conversation");
		const entries = log.flatMap(item => item.kind === "entry" ? [item.entry] : []).sort((a, b) => a.seq - b.seq);
		const importedIds = new Set(entries.map(entry => entry.id));
		const tips = new Map<ConversationId, string>();
		// A fork inherits committed document checkpoints. Import into the staged
		// file in commit order, then publish only after the repository verifies it.
		for (const entry of entries) {
			await this.native.commit(async tx => {
				const state = await tx.doc(SessionState);
				if (state.entryIds[entry.id] !== undefined) throw new Error("Imported conversation has duplicate entry IDs");
				// Older logs can retain a child after its parent was removed. Preserve
				// its original parentId in the transcript, but start a native root at
				// that boundary. Never attach it to an unrelated surviving message.
				const parentId = entry.parentId !== null && importedIds.has(entry.parentId) ? entry.parentId : null;
				const parent = parentId === null ? undefined : await this.at(tx, parentId);
				const conversation = parent && tips.get(parent.conversationId) === entry.parentId
					? parent.conversationId : await this.forkAt(tx, parentId);
				if (!parent) {
					const legacy = legacyValues["pi.lane.config/main"] as unknown as LaneConfiguration | undefined;
					if (legacy) {
						await configure(tx, conversation, { model: legacy.model, thinkingLevel: legacy.thinkingLevel });
						(await tx.doc(AgentDoc, conversation)).tools = legacy.activeToolNames ?? [];
					}
				}
				state.entryIds[entry.id] = (await appendTranscript(tx, conversation, entry)).id;
				tips.set(conversation, entry.id);
			}, BACKGROUND_CONTEXT);
		}
		for (const { lane, leafId } of lanes) await this.moveLane(lane, leafId);
		await this.native.commit(async tx => {
			const state = await tx.doc(SessionState);
			state.seq = 0;
			for (const lane of Object.values(state.lanes)) lane.seq = 0;
			for (const item of log) {
				state.seq = Math.max(state.seq, item.seq);
				if (item.kind === "fact" && item.fact === "name") state.name = { seq: item.seq, value: item.name ?? null };
				if (item.kind === "fact" && item.fact === "label") state.labels[item.targetId] = { seq: item.seq, value: item.label ?? null };
				if (item.kind === "record") state.records[item.record.id] = item.record as unknown as JsonValue;
			}
			state.legacyValues = legacyValues;
			for (const [lane, pointer] of Object.entries(state.lanes)) {
				const legacy = legacyValues[`pi.lane.config/${lane}`] as unknown as LaneConfiguration | undefined;
				if (!legacy) continue;
				const history = await scanTranscript(tx, pointer.conversationId);
				const agent = await tx.doc(AgentDoc, pointer.conversationId);
				await configure(tx, pointer.conversationId, {
					model: history.some(entry => entry.type === "model_change") ? undefined : legacy.model,
					thinkingLevel: history.some(entry => entry.type === "thinking_level_change") ? undefined : legacy.thinkingLevel,
				});
				// Migration has persisted names, not live ToolRegistration objects.
				agent.tools = legacy.activeToolNames ?? [];
			}
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
