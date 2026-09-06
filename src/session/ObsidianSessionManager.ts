import type { App, DataAdapter, Plugin } from "obsidian";
import {
	buildContextEntries,
	buildSessionContext as buildPiSessionContext,
	type BranchSummaryResult,
	JsonlSessionRepo,
	sessionEntryToContextMessages,
	type AgentMessage,
	type CompactResult,
	type Entry,
	type JsonlSessionMetadata,
	type OperationFinishedRecord,
	type OperationStartedRecord,
	type Session,
	type ThinkingLevel,
	createScanningSessionSearch,
	type SessionSearch,
	type SessionSearchOptions,
} from "@earendil-works/pi-agent-core";
import { normalizeFolderPath } from "../vault/path";
import { sanitizeMessageForLog } from "../vault/image";
import { DEFAULT_THINKING_LEVEL } from "../constants";
import { ObsidianSessionFileSystem } from "./ObsidianSessionFileSystem";
import { selectSessionsToEvict, UNLIMITED_SESSION_RETENTION } from "./retention";
import { projectSessionEntryText, type StoredSessionSearchHit } from "./sessionSearch";

export interface SessionDefaults {
	provider: string;
	modelId: string;
	/**
	 * The level a *brand-new* session starts on. The stored sessions keep their
	 * own level from here on — {@link ensureConfiguration} no longer pushes this
	 * value over an existing conversation — so it is a seed, not a setting.
	 */
	thinkingLevel?: ThinkingLevel;
}

export interface ActiveSessionInfo {
	id: string;
	path: string;
	createdAt: string;
	updatedAt: string;
	name?: string;
	messageCount: number;
	/** Opening user message; empty until the session has one. UI owns the fallback copy. */
	firstMessage: string;
	/**
	 * Session this one forked from, straight from the jsonl header. pi fills it
	 * on every fork; nothing else sets it. Absent for ordinary chats.
	 */
	parentSessionId?: string;
}

export interface SessionContext {
	messages: AgentMessage[];
	messageOrigins: (string | null)[];
	model: { provider: string; modelId: string } | null;
	thinkingLevel: ThinkingLevel;
}

export interface SessionPolicy {
	sessionDir(): string;
	retentionLimit(): number;
}

export interface SessionSettings {
	sessionDir: string;
	sessionRetention: number;
}

type PiSession = Session<JsonlSessionMetadata>;

/**
 * One hydrated session: pi's live `Session` over its JSONL file, plus the
 * metadata it was opened from, cached so header reads do not have to await.
 *
 * Hydration is the plugin's only claim on the file. pi's `repo.open` is
 * uncached — a second `Session` over the same path would replay the log into
 * its own memory and then race the first one's writes, silently violating the
 * sequence/id invariants — so exactly one entry per path must ever exist here,
 * and eviction (`selectSessionsToEvict`) treats every key as untrashable.
 */
interface HydratedSession {
	session: PiSession;
	metadata: JsonlSessionMetadata;
}

/** Piem's product-facing wrapper around pi's durable JSONL session repository. */
export class ObsidianSessionManager {
	private readonly fs: ObsidianSessionFileSystem;
	private readonly policy: SessionPolicy;
	private readonly cwd: string;
	/**
	 * Every session the plugin currently holds live, keyed by file path.
	 *
	 * Loading a session hydrates it here; switching focus only moves
	 * {@link activePath} — the previously active session stays hydrated so a
	 * background runtime keeps a valid handle. {@link loadSession} never
	 * re-opens a key of this map, and nothing in it outlives its file: eviction
	 * goes through {@link deleteSession}, which drops the entry with the file.
	 */
	private readonly hydrated = new Map<string, HydratedSession>();
	/**
	 * Paths a long-lived consumer (a session runtime) has claimed with
	 * {@link retainSession}. Claims are the multi-session half of "live": the
	 * focused session is protected by being focused and a claimed one by its
	 * claim, while a merely hydrated one is protected by neither — a chat left
	 * behind by an ordinary single-session switch stays evictable, which is what
	 * today's retention contract has always promised.
	 */
	private readonly claimed = new Set<string>();
	/** Which hydrated session the legacy single-session API surface reads. */
	private activePath: string | null = null;

