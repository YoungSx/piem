import { describe, expect, it } from "bun:test";
import type { DataAdapter, ListedFiles, Stat } from "obsidian";
import { ObsidianSessionManager, type SessionPolicy } from "./ObsidianSessionManager";
import { UNLIMITED_SESSION_RETENTION } from "./retention";

const CONFIG_DIR = `.${"obsidian"}`;
const SESSION_DIR = `${CONFIG_DIR}/plugins/piem/sessions`;
const VAULT_SESSION_DIR = "Piem/chats";
/** Far enough ahead that a stamped log outranks the wall-clock mtime of every other. */
const FUTURE_MS = Date.parse("2099-01-01T00:00:00.000Z");

class MemoryAdapter {
	private readonly files = new Map<string, { content: string; mtime: number }>();
	private readonly folders = new Set<string>();
	/** Paths handed to `trashSystem`/`trashLocal`, so eviction can be told apart from a delete. */
	readonly trashed: string[] = [];

	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.folders.has(path);
	}

	async mkdir(path: string): Promise<void> {
		this.folders.add(path);
	}

	async write(path: string, data: string): Promise<void> {
		this.files.set(path, { content: data, mtime: Date.now() });
	}

	async append(path: string, data: string): Promise<void> {
		const existing = this.files.get(path)?.content ?? "";
		this.files.set(path, { content: existing + data, mtime: Date.now() });
	}

	async read(path: string): Promise<string> {
		const file = this.files.get(path);
		if (!file) {
			throw new Error(`Missing file: ${path}`);
		}
		return file.content;
	}

	async stat(path: string): Promise<Stat | null> {
		const file = this.files.get(path);
		if (file) {
			return { type: "file", ctime: file.mtime, mtime: file.mtime, size: file.content.length };
		}
		if (this.folders.has(path)) {
			return { type: "folder", ctime: Date.now(), mtime: Date.now(), size: 0 };
		}
		return null;
	}

	/** Throws on an unknown folder, as Obsidian's adapter does — the case a fresh vault is in. */
	async list(path: string): Promise<ListedFiles> {
		if (!this.folders.has(path)) {
			throw new Error(`Missing folder: ${path}`);
		}
		return {
			files: [...this.files.keys()].filter((filePath) => getParent(filePath) === path),
			folders: [...this.folders.values()].filter((folderPath) => getParent(folderPath) === path),
		};
	}

	async trashSystem(path: string): Promise<boolean> {
		this.trashed.push(path);
		this.files.delete(path);
		return true;
	}

	async trashLocal(path: string): Promise<void> {
		this.trashed.push(path);
		this.files.delete(path);
	}

	/** The atomic publish step pi's `repo.fork` finishes a staged file with. */
	async rename(path: string, newPath: string): Promise<void> {
		const file = this.files.get(path);
		if (!file) {
			throw new Error(`Missing file: ${path}`);
		}
		this.files.delete(path);
		this.files.set(newPath, { ...file, mtime: Date.now() });
	}

	/**
	 * Present only to fail. A chat log is the only copy of a conversation, so every
	 * path that removes one has to go through trash; a call landing here is the
	 * defect this adapter exists to catch.
	 */
	async remove(path: string): Promise<void> {
		throw new Error(`Chat logs must go to trash, not be removed: ${path}`);
	}
}

