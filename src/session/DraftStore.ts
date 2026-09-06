import type { App, DataAdapter, Plugin } from "obsidian";
import { debounce } from "obsidian";
import { normalizeFolderPath } from "../vault/path";
import { getPluginSessionDir } from "./ObsidianSessionManager";
import { NOOP_LOGGER, type LoggerLike } from "../logging/Logger";

/**
 * Unsent composer text, kept per chat.
 *
 * The composer used to hold its draft in React state alone, so closing the
 * panel or restarting Obsidian discarded whatever had been typed, and switching
 * chats carried the old draft into the new one — a half-written question could
 * be sent to the wrong conversation.
 *
 * Drafts live in their own files rather than in plugin settings: they change on
 * a keystroke cadence, and `saveSettings` re-seals API keys and refreshes the
 * agent configuration on every call.
 *
 * One file per chat: `drafts/<sessionId>.json`, the session's own id verbatim.
 * All chats once shared a single `drafts.json`, which reads fine until a second
 * device is involved — a sync plugin arbitrates whole files, last writer wins,
 * so one stale device's composer could bury every chat's unsent text at once.
 * Per-chat files line the blast radius up with the loss: a lost merge costs one
 * draft, and the keystroke write touches only the chat being typed in instead
 * of rewriting the whole shelf. One key per chat is still the session's own id
 * — forking mints a whole session now, each with its own id, so nothing
 * composes a suffix and one session is one composer.
 *
 * The single-file era is migrated, not abandoned: on load a surviving
 * `drafts.json` is scattered into per-chat files and renamed
 * `drafts.json.migrated`. The rename — not a delete — matters, because a sync
 * plugin would otherwise resurrect the deleted file on the next pass and the
 * two devices would tug-of-war over it forever; a retired name travels through
 * sync like any other rename and stays retired. Scattered entries skip chats
 * that already have a newer per-chat file, and a resurrected file is simply
 * folded in and retired again, so the migration is idempotent under sync.
 */

/** How long typing must pause before a draft is written. */
const WRITE_DEBOUNCE_MS = 700;

/**
 * Longest draft persisted. A pasted note body can be enormous, and a draft file
 * is convenience state, not a document store; the composer keeps the full text
 * in memory either way.
 */
const MAX_DRAFT_LENGTH = 20_000;

export class DraftStore {
	private readonly adapter: DataAdapter;
	/** Folder the drafts live in; one file per session inside it. */
	private readonly draftsDir: string;
	/** The pre-per-chat single file, read once for migration and then retired. */
	private readonly legacyPath: string;
	/** Chat id → text, the cache every read and write goes through. */
	private readonly drafts = new Map<string, string>();
	private loaded: Promise<void> | null = null;
	/** Chats whose in-memory text has not landed on disk yet. */
	private readonly dirty = new Set<string>();
	/** Chat id → the tail of that chat's in-flight write chain. */
	private readonly writing = new Map<string, Promise<void>>();
	/**
	 * The pending disk write, as Obsidian's own debouncer.
	 *
	 * `resetTimer` gives the classic keystroke debounce: every `set` pushes the
	 * write back until typing pauses. The `Debouncer` handles the timer field,
	 * the clear-before-set, and the teardown cancel that used to be three hand-
	 * rolled `writeTimer` blocks here.
	 */
	private readonly scheduleWrite = debounce(() => {
		void this.writeDirty();
	}, WRITE_DEBOUNCE_MS, true);
	private readonly log: LoggerLike;

	// The logger stays optional: existing direct constructions (tests) keep
	// working, and silence beats a hard dependency for a convenience file.
	constructor(adapter: DataAdapter, sessionDir: string, logger?: LoggerLike) {
		this.adapter = adapter;
		const dir = normalizeFolderPath(sessionDir, { allowPluginInternals: true });
		this.draftsDir = `${dir}/drafts`;
		this.legacyPath = `${dir}/drafts.json`;
		this.log = (logger ?? NOOP_LOGGER).child("drafts");
	}

	static forPlugin(app: App, plugin: Plugin, logger?: LoggerLike): DraftStore {
		// Sits beside the session logs the drafts are keyed against.
		return new DraftStore(app.vault.adapter, getPluginSessionDir(app, plugin), logger);
	}

	/**
	 * Draft for one chat, or `""` when it has none.
	 *
	 * Chats are read from disk on demand and cached, so a vault of a hundred
	 * drafts opens without reading a hundred files to answer one composer. A
	 * malformed file yields an empty draft rather than an error, because losing
	 * a draft must never be worse than a blank composer — and only that chat's
	 * file is malformed, so the damage stops at one.
	 */
	async get(sessionId: string): Promise<string> {
		await this.ensureLoaded();
		const cached = this.drafts.get(sessionId);
		if (cached !== undefined) {
			return cached;
		}
		// A chat in `dirty` whose value the map lacks is waiting to be *removed*:
		// the stale file is still on disk until the debounce lands, and reading
		// it here would resurrect the draft clear() just dropped.
		if (this.dirty.has(sessionId)) {
			return "";
		}
		const text = await this.readDraft(sessionId);
		// Only successful reads are cached: a missing file stays uncached, so a
		// draft that arrives later (sync, a second window) is found on the next
		// look instead of being shadowed by a remembered blank.
		if (text !== null) {
			this.drafts.set(sessionId, text);
			return text;
		}
		return "";
	}