	constructor(adapter: DataAdapter, location: string | SessionPolicy, cwd: string) {
		this.fs = new ObsidianSessionFileSystem(adapter);
		this.policy = typeof location === "string" ? fixedSessionPolicy(location) : location;
		this.cwd = cwd;
	}

	static forPlugin(app: App, _plugin: Plugin, getSettings: () => SessionSettings): ObsidianSessionManager {
		const policy: SessionPolicy = {
			sessionDir: () => getSettings().sessionDir,
			retentionLimit: () => getSettings().sessionRetention,
		};
		return new ObsidianSessionManager(app.vault.adapter, policy, "piem");
	}

	async createSession(defaults: SessionDefaults): Promise<ActiveSessionInfo> {
		const sessionDir = this.resolveSessionDir();
		const session = await this.repo(sessionDir).create({ cwd: this.cwd });
		const metadata = await session.getMetadata();
		this.hydrated.set(metadata.path, { session, metadata });
		this.activePath = metadata.path;
		await this.appendModelChange(defaults.provider, defaults.modelId);
		await this.appendThinkingLevelChange(defaults.thinkingLevel ?? DEFAULT_THINKING_LEVEL);
		await this.evictSurplusSessions(sessionDir);
		return this.getActiveSessionInfo();
	}

	async continueRecentSession(defaults: SessionDefaults): Promise<ActiveSessionInfo> {
		const sessions = await this.listSessions();
		if (sessions[0]) {
			await this.loadSession(sessions[0].path);
			await this.ensureConfiguration(defaults);
			return this.getActiveSessionInfo();
		}
		return this.createSession(defaults);
	}

	/**
	 * Opens the stored session at `path` and makes it the one the single-session
	 * surface (everything without an explicit path) reads.
	 *
	 * Idempotent per path by contract: when the session is already hydrated its
	 * live instance is reused and only the focus moves. `repo.open` is uncached
	 * and returns a fresh `Session` every call, and two instances over one file
	 * would desync — so re-opening an already-loaded session is forbidden, not
	 * merely wasteful. Nothing is closed on the way in, either: the previously
	 * active session stays hydrated for whichever background runtime holds it.
	 */
	async loadSession(path: string): Promise<ActiveSessionInfo> {
		const target = normalizeFolderPath(path, { allowPluginInternals: true });
		const alreadyLive = this.hydrated.get(target);
		if (alreadyLive) {
			this.activePath = target;
			return this.summarize(alreadyLive.metadata, alreadyLive.session);
		}
		const metadata = await this.findMetadata(target);
		if (!metadata) {
			throw new Error(`Session not found: ${target}`);
		}
		const session = await this.repo(this.resolveSessionDir()).open(metadata);
		const liveMetadata = await session.getMetadata();
		this.hydrated.set(liveMetadata.path, { session, metadata: liveMetadata });
		this.activePath = liveMetadata.path;
		return this.summarize(liveMetadata, session);
	}

	/**
	 * Copies the session at `path` into a brand-new session file whose main lane
	 * ends at `entryId`, leaving the source untouched. The storage-level answer
	 * to the fork button: the reply's entry is the boundary, everything before it
	 * (including the reply itself, `position: "at"`) is carried over, and pi
	 * derives the new file's lineage automatically via `parentSessionId`.
	 *
	 * `entryId` must name a `message` entry — pi's fork mutator rejects anything
	 * else, so callers resolve their anchor to a message rather than passing a
	 * raw leaf id (which may be a compaction or model_change entry).
	 *
	 * The returned `Session` registers in {@link hydrated} directly, exactly like
	 * {@link createSession} does: `repo.fork` returns a live session over the new
	 * file, and re-opening that path through {@link loadSession} would put two
	 * instances over one log. Focus does not move — {@link activePath} stays on
	 * the source, because forking is an offer, not a switch; the caller adopts
	 * the copy explicitly.
	 */
	async forkSession(path: string, entryId: string): Promise<ActiveSessionInfo> {
		const source = this.hydrated.get(path);
		if (!source) {
			throw new Error(`No session loaded: ${path}`);
		}
		const forked = await this.repo(this.resolveSessionDir()).fork(source.metadata, {
			scope: "branch",
			entryId,
			position: "at",
			cwd: this.cwd,
		});
		const metadata = await forked.getMetadata();
		this.hydrated.set(metadata.path, { session: forked, metadata });
		// A fork is as much a new chat as `createSession` is: retention counts it,
		// and the copy has to survive the pass its own creation triggers. Neither
		// thing that spares a session covers it — focus stays on the source by
		// contract, and no runtime has claimed the copy yet — and being newest is
		// not enough: with no slot left for an unclaimed file the cap keeps none of
		// them, the copy included. So it holds a claim for the length of the sweep,
		// which is what `createSession` gets for free by moving focus first.
		this.retainSession(metadata.path);
		try {
			await this.evictSurplusSessions(this.resolveSessionDir());
		} finally {
			this.releaseSession(metadata.path);
		}
		return this.summarize(metadata, forked);
	}