describe("ObsidianSessionManager", () => {
	it("creates JSONL sessions under the plugin directory", async () => {
		const adapter = new MemoryAdapter() as unknown as DataAdapter;
		const manager = new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test");

		const info = await manager.createSession({ provider: "deepseek", modelId: "deepseek-v4-pro", thinkingLevel: "high" });
		await manager.appendMessage({ role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1 });

		const content = await adapter.read(info.path);
		expect(info.path).toContain(`${SESSION_DIR}/`);
		expect(content.split("\n")[0]).toContain('"kind":"header"');
		expect(content).toContain('"kind":"entry"');
		expect(content).toContain('"type":"model_change"');
		expect(content).toContain('"type":"thinking_level_change"');
		expect(content).toContain('"role":"user"');
	});

	it("continues the most recent session and builds context", async () => {
		const adapter = new MemoryAdapter() as unknown as DataAdapter;
		const manager = new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test");
		await manager.createSession({ provider: "deepseek", modelId: "deepseek-v4-pro", thinkingLevel: "high" });
		await manager.appendMessage({ role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1 });

		const nextManager = new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test");
		const info = await nextManager.continueRecentSession({ provider: "deepseek", modelId: "deepseek-v4-pro", thinkingLevel: "high" });
		const context = await nextManager.buildSessionContext();

		expect(info.messageCount).toBe(1);
		expect(context.messages).toHaveLength(1);
		expect(context.model).toEqual({ provider: "deepseek", modelId: "deepseek-v4-pro" });
	});

	it("reports no name before a session is active", async () => {
		const adapter = new MemoryAdapter() as unknown as DataAdapter;
		const manager = new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test");

		expect(await manager.readActiveSessionName()).toBeUndefined();
	});

	it("reads back a name set through the local write path", async () => {
		const adapter = new MemoryAdapter() as unknown as DataAdapter;
		const manager = new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test");
		await manager.createSession(DEFAULTS);

		await manager.appendSessionInfo("Local name");

		expect(await manager.readActiveSessionName()).toBe("Local name");
	});

	it("reads a name an external writer appended that the live session cannot see", async () => {
		const adapter = new MemoryAdapter() as unknown as DataAdapter;
		const manager = new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test");
		await manager.createSession(DEFAULTS);
		await manager.appendSessionInfo("Local name");

		// A second manager over the same vault plays the external writer: another
		// Obsidian window, a pi CLI, or a hand edit appending a name fact. It loads
		// the file fresh, so its sequence numbers continue correctly.
		const external = new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test");
		await external.loadSession(manager.getActiveSessionPath()!);
		await external.appendSessionInfo("External name");

		// The live session's in-memory state is hydrated once at open and never
		// sees the external line — this is exactly the staleness the read exists
		// to expose.
		expect((await manager.getActiveSessionInfo()).name).toBe("Local name");
		expect(await manager.readActiveSessionName()).toBe("External name");
	});

	it("reads a whitespace-only external name as cleared", async () => {
		const adapter = new MemoryAdapter() as unknown as DataAdapter;
		const manager = new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test");
		await manager.createSession(DEFAULTS);
		await manager.appendSessionInfo("Local name");

		const external = new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test");
		await external.loadSession(manager.getActiveSessionPath()!);
		await external.appendSessionInfo("   ");

		// Collapsing whitespace to cleared matches how `summarize` and the local
		// rename path treat it, so the comparison in the service treats "  " the
		// same as an explicit clear.
		expect(await manager.readActiveSessionName()).toBeUndefined();
	});
});

/**
 * The run ledger piem writes for crash recovery: `operation_started` when a
 * run departs, `operation_finished` with the same id as its `runId` when it
 * lands. These pin the write discipline the recovery path depends on —
 * including the pair's id contract, which pi's storage enforces by refusing
 * to open a second operation while one is still open.
 */
