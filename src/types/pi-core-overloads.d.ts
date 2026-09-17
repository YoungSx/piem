import type { Context } from "@earendil-works/chord";
import type {
	AgentMessage,
	BranchScan,
	Entry,
	EntryCursor,
	EntryType,
	ExecutionError,
	FileError,
	FileInfo,
	ForkOptions,
	JsonlSessionCreateOptions,
	JsonlSessionListOptions,
	JsonlSessionMetadata,
	JsonValue,
	ListElement,
	ListReadOptions,
	Result,
	SessionCreateOptions,
	SessionMetadata,
	SessionMutation,
	SessionMutationCallback,
	SessionStats,
	ShellExecOptions,
	ShellExecResult,
	StorageBranchScan,
	StoredValue,
	Value,
	ValueList,
} from "@earendil-works/pi-agent-core";

declare module "@earendil-works/pi-agent-core" {
	export type ProvisionedEntry<T extends Entry = Entry> = Omit<T, "seq" | "timestamp" | "parentId">;

	export type LogItem =
		| { kind: "entry"; seq: number; entry: Entry }
		| { kind: "fact"; seq: number; fact: "label"; targetId: string; label?: string }
		| { kind: "lane"; seq: number; lane: string; leafId: string | null }
		| { kind: "record"; seq: number; record: { seq: number; type: string; [key: string]: unknown } };

	export interface LegacyEntryQuery {
		type?: EntryType;
		customType?: string;
		order?: "asc" | "desc" | "oldestFirst" | "newestFirst";
		limit?: number;
		cursor?: EntryCursor;
	}

	interface SessionReader {
		getEntries(ids: string[], context?: Context): Promise<Map<string, Entry>>;
		getStats(context?: Context): Promise<SessionStats>;
		getValue<T>(address: Value<T>, context?: Context): Promise<StoredValue<T> | undefined>;
		scanValues<T>(prefix: Value<T>, context?: Context): Promise<StoredValue<T>[]>;
		readList<T>(address: ValueList<T>, options?: ListReadOptions, context?: Context): Promise<ListElement<T>[]>;
		scanBranch(query: StorageBranchScan, context?: Context): Promise<Entry[]>;
	}

	interface Session<TMetadata extends SessionMetadata = SessionMetadata> extends SessionReader {
		branch(name: string, context?: Context): Promise<Branch | undefined>;
		createBranch(name: string, at: string | null, context?: Context): Promise<Branch>;
		getEntry(id: string, context?: Context): Promise<Entry | undefined>;
		getStats(context?: Context): Promise<SessionStats>;
		getName(context?: Context): Promise<string | undefined>;
		setName(name: string | undefined, context?: Context): Promise<void>;
		getLabel(targetId: string, context?: Context): Promise<string | undefined>;
		setLabel(targetId: string, label: string | undefined, context?: Context): Promise<void>;
		findEntries(query?: LegacyEntryQuery, context?: Context): Promise<Entry[]>;
		findEntry(query?: LegacyEntryQuery, context?: Context): Promise<Entry | undefined>;
		getValue<T>(address: Value<T>, context?: Context): Promise<StoredValue<T> | undefined>;
		setValue<T>(address: Value<T>, next: NoInfer<T>, context?: Context): Promise<void>;
		deleteValue<T>(address: Value<T>, context?: Context): Promise<void>;
		scanValues<T>(prefix: Value<T>, context?: Context): Promise<StoredValue<T>[]>;
		readList<T>(address: ValueList<T>, options?: ListReadOptions, context?: Context): Promise<ListElement<T>[]>;
		appendList<T>(address: ValueList<T>, element: NoInfer<T>, context?: Context): Promise<void>;
		deleteList<T>(address: ValueList<T>, context?: Context): Promise<void>;
		close(context?: Context): Promise<void>;
		beginMutation(context?: Context): Promise<SessionMutation>;
		mutate<T>(mutation: SessionMutationCallback<T>, context?: Context): Promise<T>;

		// Backward-compatibility and extension methods
		getMetadata(): Promise<TMetadata>;
		view(lane?: string): {
			getLeafId(): Promise<string | null>;
			findEntriesOnBranch(query?: BranchScan): Promise<Entry[]>;
			findEntries(query?: BranchScan, context?: Context): Promise<Entry[]>;
			findEntryOnBranch(query: { type?: string }): Promise<Entry | undefined>;
			appendMessage(message: AgentMessage): Promise<string>;
		};
		moveLane(lane: string, targetId: string | null): Promise<void>;
		createLane(lane: string, targetId: string | null): Promise<void>;
		getLanes(context?: Context): Promise<Array<{ lane: string; leafId: string | null }>>;
		findEntriesOnBranch(query?: BranchScan): Promise<Entry[]>;
		appendCustomEntry(customType: string, data?: unknown, lane?: string): Promise<string>;
		appendMessage(message: unknown, lane?: string): Promise<string>;
		getLeafId(lane?: string): Promise<string | null>;
		appendEntry(entry: { type: string; [key: string]: unknown }, lane?: string): Promise<{ id: string; parentId: string | null; seq?: number }>;
		appendRecord(record: { type: string; [key: string]: unknown }): Promise<{ id: string }>;
		findOpenOperations(lane?: string, context?: Context): Promise<Array<{
			id: string;
			lane: string;
			sourceLeafId: string | null;
			timestamp?: number;
			intent: Record<string, unknown>;
		}>>;
		findRecords(query?: { type?: string }): Promise<Array<{
			type: string;
			id: string;
			runId: string;
			lane: string;
			outcome?: string;
			error?: unknown;
		}>>;
		getLog(query?: { afterSeq?: number; limit?: number }): Promise<LogItem[]>;
	}

