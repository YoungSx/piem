import { describe, expect, it } from "bun:test";
import type { DataAdapter } from "obsidian";
import { installObsidianStub } from "../testUtils/obsidianStub";

// DraftStore imports Obsidian's `debounce` at runtime (#99), so the shared stub
// must be registered before the module loads. The import below stays dynamic on
// purpose: a static import hoists above the install call and resolves the real
// (declaration-only) `obsidian` package first.
installObsidianStub();

const { DraftStore } = await import("./DraftStore");
/** Instance shape of the dynamically imported class, for the signatures below. */
type DraftStoreInstance = InstanceType<typeof DraftStore>;

/**
 * The folder drafts live under — the constructor takes the session *directory*
 * and derives both the per-chat folder and the legacy file from it, so the tests
 * pin those two derivations rather than re-deriving them independently.
 */
const SESSION_DIR = `.${"obsidian"}/plugins/piem/sessions`;
const DRAFTS_DIR = `${SESSION_DIR}/drafts`;
const LEGACY_PATH = `${SESSION_DIR}/drafts.json`;
const LEGACY_RETIRED_PATH = `${LEGACY_PATH}.migrated`;

/** Per-chat draft file for `sessionId`, matching the store's own layout. */
function draftFile(sessionId: string): string {
	return `${DRAFTS_DIR}/${sessionId}.json`;
}

/**
 * Minimal adapter with every call `DraftStore` makes, plus counters so a test
 * can prove the debounce is doing its job.
 */
class MemoryAdapter {
	private readonly files = new Map<string, string>();
	private readonly folders = new Set<string>();
	writes = 0;
	failWrites = false;
	/** Holds writes briefly, so a test can interleave new state into a flush. */
	delayWrites = 0;

	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.folders.has(path);
	}

	async mkdir(path: string): Promise<void> {
		this.folders.add(path);
	}

	async write(path: string, data: string): Promise<void> {
		this.writes += 1;
		if (this.failWrites) {
			throw new Error("read-only vault");
		}
		if (this.delayWrites > 0) {
			this.delayWrites -= 1;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		this.files.set(path, data);
	}

	async read(path: string): Promise<string> {
		const content = this.files.get(path);
		if (content === undefined) {
			throw new Error(`Missing file: ${path}`);
		}
		return content;
	}

	async remove(path: string): Promise<void> {
		this.files.delete(path);
	}

	async rename(path: string, newPath: string): Promise<void> {
		const content = this.files.get(path);
		if (content === undefined) {
			throw new Error(`Missing file: ${path}`);
		}
		this.files.delete(path);
		this.files.set(newPath, content);
	}

	seed(path: string, content: string): void {
		this.files.set(path, content);
	}

	stored(path: string): string | undefined {
		return this.files.get(path);
	}
}

/**
 * Collects the records a store emits, so the tests can pin which failures get
 * logged rather than trusting that "somewhere a logger was touched".
 */
const { spyLogger } = await import("../testUtils/logSpy");

function createStore(
	adapter = new MemoryAdapter(),
	logger?: ReturnType<typeof spyLogger>["logger"],
): { store: DraftStoreInstance; adapter: MemoryAdapter } {
	return { store: new DraftStore(adapter as unknown as DataAdapter, SESSION_DIR, logger), adapter };
}

/**
 * Points a live store at another directory and makes it load again, as
 * reconfiguring the chat folder does.
 *
 * Reaches past the public surface deliberately: the load is memoised, and the
 * behaviour under test is what a *second* load leaves behind. Constructing a
 * fresh store instead would start from an empty object and pass either way.
 */
async function reloadFrom(store: DraftStoreInstance, sessionDir: string): Promise<void> {
	const dir = sessionDir;
	const internals = store as unknown as { draftsDir: string; legacyPath: string; loaded: Promise<void> | null };
	internals.draftsDir = `${dir}/drafts`;
	internals.legacyPath = `${dir}/drafts.json`;
	internals.loaded = null;
	await store.get("ignored");
}