describe("ObsidianSessionManager run ledger", () => {
	it("opens a ledger entry for a run and closes it with the same id", async () => {
		const adapter = new MemoryAdapter() as unknown as DataAdapter;
		const manager = new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test");
		await manager.createSession(DEFAULTS);

		const runId = await manager.beginRunOperation([{ role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1 }]);
		expect(await manager.findOpenRunOperations()).toHaveLength(1);

		await manager.endRunOperation(runId, "completed");
		expect(await manager.findOpenRunOperations()).toEqual([]);
	});

	it("writes the ledger to the session file so another load can see it", async () => {
		const adapter = new MemoryAdapter() as unknown as DataAdapter;
		const manager = new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test");
		await manager.createSession(DEFAULTS);
		const runId = await manager.beginRunOperation([{ role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1 }]);

		// A fresh manager over the same vault reads the crash signature off
		// disk, not from any in-memory state.
		const reloaded = new ObsidianSessionManager(adapter as unknown as DataAdapter, SESSION_DIR, "obsidian-vault:Test");
		await reloaded.loadSession(manager.getActiveSessionPath()!);
		const open = await reloaded.findOpenRunOperations();
		expect(open).toHaveLength(1);
		expect(open[0]?.id).toBe(runId);
		expect(open[0]?.intent).toMatchObject({ kind: "run", originalPrompt: [{ role: "user" }] });
	});

	it("carries the failure reason onto the closing record", async () => {
		const adapter = new MemoryAdapter() as unknown as DataAdapter;
		const manager = new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test");
		await manager.createSession(DEFAULTS);
		const runId = await manager.beginRunOperation([{ role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1 }]);

		await manager.endRunOperation(runId, "failed", { code: "provider_error", message: "boom" });

		const open = await manager.findOpenRunOperations();
		expect(open).toEqual([]);
		const finished = await manager.getSession().findRecords({ type: "operation_finished" });
		expect(finished).toHaveLength(1);
		expect(finished[0]).toMatchObject({ runId, outcome: "failed", error: { code: "provider_error", message: "boom" } });
	});
});

describe("ObsidianSessionManager branch summary", () => {
	it("persists a branch summary so a reload keeps the abandoned fork in context", async () => {
		const adapter = new MemoryAdapter() as unknown as DataAdapter;
		const manager = new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test");
		await manager.createSession(DEFAULTS);
		// `appendBranchSummary` hangs the summary off the current leaf — the same
		// spot `summarizeAbandonedBranch` leaves it after a rewind — so a reload
		// walks through it on the live branch. `fromId` points the other way, at
		// the leaf of the branch that was abandoned, which is off this path.
		await manager.appendMessage({ role: "user", content: [{ type: "text", text: "Main line" }], timestamp: 1 });
		const summaryId = await manager.appendBranchSummary(
			{ summary: "Explored a dead end", readFiles: ["a.ts"], modifiedFiles: ["b.ts"] },
			"dead-leaf",
		);

		// The summary is on disk as a branch_summary line, not just in memory.
		const content = await adapter.read(manager.getActiveSessionPath()!);
		expect(content).toContain('"type":"branch_summary"');
		expect(content).toContain('"fromId":"dead-leaf"');

		// A fresh manager loading the file projects the summary into context, so
		// the memory survives a reload instead of being stranded on the dead branch.
		const reloaded = new ObsidianSessionManager(adapter as unknown as DataAdapter, SESSION_DIR, "obsidian-vault:Test");
		await reloaded.loadSession(manager.getActiveSessionPath()!);
		const context = await reloaded.buildSessionContext();

		expect(await reloaded.getSession().getLeafId()).toBe(summaryId);
		expect(context.messages.at(-1)).toMatchObject({ role: "branchSummary", summary: "Explored a dead end", fromId: "dead-leaf" });
	});
});

/**
 * A policy whose folder and cap can be changed mid-test, which is the shape
 * production uses: both are settings the user can edit with the plugin running.
 */
function mutablePolicy(sessionDir: string, retentionLimit: number): SessionPolicy & { dir: string; limit: number } {
	const state = {
		dir: sessionDir,
		limit: retentionLimit,
		sessionDir: () => state.dir,
		retentionLimit: () => state.limit,
	};
	return state;
}

const DEFAULTS = { provider: "deepseek", modelId: "deepseek-v4-pro", thinkingLevel: "high" } as const;

/**
 * Creates a chat and stamps it with an explicit recency.
 *
 * `getSessionModifiedTime` takes the newest timestamp in the log, and every chat
 * created inside one test shares a millisecond. A far-future message timestamp is
 * what makes the ordering eviction sorts on deterministic rather than incidental.
 */