	/**
	 * Records a draft, writing after typing pauses.
	 *
	 * In-memory state updates immediately, so a chat switch that reads right
	 * after a keystroke sees the current text without waiting for the disk.
	 */
	async set(sessionId: string, text: string): Promise<void> {
		await this.ensureLoaded();
		const trimmed = text.slice(0, MAX_DRAFT_LENGTH);
		if (!trimmed.trim()) {
			// An emptied composer has no draft; keeping a stale file would contradict
			// the composer on the next look. Nothing was ever held means nothing to
			// write — and no pointless removal racing a sync pass.
			const existing = this.drafts.get(sessionId);
			this.drafts.delete(sessionId);
			if (existing !== undefined && existing.trim()) {
				this.dirty.add(sessionId);
				this.scheduleWrite();
			}
			return;
		}
		this.drafts.set(sessionId, trimmed);
		this.dirty.add(sessionId);
		this.scheduleWrite();
	}

	/**
	 * Drops a chat's draft — after a send, or because the session is gone.
	 *
	 * Unconditional on purpose: a chat cleared after sending is always in the
	 * cache already, so the only case a guard could skip is a file for a chat
	 * this window never opened — a draft typed elsewhere whose session was
	 * deleted here. The removal itself still waits for the debounce, batched
	 * with any other pending work.
	 */
	async clear(sessionId: string): Promise<void> {
		await this.ensureLoaded();
		this.drafts.delete(sessionId);
		this.dirty.add(sessionId);
		this.scheduleWrite();
	}

	/**
	 * Writes any pending draft immediately.
	 *
	 * Called when the view closes: the debounce would otherwise be cancelled by
	 * teardown and the last keystrokes lost, which is exactly the case this store
	 * exists to fix.
	 */
	async flush(): Promise<void> {
		// Cancel rather than `run()`: the debouncer only fires its callback when a
		// write is actually pending, but the store's reason for existing is that a
		// closing panel must land every keystroke — so the write itself stays
		// unconditional here.
		this.scheduleWrite.cancel();
		await Promise.all([...this.dirty].map((sessionId) => this.writeSession(sessionId)));
	}

	/** Cancels pending work without writing. For teardown paths that must not touch disk. */
	dispose(): void {
		this.scheduleWrite.cancel();
	}

	/**
	 * Marks a chat for writing and returns once its write has run.
	 *
	 * Each chat's writes ride that chat's own chain, so a flush racing the
	 * debouncer — or two flushes — cannot interleave one file's writes: an
	 * unchained older read could land after a newer write, and the file would
	 * end up holding text the composer never showed. Chains are per chat, so a
	 * slow write never delays another chat's. Failures are swallowed: an
	 * unwritable draft file is a lost convenience, not something worth
	 * surfacing mid-sentence.
	 */
	private writeSession(sessionId: string): Promise<void> {
		this.dirty.add(sessionId);
		// The tail is defused before chaining: one failed run must not sever the
		// chain, or every later write of that chat would silently never run.
		const run = (this.writing.get(sessionId) ?? Promise.resolve())
			.catch(() => undefined)
			.then(async () => {
				// Cleared when the write takes the value, not when it finishes: a
				// `set` landing mid-write re-marks the chat and the debouncer's next
				// fire carries the newer text.
				this.dirty.delete(sessionId);
				try {
					await this.writeNow(sessionId);
				} catch (error) {
					// Logged but not thrown: the next pause retries, so a transient
					// failure costs one debounce cycle, not the draft.
					this.log.warn("Failed to write draft file", () => ({ path: this.draftFile(sessionId), error: String(error) }));
				}
			});
		this.writing.set(sessionId, run);
		// Retire the tail once nothing queues behind it, so the map tracks live
		// work only and a finished chat costs nothing to keep.
		void run.then(
			() => {
				if (this.writing.get(sessionId) === run) {
					this.writing.delete(sessionId);
				}
			},
			// Unreachable while writeNow's catch holds, but a throwing logger must
			// not turn the tail into a floating rejection.
			() => undefined,
		);
		return run;
	}

	/** Writes every chat the debouncer found dirty, concurrently but per-file serialized. */
	private async writeDirty(): Promise<void> {
		await Promise.all([...this.dirty].map((sessionId) => this.writeSession(sessionId)));
	}

	private async writeNow(sessionId: string): Promise<void> {
		const text = this.drafts.get(sessionId);
		const path = this.draftFile(sessionId);
		if (text === undefined || !text.trim()) {
			// An empty draft is the absence of a file, not an empty one: writing
			// `{}` would leave debris every sync pass has to carry around.
			if (await this.adapter.exists(path)) {
				await this.adapter.remove(path);
			}
			return;
		}
		await this.ensureDraftsDirectory();
		await this.adapter.write(path, JSON.stringify({ text, updatedAt: Date.now() }));
	}