describe("DraftStore per-chat isolation", () => {
	it("keeps each chat's draft separate, so switching never sends text to the wrong conversation", async () => {
		const { store } = createStore();
		await store.set("session-a", "half a question for A");
		await store.set("session-b", "something else for B");

		expect(await store.get("session-a")).toBe("half a question for A");
		expect(await store.get("session-b")).toBe("something else for B");
	});

	it("reports an empty draft for a chat that has none", async () => {
		const { store } = createStore();
		expect(await store.get("unknown")).toBe("");
	});

	it("drops the draft when the composer is emptied by removing the file, not writing debris", async () => {
		const { store, adapter } = createStore();
		await store.set("session-a", "typed then deleted");
		await store.flush();

		await store.set("session-a", "   ");
		await store.flush();

		expect(await store.get("session-a")).toBe("");
		expect(await adapter.exists(draftFile("session-a"))).toBe(false);
	});

	it("clears a single chat without disturbing the others", async () => {
		const { store } = createStore();
		await store.set("session-a", "keep me");
		await store.set("session-b", "remove me");
		await store.clear("session-b");

		expect(await store.get("session-a")).toBe("keep me");
		expect(await store.get("session-b")).toBe("");
	});

	it("coexists with hundreds of chats, one file each, with no cap and no cross-talk", async () => {
		// The single-file era capped 50 drafts in one JSON object, and every
		// keystroke rewrote the whole shelf. One file per chat needs no cap: each
		// write touches only the chat being typed in.
		const { store, adapter } = createStore();
		for (let index = 0; index < 120; index += 1) {
			await store.set(`session-${index}`, `draft ${index}`);
		}
		await store.flush();

		expect(await store.get("session-0")).toBe("draft 0");
		expect(await store.get("session-119")).toBe("draft 119");
		expect(await adapter.exists(draftFile("session-7"))).toBe(true);
	});
});

describe("DraftStore persistence", () => {
	it("survives a reload, which is the whole point of the file", async () => {
		const { store, adapter } = createStore();
		await store.set("session-a", "written before the restart");
		await store.flush();

		const reopened = new DraftStore(adapter as unknown as DataAdapter, SESSION_DIR);
		expect(await reopened.get("session-a")).toBe("written before the restart");
	});

	it("batches keystrokes into one write instead of touching disk per character", async () => {
		const { store, adapter } = createStore();
		await store.set("session-a", "t");
		await store.set("session-a", "ty");
		await store.set("session-a", "typ");
		expect(adapter.writes).toBe(0);

		await store.flush();
		expect(adapter.writes).toBe(1);
	});

	it("starts empty on a corrupt file rather than blocking the panel", async () => {
		const adapter = new MemoryAdapter();
		adapter.seed(draftFile("session-a"), "{ this is not json");
		const { store } = createStore(adapter);

		expect(await store.get("session-a")).toBe("");
	});

	it("keeps healthy chats working when one chat's file is corrupt — the blast radius is one draft", async () => {
		const adapter = new MemoryAdapter();
		adapter.seed(draftFile("session-a"), "{ not json");
		adapter.seed(draftFile("session-b"), JSON.stringify({ text: "intact", updatedAt: 1 }));
		const { store } = createStore(adapter);

		expect(await store.get("session-a")).toBe("");
		expect(await store.get("session-b")).toBe("intact");
	});

	it("logs a warning when a draft file is unreadable, so the lost draft has a cause", async () => {
		const adapter = new MemoryAdapter();
		adapter.seed(draftFile("session-a"), "{ this is not json");
		const { logger, records } = spyLogger();
		const { store } = createStore(adapter, logger);

		expect(await store.get("session-a")).toBe("");
		expect(records).toHaveLength(1);
		expect(records[0]?.message).toContain("unreadable");
	});

	it("logs a warning when a write fails, without throwing into the composer", async () => {
		const adapter = new MemoryAdapter();
		adapter.failWrites = true;
		const { logger, records } = spyLogger();
		const { store } = createStore(adapter, logger);

		await store.set("session-a", "still typed");
		await store.flush();

		expect(await store.get("session-a")).toBe("still typed");
		expect(records).toHaveLength(1);
		expect(records[0]?.message).toContain("Failed to write");
		expect(records[0]?.detail).toMatchObject({ path: draftFile("session-a") });
	});

	it("ignores a per-chat file whose shape does not match, so a hand-edit cannot inject undefined", async () => {
		const adapter = new MemoryAdapter();
		adapter.seed(draftFile("weird"), JSON.stringify({ text: 42, extra: true }));
		const { store } = createStore(adapter);

		expect(await store.get("weird")).toBe("");
	});

	it("keeps serving drafts from memory when the write fails", async () => {
		const adapter = new MemoryAdapter();
		adapter.failWrites = true;
		const { store } = createStore(adapter);

		await store.set("session-a", "still typed");
		await store.flush();

		expect(await store.get("session-a")).toBe("still typed");
	});

	it("caps a single draft so a pasted note body cannot bloat the file", async () => {
		const { store } = createStore();
		await store.set("session-a", "x".repeat(30_000));

		expect((await store.get("session-a")).length).toBe(20_000);
	});

	it("forgets the previous folder's drafts when the new one holds no draft files", async () => {
		// Regression: `load` returned early when the file was absent without clearing
		// what it already held, so after the chat folder changed the old folder's
		// drafts stayed in memory and the next write filed them under the new folder —
		// one chat's unsent text appearing in another's composer.
		const adapter = new MemoryAdapter();
		adapter.seed(draftFile("session-a"), JSON.stringify({ text: "typed in the old folder", updatedAt: 1 }));
		const { store } = createStore(adapter);
		expect(await store.get("session-a")).toBe("typed in the old folder");

		await reloadFrom(store, `${SESSION_DIR}/../elsewhere`);

		expect(await store.get("session-a")).toBe("");
	});

	it("does not write after dispose cancels the pending debounce", async () => {
		const { store, adapter } = createStore();
		await store.set("session-a", "typed then torn down");
		store.dispose();
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(adapter.writes).toBe(0);
	});
});