async function createStampedSession(manager: ObsidianSessionManager, modifiedTime: number): Promise<string> {
	const info = await manager.createSession(DEFAULTS);
	await manager.appendMessage({ role: "user", content: [{ type: "text", text: "Hello" }], timestamp: modifiedTime });
	return info.path;
}

describe("ObsidianSessionManager retention", () => {
	it("trims to the cap on the next new chat, counting that chat against it", async () => {
		const adapter = new MemoryAdapter();
		const policy = mutablePolicy(VAULT_SESSION_DIR, UNLIMITED_SESSION_RETENTION);
		const manager = new ObsidianSessionManager(adapter as unknown as DataAdapter, policy, "obsidian-vault:Test");
		// Seeded with the cap off, so the trimming under test is the one the raised
		// cap causes rather than a side effect of filling the folder.
		const oldest = await createStampedSession(manager, FUTURE_MS);
		const older = await createStampedSession(manager, FUTURE_MS + 1_000);
		const old = await createStampedSession(manager, FUTURE_MS + 2_000);
		const kept = await createStampedSession(manager, FUTURE_MS + 3_000);

		policy.limit = 2;
		const newest = await createStampedSession(manager, FUTURE_MS + 10_000);

		const remaining = await manager.listSessions();
		expect(remaining.map((session) => session.path)).toEqual([newest, kept]);
		// Sorted: which chats go is the contract, the order the trash calls happen in
		// is not, so pinning it would fail on a reordering that changes nothing.
		expect([...adapter.trashed].sort()).toEqual([oldest, older, old].sort());
	});

	it("evicts to trash rather than removing, so a chat stays recoverable", async () => {
		const adapter = new MemoryAdapter();
		const manager = new ObsidianSessionManager(
			adapter as unknown as DataAdapter,
			mutablePolicy(VAULT_SESSION_DIR, 1),
			"obsidian-vault:Test",
		);

		const first = await createStampedSession(manager, FUTURE_MS);
		// `MemoryAdapter#remove` throws, so a hard delete would fail this rather
		// than pass quietly with the file gone.
		const second = await createStampedSession(manager, FUTURE_MS + 1_000);

		expect(adapter.trashed).toEqual([first]);
		expect(await adapter.exists(second)).toBe(true);
	});

	it("never evicts the chat that was just created", async () => {
		const adapter = new MemoryAdapter();
		const manager = new ObsidianSessionManager(
			adapter as unknown as DataAdapter,
			mutablePolicy(VAULT_SESSION_DIR, 1),
			"obsidian-vault:Test",
		);
		await createStampedSession(manager, FUTURE_MS + 5_000);

		// Stamped older than the chat it replaces: recency must not be the only
		// thing sparing the conversation on screen.
		const newest = await createStampedSession(manager, FUTURE_MS);

		expect(adapter.trashed).not.toContain(newest);
		expect(manager.getActiveSessionPath()).toBe(newest);
	});

	it("never evicts the copy a fork just made", async () => {
		const adapter = new MemoryAdapter();
		const manager = new ObsidianSessionManager(
			adapter as unknown as DataAdapter,
			mutablePolicy(VAULT_SESSION_DIR, 1),
			"obsidian-vault:Test",
		);
		const source = await createStampedSession(manager, FUTURE_MS);

		// The mirror of the test above, for the other way a chat is minted. At a
		// cap of 1 the focused source fills the only slot, so nothing unprotected
		// is spared by being recent — and a fork deliberately leaves focus where
		// it is. Without a claim of its own the copy would be trashed by the very
		// sweep its creation triggers, and the panel would open a gone file.
		const forked = await manager.forkSession(source, await entryIdOfMessage(manager, "Hello"));

		expect(adapter.trashed).not.toContain(forked.path);
		expect(await adapter.exists(forked.path)).toBe(true);
		expect(manager.getActiveSessionPath()).toBe(source);
	});

	it("keeps a claimed session alive across a switch and an eviction sweep", async () => {
		const adapter = new MemoryAdapter();
		const manager = new ObsidianSessionManager(
			adapter as unknown as DataAdapter,
			mutablePolicy(VAULT_SESSION_DIR, 1),
			"obsidian-vault:Test",
		);

		// A runtime claims its session before focus moves on: the claim — not
		// focus — is what spares it when the next chat triggers a sweep.
		const background = await createStampedSession(manager, FUTURE_MS);
		manager.retainSession(background);
		const focused = await createStampedSession(manager, FUTURE_MS + 1_000);

		expect(manager.isLoaded(background)).toBe(true);
		expect(manager.getActiveSessionPath()).toBe(focused);
		expect(adapter.trashed).toEqual([]);

		// Once the runtime releases it, the chat is an ordinary leftover: at a cap
		// of 1 with only the new chat protected, both of them go.
		manager.releaseSession(background);
		await createStampedSession(manager, FUTURE_MS + 2_000);
		expect([...adapter.trashed].sort()).toEqual([background, focused].sort());
	});

	it("keeps every chat when the cap is unlimited", async () => {
		const adapter = new MemoryAdapter();
		const manager = new ObsidianSessionManager(
			adapter as unknown as DataAdapter,
			mutablePolicy(VAULT_SESSION_DIR, UNLIMITED_SESSION_RETENTION),
			"obsidian-vault:Test",
		);

		for (let index = 0; index < 6; index += 1) {
			await createStampedSession(manager, FUTURE_MS + index * 1_000);
		}

		expect(adapter.trashed).toEqual([]);
		expect(await manager.countStoredSessions()).toBe(6);
	});
});

