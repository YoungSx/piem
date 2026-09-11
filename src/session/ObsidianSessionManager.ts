import type { App, DataAdapter, Plugin } from "obsidian";
import {
	buildContextEntries,
	buildSessionContext as buildPiSessionContext,
	type BranchSummaryResult,
	type FileError,
	InMemorySessionStorage,
	JsonlSessionRepo,
	type Result,
	sessionEntryToContextMessages,
	type AgentMessage,
	type CompactResult,
	type Entry,
	type JsonlSessionMetadata,
	type JsonlV4Header,
	type OperationFinishedRecord,
	type OperationStartedRecord,
	Session,
	type ThinkingLevel,
	createScanningSessionSearch,
	type SessionSearch,
	type SessionSearchOptions,
} from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-ai";
// Deep imports past pi's package `exports` map, same precedent as
// `sessionMutationLine.ts`: the JSONL codec is not re-exported at the package
// root, and the header writer below needs pi's own encoder to guarantee a
// header pi's loader will validate.
import { encodeHeader } from "../../node_modules/@earendil-works/pi-agent-core/dist/harness/session/jsonl/codec.js";
import type { LoggerLike } from "../logging/Logger";
import { normalizeFolderPath } from "../vault/path";
import { sanitizeMessageForLog } from "../vault/image";
import { DEFAULT_THINKING_LEVEL } from "../constants";
import { ObsidianSessionFileSystem } from "./ObsidianSessionFileSystem";
import { selectSessionsToEvict, UNLIMITED_SESSION_RETENTION } from "./retention";
import { mergeSessions, serializeLogLines } from "./sessionMerge";
import { collapseSkillInvocation, parseSkillInvocation } from "../agent/skillInvocation";
import { projectSessionEntryText, type StoredSessionSearchHit } from "./sessionSearch";
import { readSessionMetadata } from "./sessionMetadata";

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

/**
 * Where the panel's "which session to reopen" record lives, per device.
 *
 * A sync plugin copies whole session files — and, for anything vault-resident,
 * any record stored beside them — across devices last-writer-wins, so a record
 * that lives in the vault cannot answer "what was *this* device looking at?"
 * Implementations must therefore keep the record off the vault entirely (the
 * plugin uses `localStorage`, which is exactly that). Storage failures are the
 * implementation's to swallow: the fallback is the pre-record behavior, open
 * the newest session, and startup must never die for a convenience.
 */
export interface LastOpenedSessionStore {
	/** The recorded session path, or null when there is none. */
	read(): string | null;
	/** Records `path` as the session this device last focused. */
	write(path: string): void;
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
	 * This device's last-focused session, when a store was provided. Null-shaped
	 * without one: every read and write goes through the optional chain, so the
	 * record is simply absent rather than wrong when storage is unavailable.
	 */
	private readonly lastOpened: LastOpenedSessionStore | null;
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
	/** Only in-flight opens: simultaneous callers must share one Pi mutation queue. */
	private readonly loading = new Map<string, Promise<HydratedSession>>();
	/**
	 * Paths a long-lived consumer (a session runtime) has claimed with
	 * {@link retainSession}. Claims are the multi-session half of "live": the
	 * focused session is protected by being focused and a claimed one by its
	 * claim, while a merely hydrated one is protected by neither — a chat left
	 * behind by an ordinary single-session switch stays evictable, which is what
	 * today's retention contract has always promised.
	 */
	private readonly claimed = new Set<string>();
	private readonly transientClaims = new Map<string, number>();
	/**
	 * Paths whose live `Session` still runs on the in-memory storage
	 * {@link createBlankSession} built: the blank sheet, reserved but not yet
	 * written. Materialization and deletion both drop the path from here the
	 * moment its answer changes, so membership is the one honest test for
	 * "no file behind this path yet" — pi keeps the session's storage private,
	 * and metadata cannot tell the two storages apart.
	 */
	private readonly blankPaths = new Set<string>();
	/** Which hydrated session the legacy single-session API surface reads. */
	private activePath: string | null = null;
	/**
	 * Told, best effort, when a session file has been removed. Manual deletes and
	 * retention eviction both funnel through {@link deleteSession}, so this is
	 * the one announcement side state living beside the session log — composer
	 * drafts — can learn its chat is gone from. Fire and forget from here: the
	 * listener owns its errors, and the manager holds no logger to report them.
	 */
	onSessionDeleted: ((sessionId: string) => void) | null = null;