	async deleteSession(path: string): Promise<void> {
		const target = normalizeFolderPath(path, { allowPluginInternals: true });
		const result = await this.fs.remove(target, { force: true });
		if (!result.ok) {
			throw result.error;
		}
		// Dropping the entry is what hands the file back to the disk: the next
		// load of this path opens a fresh instance rather than a session whose
		// underlying log is gone. Only the focus moves when it pointed here —
		// deleting a background session must not blank the one on screen. The
		// claim goes with the file: nothing survives to claim a trashed log.
		this.hydrated.delete(target);
		this.claimed.delete(target);
		if (this.activePath === target) {
			this.activePath = null;
		}
	}

	async listSessions(): Promise<ActiveSessionInfo[]> {
		const metadata = await this.repo(this.resolveSessionDir()).list({ cwd: this.cwd });
		const sessions = await Promise.all(metadata.map((item) => this.readSessionInfo(item)));
		return sessions
			.filter((session): session is SessionFileInfo => session !== null)
			.sort((left, right) => right.modifiedTime - left.modifiedTime)
			.map(({ modifiedTime: _modifiedTime, ...session }) => session);
	}

	createStoredSessionSearch(): SessionSearch<StoredSessionSearchHit> {
		return createScanningSessionSearch((options?: SessionSearchOptions) => this.openStoredSessions(options), {
			// Hands the caller's signal to the source so a superseded query stops
			// before opening the next JSONL file; pi only checks it between sessions.
			sourceOptions: (_text, options) => options,
			pageSize: 64,
			projectText: projectSessionEntryText,
			createHit: (metadata, candidate) => ({
				sessionId: metadata.id, path: metadata.path, entryId: candidate.entryId,
				entryType: candidate.type, timestamp: candidate.timestamp, snippet: candidate.text,
			}),
		});
	}

	getSessionDir(): string {
		return this.resolveSessionDir();
	}

	async countStoredSessions(): Promise<number> {
		return (await this.repo(this.resolveSessionDir()).list({ cwd: this.cwd })).length;
	}

	async countSessionsIn(dir: string): Promise<number> {
		let normalized: string;
		try {
			normalized = normalizeFolderPath(dir, { allowPluginInternals: true });
		} catch {
			return 0;
		}
		return this.countJsonlFiles(normalized);
	}

	async appendMessage(message: AgentMessage, lane = "main"): Promise<string> {
		return this.appendMessageFor(this.requireActivePath(), message, lane);
	}

	async appendMessageFor(path: string, message: AgentMessage, lane = "main"): Promise<string> {
		const persisted = JSON.parse(JSON.stringify(message)) as AgentMessage;
		return this.getSessionFor(path).view(lane).appendMessage(persisted);
	}

	async appendModelChange(provider: string, modelId: string, lane = "main"): Promise<string> {
		return this.appendModelChangeFor(this.requireActivePath(), provider, modelId, lane);
	}

	async appendModelChangeFor(path: string, provider: string, modelId: string, lane = "main"): Promise<string> {
		const session = this.getSessionFor(path);
		return (await session.appendEntry({ type: "model_change", id: session.idGenerator.next(), provider, modelId }, lane)).id;
	}