describe("ObsidianSessionManager chat folder", () => {
	it("writes chats to the folder the settings name, not a plugin-internal one", async () => {
		const adapter = new MemoryAdapter();
		const manager = new ObsidianSessionManager(
			adapter as unknown as DataAdapter,
			mutablePolicy(VAULT_SESSION_DIR, UNLIMITED_SESSION_RETENTION),
			"obsidian-vault:Test",
		);

		const info = await manager.createSession(DEFAULTS);

		expect(info.path.startsWith(`${VAULT_SESSION_DIR}/`)).toBe(true);
		expect(manager.getSessionDir()).toBe(VAULT_SESSION_DIR);
	});

	it("follows a folder changed while running, for the next chat only", async () => {
		const adapter = new MemoryAdapter();
		const policy = mutablePolicy(VAULT_SESSION_DIR, UNLIMITED_SESSION_RETENTION);
		const manager = new ObsidianSessionManager(adapter as unknown as DataAdapter, policy, "obsidian-vault:Test");
		const before = await createStampedSession(manager, FUTURE_MS);

		policy.dir = "Notes/chats";
		const after = await createStampedSession(manager, FUTURE_MS + 1_000);

		expect(after.startsWith("Notes/chats/")).toBe(true);
		// Nothing is moved, which is what the Sessions tab promises: the old chat is
		// still on disk and simply drops out of the list.
		expect(await adapter.exists(before)).toBe(true);
		expect((await manager.listSessions()).map((session) => session.path)).toEqual([after]);
	});

	it("keeps serving a vault whose folder is still the plugin-internal one", async () => {
		// Nothing migrates the logs an earlier release left there, so a manager
		// pointed at that folder has to read and write it rather than throw.
		const adapter = new MemoryAdapter();
		const manager = new ObsidianSessionManager(
			adapter as unknown as DataAdapter,
			mutablePolicy(SESSION_DIR, UNLIMITED_SESSION_RETENTION),
			"obsidian-vault:Test",
		);

		const info = await manager.createSession(DEFAULTS);

		expect(info.path.startsWith(`${SESSION_DIR}/`)).toBe(true);
		expect(await manager.countStoredSessions()).toBe(1);
	});

	it("reports no chats, and creates no folder, before the first one is written", async () => {
		// The folder is in the user's vault now, so an install that never chats must
		// not leave an empty directory in their file explorer.
		const adapter = new MemoryAdapter();
		const manager = new ObsidianSessionManager(
			adapter as unknown as DataAdapter,
			mutablePolicy(VAULT_SESSION_DIR, UNLIMITED_SESSION_RETENTION),
			"obsidian-vault:Test",
		);

		expect(await manager.countStoredSessions()).toBe(0);
		expect(await manager.listSessions()).toEqual([]);
		expect(await adapter.exists(VAULT_SESSION_DIR)).toBe(false);
	});

	it("counts the chats left in another folder, for the legacy notice", async () => {
		const adapter = new MemoryAdapter();
		const legacyManager = new ObsidianSessionManager(
			adapter as unknown as DataAdapter,
			mutablePolicy(SESSION_DIR, UNLIMITED_SESSION_RETENTION),
			"obsidian-vault:Test",
		);
		await createStampedSession(legacyManager, FUTURE_MS);
		await createStampedSession(legacyManager, FUTURE_MS + 1_000);
		const manager = new ObsidianSessionManager(
			adapter as unknown as DataAdapter,
			mutablePolicy(VAULT_SESSION_DIR, UNLIMITED_SESSION_RETENTION),
			"obsidian-vault:Test",
		);

		expect(await manager.countSessionsIn(SESSION_DIR)).toBe(2);
		expect(await manager.countSessionsIn(`${SESSION_DIR}/`)).toBe(2);
		// A folder that was never created is the state of every vault installed
		// after the move, and reads as empty rather than failing.
		expect(await manager.countSessionsIn("Nowhere/chats")).toBe(0);
	});
});