describe("DraftStore legacy migration", () => {
	it("scatters the single-file era into per-chat files and retires the old file", async () => {
		const adapter = new MemoryAdapter();
		adapter.seed(
			LEGACY_PATH,
			JSON.stringify({
				"session-a": { text: "old draft A", updatedAt: 1 },
				"session-b": { text: "old draft B", updatedAt: 2 },
			}),
		);
		const { store, adapter: written } = createStore(adapter);

		expect(await store.get("session-a")).toBe("old draft A");
		expect(await store.get("session-b")).toBe("old draft B");

		// The read migrated on load, before `get` even reached for a draft file.
		expect(await written.exists(draftFile("session-a"))).toBe(true);
		expect(await written.exists(draftFile("session-b"))).toBe(true);
		expect(await written.exists(LEGACY_PATH)).toBe(false);
		// Renamed, not deleted: a sync plugin would resurrect a deleted file.
		expect(await written.exists(LEGACY_RETIRED_PATH)).toBe(true);
	});

	it("never clobbers a per-chat file that already exists — newer state wins", async () => {
		const adapter = new MemoryAdapter();
		adapter.seed(LEGACY_PATH, JSON.stringify({ "session-a": { text: "stale", updatedAt: 1 } }));
		adapter.seed(draftFile("session-a"), JSON.stringify({ text: "newer on this device", updatedAt: 99 }));
		const { store } = createStore(adapter);

		expect(await store.get("session-a")).toBe("newer on this device");
	});

	it("skips the migration when the legacy file is corrupt, and warns", async () => {
		// A parse failure surfaces from the second half of the migration, so the
		// wording differs from an unreadable file — but the contract is the same:
		// warn, leave the legacy file in place, retry on the next load.
		const adapter = new MemoryAdapter();
		adapter.seed(LEGACY_PATH, "{ not json");
		const { logger, records } = spyLogger();
		const { store, adapter: written } = createStore(adapter, logger);

		expect(await store.get("session-a")).toBe("");
		expect(await written.exists(LEGACY_PATH)).toBe(true);
		expect(await written.exists(LEGACY_RETIRED_PATH)).toBe(false);
		expect(records).toHaveLength(1);
		expect(records[0]?.message).toContain("migration failed");
	});

	it("folds a legacy file a sync pass resurrected back in, and retires it again", async () => {
		// Idempotence under sync: the other device still ships `drafts.json` until
		// its own copy of the `.migrated` rename lands, so every load must be able
		// to do this a second time without duplicating or losing anything.
		const adapter = new MemoryAdapter();
		adapter.seed(LEGACY_PATH, JSON.stringify({ "session-a": { text: "first pass", updatedAt: 1 } }));
		const { store } = createStore(adapter);
		expect(await store.get("session-a")).toBe("first pass");

		adapter.seed(LEGACY_PATH, JSON.stringify({ "session-b": { text: "resurrected", updatedAt: 2 } }));
		await reloadFrom(store, SESSION_DIR);

		expect(await store.get("session-a")).toBe("first pass");
		expect(await store.get("session-b")).toBe("resurrected");
		expect(await adapter.exists(LEGACY_PATH)).toBe(false);
		expect(await adapter.exists(LEGACY_RETIRED_PATH)).toBe(true);
	});

	it("warns and leaves everything in place when the migration itself fails", async () => {
		const adapter = new MemoryAdapter();
		adapter.seed(LEGACY_PATH, JSON.stringify({ "session-a": { text: "survives", updatedAt: 1 } }));
		// The rename step throws only after the scatter — the shape the retry
		// path has to cope with on the next load.
		const originalRename = adapter.rename.bind(adapter);
		adapter.rename = async (path, newPath) => {
			if (path === LEGACY_PATH) {
				throw new Error("sync held the file");
			}
			await originalRename(path, newPath);
		};
		const { logger, records } = spyLogger();
		const { store, adapter: written } = createStore(adapter, logger);

		expect(await store.get("session-a")).toBe("survives");
		expect(await written.exists(LEGACY_PATH)).toBe(true);
		expect(await written.exists(LEGACY_RETIRED_PATH)).toBe(false);
		expect(records).toHaveLength(1);
		expect(records[0]?.message).toContain("migration failed");
	});
});