	async appendThinkingLevelChange(thinkingLevel: ThinkingLevel, lane = "main"): Promise<string> {
		return this.appendThinkingLevelChangeFor(this.requireActivePath(), thinkingLevel, lane);
	}

	async appendThinkingLevelChangeFor(path: string, thinkingLevel: ThinkingLevel, lane = "main"): Promise<string> {
		const session = this.getSessionFor(path);
		return (await session.appendEntry({ type: "thinking_level_change", id: session.idGenerator.next(), thinkingLevel }, lane)).id;
	}

	/**
	 * The thinking level the most recent stored session ended on, for seeding a
	 * brand-new conversation. Read through a throwaway session the same way
	 * {@link readActiveSessionName} does: the live session object is never
	 * touched, so an in-flight append cannot be disturbed. Undefined when no
	 * session exists yet or the newest one predates level entries (pi's context
	 * builder already defaults those to `"off"`, so `undefined` here only means
	 * "nothing to inherit").
	 */
	async readLastSessionThinkingLevel(): Promise<ThinkingLevel | undefined> {
		const sessions = await this.listSessions();
		const newest = sessions[0];
		if (!newest) {
			return undefined;
		}
		const metadata = await this.findMetadata(newest.path);
		if (!metadata) {
			return undefined;
		}
		const previous = await this.repo(this.resolveSessionDir()).open(metadata);
		const entries = await previous.findEntriesOnBranch({ order: "oldestFirst" });
		return buildPiSessionContext(entries).thinkingLevel as ThinkingLevel | undefined;
	}

	async appendCompaction(result: CompactResult, lane = "main"): Promise<string> {
		return this.appendCompactionFor(this.requireActivePath(), result, lane);
	}

	async appendCompactionFor(path: string, result: CompactResult, lane = "main"): Promise<string> {
		const session = this.getSessionFor(path);
		// Agent messages may carry optional fields as explicit `undefined`; pi's
		// durable payload contract rejects those even though JSON.stringify would
		// silently omit them. Normalize to the wire shape before appending.
		const persisted = JSON.parse(JSON.stringify(result)) as CompactResult;
		const entry = {
			type: "compaction" as const,
			id: session.idGenerator.next(),
			summary: persisted.summary,
			tokensBefore: persisted.tokensBefore,
			retainedTail: persisted.retainedTail,
			...(persisted.usage === undefined ? {} : { usage: persisted.usage }),
			...(persisted.details === undefined ? {} : { details: persisted.details }),
		};
		return (await session.appendEntry(entry, lane)).id;
	}

	/**
	 * Persists a summary of the branch a rewind abandoned. Appended with the
	 * current leaf as its parent — which, after {@link rewindTo} has moved the
	 * leaf back to the fork point, is the new main line — so a reload projects
	 * it into context as a memory of the fork rather than leaving it stranded
	 * on the dead branch. `fromId` names the leaf the abandoned branch ended on.
	 */
	async appendBranchSummary(result: BranchSummaryResult, fromId: string, lane = "main"): Promise<string> {
		return this.appendBranchSummaryFor(this.requireActivePath(), result, fromId, lane);
	}

	async appendBranchSummaryFor(path: string, result: BranchSummaryResult, fromId: string, lane = "main"): Promise<string> {
		const session = this.getSessionFor(path);
		const entry = {
			type: "branch_summary" as const,
			id: session.idGenerator.next(),
			fromId,
			summary: result.summary,
			details: { readFiles: result.readFiles, modifiedFiles: result.modifiedFiles },
			...(result.usage === undefined ? {} : { usage: result.usage }),
		};
		return (await session.appendEntry(entry, lane)).id;
	}

	async appendSessionInfo(name: string | undefined): Promise<string> {
		return this.appendSessionInfoFor(this.requireActivePath(), name);
	}

	/** Renames the session at `path`. A rename is a fact in the log, not a path change — the map key stands. */
	async appendSessionInfoFor(path: string, name: string | undefined): Promise<string> {
		const session = this.getSessionFor(path);
		await session.setName(name);
		return (await session.getMetadata()).id;
	}