	constructor(adapter: DataAdapter, location: string | SessionPolicy, cwd: string, log?: LoggerLike, lastOpened?: LastOpenedSessionStore) {
		this.fs = new ObsidianSessionFileSystem(adapter, undefined, log ? (event) => {
			// The repair net's verdicts are the sync story the panel cannot show:
			// either one means another device's file version was on disk under
			// our append. A drop is the failure class — the line never landed —
			// (warn) while a repair is the recovery working as designed (info).
			log[event.action === "dropped" ? "warn" : "info"](`session append ${event.action}: ${event.path}`, () => ({
				kind: event.kind,
				seq: event.seq ?? 0,
			}));
		} : undefined);
		this.policy = typeof location === "string" ? fixedSessionPolicy(location) : location;
		this.cwd = cwd;
		this.lastOpened = lastOpened ?? null;
	}

	static forPlugin(app: App, _plugin: Plugin, getSettings: () => SessionSettings, log?: LoggerLike): ObsidianSessionManager {
		const policy: SessionPolicy = {
			sessionDir: () => getSettings().sessionDir,
			retentionLimit: () => getSettings().sessionRetention,
		};
		// `appId` is real at runtime on every current build but absent from the
		// public `App` type, so it is probed off the instance rather than typed.
		const appId = (app as App & { appId?: unknown }).appId;
		const vaultKey = typeof appId === "string" && appId ? appId : undefined;
		return new ObsidianSessionManager(app.vault.adapter, policy, "piem", log, localStorageLastOpenedSessionStore(vaultKey));
	}

	/**
	 * Creates a session with a durable file behind it: the blank sheet plus its
	 * materialization in one step.
	 *
	 * The panel never calls this — {@link createBlankSession} is its path, so a
	 * session a user merely looked at never touches the disk. This is the shape
	 * callers that *demand* persistence keep: startup-ready tests, and any future
	 * consumer whose session exists to be read by something other than the user
	 * typing into it.
	 */
	async createSession(defaults: SessionDefaults): Promise<ActiveSessionInfo> {
		const info = await this.createBlankSession(defaults);
		const materialized = await this.materializeSession(info.path, defaults);
		// Materialized on the spot means focused on the spot: this caller's
		// session is durable, so it earns the record the blank sheet
		// deliberately withholds — otherwise a restart would not return to it.
		this.lastOpened?.write(materialized.path);
		return materialized;
	}

	/**
	 * The blank sheet a "new chat" click opens: a session that lives in memory
	 * only, behind a path reserved for the file it will become.
	 *
	 * Nothing is written — no header, no model or thinking facts, no
	 * last-opened record — so an untouched sheet is invisible everywhere the
	 * product looks for sessions: the history list reads the disk, retention
	 * reads the disk, and a restart finds no file and no record. The first real
	 * message is what makes the session durable, in {@link materializeSession}.
	 *
	 * The reserved path is the whole trick. Every consumer of a live session
	 * keys on its path — runtimes, claims, tools, the extension bridge — and
	 * pi's in-memory storage has none, so the sheet reserves the exact filename
	 * pi's `create` will mint for the same id: `sessionFileName(createdAt, id)`
	 * is deterministic in both. Moving from memory to file then keeps every key
	 * and the session id stable; only the storage under the `Session` is
	 * swapped, in {@link materializeSession}.
	 *
	 * The seed configuration lands in the sheet's memory as real entries — the
	 * same facts a durable file's first lines would carry — so every consumer
	 * reading the session through its context (extension bridges, `buildSessionContextFor`)
	 * sees the same shape on a sheet as on a stored chat. `materializeSession`
	 * replays them, moving the facts to the file exactly once.
	 */
	async createBlankSession(defaults: SessionDefaults): Promise<ActiveSessionInfo> {
		const id = uuidv7();
		const createdAt = Date.now();
		// pi nests sessions under a cwd-encoded directory (`--<cwd>--`): the
		// reserved path must include it or materialization lands one level up.
		const sessionDir = `${this.resolveSessionDir()}/${reservedSessionDirectoryName(this.cwd)}`;
		const path = `${sessionDir}/${reservedSessionFileName(createdAt, id)}`;
		const metadata: JsonlSessionMetadata = {
			id, createdAt, cwd: this.cwd, path, modifiedAt: createdAt, sourceFormat: 4,
		};
		// The sheet's Session runs on the in-memory storage, whose metadata has
		// no path of its own — the reserved path above is the only path it will
		// ever have. `Session` is generic over storage metadata, and piem's
		// registry speaks `JsonlSessionMetadata`; the sheet's hand-built entry
		// carries that shape, so the session is cast to match the registry it
		// lives in. Every read goes through the registry entry, never the
		// session-borne metadata, so the widened metadata inside pi is harmless.
		const session = new Session(new InMemorySessionStorage({ id, createdAt })) as unknown as PiSession;
		this.hydrated.set(path, { session, metadata });
		this.blankPaths.add(path);
		this.activePath = path;
		await this.appendModelChangeFor(path, defaults.provider, defaults.modelId);
		await this.appendThinkingLevelChangeFor(path, defaults.thinkingLevel ?? DEFAULT_THINKING_LEVEL);
		return this.summarize(metadata, session);
	}

