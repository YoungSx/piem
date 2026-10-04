import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/chord";
import type { Usage } from "@earendil-works/pi-ai";

/** Piem's persisted transcript identity; Pi's numeric storage IDs stay internal. */
interface EntryBase {
	id: string;
	parentId: string | null;
	seq: number;
	timestamp: number;
	customType?: string;
}
export interface MessageEntry extends EntryBase { type: "message"; message: AgentMessage; terminate?: true }
export interface CompactionEntry extends EntryBase {
	type: "compaction";
	summary: string;
	retainedTail: AgentMessage[];
	tokensBefore: number;
	fromHook: boolean;
	details?: JsonValue;
	usage?: Usage;
	firstKeptEntryId?: string;
	retainedMessageOrigins?: (string | null)[];
}
export interface BranchSummaryEntry extends EntryBase {
	type: "branch_summary";
	fromId: string | null;
	summary: string;
	fromHook: boolean;
	details?: JsonValue;
	usage?: Usage;
}
export interface CustomEntry extends EntryBase { type: "custom"; customType: string; data?: JsonValue }
export interface ModelChangeEntry extends EntryBase { type: "model_change"; provider: string; modelId: string }
export interface ThinkingLevelChangeEntry extends EntryBase { type: "thinking_level_change"; thinkingLevel: ThinkingLevel }
export type Entry = MessageEntry | CompactionEntry | BranchSummaryEntry | CustomEntry | ModelChangeEntry | ThinkingLevelChangeEntry;
export type NewEntry<T extends Entry = Entry> = T extends Entry ? Omit<T, "seq" | "timestamp"> : never;
export interface EntryQuery { type?: Entry["type"]; customType?: string; order?: "asc" | "desc" | "oldestFirst" | "newestFirst"; limit?: number; cursor?: number }
export interface BranchScan extends EntryQuery { fromId?: string | null; stopAtId?: string; includeStopAt?: boolean }
export interface SessionMetadata {
	id: string;
	createdAt: number;
	storageVersion: number;
	parentSessionId?: string;
	legacyParentSessionPath?: string;
}
export interface JsonlSessionMetadata extends SessionMetadata { cwd: string; path: string; modifiedAt: number }
export interface SessionCreateOptions { id?: string; parentSessionId?: string }
export interface ForkOptions extends SessionCreateOptions { scope?: "branch" | "all"; branch?: string; entryId?: string; position?: "at" | "before"; targetEntryId?: string; atEntryId?: string; fromEntryId?: string; name?: string; cwd?: string; lane?: string }
export interface CompactResult<T = JsonValue> { summary: string; tokensBefore: number; retainedTail: AgentMessage[]; usage?: Usage; details?: T }
export interface BranchSummaryResult { summary: string; usage?: Usage; details?: JsonValue; readFiles?: string[]; modifiedFiles?: string[] }
export interface EntrySearchHit { sessionId: string; entryId: string; timestamp: number }
export interface LaneConfiguration { model: { provider: string; modelId: string }; thinkingLevel: ThinkingLevel; activeToolNames: string[] }
export interface OperationRecord {
	id: string;
	type: string;
	seq: number;
	lane: string;
	runId: string;
	sourceLeafId?: string | null;
	timestamp?: number;
	intent?: Record<string, unknown>;
	outcome?: string;
	error?: unknown;
}
export type LogItem =
	| { kind: "entry"; seq: number; entry: Entry }
	| { kind: "fact"; seq: number; fact: "name"; name?: string }
	| { kind: "fact"; seq: number; fact: "label"; targetId: string; label?: string }
	| { kind: "lane"; seq: number; lane: string; leafId: string | null }
	| { kind: "record"; seq: number; record: OperationRecord };