/**
 * Session fork, exercised through the manager rather than pi's repo directly:
 * what a fork copies, what the source keeps, and where the focus lands — the
 * promises the product makes when the reader presses the fork button on a reply.
 */
describe("ObsidianSessionManager session fork", () => {
	it("copies the conversation up to the reply into a new session", async () => {
		const manager = await sessionWithTurns(["first", "second"]);
		const source = manager.getActiveSessionPath()!;

		const forked = await manager.forkSession(source, await entryIdOfMessage(manager, "second"));

		expect(forked.path).not.toBe(source);
		// position "at" is the promise: the reply the button was pressed on is
		// part of the copy, so the new chat continues from that answer.
		expect(await textsOf(manager, forked.path)).toEqual(["first", "second"]);
	});

	it("leaves the source conversation and the focus on it untouched", async () => {
		const manager = await sessionWithTurns(["first", "second"]);
		const source = manager.getActiveSessionPath()!;

		await manager.forkSession(source, await entryIdOfMessage(manager, "second"));

		// Forking is an offer, not a switch: the reader keeps their current chat
		// on screen and adopts the copy by opening it.
		expect(manager.getActiveSessionPath()).toBe(source);
		expect(await textsOf(manager, source)).toEqual(["first", "second"]);
	});

	it("grows only the copy when the forked chat continues", async () => {
		const manager = await sessionWithTurns(["first", "second"]);
		const source = manager.getActiveSessionPath()!;
		const forked = await manager.forkSession(source, await entryIdOfMessage(manager, "second"));

		await manager.appendMessageFor(forked.path, { role: "user", content: [{ type: "text", text: "onward" }], timestamp: 3 });

		expect(await textsOf(manager, forked.path)).toEqual(["first", "second", "onward"]);
		expect(await textsOf(manager, source)).toEqual(["first", "second"]);
	});

	it("carries the source session's id as the fork's parent", async () => {
		const manager = await sessionWithTurns(["first", "second"]);
		const source = manager.getActiveSessionPath()!;
		const sourceId = (await manager.listSessions()).find((session) => session.path === source)!.id;

		const forked = await manager.forkSession(source, await entryIdOfMessage(manager, "second"));

		expect(forked.parentSessionId).toBe(sourceId);
		// The source was never a fork itself, so it carries no lineage.
		expect((await manager.listSessions()).find((session) => session.path === source)!.parentSessionId).toBeUndefined();
	});

	it("refuses to fork a session that is not loaded", async () => {
		const manager = await sessionWithTurns(["first"]);

		expect(await rejection(() => manager.forkSession("Nowhere/chats/none.jsonl", "e1"))).toBe(
			"No session loaded: Nowhere/chats/none.jsonl",
		);
	});
});