	/**
	 * Opens a run in pi's operation ledger on `lane`: an `operation_started`
	 * record whose id the matching `operation_finished` must carry back as its
	 * `runId`.
	 *
	 * This is the durability half of crash recovery. A live run is in-memory
	 * agent state; the ledger is the session file's own record that a run was
	 * in flight. A crash between the two writes — the only way a started entry
	 * survives without its finish — is exactly the signature a later load looks
	 * for via {@link findOpenRunOperations}.
	 *
	 * The lane is explicit because pi scopes the refusal to one: a second open
	 * operation on a lane that already has one is rejected, so the entry has to
	 * be filed and found under the same name. Only main is written today — the
	 * A/B comparison that wrote to two at once has retired into session forking —
	 * but a log from that release can still hold entries on another lane, and
	 * hard-coding `"main"` would look right up until it read one.
	 *
	 * `originalPrompt` is the caller's input as the caller shaped it, pi's
	 * "normalized caller input" — deliberately not a claim about transcript
	 * truth, which pi itself persists separately. Message objects may carry
	 * optional fields as explicit `undefined`, which pi's durable payload
	 * contract rejects, so they pass through the same JSON round-trip
	 * {@link appendMessage} applies.
	 *
	 * Throws when no session is active or the ledger write fails; the caller
	 * decides whether a run may start with its ledger entry missing.
	 */
	async beginRunOperation(originalPrompt: AgentMessage[], lane = "main"): Promise<string> {
		return this.beginRunOperationFor(this.requireActivePath(), originalPrompt, lane);
	}

	async beginRunOperationFor(path: string, originalPrompt: AgentMessage[], lane = "main"): Promise<string> {
		const session = this.getSessionFor(path);
		// The ledger stores the prompt, and the prompt can carry image bytes.
		// The same placeholder treatment {@link appendMessage} applies keeps
		// both writers to one rule: no base64 ever reaches the session log.
		const sanitized = originalPrompt.map((message) => sanitizeMessageForLog(message));
		const started = await session.appendRecord({
			type: "operation_started",
			id: session.idGenerator.next(),
			lane,
			sourceLeafId: await session.view(lane).getLeafId(),
			intent: {
				kind: "run",
				originalPrompt: JSON.parse(JSON.stringify(sanitized)) as AgentMessage[],
				initialMessages: [],
			},
		});
		return started.id;
	}

	/**
	 * Closes the ledger entry {@link beginRunOperation} opened. `runId` must be
	 * the started record's id — pi's storage keys the close off it, and a
	 * mismatched id leaves the original entry open forever. `lane` must be the
	 * lane the entry was opened on: pi tracks open operations per lane, so a
	 * close filed against the wrong one leaves the real entry open.
	 */
	async endRunOperation(
		runId: string,
		outcome: OperationFinishedRecord["outcome"],
		error?: { code: string; message: string },
		lane = "main",
	): Promise<void> {
		return this.endRunOperationFor(this.requireActivePath(), runId, outcome, error, lane);
	}

	async endRunOperationFor(
		path: string,
		runId: string,
		outcome: OperationFinishedRecord["outcome"],
		error?: { code: string; message: string },
		lane = "main",
	): Promise<void> {
		const session = this.getSessionFor(path);
		await session.appendRecord({
			type: "operation_finished",
			id: session.idGenerator.next(),
			lane,
			runId,
			outcome,
			...(error ? { error } : {}),
		});
	}

	/**
	 * Reads one lane's unfinished operations, newest first. An empty result is
	 * the steady state — every run opened there has been closed. Entries
	 * surviving into a later load mean a run was cut off mid-flight, and pi's
	 * storage refuses to open a second operation on a lane that already has
	 * one, so recovery must close these before anything new can start there.
	 */
	async findOpenRunOperations(lane = "main"): Promise<OperationStartedRecord[]> {
		return this.findOpenRunOperationsFor(this.requireActivePath(), lane);
	}

	async findOpenRunOperationsFor(path: string, lane = "main"): Promise<OperationStartedRecord[]> {
		return this.getSessionFor(path).findOpenOperations(lane);
	}