	/**
	 * Whether `path` names a blank sheet: one {@link createBlankSession}
	 * opened and nothing has written to the disk for it yet. A path that was
	 * materialized, loaded from disk, or never known is not blank.
	 */
	isBlankSession(path: string): boolean {
		return this.blankPaths.has(path);
	}

	/**
	 * Materializes the blank sheet at `path` if it is still blank; a path that
	 * already has its file (loaded, materialized, or never known) is left alone
	 * and answers with the summary unchanged.
	 *
	 * Callers bring the configuration the *first run* speaks, not the seed the
	 * sheet was opened with: between the click and the first message the user
	 * may have picked another model or level, and the sheet kept those as
	 * memory only. This is where they become facts a restart can read.
	 */
	async materializeIfBlank(path: string, defaults: SessionDefaults): Promise<ActiveSessionInfo> {
		if (!this.isBlankSession(path)) {
			return this.summarize(this.requireHydrated(path).metadata, this.requireHydrated(path).session);
		}
		return this.materializeSession(path, defaults);
	}

	/**
	 * Turns the blank sheet at `path` into the durable session it reserved the
	 * name of: creates the file under the same id at the reserved path, replays
	 * what accumulated in memory, and swaps the live `Session` over to it.
	 *
	 * The replay rides pi's own storage APIs rather than raw lines: `setName`
	 * restores the fact, `appendRecord` re-arms the run ledger if a record had
	 * landed, and `appendEntry` carries every entry with its id and parent —
	 * so a name given before the first message, or any other write the sheet
	 * accepted, survives as though it had been written to the file all along.
	 * pi's serialized queues guarantee no write is in flight once the caller's
	 * checkpoint is reached, so the log read here is the whole log.
	 */
	private async materializeSession(path: string, defaults: SessionDefaults): Promise<ActiveSessionInfo> {
		const blank = this.requireHydrated(path);
		const sessionDir = this.resolveSessionDir();
		// `repo.create` mints its own `createdAt`, which would part the real
		// filename from the reserved one — so the header is written here, at
		// the reserved path, and `repo.open` re-loads it as the durable session
		// (deep-imported `encodeHeader` is pi's own encoder; the header shape is
		// the v4 one pi validates on load).
		const header: JsonlV4Header = {
			kind: "header",
			version: 4,
			id: blank.metadata.id,
			createdAt: blank.metadata.createdAt,
			cwd: this.cwd,
		};
		fileResultOrThrow(await this.fs.writeFile(path, encodeHeader(header)), `Failed to initialize session ${path}`);
		const session = await this.repo(sessionDir).open({ ...blank.metadata, sourceFormat: 4 });
		const metadata = await session.getMetadata();
		const items = await blank.session.getLog();
		const lanes = await blank.session.getLanes();
		const name = await blank.session.getName();
		if (name) {
			await session.setName(name);
		}
		for (const item of items) {
			if (item.kind === "record") {
				const { seq: _seq, timestamp: _timestamp, ...restored } = item.record;
				await session.appendRecord(restored);
			} else if (item.kind === "entry") {
				const { seq: _s, timestamp: _t, parentId: _p, ...restored } = item.entry;
				await session.appendEntry(restored, "main");
			}
			// "lane" pointers are replayed below from `getLanes`, which carries
			// the branch heads the entries' own appends lost; "fact" items other
			// than the name (labels) ride `setLabel` the same way if ever set.
		}
		for (const lane of lanes) {
			if (lane.lane !== "main") {
				await session.createLane(lane.lane, lane.leafId);
			} else if (lane.leafId !== null) {
				await session.moveLane("main", lane.leafId);
			}
		}
		// The swap must precede any further appends: they go through
		// `getSessionFor`, which reads this registry — writing them while the
		// blank sheet still occupies the entry would leave them in memory,
		// discarded with the sheet.
		this.hydrated.set(path, { session, metadata });
		this.blankPaths.delete(path);
		// `materializeIfBlank`'s contract: callers bring the configuration the
		// *first run* speaks, which may part from the seed the sheet opened with
		// (the user picked another model between the click and the message). The
		// replay already carried the seed facts; only a real difference earns a
		// change entry, so the file's facts stay deduplicated the way
		// `ensureConfigurationFor` keeps them.
		const replayed = await this.buildSessionContextFor(path);
		if (replayed.model?.provider !== defaults.provider || replayed.model?.modelId !== defaults.modelId) {
			await this.appendModelChangeFor(path, defaults.provider, defaults.modelId);
		}
		const level = defaults.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
		if ((replayed.thinkingLevel ?? DEFAULT_THINKING_LEVEL) !== level) {
			await this.appendThinkingLevelChangeFor(path, level);
		}
		await this.evictSurplusSessions(sessionDir);
		return this.summarize(metadata, session);
	}