	interface Branch {
		getTipId(context?: Context): Promise<string | null>;
		findEntries(query?: BranchScan, context?: Context): Promise<Entry[]>;
		findEntry(query?: BranchScan, context?: Context): Promise<Entry | undefined>;
		appendMessage(message: AgentMessage, context?: Context): Promise<string>;
		appendCustomEntry(customType: string, data?: JsonValue, context?: Context): Promise<string>;
		findEntriesOnBranch(query?: BranchScan, context?: Context): Promise<Entry[]>;
		appendEntry(entry: { type: string; [key: string]: unknown }, context?: Context): Promise<unknown>;
		getLeafId(context?: Context): Promise<string | null>;
	}

	interface SessionRepo<
		TMetadata extends SessionMetadata = SessionMetadata,
		TCreateOptions extends { id?: string; parentSessionId?: string } = SessionCreateOptions,
		TListOptions = void,
	> {
		create(options: TCreateOptions, context?: Context): Promise<Session<TMetadata>>;
		open(metadata: TMetadata, context?: Context): Promise<Session<TMetadata>>;
		list(options?: TListOptions, context?: Context): Promise<TMetadata[]>;
		delete(metadata: TMetadata, context?: Context): Promise<void>;
		fork(source: TMetadata, options: ForkOptions, context?: Context): Promise<Session<TMetadata>>;
	}

	interface JsonlSessionRepo {
		create(options: JsonlSessionCreateOptions, context?: Context): Promise<Session<JsonlSessionMetadata>>;
		open(metadata: JsonlSessionMetadata, context?: Context): Promise<Session<JsonlSessionMetadata>>;
		list(options?: JsonlSessionListOptions, context?: Context): Promise<JsonlSessionMetadata[]>;
		delete(metadata: JsonlSessionMetadata, context?: Context): Promise<void>;
		fork(source: JsonlSessionMetadata, options: ForkOptions, context?: Context): Promise<Session<JsonlSessionMetadata>>;
		close(context?: Context): Promise<void>;
	}

	interface MemorySessionRepo {
		create(options: SessionCreateOptions, context?: Context): Promise<Session<SessionMetadata>>;
		open(metadata: SessionMetadata, context?: Context): Promise<Session<SessionMetadata>>;
		list(options?: undefined, context?: Context): Promise<SessionMetadata[]>;
		delete(metadata: SessionMetadata, context?: Context): Promise<void>;
		fork(source: SessionMetadata, options: ForkOptions, context?: Context): Promise<Session<SessionMetadata>>;
		close(context?: Context): Promise<void>;
	}

	interface FileSystem {
		absolutePath(path: string, context?: Context): Promise<Result<string, FileError>>;
		joinPath(parts: string[], context?: Context): Promise<Result<string, FileError>>;
		readTextFile(path: string, context?: Context): Promise<Result<string, FileError>>;
		readTextLines(path: string, options?: { maxLines?: number }, context?: Context): Promise<Result<string[], FileError>>;
		readBinaryFile(path: string, context?: Context): Promise<Result<Uint8Array, FileError>>;
		writeFile(path: string, content: string | Uint8Array, context?: Context): Promise<Result<void, FileError>>;
		appendFile(path: string, content: string | Uint8Array, context?: Context): Promise<Result<void, FileError>>;
		renameFile(sourcePath: string, destinationPath: string, context?: Context): Promise<Result<void, FileError>>;
		fileInfo(path: string, context?: Context): Promise<Result<FileInfo, FileError>>;
		listDir(path: string, context?: Context): Promise<Result<FileInfo[], FileError>>;
		canonicalPath(path: string, context?: Context): Promise<Result<string, FileError>>;
		exists(path: string, context?: Context): Promise<Result<boolean, FileError>>;
		createDir(path: string, options?: unknown, context?: Context): Promise<Result<void, FileError>>;
		remove(path: string, options?: unknown, context?: Context): Promise<Result<void, FileError>>;
		createTempDir(prefix?: string, context?: Context): Promise<Result<string, FileError>>;
		createTempFile(options?: unknown, context?: Context): Promise<Result<string, FileError>>;
		cleanup(context?: Context): Promise<void>;
	}

	interface Shell {
		exec(command: string, options?: ShellExecOptions, context?: Context): Promise<Result<ShellExecResult, ExecutionError>>;
		cleanup(context?: Context): Promise<void>;
	}
}
