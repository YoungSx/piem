import { BACKGROUND_CONTEXT, type Context, type Session } from "@earendil-works/pi-agent-core";
import {
	StorageBackedSession,
	branchTip,
	branchTipInventoryPrefix,
	laneConfig,
	laneState,
	operationMeta,
	operationResult,
	entryLabel,
	insertEntry,
	setValue,
	type BranchScan,
	type Entry,
	type EntryQuery,
	type NewEntry,
	type Value,
	type ValueList,
	type JsonValue,
	type ThinkingLevel,
	type OperationMeta,
	type SessionMutator,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	MemorySessionRepo,
} from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { LogItem } from "./sessionMerge";

export { BACKGROUND_CONTEXT, type Context, branchTip, branchTipInventoryPrefix, laneConfig, laneState, operationMeta, operationResult, entryLabel };

export function buildContextEntries(pathEntries: readonly Entry[]): Entry[] {
	let compaction: Entry | undefined;
	let compactionIndex = -1;
	for (let index = pathEntries.length - 1; index >= 0; index--) {
		const entry = pathEntries[index];
		if (entry?.type === "compaction") {
			compaction = entry;
			compactionIndex = index;
			break;
		}
	}
	return compaction === undefined ? [...pathEntries] : [compaction, ...pathEntries.slice(compactionIndex + 1)];
}

function isContextMessage(message: AgentMessage): boolean {
	return (
		message.role !== "assistant" ||
		(message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "deferred")
	);
}

export function sessionEntryToContextMessages(entry: Entry): AgentMessage[] {
	switch (entry.type) {
		case "message":
			return isContextMessage(entry.message) ? [entry.message] : [];
		case "compaction":
			return [
				createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
				...entry.retainedTail.filter(isContextMessage),
			];
		case "branch_summary":
			return entry.summary ? [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)] : [];
		case "custom":
		default:
			return [];
	}
}

export async function buildSessionContext(
	pathEntries: readonly Entry[],
	options?: { entryProjectors?: Readonly<Record<string, (entry: Entry, context: Context) => Promise<AgentMessage[] | undefined>>> },
	context: Context = BACKGROUND_CONTEXT,
): Promise<AgentMessage[]> {
	options ??= {};
	const entries = buildContextEntries(pathEntries);
	const messages: AgentMessage[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom") {
			messages.push(...sessionEntryToContextMessages(entry));
			continue;
		}
		const projector = options.entryProjectors?.[entry.customType];
		if (projector !== undefined) {
			messages.push(...((await projector(entry, context)) ?? []));
		}
	}
	return messages;
}

type CompatSession = Session & {
	metadata?: unknown;
	view(lane?: string): {
		getLeafId(): Promise<string | null>;
		findEntriesOnBranch(query?: BranchScan): Promise<Entry[]>;
		findEntries(query?: BranchScan, context?: Context): Promise<Entry[]>;
		findEntryOnBranch(query: { type?: string }): Promise<Entry | undefined>;
		appendMessage(message: AgentMessage): Promise<string>;
	};
	appendEntry(entry: { type: string; [key: string]: unknown }, lane?: string): Promise<{ id: string; parentId: string | null; seq?: number }>;
};

let installed = false;

export function installSessionCompat(): void {
	if (installed) return;
	installed = true;

	// Hook MemorySessionRepo.prototype.openRecord to patch MemorySessionFacade.prototype
	const repoProto = MemorySessionRepo.prototype as unknown as { openRecord?: (record: unknown) => unknown };
	const origOpenRecord = repoProto.openRecord;
	if (typeof origOpenRecord === "function" && !(origOpenRecord as { __patched?: boolean }).__patched) {
		const patchedOpenRecord = function (this: unknown, record: unknown) {
			const facade = origOpenRecord.call(this, record);
			if (facade && typeof facade === "object") {
				applyCompatMethods(Object.getPrototypeOf(facade) as Record<string, unknown>);
			}
			return facade;
		};
		(patchedOpenRecord as { __patched?: boolean }).__patched = true;
		repoProto.openRecord = patchedOpenRecord;
	}

	const proto = StorageBackedSession.prototype as unknown as Record<string, unknown>;

	applyCompatMethods(proto);
}