	/**
	 * Every lane's unfinished operations, keyed by lane.
	 *
	 * Recovery has to sweep the whole session rather than just the lane on
	 * screen. Every conversation reads and writes main now, but the A/B
	 * comparison that preceded forking left two writable branches, so a log
	 * written then can hold an orphan on a lane nothing opens anymore — and an
	 * unswept orphan is a lane, and eventually a file, that never runs again.
	 */
	async findAllOpenRunOperations(): Promise<Map<string, OperationStartedRecord[]>> {
		return this.findAllOpenRunOperationsFor(this.requireActivePath());
	}

	async findAllOpenRunOperationsFor(path: string): Promise<Map<string, OperationStartedRecord[]>> {
		const session = this.getSessionFor(path);
		const open = new Map<string, OperationStartedRecord[]>();
		for (const { lane } of await session.getLanes()) {
			const orphans = await session.findOpenOperations(lane);
			if (orphans.length > 0) {
				open.set(lane, orphans);
			}
		}
		return open;
	}

	async buildSessionContext(lane = "main"): Promise<SessionContext> {
		return this.buildSessionContextFor(this.requireActivePath(), lane);
	}

	async buildSessionContextFor(path: string, lane = "main"): Promise<SessionContext> {
		const entries = await this.getSessionFor(path).view(lane).findEntriesOnBranch({ order: "oldestFirst" });
		const piContext = buildPiSessionContext(entries);
		const contextEntries = buildContextEntries(entries);
		const messages: AgentMessage[] = [];
		const messageOrigins: (string | null)[] = [];
		contextEntries.forEach((entry, index) => {
			const projected = sessionEntryToContextMessages(entry, index, contextEntries);
			messages.push(...projected);
			messageOrigins.push(...projected.map(() => (entry.type === "message" ? entry.id : null)));
		});
		return {
			messages,
			messageOrigins,
			model: piContext.model,
			thinkingLevel: piContext.thinkingLevel as ThinkingLevel,
		};
	}

	async rewindTo(entryId: string, lane = "main"): Promise<void> {
		const session = this.getSession();
		const entry = await session.getEntry(entryId);
		if (!entry) {
			throw new Error(`Unknown session entry: ${entryId}`);
		}
		await session.moveLane(lane, entry.parentId);
	}

	/** The live pi session currently focused — {@link loadSession} or {@link createSession} put it there. */
	getSession(): PiSession {
		return this.getSessionFor(this.requireActivePath());
	}

	/** The live pi session hydrated for `path`. Throws when it was never loaded (or was deleted). */
	getSessionFor(path: string): PiSession {
		const live = this.hydrated.get(path);
		if (!live) {
			throw new Error(`No session loaded: ${path}`);
		}
		return live.session;
	}

	private requireActivePath(): string {
		if (!this.activePath) {
			throw new Error("No active session.");
		}
		return this.activePath;
	}

	/** Whether `path` has a live instance. Hydration is not focus: a background session is loaded too. */
	isLoaded(path: string): boolean {
		return this.hydrated.has(path);
	}

	/** Every hydrated path, active or not. Any of them may be targeted by path. */
	getLoadedPaths(): string[] {
		return [...this.hydrated.keys()];
	}

	/**
	 * Marks `path` as claimed by a long-lived consumer (a session runtime), so a
	 * later focus switch cannot leave it behind and retention can never trash it.
	 * Idempotent; the path must already be hydrated.
	 */
	retainSession(path: string): void {
		if (!this.hydrated.has(path)) {
			throw new Error(`No session loaded: ${path}`);
		}
		this.claimed.add(path);
	}

	/** Drops a {@link retainSession} claim. Retention may then evict the session as usual. */
	releaseSession(path: string): void {
		this.claimed.delete(path);
	}

	/** What retention must spare: the focused session plus every claimed one. */
	private protectedPaths(): string[] {
		return this.activePath ? [...this.claimed, this.activePath] : [...this.claimed];
	}

	async getLastCompaction(lane = "main"): Promise<CompactResult | undefined> {
		return this.getLastCompactionFor(this.requireActivePath(), lane);
	}

