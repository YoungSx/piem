import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { uuidv7, type Models } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, ROOT_CONVERSATION_ID, type Seq, type AgentChange, type Conversation, type ConversationView, type HarnessSettings, type Registry, type Submission, type UserInput } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { App } from "obsidian";
import { DurableVaultStorage } from "./DurableVaultStorage";
import { parseDurableWrites } from "./durableCommit";
import { nativeSessionHeader } from "./nativeSessionData";
import { NATIVE_SESSION_FORMAT } from "./sessionMetadata";
import { normalizeFolderPath } from "../vault/path";

export interface NativeChatOptions {
	models: Models;
	registry: Registry;
	env: ExecutionEnv;
	settings?: HarnessSettings;
	agent?: AgentChange;
}
export interface NativeChatSnapshot {
	view: ConversationView;
	paused: boolean;
	closed: boolean;
	error?: string;
}

/** File ownership and UI attachment only. Pi owns every task and execution state. */
export class NativeChatSession {
	private snapshot: NativeChatSnapshot;
	private readonly listeners = new Set<() => void>();
	private readonly admissions = new Set<AbortController>();
	private unsubscribe: () => void;
	private closing?: Promise<void>;
	private writeRevision = 0;
	private writesInFlight = 0;
	private activation?: Promise<void>;
	private readonly lifetime = new AbortController();

	private constructor(
		private readonly app: App,
		readonly path: string,
		readonly id: string,
		private readonly storage: DurableVaultStorage,
		private harness: Harness,
		private currentConversation: Conversation,
		private currentView: AttachedReplicatedState<ConversationView>,
		private readonly options: NativeChatOptions,
		private active: boolean,
	) {
		this.snapshot = { view: currentView.value, paused: true, closed: false };
		this.unsubscribe = currentView.subscribe(value => this.publish({ view: value }));
	}

	static async create(app: App, path: string, options: NativeChatOptions): Promise<NativeChatSession> {
		path = normalizeFolderPath(path, { allowPluginInternals: true });
		await app.vault.create(path, nativeSessionHeader({ id: uuidv7(), cwd: options.env.cwd, createdAt: Date.now(), storageVersion: 1 }));
		return this.attach(app, path, options, true);
	}

	static open(app: App, path: string, options: NativeChatOptions): Promise<NativeChatSession> {
		return this.attach(app, normalizeFolderPath(path, { allowPluginInternals: true }), options, false);
	}

	private static async attach(app: App, path: string, options: NativeChatOptions, creating: boolean): Promise<NativeChatSession> {
		const storage = await DurableVaultStorage.open(app.vault.adapter, path);
		let harness: Harness | undefined;
		let host: NativeChatSession | undefined;
		try {
			if (storage.format !== NATIVE_SESSION_FORMAT) throw new Error("Expected a native chat file");
			if (storage.needsRecovery) throw new Error("Native chat needs recovery before opening");
			const content = await app.vault.adapter.read(path);
			if (!storage.matchesContent(content)) throw new Error("Native chat changed while opening");
			const header = JSON.parse(content.slice(0, content.indexOf("\n"))) as { id?: unknown };
			if (typeof header.id !== "string" || !header.id) throw new Error("Native chat has no session identity");
			const commit = storage.commit.bind(storage);
			storage.commit = async (writes, callContext) => {
				if (host) { host.writeRevision++; host.writesInFlight++; }
				try { return await commit(writes, callContext); }
				catch (error) {
					// Cancellation before admission is expected. Other rejected writes seal
					// the host immediately; awaiting close here would join this very commit.
					if (!callContext.abortSignal?.aborted) host?.fail(error);
					throw error;
				} finally { if (host) { host.writeRevision++; host.writesInFlight--; } }
			};
			// Harness.open recovers running tasks even before resume. A viewer must
			// recover a private copy, never the other device's authoritative log.
			const engineStorage = creating ? storage : copyStorage(content);
			harness = await Harness.open(engineStorage, { ...options, env: () => options.env }, context);
			const conversation = creating
				? await harness.root(context, { agent: options.agent })
				: await harness.conversation(ROOT_CONVERSATION_ID, context);
			if (!conversation) throw new Error("Native chat has no root conversation");
			const view = await conversation.viewState(context);
			host = new NativeChatSession(app, path, header.id, storage, harness, conversation, view, options, creating);
			return host;
		} catch (error) {
			if (harness) await harness.close(context);
			await storage.close();
			throw error;
		}
	}

	get conversation(): Conversation { return this.currentConversation; }
	get view(): AttachedReplicatedState<ConversationView> { return this.currentView; }