function applyCompatMethods(proto: Record<string, unknown>): void {
	// Skip if already patched (idempotent — called twice for StorageBackedSession + MemorySessionFacade)
	if (proto.__compatInstalled) return;
	proto.__compatInstalled = true;

	const originalGetEntry = proto.getEntry as (this: CompatSession, id: string, ctx?: Context) => Promise<Entry | undefined>;
	proto.getEntry = function (this: CompatSession, id: string, context: Context = BACKGROUND_CONTEXT) {
		return originalGetEntry.call(this, id, context);
	};

	const originalGetStats = proto.getStats as (this: CompatSession, ctx?: Context) => Promise<unknown>;
	proto.getStats = function (this: CompatSession, context: Context = BACKGROUND_CONTEXT) {
		return originalGetStats.call(this, context);
	};

	const originalGetName = proto.getName as (this: CompatSession, ctx?: Context) => Promise<string | undefined>;
	proto.getName = function (this: CompatSession, context: Context = BACKGROUND_CONTEXT) {
		return originalGetName.call(this, context);
	};

	const originalSetName = proto.setName as (this: CompatSession, name: string | undefined, ctx?: Context) => Promise<void>;
	proto.setName = function (this: CompatSession, name: string | undefined, context: Context = BACKGROUND_CONTEXT) {
		return originalSetName.call(this, name, context);
	};

	const originalGetLabel = proto.getLabel as (this: CompatSession, targetId: string, ctx?: Context) => Promise<string | undefined>;
	proto.getLabel = function (this: CompatSession, targetId: string, context: Context = BACKGROUND_CONTEXT) {
		return originalGetLabel.call(this, targetId, context);
	};

	const originalSetLabel = proto.setLabel as (this: CompatSession, targetId: string, label: string | undefined, ctx?: Context) => Promise<void>;
	proto.setLabel = function (this: CompatSession, targetId: string, label: string | undefined, context: Context = BACKGROUND_CONTEXT) {
		return originalSetLabel.call(this, targetId, label, context);
	};

	const originalFindEntries = proto.findEntries as (this: CompatSession, query?: unknown, ctx?: Context) => Promise<Entry[]>;
	proto.findEntries = function (this: CompatSession, query?: { order?: string; [key: string]: unknown }, context: Context = BACKGROUND_CONTEXT) {
		const normalized = query?.order === "oldestFirst"
			? { ...query, order: "asc" }
			: query?.order === "newestFirst"
				? { ...query, order: "desc" }
				: query;
		return originalFindEntries.call(this, normalized, context);
	};

	const originalFindEntry = proto.findEntry as (this: CompatSession, query?: EntryQuery, ctx?: Context) => Promise<Entry | undefined>;
	proto.findEntry = function (this: CompatSession, query?: EntryQuery, context: Context = BACKGROUND_CONTEXT) {
		return originalFindEntry.call(this, query, context);
	};

	const originalBranch = proto.branch as (this: CompatSession, name: string, ctx?: Context) => Promise<unknown>;
	proto.branch = function (this: CompatSession, name: string, context: Context = BACKGROUND_CONTEXT) {
		return originalBranch.call(this, name, context);
	};

	const originalCreateBranch = proto.createBranch as (this: CompatSession, name: string, at: string | null, ctx?: Context) => Promise<unknown>;
	proto.createBranch = function (this: CompatSession, name: string, at: string | null, context: Context = BACKGROUND_CONTEXT) {
		return originalCreateBranch.call(this, name, at, context);
	};

	const originalGetValue = proto.getValue as (this: CompatSession, address: Value<unknown>, ctx?: Context) => Promise<{ value: unknown } | undefined>;
	proto.getValue = function (this: CompatSession, address: Value<unknown>, context: Context = BACKGROUND_CONTEXT) {
		return originalGetValue.call(this, address, context);
	};

	const originalSetValue = proto.setValue as (this: CompatSession, address: Value<unknown>, next: unknown, ctx?: Context) => Promise<void>;
	proto.setValue = function (this: CompatSession, address: Value<unknown>, next: unknown, context: Context = BACKGROUND_CONTEXT) {
		return originalSetValue.call(this, address, next, context);
	};

	const originalDeleteValue = proto.deleteValue as (this: CompatSession, address: Value<unknown>, ctx?: Context) => Promise<void>;
	proto.deleteValue = function (this: CompatSession, address: Value<unknown>, context: Context = BACKGROUND_CONTEXT) {
		return originalDeleteValue.call(this, address, context);
	};

	const originalScanValues = proto.scanValues as (this: CompatSession, prefix: Value<unknown>, ctx?: Context) => Promise<Array<{ address: { key: string }; seq: number; value: unknown }>>;
	proto.scanValues = function (this: CompatSession, prefix: Value<unknown>, context: Context = BACKGROUND_CONTEXT) {
		return originalScanValues.call(this, prefix, context);
	};

	const originalReadList = proto.readList as (this: CompatSession, address: ValueList<unknown>, options: unknown, ctx?: Context) => Promise<unknown[]>;
	proto.readList = function (this: CompatSession, address: ValueList<unknown>, options: unknown, context: Context = BACKGROUND_CONTEXT) {
		return originalReadList.call(this, address, options, context);
	};

	const originalAppendList = proto.appendList as (this: CompatSession, address: ValueList<unknown>, element: unknown, ctx?: Context) => Promise<void>;
	proto.appendList = function (this: CompatSession, address: ValueList<unknown>, element: unknown, context: Context = BACKGROUND_CONTEXT) {
		return originalAppendList.call(this, address, element, context);
	};

	const originalDeleteList = proto.deleteList as (this: CompatSession, address: ValueList<unknown>, ctx?: Context) => Promise<void>;
	proto.deleteList = function (this: CompatSession, address: ValueList<unknown>, context: Context = BACKGROUND_CONTEXT) {
		return originalDeleteList.call(this, address, context);
	};

	const originalClose = proto.close as (this: CompatSession, ctx?: Context) => Promise<void>;
	proto.close = function (this: CompatSession, context: Context = BACKGROUND_CONTEXT) {
		return originalClose.call(this, context);
	};

	// Backward-compatibility methods
	proto.getMetadata = function (this: CompatSession) {
		return Promise.resolve(this.metadata);
	};

	proto.view = function (this: CompatSession, lane = "main") {
		return {
			getLeafId: async (): Promise<string | null> => {
				const stored = await this.getValue(branchTip(lane), BACKGROUND_CONTEXT);
				return (stored?.value as string | null) ?? null;
			},
			findEntriesOnBranch: async (query?: BranchScan): Promise<Entry[]> => {
				const b = await (this.branch(lane, BACKGROUND_CONTEXT) as Promise<{ findEntries(q?: BranchScan, ctx?: Context): Promise<Entry[]> } | undefined>);
				return b ? await b.findEntries(query, BACKGROUND_CONTEXT) : [];
			},
			findEntries: async (query?: BranchScan, context?: Context): Promise<Entry[]> => {
				const b = await (this.branch(lane, context ?? BACKGROUND_CONTEXT) as Promise<{ findEntries(q?: BranchScan, ctx?: Context): Promise<Entry[]> } | undefined>);
				return b ? await b.findEntries(query, context ?? BACKGROUND_CONTEXT) : [];
			},
			findEntryOnBranch: async (query: { type?: string }): Promise<Entry | undefined> => {
				const b = await (this.branch(lane, BACKGROUND_CONTEXT) as Promise<{ findEntries(q?: BranchScan, ctx?: Context): Promise<Entry[]> } | undefined>);
				if (!b) return undefined;
				const entries = await b.findEntries({ order: "newestFirst" }, BACKGROUND_CONTEXT);
				return entries.find((e: Entry) => !query.type || e.type === query.type);
			},
			appendMessage: async (message: AgentMessage): Promise<string> => {
				let b = await this.branch(lane, BACKGROUND_CONTEXT);
				if (!b) {
					b = await this.createBranch(lane, null, BACKGROUND_CONTEXT);
				}
				return await b.appendMessage(message, BACKGROUND_CONTEXT);
			},
		};
	};

	proto.moveLane = function (this: CompatSession, lane: string, targetId: string | null) {
		return this.setValue(branchTip(lane), targetId, BACKGROUND_CONTEXT);
	};

	proto.createLane = function (this: CompatSession, lane: string, targetId: string | null) {
		return this.setValue(branchTip(lane), targetId, BACKGROUND_CONTEXT);
	};

	proto.getLanes = async function (this: CompatSession) {
		const host = this as unknown as {
			storage?: { storageState?: { scalarValues: Map<string, { address: { namespace: string; key: string }; seq: number; value: unknown }> } };
			session?: { storage?: { storageState?: { scalarValues: Map<string, { address: { namespace: string; key: string }; seq: number; value: unknown }> } } };
		};
		const internalStorage = host.storage ?? host.session?.storage;
		if (internalStorage?.storageState) {
			const lanes: Array<{ lane: string; leafId: string | null }> = [];
			for (const sv of internalStorage.storageState.scalarValues.values()) {
				if (sv.address.namespace === "pi.branch.tip") {
					lanes.push({ lane: sv.address.key, leafId: sv.value as string | null });
				}
			}
			return lanes;
		}
		const tips = await this.scanValues(branchTipInventoryPrefix(), BACKGROUND_CONTEXT);
		return tips.map((t: { address: { key: string }; value: unknown }) => ({ lane: t.address.key, leafId: t.value }));
	};

	proto.findEntriesOnBranch = async function (this: CompatSession, query?: BranchScan) {
		const b = await (this.branch("main", BACKGROUND_CONTEXT) as Promise<{ findEntries(q?: BranchScan, ctx?: Context): Promise<Entry[]> } | undefined>);
		return b ? await b.findEntries(query, BACKGROUND_CONTEXT) : [];
	};

	proto.appendCustomEntry = async function (this: CompatSession, customType: string, data?: unknown, lane = "main") {
		const res = await this.appendEntry({ type: "custom", customType, data }, lane);
		return res.id;
	};

	proto.appendMessage = async function (this: CompatSession, message: unknown, lane = "main") {
		const raw = typeof message === "string" ? { role: "user" as const, content: [{ type: "text" as const, text: message }], timestamp: Date.now() } : (message as AgentMessage);
		const normalized = typeof (raw as { content?: unknown }).content === "string" ? { ...raw, content: [{ type: "text" as const, text: (raw as { content: string }).content }] } : raw;
		return await this.view(lane).appendMessage(normalized);
	};

	proto.getLeafId = async function (this: CompatSession, lane = "main") {
		const stored = await this.getValue(branchTip(lane), BACKGROUND_CONTEXT);
		return (stored?.value as string | null) ?? null;
	};

	proto.appendEntry = async function (this: CompatSession, entry: { type: string; [key: string]: unknown }, lane = "main") {
		const tip = ((await this.getValue(branchTip(lane), BACKGROUND_CONTEXT))?.value as string | null) ?? null;
		const host = this as unknown as { idGenerator?: { next(): string }; session?: { idGenerator?: { next(): string } } };
		const idGen = host.idGenerator ?? host.session?.idGenerator;
		const id = typeof entry.id === "string" ? entry.id : (idGen ? idGen.next() : String(Date.now()));

		if (entry.type === "message") {
			let commitRes: { firstSeq?: number; lastSeq?: number } | undefined;
			await this.mutate(async (mutator: SessionMutator) => {
				commitRes = await mutator.commit([
					insertEntry({
						id,
						parentId: tip,
						type: "message",
						message: entry.message as AgentMessage,
					}),
					setValue(branchTip(lane), id),
				], BACKGROUND_CONTEXT);
			}, BACKGROUND_CONTEXT);
			return { id, parentId: tip, seq: commitRes?.firstSeq };
		}
		if (entry.type === "custom") {
			let commitRes: { firstSeq?: number; lastSeq?: number } | undefined;
			await this.mutate(async (mutator: SessionMutator) => {
				commitRes = await mutator.commit([
					insertEntry({
						id,
						parentId: tip,
						type: "custom",
						customType: String(entry.customType),
						...(entry.data === undefined ? {} : { data: entry.data as JsonValue }),
					}),
					setValue(branchTip(lane), id),
				], BACKGROUND_CONTEXT);
			}, BACKGROUND_CONTEXT);
			return { id, parentId: tip, seq: commitRes?.firstSeq };
		}
		if (entry.type === "compaction") {
			let commitRes: { firstSeq?: number; lastSeq?: number } | undefined;
			await this.mutate(async (mutator: SessionMutator) => {
				commitRes = await mutator.commit([
					insertEntry({
						id,
						parentId: tip,
						type: "compaction",
						summary: String(entry.summary),
						tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : 0,
						retainedTail: Array.isArray(entry.retainedTail) ? (entry.retainedTail as AgentMessage[]) : [],
						fromHook: entry.fromHook === true,
						...(typeof entry.firstKeptEntryId === "string" ? { firstKeptEntryId: entry.firstKeptEntryId } : {}),
						...(Array.isArray(entry.retainedMessageOrigins) ? { retainedMessageOrigins: entry.retainedMessageOrigins as (string | null)[] } : {}),
						...(entry.details === undefined ? {} : { details: entry.details as JsonValue }),
						...(entry.usage === undefined ? {} : { usage: entry.usage as Usage }),
					} as unknown as NewEntry),
					setValue(branchTip(lane), id),
				], BACKGROUND_CONTEXT);
			}, BACKGROUND_CONTEXT);
			return { id, parentId: tip, seq: commitRes?.firstSeq };
		}
		if (entry.type === "branch_summary") {
			let commitRes: { firstSeq?: number; lastSeq?: number } | undefined;
			await this.mutate(async (mutator: SessionMutator) => {
				const writes = [
					insertEntry({
						id,
						parentId: tip,
						type: "branch_summary",
						summary: String(entry.summary),
						fromId: typeof entry.fromId === "string" ? entry.fromId : "",
						fromHook: entry.fromHook === true,
						...(entry.details === undefined ? {} : { details: entry.details as JsonValue }),
						...(entry.usage === undefined ? {} : { usage: entry.usage as Usage }),
					}),
					setValue(branchTip(lane), id),
				];
				commitRes = await mutator.commit(writes, BACKGROUND_CONTEXT);
			}, BACKGROUND_CONTEXT);
			return { id, parentId: tip, seq: commitRes?.firstSeq };
		}
		if (entry.type === "model_change") {
			const cur = (await this.getValue(laneConfig(lane), BACKGROUND_CONTEXT))?.value as { thinkingLevel?: ThinkingLevel; activeToolNames?: string[] } | undefined;
			const curState = await this.getValue(laneState(lane), BACKGROUND_CONTEXT);
			let commitRes: { firstSeq?: number; lastSeq?: number } | undefined;
			await this.mutate(async (mutator: SessionMutator) => {
				const writes = [
					insertEntry({
						id,
						parentId: tip,
						...entry,
					} as unknown as Parameters<typeof insertEntry>[0]),
					setValue(branchTip(lane), id),
					setValue(laneConfig(lane), {
						model: { provider: String(entry.provider), modelId: String(entry.modelId) },
						thinkingLevel: cur?.thinkingLevel ?? "off",
						activeToolNames: cur?.activeToolNames ?? [],
					}),
				];
				if (curState === undefined) {
					writes.push(setValue(laneState(lane), {
						currentOperationId: null,
						lastOperationId: null,
						inbox: [],
					}));
				}
				commitRes = await mutator.commit(writes, BACKGROUND_CONTEXT);
			}, BACKGROUND_CONTEXT);
			return { id, parentId: tip, seq: commitRes?.firstSeq };
		}
		if (entry.type === "thinking_level_change") {
			const cur = (await this.getValue(laneConfig(lane), BACKGROUND_CONTEXT))?.value as { model?: { provider: string; modelId: string }; activeToolNames?: string[] } | undefined;
			const curState = await this.getValue(laneState(lane), BACKGROUND_CONTEXT);
			let commitRes: { firstSeq?: number; lastSeq?: number } | undefined;
			await this.mutate(async (mutator: SessionMutator) => {
				const writes = [
					insertEntry({
						id,
						parentId: tip,
						...entry,
					} as unknown as Parameters<typeof insertEntry>[0]),
					setValue(branchTip(lane), id),
					setValue(laneConfig(lane), {
						model: cur?.model ?? { provider: "", modelId: "" },
						thinkingLevel: (typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : "off") as ThinkingLevel,
						activeToolNames: cur?.activeToolNames ?? [],
					}),
				];
				if (curState === undefined) {
					writes.push(setValue(laneState(lane), {
						currentOperationId: null,
						lastOperationId: null,
						inbox: [],
					}));
				}
				commitRes = await mutator.commit(writes, BACKGROUND_CONTEXT);
			}, BACKGROUND_CONTEXT);
			return { id, parentId: tip, seq: commitRes?.firstSeq };
		}
		let commitRes: { firstSeq?: number; lastSeq?: number } | undefined;
		await this.mutate(async (mutator: SessionMutator) => {
			commitRes = await mutator.commit([
				insertEntry({
					id,
					parentId: tip,
					...entry,
				} as unknown as Parameters<typeof insertEntry>[0]),
				setValue(branchTip(lane), id),
			], BACKGROUND_CONTEXT);
		}, BACKGROUND_CONTEXT);
		return { id, parentId: tip, seq: commitRes?.firstSeq };
	};

	proto.appendRecord = async function (this: CompatSession, record: { type: string; [key: string]: unknown }) {
		const host = this as unknown as { idGenerator?: { next(): string }; session?: { idGenerator?: { next(): string } } };
		const idGen = host.idGenerator ?? host.session?.idGenerator;
		const id = typeof record.id === "string" ? record.id : (idGen ? idGen.next() : String(Date.now()));
		const lane = typeof record.lane === "string" ? record.lane : "main";
		if (record.type === "operation_started") {
			await this.mutate(async (mutator: SessionMutator) => {
				const writes = [
					setValue(operationMeta(id), {
						operationId: id,
						lane,
						sourceTipId: typeof record.sourceLeafId === "string" ? record.sourceLeafId : null,
						startedAt: typeof record.timestamp === "number" ? record.timestamp : Date.now(),
						intent: (record.intent && typeof record.intent === "object" ? record.intent : { kind: "run", promptEntryIds: [] }) as OperationMeta["intent"],
					}),
				];
				const curState = (await this.getValue(laneState(lane), BACKGROUND_CONTEXT))?.value ?? {
					currentOperationId: null,
					lastOperationId: null,
					inbox: [],
				};
				writes.push(setValue(laneState(lane), {
					...curState,
					currentOperationId: id,
				}));
				await mutator.commit(writes, BACKGROUND_CONTEXT);
			}, BACKGROUND_CONTEXT);
			return { id };
		}
		if (record.type === "operation_finished") {
			const runId = typeof record.runId === "string" ? record.runId : id;
			await this.mutate(async (mutator: SessionMutator) => {
				const writes = [
					setValue(operationResult(runId), {
						operationId: runId,
						kind: "run",
						status: record.outcome === "completed" || record.outcome === "failed" || record.outcome === "aborted" || record.outcome === "declined" ? record.outcome : "completed",
						...(record.error ? { error: record.error as { code: string; message: string } } : {}),
						fromTipId: null,
						tipId: null,
						startedAt: Date.now(),
						endedAt: Date.now(),
					}),
				];
				const curState = (await this.getValue(laneState(lane), BACKGROUND_CONTEXT))?.value ?? {
					currentOperationId: null,
					lastOperationId: null,
					inbox: [],
				};
				writes.push(setValue(laneState(lane), {
					...curState,
					currentOperationId: null,
					lastOperationId: runId,
				}));
				await mutator.commit(writes, BACKGROUND_CONTEXT);
			}, BACKGROUND_CONTEXT);
			return { id };
		}
		return { id };
	};

	proto.findOpenOperations = async function (this: CompatSession, lane = "main") {
		const state = (await this.getValue(laneState(lane), BACKGROUND_CONTEXT))?.value as { currentOperationId: string | null } | undefined;
		if (state?.currentOperationId) {
			const meta = (await this.getValue(operationMeta(state.currentOperationId), BACKGROUND_CONTEXT))?.value as { operationId: string; sourceTipId: string | null; startedAt: number; intent: unknown } | undefined;
			if (meta) {
				return [{
					id: meta.operationId,
					lane,
					sourceLeafId: meta.sourceTipId,
					timestamp: meta.startedAt,
					intent: (meta.intent ?? {}) as Record<string, unknown>,
				}];
			}
		}
		return [];
	};

	proto.findRecords = async function (this: CompatSession, query?: { type?: string }) {
		if (!query || query.type === "operation_finished") {
			const results = await this.scanValues(operationResult(""), BACKGROUND_CONTEXT);
			return results.map((r: { value: unknown }) => {
				const v = r.value as { operationId: string; status?: string; error?: unknown };
				return {
					type: "operation_finished",
					id: v.operationId,
					runId: v.operationId,
					lane: "main",
					outcome: v.status,
					...(v.error ? { error: v.error } : {}),
				};
			});
		}
		return [];
	};

	proto.getLog = async function (this: CompatSession, options?: { afterSeq?: number; limit?: number }) {
		const host = this as unknown as {
			storage?: { storageState?: { entriesBySeq: Entry[]; scalarValues: Map<string, { address: { namespace: string; key: string }; seq: number; value: unknown }> } };
			session?: { storage?: { storageState?: { entriesBySeq: Entry[]; scalarValues: Map<string, { address: { namespace: string; key: string }; seq: number; value: unknown }> } } };
		};
		const internalStorage = host.storage ?? host.session?.storage;
		if (internalStorage?.storageState) {
			const state = internalStorage.storageState;
			const items: LogItem[] = state.entriesBySeq.map((e: Entry) => ({ kind: "entry", seq: e.seq, entry: e }));
			for (const sv of state.scalarValues.values()) {
				if (sv.address.namespace === "pi.entry.label") {
					if (typeof sv.value === "string") {
						items.push({ kind: "fact", seq: sv.seq, fact: "label", targetId: sv.address.key, label: sv.value });
					}
				} else if (sv.address.namespace === "pi.branch.tip") {
					if (sv.address.key !== "piem-context") {
						items.push({ kind: "lane", seq: sv.seq, lane: sv.address.key, leafId: sv.value as string | null });
					}
				} else if (sv.address.namespace === "pi.lane.state") {
					items.push({
						kind: "record",
						seq: sv.seq,
						record: {
							seq: sv.seq,
							type: "lane_state",
							lane: sv.address.key,
							state: sv.value,
						},
					});
				}
			}
			items.sort((a, b) => a.seq - b.seq);
			let filtered = items;
			if (options?.afterSeq !== undefined) {
				filtered = filtered.filter((item) => item.seq > options.afterSeq!);
			}
			if (options?.limit !== undefined) {
				filtered = filtered.slice(0, options.limit);
			}
			return filtered;
		}

		const entries = await this.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
		const items: LogItem[] = entries.map((e: Entry) => ({ kind: "entry", seq: e.seq, entry: e }));
		try {
			const labelValues = await this.scanValues(entryLabel(""), BACKGROUND_CONTEXT);
			for (const lv of labelValues) {
				if (typeof lv.value === "string") {
					items.push({ kind: "fact", seq: lv.seq, fact: "label", targetId: lv.address.key, label: lv.value });
				}
			}
		} catch {
			// Scan not available on memory sessions
		}
		try {
			const tips = await this.scanValues(branchTipInventoryPrefix(), BACKGROUND_CONTEXT);
			for (const t of tips) {
				if (t.address.key !== "piem-context") {
					items.push({ kind: "lane", seq: t.seq, lane: t.address.key, leafId: t.value });
				}
			}
		} catch {
			// Scan not available on memory sessions
		}
		try {
			const states = await this.scanValues(laneState(""), BACKGROUND_CONTEXT);
			for (const s of states) {
				items.push({
					kind: "record",
					seq: s.seq,
					record: {
						seq: s.seq,
						type: "lane_state",
						lane: s.address.key,
						state: s.value,
					},
				});
			}
		} catch {
			// Scan not available on memory sessions
		}
		items.sort((a, b) => a.seq - b.seq);
		let filtered = items;
		if (options?.afterSeq !== undefined) {
			filtered = filtered.filter((item) => item.seq > options.afterSeq!);
		}
		if (options?.limit !== undefined) {
			filtered = filtered.slice(0, options.limit);
		}
		return filtered;
	};

	// (JsonlSessionRepo open/delete patch removed)
}
// Auto-install on module import
installSessionCompat();