/**
 * The run ledger. An open entry blocks every later run on the session — pi
 * refuses a second open operation while one survives — so a crash mid-run has
 * to be recoverable, and recovery has to find the orphans where they lie.
 */
describe("ObsidianSessionManager run ledger", () => {
	it("closes the entry it opened", async () => {
		const manager = await sessionWithTurns(["first"]);
		const runId = await manager.beginRunOperation([]);

		await manager.endRunOperation(runId, "completed", undefined);

		expect(await manager.findOpenRunOperations()).toEqual([]);
	});

	it("sweeps the session for the runs a crash left open", async () => {
		const manager = await sessionWithTurns(["first"]);
		const mainRun = await manager.beginRunOperation([]);

		const open = await manager.findAllOpenRunOperations();

		expect([...open.keys()]).toEqual(["main"]);
		expect(open.get("main")?.map((record) => record.id)).toEqual([mainRun]);
	});

	it("keeps image bytes out of the ledger", async () => {
		const manager = await sessionWithTurns(["first"]);

		const runId = await manager.beginRunOperation([
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image", data: "AAAABBBBCCCC", mimeType: "image/png" },
				],
				timestamp: 1,
			},
		]);

		const [record] = await manager.findOpenRunOperations();
		expect(record?.id).toBe(runId);
		const serialized = JSON.stringify(record);
		expect(serialized).not.toContain("AAAABBBBCCCC");
	});
});

/** The message a call rejected with, or `undefined` when it resolved. */
async function rejection(call: () => Promise<unknown>): Promise<string | undefined> {
	try {
		await call();
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** A session whose main lane holds one user message per entry of `texts`. */
async function sessionWithTurns(texts: string[]): Promise<ObsidianSessionManager> {
	const adapter = new MemoryAdapter() as unknown as DataAdapter;
	const manager = new ObsidianSessionManager(adapter, SESSION_DIR, "obsidian-vault:Test");
	await manager.createSession(DEFAULTS);
	for (const [index, text] of texts.entries()) {
		await manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: index + 1 });
	}
	return manager;
}

/** The durable entry id of the message saying `text`, which is what a fork targets. */
async function entryIdOfMessage(manager: ObsidianSessionManager, text: string): Promise<string> {
	const entries = await manager.getSession().findEntries({ order: "oldestFirst" });
	const found = entries.find((entry) => entry.type === "message" && JSON.stringify(entry.message).includes(`"${text}"`));
	if (!found) {
		throw new Error(`No entry says: ${text}`);
	}
	return found.id;
}

/** The text of every message entry on a session's main line, oldest first. */
async function textsOf(manager: ObsidianSessionManager, path: string): Promise<string[]> {
	const context = await manager.buildSessionContextFor(path);
	return context.messages.flatMap((message) => {
		const { content } = message as { content?: unknown };
		if (!Array.isArray(content)) {
			return [];
		}
		return content.filter((part): part is { type: "text"; text: string } => (part as { type?: string }).type === "text").map((part) => part.text);
	});
}

function getParent(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}