	async getLastCompactionFor(path: string, lane = "main"): Promise<CompactResult | undefined> {
		const entry = await this.getSessionFor(path).view(lane).findEntryOnBranch({ type: "compaction" });
		if (!entry || entry.type !== "compaction") {
			return undefined;
		}
		return {
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			retainedTail: entry.retainedTail,
			usage: entry.usage,
			details: entry.details,
		};
	}

	async getActiveSessionInfo(): Promise<ActiveSessionInfo> {
		const path = this.requireActivePath();
		const live = this.hydrated.get(path)!;
		return this.summarize(live.metadata, live.session);
	}

	getActiveSessionPath(): string | null {
		return this.activePath;
	}

	/**
	 * Reads the active session's display name straight from disk, bypassing the
	 * live session object. pi hydrates `SessionState` once at open and mutates it
	 * only through its own writes, so a name appended by anyone else — a second
	 * Obsidian window on the same vault, a running pi CLI, a hand edit — is
	 * invisible to `getName()` forever. `listSessions()` already re-reads disk
	 * per entry via `repo.open()`, which is why the picker can be externally
	 * correct while the active header is not; this gives that same freshness to
	 * just the active name without the list's cost.
	 *
	 * The throwaway session is deliberately discarded and the hydrated registry is
	 * never touched: swapping the live storage object out from under an in-flight
	 * append or stream would be destructive, and `loadSession()` on the same path
	 * is a session switch, not a refresh. One consequence is inherited from
	 * `listSessions()`, which already opens throwaways concurrently with the live
	 * session's appends: pi's loader may repair a torn tail it finds, a benign
	 * self-healing write. Deliberately no `ensureConfiguration` here — it derives
	 * model/thinking level from the branch and would append junk entries.
	 *
	 * Returns undefined both for "no active session" and "name cleared or absent";
	 * callers compare against the cached name, and `summarize` collapses
	 * whitespace-only names to undefined, so an external rename to `"  "` reads
	 * as cleared exactly like a local one does.
	 */
	async readActiveSessionName(): Promise<string | undefined> {
		const path = this.activePath;
		if (!path) {
			return undefined;
		}
		const fresh = await this.repo(this.resolveSessionDir()).open(this.hydrated.get(path)!.metadata);
		return (await fresh.getName())?.trim() || undefined;
	}

	async ensureConfiguration(defaults: SessionDefaults, lane = "main"): Promise<void> {
		return this.ensureConfigurationFor(this.requireActivePath(), defaults, lane);
	}

	async ensureConfigurationFor(path: string, defaults: SessionDefaults, lane = "main"): Promise<void> {
		// Model only. The thinking level used to be re-asserted here from global
		// settings, which made the session's own recorded level decorative; the
		// level now belongs to the conversation, so the session file wins and
		// this sync must not overwrite it.
		const context = await this.buildSessionContextFor(path, lane);
		if (context.model?.provider !== defaults.provider || context.model.modelId !== defaults.modelId) {
			await this.appendModelChangeFor(path, defaults.provider, defaults.modelId, lane);
		}
	}

	/**
	 * Opens each stored chat in turn, newest first, for the scanning search.
	 *
	 * A generator rather than a list of opened sessions: `repo.open` reads and
	 * parses a whole JSONL file, so materializing them all would pay for every
	 * chat in the vault before the first hit is yielded. pi stops pulling once its
	 * limit is met, which is what keeps the common query cheap.
	 *
	 * The signal is re-checked here because pi only tests it between sessions and
	 * candidates, and `repo.open` cannot be interrupted once it has begun — the
	 * boundary before the next file is the last place a superseded keystroke can
	 * still save the work.
	 */
	private async *openStoredSessions(options?: SessionSearchOptions): AsyncIterable<PiSession> {
		const repo = this.repo(this.resolveSessionDir());
		for (const metadata of await repo.list({ cwd: this.cwd })) {
			if (options?.signal?.aborted) {
				return;
			}
			try {
				yield await repo.open(metadata);
			} catch {
				// A corrupt log must not make every healthy chat unsearchable.
			}
		}
	}

	private repo(sessionDir: string): JsonlSessionRepo {
		return new JsonlSessionRepo({ fs: this.fs, sessionsRoot: sessionDir });
	}

	private resolveSessionDir(): string {
		return normalizeFolderPath(this.policy.sessionDir(), { allowPluginInternals: true });
	}