	getSnapshot = (): NativeChatSnapshot => this.snapshot;
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	async submit(content: UserInput): Promise<Submission> {
		this.assertOpen();
		const admission = new AbortController();
		this.admissions.add(admission);
		try {
			await this.checkExternalChange();
			this.assertOpen();
			admission.signal.throwIfAborted();
			await this.activate();
			this.assertOpen();
			admission.signal.throwIfAborted();
			const submission = await this.conversation.submit({ type: "input", content, requestId: uuidv7(), whenBusy: "reject" }, withAbortSignal(admission.signal, context));
			this.publish({ paused: false });
			return submission;
		} finally { this.admissions.delete(admission); }
	}

	async configure(change: AgentChange): Promise<void> {
		this.assertOpen();
		await this.checkExternalChange();
		this.assertOpen();
		await this.activate();
		this.assertOpen();
		await this.conversation.configure(change, context);
	}

	async resume(): Promise<void> {
		this.assertOpen();
		await this.activate();
		this.assertOpen();
		this.harness.resume();
		this.publish({ paused: false });
	}

	async abort(): Promise<void> {
		for (const admission of this.admissions) admission.abort();
		this.assertOpen();
		await this.activate();
		this.assertOpen();
		this.publish({ paused: false });
		await this.conversation.abort(context);
	}

	/** Detect sync drift without ever rebuilding or overwriting the native graph. */
	async checkExternalChange(): Promise<boolean> {
		this.assertOpen();
		try {
			const revision = this.writeRevision;
			if (this.writesInFlight) return false;
			const content = await this.app.vault.adapter.read(this.path);
			// The read may have captured bytes before our own append completed.
			// The next stable check (and every storage commit) still detects drift.
			if (revision !== this.writeRevision || this.writesInFlight) return false;
			if (this.storage.matchesContent(content)) return false;
			this.fail(new Error("Native chat changed on disk; reopen it before continuing"));
			return true;
		} catch (error) { this.fail(error); throw error; }
	}

	close(): Promise<void> {
		if (!this.closing) {
			for (const admission of this.admissions) admission.abort();
			this.lifetime.abort();
			this.unsubscribe();
			this.view.dispose();
			// Seal the current engine now; also join any engine being activated.
			const stopped = this.harness.close(context);
			this.closing = Promise.allSettled([stopped, this.activation]).then(async results => {
				await this.storage.close();
				if (results[0]?.status === "rejected") throw results[0].reason;
			});
			this.publish({ closed: true });
		}
		return this.closing;
	}


	/** Explicit progress takes ownership only if the originally viewed bytes remain current. */
	private activate(): Promise<void> {
		this.assertOpen();
		if (this.active) return Promise.resolve();
		return this.activation ??= (async () => {
			await this.checkExternalChange();
			this.assertOpen();
			const live = await Harness.open(this.storage, { ...this.options, env: () => this.options.env }, withAbortSignal(this.lifetime.signal, context));
			try {
				this.assertOpen();
				const conversation = await live.conversation(ROOT_CONVERSATION_ID, context);
				if (!conversation) throw new Error("Native chat has no root conversation");
				const view = await conversation.viewState(context);
				if (this.snapshot.closed) { view.dispose(); this.assertOpen(); }
				this.unsubscribe();
				this.currentView.dispose();
				await this.harness.close(context);
				this.assertOpen();
				this.harness = live;
				this.currentConversation = conversation;
				this.currentView = view;
				this.unsubscribe = view.subscribe(value => this.publish({ view: value }));
				this.active = true;
				this.publish({ view: view.value });
			} catch (error) { await live.close(context); throw error; }
		})().catch(error => { if (!this.snapshot.closed) this.fail(error); throw error; });
	}

	private fail(error: unknown): void {
		if (!this.snapshot.error) this.snapshot = { ...this.snapshot, error: error instanceof Error ? error.message : String(error) };
		void this.close().catch(closeError => {
			if (!this.snapshot.error) this.publish({ error: String(closeError) });
		});
	}

	private assertOpen(): void {
		if (this.snapshot.closed) throw new Error(this.snapshot.error ?? "Native chat is closed");
	}

	private publish(change: Partial<NativeChatSnapshot>): void {
		this.snapshot = { ...this.snapshot, ...change };
		for (const listener of this.listeners) {
			try { listener(); } catch { /* A UI observer must never break a committed publication. */ }
		}
	}
}

/** Replay only already validated commits; no task snapshots or synthetic view state. */
function copyStorage(content: string): MemoryStorage {
	const copy = new MemoryStorage();
	for (const line of content.split("\n").slice(1)) {
		if (!line) continue;
		const frame = JSON.parse(line) as { seq: Seq; writes: unknown[] };
		copy.prepareCommit(parseDurableWrites(frame.writes), frame.seq).apply();
	}
	return copy;
}