	private requireHydrated(path: string): HydratedSession {
		const live = this.hydrated.get(path);
		if (!live) {
			throw new Error(`No session loaded: ${path}`);
		}
		return live;
	}

	async continueRecentSession(defaults: SessionDefaults): Promise<ActiveSessionInfo> {
		// The record outranks recency: with a vault sync plugin arbitrating whole
		// files last-writer-wins, "newest file" is whichever device wrote last, so
		// opening it would have this panel resuming a conversation another device
		// ended — the cross-device bleed the record exists to prevent. The record
		// lives off-vault (localStorage), so it stays per-device by construction.
		// The read is inside the try for the same reason as everything below: a
		// broken store must degrade to the record-less behavior, not kill startup.
		try {
			const recorded = this.lastOpened?.read();
			if (recorded) {
				return await this.loadSession(recorded);
			}
		} catch {
			// Gone (deleted here, or never existed on this device), unreadable, or
			// the store itself failed: fall through to the pre-record behavior. No
			// write-back — the stale record is corrected when a session is focused.
		}
		const sessions = await this.listSessions();
		if (sessions[0]) {
			// Deliberately no `ensureConfiguration` here. Opening must stay a pure
			// read: a vault sync plugin arbitrates whole files last-writer-wins, and
			// an append fired at open time marks the local file newer, so the stale
			// copy can win and bury the other device's newer chat. The model is
			// asserted where the user actually acts — at run start, in
			// `beginRunOperation` — not at open time.
			await this.loadSession(sessions[0].path);
			return this.getActiveSessionInfo();
		}
		// An empty vault opens the blank sheet, not a durable session: the first
		// conversation this device ever has should not be forced onto the disk
		// before its first word, same as any other new chat.
		return this.createBlankSession(defaults);
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
		const info = await this.prepareSession(path);
		this.focusSession(info.path);
		return info;
	}

	/** Commits a prepared conversation's focus without another asynchronous read. */
	focusSession(path: string): void {
		const target = normalizeFolderPath(path, { allowPluginInternals: true });
		if (!this.hydrated.has(target)) throw new Error(`No session loaded: ${target}`);
		this.activePath = target;
		this.lastOpened?.write(target);
	}

	/**
	 * Prepares a stored conversation while the previous one remains focused.
	 * The service can build its runtime before committing the visible switch
	 * through `focusSession`; overlapping prepares share the same native Session.
	 */
	async prepareSession(path: string): Promise<ActiveSessionInfo> {
		const target = normalizeFolderPath(path, { allowPluginInternals: true });
		let live = this.hydrated.get(target);
		if (!live) {
			let pending = this.loading.get(target);
			if (!pending) {
				pending = this.hydrateSession(target);
				this.loading.set(target, pending);
			}
			try {
				live = await pending;
			} finally {
				if (this.loading.get(target) === pending) this.loading.delete(target);
			}
		}
		return this.summarize(live.metadata, live.session);
	}