describe("DraftStore deletion hook", () => {
	it("clears a draft for a chat this window never opened, and removes its file", async () => {
		// clear() is unconditional on purpose: the caller is the session manager's
		// delete announcement, and a draft typed elsewhere whose session was just
		// deleted here would otherwise outlive its conversation forever.
		const adapter = new MemoryAdapter();
		adapter.seed(draftFile("session-x"), JSON.stringify({ text: "typed on the phone", updatedAt: 1 }));
		const { store, adapter: written } = createStore(adapter);

		await store.clear("session-x");
		await store.flush();

		expect(await store.get("session-x")).toBe("");
		expect(await written.exists(draftFile("session-x"))).toBe(false);
	});

	it("serves an empty draft while a just-cleared file is still on disk, rather than resurrecting it", async () => {
		// The dirty guard: clear() marks removal, the stale file lingers until the
		// debounce lands, and a read in that window must not hand the old text back.
		const adapter = new MemoryAdapter();
		adapter.seed(draftFile("session-x"), JSON.stringify({ text: "about to be cleared", updatedAt: 1 }));
		const { store } = createStore(adapter);
		expect(await store.get("session-x")).toBe("about to be cleared");

		await store.clear("session-x");

		expect(await store.get("session-x")).toBe("");
		expect(await adapter.exists(draftFile("session-x"))).toBe(true);
		await store.flush();
		expect(await adapter.exists(draftFile("session-x"))).toBe(false);
	});
});

describe("DraftStore write chains", () => {
	it("never lets a flush racing new typing overwrite a newer draft with an older one", async () => {
		// A slow write in flight when `flush` starts, and a `set` landing mid-write:
		// the chain must serialize them so the file ends holding the newer text.
		const adapter = new MemoryAdapter();
		adapter.delayWrites = 1;
		const { store } = createStore(adapter);

		await store.set("session-a", "one");
		const flushing = store.flush();
		await store.set("session-a", "two");
		await flushing;
		// The newer text rode the same chain behind the slow write, so a final
		// flush — what the unmount path does — is all it takes to land it.
		await store.flush();

		expect(adapter.stored(draftFile("session-a"))).toContain('"two"');
		expect(await store.get("session-a")).toBe("two");
	});
});