	private async findMetadata(path: string): Promise<JsonlSessionMetadata | undefined> {
		const metadata = await this.repo(this.resolveSessionDir()).list();
		return metadata.find((item) => item.path === path);
	}

	private async countJsonlFiles(path: string): Promise<number> {
		const listing = await this.fs.listDir(path);
		if (!listing.ok) {
			return 0;
		}
		let count = 0;
		for (const entry of listing.value) {
			if (entry.kind === "file" && entry.name.endsWith(".jsonl")) {
				count += 1;
			} else if (entry.kind === "directory") {
				count += await this.countJsonlFiles(entry.path);
			}
		}
		return count;
	}

	private async evictSurplusSessions(sessionDir: string): Promise<void> {
		const limit = this.policy.retentionLimit();
		if (limit <= UNLIMITED_SESSION_RETENTION) {
			return;
		}
		const metadata = await this.repo(sessionDir).list({ cwd: this.cwd });
		const sessions = await Promise.all(metadata.map((item) => this.readSessionInfo(item)));
		// The protected set is focus + claims, not the whole hydration map: a
		// claimed session is one a runtime may append to at any moment, and
		// trashing it would strand that runtime's writes against a gone file. A
		// merely hydrated session — the one an ordinary single-session switch
		// left behind — is exactly what retention has always been allowed to
		// evict, and must stay that way.
		for (const session of selectSessionsToEvict({
			sessions: sessions.filter((item): item is SessionFileInfo => item !== null),
			limit,
			protectedPaths: this.protectedPaths(),
		})) {
			try {
				await this.deleteSession(session.path);
			} catch {
				// Retention is best-effort; never block the newly created chat.
			}
		}
	}

	private async readSessionInfo(metadata: JsonlSessionMetadata): Promise<SessionFileInfo | null> {
		try {
			const session = await this.repo(this.resolveSessionDir()).open(metadata);
			return this.summarize(metadata, session);
		} catch {
			return null;
		}
	}

	private async summarize(metadata: JsonlSessionMetadata, session: PiSession): Promise<SessionFileInfo> {
		const entries = await session.findEntries({ order: "oldestFirst" });
		const stats = await session.getStats();
		const name = await session.getName();
		const info = await this.fs.fileInfo(metadata.path);
		const modifiedTime = info.ok ? info.value.mtimeMs : metadata.modifiedAt;
		const entryTime = entries.reduce((latest, entry) => {
			const messageTime = entry.type === "message" && typeof entry.message.timestamp === "number" ? entry.message.timestamp : 0;
			return Math.max(latest, entry.timestamp, messageTime);
		}, 0);
		const effectiveModifiedTime = Math.max(modifiedTime, entryTime);
		const firstMessage = entries.find(
			(entry): entry is Extract<Entry, { type: "message" }> => entry.type === "message" && entry.message.role === "user",
		);
		return {
			id: metadata.id,
			path: metadata.path,
			createdAt: new Date(metadata.createdAt).toISOString(),
			updatedAt: new Date(effectiveModifiedTime).toISOString(),
			name: name?.trim() || undefined,
			messageCount: stats.messageCount,
			// Empty string, not a placeholder: sessionTitle's fallback to
			// session.untitled only triggers on emptiness.
			firstMessage: firstMessage ? extractMessageText(firstMessage.message) : "",
			parentSessionId: metadata.parentSessionId,
			modifiedTime: effectiveModifiedTime,
		};
	}
}

interface SessionFileInfo extends ActiveSessionInfo {
	modifiedTime: number;
}

function fixedSessionPolicy(sessionDir: string): SessionPolicy {
	return { sessionDir: () => sessionDir, retentionLimit: () => UNLIMITED_SESSION_RETENTION };
}

export function getPluginSessionDir(app: App, plugin: Plugin): string {
	const pluginDir = plugin.manifest.dir ?? `${app.vault.configDir}/plugins/${plugin.manifest.id}`;
	return `${pluginDir}/sessions`;
}

function extractMessageText(message: AgentMessage): string {
	if (!("content" in message)) {
		return "";
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	return message.content
		.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}