	private async hydrateSession(path: string): Promise<HydratedSession> {
		const metadata = await this.findMetadata(path);
		if (!metadata) {
			throw new Error(`Session not found: ${path}`);
		}
		const session = await this.repo(this.resolveSessionDir()).open(metadata);
		const liveMetadata = await session.getMetadata();
		const live = { session, metadata: liveMetadata };
		this.hydrated.set(liveMetadata.path, live);
		return live;
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

	/** A short operation claim. Independent of the active run's set-based ownership. */
	claimOperation(path: string): () => void {
		this.getSessionFor(path);
		this.transientClaims.set(path, (this.transientClaims.get(path) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const count = (this.transientClaims.get(path) ?? 1) - 1;
			if (count > 0) this.transientClaims.set(path, count);
			else this.transientClaims.delete(path);
		};
	}

	async deleteSession(path: string): Promise<void> {
		const target = normalizeFolderPath(path, { allowPluginInternals: true });
		if (this.transientClaims.has(target)) throw new Error("The conversation still has an active operation.");
		// A blank sheet never had its file, so there is nothing on the disk to
		// trash — skipping the remove keeps a no-op from masquerading as a
		// success that tells the caller the file was moved somewhere findable.
		if (!this.blankPaths.has(target)) {
			const result = await this.fs.remove(target, { force: true });
			if (!result.ok) {
				throw result.error;
			}
		}
		// Dropping the entry is what hands the file back to the disk: the next
		// load of this path opens a fresh instance rather than a session whose
		// underlying log is gone. Only the focus moves when it pointed here —
		// deleting a background session must not blank the one on screen. The
		// claim goes with the file: nothing survives to claim a trashed log.
		this.hydrated.delete(target);
		this.claimed.delete(target);
		this.transientClaims.delete(target);
		this.blankPaths.delete(target);
		if (this.activePath === target) {
			this.activePath = null;
		}
		// Announced after the file is truly gone: a listener racing the removal
		// would recreate state the caller just asked to bury. Best effort — the
		// delete itself already succeeded and must not inherit a listener's throw.
		const sessionId = sessionIdFromSessionPath(target);
		if (sessionId) {
			this.onSessionDeleted?.(sessionId);
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
		const paths = [...this.claimed, ...this.transientClaims.keys()];
		return this.activePath ? [...paths, this.activePath] : paths;
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

	/**
	 * Reconciles a session whose file moved under it — the vault sync plugin
	 * landed another device's version of the log — with the live in-memory view.
	 *
	 * Both sides are read as lines ({@link serializeLogLines} flattens the live
	 * log; the disk holds the foreign version) and union-merged by
	 * {@link mergeSessions}. The merged output is published with pi's own
	 * torn-tail ritual — staged as `<path>.tmp`, then renamed over the target —
	 * and the live `Session` is replaced by a fresh instance opened over the
	 * merged file: pi's storage holds its state in memory and has no live
	 * reload, so the merge is invisible until the instance is swapped.
	 *
	 * Outcomes:
	 * - `skipped` — the disk read failed (best-effort: the repair net keeps the
	 *   file loadable either way) or the merge found both sides already hold the
	 *   full union, in which case writing anything would only churn mtime and
	 *   invite the sync plugin to arbitrate a file that did not change.
	 * - `merged` — the union was written when the local side held entries the
	 *   foreign file lacked (a stale foreign overwrite folds back in), or the
	 *   foreign side was the superset and only the in-memory instance needed
	 *   rebuilding. Either way the fresh instance reads the merged file.
	 * - `conflict` — the merge refused (divergent content for one entry id, both
	 *   sides compacted past the shared history, a foreign header for another
	 *   session). The foreign file as it sits on disk is copied to a
	 *   `conflicts/` folder beside the log — pi's repo only lists session files,
	 *   so the copy never surfaces as a duplicate chat — and the live session
	 *   stays untouched for the caller to surface.
	 *
	 * The path must already be hydrated; this is a recovery for a live session,
	 * not a loader.
	 */
	async reconcileExternalDrift(path: string): Promise<SessionReconcileOutcome> {
		const target = normalizeFolderPath(path, { allowPluginInternals: true });
		const live = this.hydrated.get(target);
		if (!live) {
			throw new Error(`No session loaded: ${target}`);
		}
		const foreign = await this.fs.readTextFile(target);
		if (!foreign.ok) {
			return { action: "skipped" };
		}
		const localLines = serializeLogLines(await live.session.getLog(), await live.session.getLanes());
		const result = mergeSessions(localLines, foreign.value.split("\n"), live.metadata.id);

		if (result.merged === null) {
			// Quarantine: copy the foreign file as it sits on disk to `conflicts/`
			// beside its log — pi's repo only lists session files, so the copy never
			// surfaces as a duplicate chat.
			const slash = target.lastIndexOf("/");
			const backupPath = `${target.slice(0, slash)}/conflicts/${target.slice(slash + 1).replace(/\.jsonl$/, "")}.conflict-${Date.now()}.jsonl`;
			// Session paths are policy-built under `sessionDir/`, so a parent always exists.
			await this.writeFileStrict(backupPath, foreign.value);
			return { action: "conflict", backupPath };
		}
		if (result.localTail > 0 || result.localFactsChanged) {
			const staged = `${target}.tmp`;
			await this.writeFileStrict(staged, result.merged.join(""), target);
		} else if (result.foreignTail === 0 && !result.factsChanged) {
			// Both sides already hold the full union: writing anything would only
			// churn mtime and invite the sync plugin to arbitrate a file that did
			// not change. The live instance is also still current, so no rebuild.
			return { action: "skipped" };
		}
		const fresh = await this.repo(this.resolveSessionDir()).open(live.metadata);
		this.hydrated.set(target, { session: fresh, metadata: await fresh.getMetadata() });
		return { action: "merged" };
	}

	/**
	 * A whole-file write whose failure is this method's own outcome, not a
	 * caller's concern. `renameTo` stages-then-releases: pi's own torn-tail
	 * ritual for publishing a rewritten log.
	 */
	private async writeFileStrict(path: string, content: string, renameTo?: string): Promise<void> {
		const written = await this.fs.writeFile(path, content);
		if (!written.ok) {
			throw written.error;
		}
		if (renameTo !== undefined) {
			const rename = await this.fs.renameFile(path, renameTo);
			if (!rename.ok) {
				throw rename.error;
			}
		}
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
		return readSessionMetadata(this.fs, this.resolveSessionDir(), path);
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
		const entryTime = entries.reduce((latest, entry) => {
			const messageTime = entry.type === "message" && typeof entry.message.timestamp === "number" ? entry.message.timestamp : 0;
			return Math.max(latest, entry.timestamp, messageTime);
		}, 0);
		// In-band first: the newest entry timestamp is what "recently chatted"
		// means, and it survives a sync tool touching the file's mtime on the
		// wrong side. mtime is only the fallback for files whose entries carry no
		// usable clock (or a read failure) — for those it is all there is, noise
		// and all, and blending the two clocks with a max would let a sync-
		// refreshed mtime outrank a truthful but older entry timestamp.
		const modifiedTime =
			entryTime > 0 ? entryTime : info.ok ? info.value.mtimeMs : metadata.modifiedAt;
		const firstMessage = entries.find(
			(entry): entry is Extract<Entry, { type: "message" }> => entry.type === "message" && entry.message.role === "user",
		);
		return {
			id: metadata.id,
			path: metadata.path,
			createdAt: new Date(metadata.createdAt).toISOString(),
			updatedAt: new Date(modifiedTime).toISOString(),
			name: name?.trim() || undefined,
			messageCount: stats.messageCount,
			// Empty string, not a placeholder: sessionTitle's fallback to
			// session.untitled only triggers on emptiness.
			firstMessage: firstMessage ? extractMessageText(firstMessage.message) : "",
			parentSessionId: metadata.parentSessionId,
			modifiedTime,
		};
	}
}

interface SessionFileInfo extends ActiveSessionInfo {
	modifiedTime: number;
}

/**
 * What {@link ObsidianSessionManager.reconcileExternalDrift} decided:
 * `skipped` (nothing to do), `merged` (union written and/or instance rebuilt),
 * or `conflict` (merge refused; the foreign file was quarantined at
 * `backupPath` for the user to inspect).
 */
export type SessionReconcileOutcome = { action: "merged" } | { action: "skipped" } | { action: "conflict"; backupPath: string };

function fixedSessionPolicy(sessionDir: string): SessionPolicy {
	return { sessionDir: () => sessionDir, retentionLimit: () => UNLIMITED_SESSION_RETENTION };
}

/**
 * The production {@link LastOpenedSessionStore}: `localStorage`, keyed per vault
 * via the app id so one machine running several vaults keeps one record each.
 *
 * `localStorage` is the whole point — it is device-local browser storage the
 * vault sync never sees, unlike anything written into the vault or `data.json`,
 * both of which a sync plugin copies wholesale. Every access is guarded because
 * the record is a convenience: a storage failure (private mode, quota, a host
 * without the API) must degrade to the record-less behavior, not take startup
 * or a session switch down with it.
 */
export function localStorageLastOpenedSessionStore(appId: string | undefined): LastOpenedSessionStore {
	const key = `piem:last-session:${appId || "default"}`;
	return {
		read(): string | null {
			try {
				return window.localStorage.getItem(key);
			} catch {
				return null;
			}
		},
		write(path: string): void {
			try {
				window.localStorage.setItem(key, path);
			} catch {
				// Keep going; the fallback is the pre-record behavior.
			}
		},
	};
}

export function getPluginSessionDir(app: App, plugin: Plugin): string {
	const pluginDir = plugin.manifest.dir ?? `${app.vault.configDir}/plugins/${plugin.manifest.id}`;
	return `${pluginDir}/sessions`;
}

/**
 * Recovers a session's id from its log path, the inverse of pi's
 * `sessionFileName` — `<ISO timestamp>_<id>.jsonl`, where the timestamp half
 * holds no underscore, so the id starts at the last one. `null` for anything
 * else: sessions not named by pi (hand-renamed, foreign) have no id to recover,
 * and a listener keyed by id must not be fed a guess.
 */
export function sessionIdFromSessionPath(path: string): string | null {
	const base = path.split("/").pop() ?? "";
	if (!base.endsWith(".jsonl")) {
		return null;
	}
	const stem = base.slice(0, -".jsonl".length);
	const cut = stem.lastIndexOf("_");
	const id = cut === -1 ? "" : stem.slice(cut + 1);
	return id || null;
}

/**
 * The filename pi's `JsonlSessionRepo.create` mints for a session: the
 * creation timestamp (colons and dots flattened to dashes) then the id.
 * pi keeps this rule private, so it is mirrored here — and only used with an
 * id pi itself will be handed at materialization, where `create({ id })` must
 * land on exactly this name for the reserved path to match.
 */
function reservedSessionFileName(createdAt: number, id: string): string {
	const timestamp = new Date(createdAt).toISOString().replace(/[:.]/g, "-");
	return `${timestamp}_${id}.jsonl`;
}

/** The cwd-encoded directory pi nests every session file under (`--<cwd>--`). */
function reservedSessionDirectoryName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** pi's `fileResult` discipline: a failed file write is thrown, not returned. */
function fileResultOrThrow<T>(result: Result<T, FileError>, message: string): T {
	if (!result.ok) {
		throw new Error(`${message}: ${result.error.message}`);
	}
	return result.value;
}

function extractMessageText(message: AgentMessage): string {
	if (!("content" in message)) {
		return "";
	}
	if (typeof message.content === "string") {
		return collapseSkillInvocationText(message.content);
	}
	return message.content
		.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
		.map((part) => collapseSkillInvocationText(part.text))
		.join("\n");
}

/**
 * Reads a text block back as the user's own words: a skill expansion goes back
 * to `/name` plus whatever instructions followed it. Everything that titles a
 * session — the header, the picker, the exported note's file name — draws from
 * `firstMessage`, and the expansion is pi-agent-core's, not the user's; a title
 * of `<skill name="…" location="…">` says nothing anyone chose. Blocks that
 * aren't invocations (including injected context from the implicit-injection
 * pass) pass through untouched, so a failed parse degrades to exactly the
 * pre-collapse behaviour.
 */
function collapseSkillInvocationText(text: string): string {
	const parsed = parseSkillInvocation(text);
	return parsed ? collapseSkillInvocation(parsed) : text;
}