describe("ObsidianSessionManager stored search", () => {
	const CWD = "obsidian-vault:Test";

	async function seed(adapter: DataAdapter, text: string): Promise<string> {
		const manager = new ObsidianSessionManager(adapter, SESSION_DIR, CWD);
		await manager.createSession(DEFAULTS);
		await manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
		return manager.getActiveSessionPath()!;
	}

	async function collect(manager: ObsidianSessionManager, query: string, options?: { limit?: number; signal?: AbortSignal }) {
		const hits = [];
		for await (const hit of manager.createStoredSessionSearch().search(query, options)) {
			hits.push(hit);
		}
		return hits;
	}

	it("finds a stored chat by its content and reports the path to open", async () => {
		const adapter = new MemoryAdapter() as unknown as DataAdapter;
		const path = await seed(adapter, "记得那次关于向量检索的讨论");

		const hits = await collect(new ObsidianSessionManager(adapter, SESSION_DIR, CWD), "向量检索");

		expect(hits).toHaveLength(1);
		expect(hits[0]?.path).toBe(path);
		expect(hits[0]?.entryType).toBe("message");
		expect(hits[0]?.snippet).toContain("向量检索");
	});

	it("does not leak tool arguments or thinking into the searchable text", async () => {
		const adapter = new MemoryAdapter() as unknown as DataAdapter;
		const manager = new ObsidianSessionManager(adapter, SESSION_DIR, CWD);
		await manager.createSession(DEFAULTS);
		await manager.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "answer" },
				{ type: "thinking", thinking: "hidden-reasoning" },
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "secret-note.md" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: 2,
		} as never);

		const searcher = new ObsidianSessionManager(adapter, SESSION_DIR, CWD);
		expect(await collect(searcher, "answer")).toHaveLength(1);
		expect(await collect(searcher, "hidden-reasoning")).toHaveLength(0);
		expect(await collect(searcher, "secret-note.md")).toHaveLength(0);
	});

	it("yields nothing for an empty query", async () => {
		const adapter = new MemoryAdapter() as unknown as DataAdapter;
		await seed(adapter, "anything");

		expect(await collect(new ObsidianSessionManager(adapter, SESSION_DIR, CWD), "   ")).toHaveLength(0);
	});

	it("stops opening further logs once the entry limit is reached", async () => {
		const memory = new MemoryAdapter();
		const adapter = memory as unknown as DataAdapter;
		await seed(adapter, "shared marker one");
		await seed(adapter, "shared marker two");
		const reads: string[] = [];
		const originalRead = memory.read.bind(memory);
		(memory as unknown as { read: (path: string) => Promise<string> }).read = async (path: string) => {
			reads.push(path);
			return originalRead(path);
		};

		const hits = await collect(new ObsidianSessionManager(adapter, SESSION_DIR, CWD), "shared marker", { limit: 1 });

		expect(hits).toHaveLength(1);
		// Listing reads a header from both logs; only the matching one is then
		// opened. Three reads rather than four is the proof the scan stopped.
		expect(reads).toHaveLength(3);
		expect(reads.filter((path) => path === hits[0]?.path)).toHaveLength(2);
	});

	it("stops at a session boundary when the caller aborts", async () => {
		const adapter = new MemoryAdapter() as unknown as DataAdapter;
		await seed(adapter, "marker one");
		await seed(adapter, "marker two");
		const controller = new AbortController();
		controller.abort();

		expect(await collect(new ObsidianSessionManager(adapter, SESSION_DIR, CWD), "marker", { signal: controller.signal })).toHaveLength(0);
	});

	it("keeps healthy chats searchable when one log is corrupt", async () => {
		const memory = new MemoryAdapter();
		const adapter = memory as unknown as DataAdapter;
		const healthy = await seed(adapter, "still findable");
		const broken = await seed(adapter, "irrelevant");
		await memory.write(broken, '{"kind":"header","version":4,"id":"broken","createdAt":0,"cwd":"obsidian-vault:Test"}\n{oops\n');

		const hits = await collect(new ObsidianSessionManager(adapter, SESSION_DIR, CWD), "still findable");

		expect(hits.map((hit) => hit.path)).toEqual([healthy]);
	});
});