	private async readDraft(sessionId: string): Promise<string | null> {
		try {
			const path = this.draftFile(sessionId);
			if (!(await this.adapter.exists(path))) {
				return null;
			}
			return parseDraftFile(await this.adapter.read(path));
		} catch (error) {
			// A corrupt or unreadable file starts that chat empty rather than
			// blocking the panel, but the user loses a draft with no visible
			// cause — so the reason lands in the log at a level the default
			// view shows.
			this.log.warn("Draft file unreadable; starting that chat empty", () => ({ path: this.draftFile(sessionId), error: String(error) }));
			return null;
		}
	}

	/**
	 * Folds the single-file era into per-chat files, once.
	 *
	 * Runs on every load but only does work while a `drafts.json` survives —
	 * which is what makes it safe under sync: if the old file is resurrected by
	 * another device, the next load scatters it again and retires it again.
	 */
	private async migrateLegacyFile(): Promise<void> {
		let content: string;
		try {
			if (!(await this.adapter.exists(this.legacyPath))) {
				return;
			}
			content = await this.adapter.read(this.legacyPath);
		} catch (error) {
			this.log.warn("Legacy drafts file unreadable; skipping migration", () => ({ path: this.legacyPath, error: String(error) }));
			return;
		}
		try {
			const legacy = parseLegacyFile(content);
			await this.ensureDraftsDirectory();
			for (const [sessionId, entry] of Object.entries(legacy)) {
				const path = this.draftFile(sessionId);
				// A chat that already has a file has newer state than the shared
				// file ever held; migrating over it would resurrect stale text.
				if (!(await this.adapter.exists(path))) {
					await this.adapter.write(path, JSON.stringify({ text: entry.text, updatedAt: entry.updatedAt }));
				}
			}
			// Renamed, not deleted: a deletion syncs as a deletion and comes back
			// with the next pass from the device that still has the file, and the
			// two devices would fight over it forever. A rename travels as a
			// rename, and `.migrated` is a name nothing reads again.
			const retired = `${this.legacyPath}.migrated`;
			if (await this.adapter.exists(retired)) {
				await this.adapter.remove(retired);
			}
			await this.adapter.rename(this.legacyPath, retired);
		} catch (error) {
			this.log.warn("Legacy drafts migration failed; will retry on next load", () => ({ path: this.legacyPath, error: String(error) }));
		}
	}

	private async ensureLoaded(): Promise<void> {
		this.loaded ??= this.load();
		await this.loaded;
	}

	private async load(): Promise<void> {
		// Start from nothing on every load: loading against a second location —
		// the chat folder changed — otherwise leaves the previous folder's drafts
		// in memory, and the next write files them under the new folder. One
		// chat's unsent text would then surface in another's composer.
		this.drafts.clear();
		await this.migrateLegacyFile();
	}

	/** Per-chat draft file: the session's own id, verbatim, one file. */
	private draftFile(sessionId: string): string {
		return `${this.draftsDir}/${sessionId}.json`;
	}

	/**
	 * Creates the drafts folder, one missing segment at a time.
	 *
	 * `adapter.mkdir` is not recursive, and the folder is created on first write
	 * rather than on load so a vault that never drafts is never given an empty
	 * folder to sync.
	 */
	private async ensureDraftsDirectory(): Promise<void> {
		const segments = this.draftsDir.split("/");
		for (let depth = 1; depth <= segments.length; depth += 1) {
			const partial = segments.slice(0, depth).join("/");
			if (!(await this.adapter.exists(partial))) {
				await this.adapter.mkdir(partial);
			}
		}
	}
}

/**
 * Reads the per-chat shape defensively.
 *
 * The file is hand-editable and shared with whatever wrote it last, so every
 * field is validated and `null` — not a broken draft — comes back for anything
 * unrecognized.
 */
function parseDraftFile(content: string): string | null {
	const parsed: unknown = JSON.parse(content);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	const { text } = parsed as { text?: unknown };
	if (typeof text !== "string" || !text.trim()) {
		return null;
	}
	return text.slice(0, MAX_DRAFT_LENGTH);
}

interface LegacyDraftRecord {
	text: string;
	updatedAt: number;
}

/**
 * Reads the single-file era's shape defensively.
 *
 * `drafts.json` mapped session id → record; the same field rules as the
 * per-chat parser apply, and anything unrecognized is dropped instead of
 * reaching the composer as `undefined`.
 */
function parseLegacyFile(content: string): Record<string, LegacyDraftRecord> {
	const parsed: unknown = JSON.parse(content);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {};
	}
	const drafts: Record<string, LegacyDraftRecord> = {};
	for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (!value || typeof value !== "object") {
			continue;
		}
		const { text, updatedAt } = value as { text?: unknown; updatedAt?: unknown };
		if (typeof text !== "string" || !text.trim()) {
			continue;
		}
		drafts[sessionId] = {
			text: text.slice(0, MAX_DRAFT_LENGTH),
			updatedAt: typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : 0,
		};
	}
	return drafts;
}
