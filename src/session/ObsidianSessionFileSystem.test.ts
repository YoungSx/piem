import { describe, expect, it } from "bun:test";
import type { DataAdapter } from "obsidian";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { ObsidianSessionFileSystem } from "./ObsidianSessionFileSystem";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { scanDiskLines, type SessionDriftEvent } from "./sessionMutationLine";

const SESSIONS_ROOT = "Piem/chats";
const LEGACY_ROOT = `.${"obsidian"}/plugins/piem/sessions`;
const CWD = "piem";

function setup(): { adapter: MemoryAdapter; fs: ObsidianSessionFileSystem; repo: JsonlSessionRepo } {
	const adapter = new MemoryAdapter();
	const fs = new ObsidianSessionFileSystem(adapter as unknown as DataAdapter);
	return { adapter, fs, repo: new JsonlSessionRepo({ fs, sessionsRoot: SESSIONS_ROOT }) };
}

/** Unwraps a pi `Result`, failing the test with its error rather than a type error. */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: Error }): T {
	if (!result.ok) {
		throw result.error;
	}
	return result.value;
}

describe("ObsidianSessionFileSystem", () => {
	it("keeps paths vault-relative, so stored session paths need no translation", async () => {
		const { fs } = setup();

		expect(fs.cwd).toBe("");
		expect(unwrap(await fs.absolutePath(SESSIONS_ROOT))).toBe(SESSIONS_ROOT);
		expect(unwrap(await fs.joinPath([SESSIONS_ROOT, "--piem--", "a.jsonl"]))).toBe(`${SESSIONS_ROOT}/--piem--/a.jsonl`);
	});

	/**
	 * The reason this class exists rather than reusing `VaultExecutionEnv`, which
	 * refuses plugin-internal paths outright.
	 */
	it("serves the folder earlier releases wrote chats into", async () => {
		const { adapter, fs } = setup();
		await adapter.mkdir(LEGACY_ROOT);
		await adapter.write(`${LEGACY_ROOT}/old.jsonl`, "{}\n");

		expect(unwrap(await fs.exists(`${LEGACY_ROOT}/old.jsonl`))).toBe(true);
		expect(unwrap(await fs.listDir(LEGACY_ROOT)).map((info) => info.name)).toEqual(["old.jsonl"]);
	});

	it("reports a rejected path as invalid instead of throwing", async () => {
		const { fs } = setup();

		const escaping = await fs.exists("../outside");
		expect(escaping.ok).toBe(false);
		expect(escaping.ok === false && escaping.error.code).toBe("invalid");
	});

	it("reports a missing file as not_found instead of throwing", async () => {
		const { fs } = setup();

		const missing = await fs.readTextFile("Piem/chats/absent.jsonl");
		expect(missing.ok).toBe(false);
		expect(missing.ok === false && missing.error.code).toBe("not_found");

		const stat = await fs.fileInfo("Piem/chats/absent.jsonl");
		expect(stat.ok === false && stat.error.code).toBe("not_found");
	});

	it("honours an already-aborted signal", async () => {
		const { fs } = setup();
		const controller = new AbortController();
		controller.abort();

		const aborted = await fs.exists(SESSIONS_ROOT, controller.signal);
		expect(aborted.ok === false && aborted.error.code).toBe("aborted");
	});

	it("stops readTextLines at maxLines and drops the trailing newline", async () => {
		const { adapter, fs } = setup();
		await adapter.mkdir(SESSIONS_ROOT);
		await adapter.write(`${SESSIONS_ROOT}/a.jsonl`, "one\ntwo\nthree\n");

		expect(unwrap(await fs.readTextLines(`${SESSIONS_ROOT}/a.jsonl`, { maxLines: 1 }))).toEqual(["one"]);
		expect(unwrap(await fs.readTextLines(`${SESSIONS_ROOT}/a.jsonl`))).toEqual(["one", "two", "three"]);
	});

	it("creates parent directories on write", async () => {
		const { adapter, fs } = setup();

		unwrap(await fs.writeFile("Piem/chats/--piem--/a.jsonl", "{}\n"));

		expect(await adapter.exists("Piem")).toBe(true);
		expect(await adapter.exists("Piem/chats/--piem--")).toBe(true);
	});

	it("replaces the destination on rename, which adapter.rename alone refuses", async () => {
		const { adapter, fs } = setup();
		await adapter.mkdir(SESSIONS_ROOT);
		await adapter.write(`${SESSIONS_ROOT}/a.jsonl.tmp`, "new\n");
		await adapter.write(`${SESSIONS_ROOT}/a.jsonl`, "old\n");
		adapter.allowReplaceRemoval = true;

		unwrap(await fs.renameFile(`${SESSIONS_ROOT}/a.jsonl.tmp`, `${SESSIONS_ROOT}/a.jsonl`));

		expect(await adapter.read(`${SESSIONS_ROOT}/a.jsonl`)).toBe("new\n");
		expect(await adapter.exists(`${SESSIONS_ROOT}/a.jsonl.tmp`)).toBe(false);
	});

	/**
	 * The split that makes the whole class worth writing: a chat log is the only
	 * copy of a conversation and must stay recoverable, while pi's staging files
	 * are debris that would otherwise pile up in the user's trash on every fork.
	 */
	it("trashes chat logs but hard-deletes pi's staging files", async () => {
		const { adapter, fs } = setup();
		await adapter.mkdir(SESSIONS_ROOT);
		await adapter.write(`${SESSIONS_ROOT}/a.jsonl`, "{}\n");
		await adapter.write(`${SESSIONS_ROOT}/a.jsonl.tmp`, "{}\n");

		unwrap(await fs.remove(`${SESSIONS_ROOT}/a.jsonl.tmp`, { force: true }));
		unwrap(await fs.remove(`${SESSIONS_ROOT}/a.jsonl`, { force: true }));

		expect(adapter.trashed).toEqual([`${SESSIONS_ROOT}/a.jsonl`]);
		expect(adapter.removed).toEqual([`${SESSIONS_ROOT}/a.jsonl.tmp`]);
	});

	it("treats a missing path as removed only when forced", async () => {
		const { fs } = setup();

		expect(unwrap(await fs.remove("Piem/chats/absent.jsonl", { force: true }))).toBeUndefined();
		const unforced = await fs.remove("Piem/chats/absent.jsonl");
		expect(unforced.ok === false && unforced.error.code).toBe("not_found");
	});

	// Everything above verifies one method. What follows drives pi's real repo,
	// which is the only thing that proves the twelve of them compose.
	describe("driving pi's JsonlSessionRepo", () => {
		it("round-trips a session through create, list, and open", async () => {
			const { repo } = setup();

			const created = await repo.create({ cwd: CWD });
			await created.appendEntry({ type: "message", id: "hello", message: userMessage("hello") }, "main");
			await created.setName("First chat");

			const listed = await repo.list();
			expect(listed).toHaveLength(1);
			expect(listed[0]?.id).toBe((await created.getMetadata()).id);

			const reopened = await repo.open(listed[0]!);
			expect(await reopened.getName()).toBe("First chat");
			const entries = await reopened.findEntriesOnBranch({ order: "oldestFirst" });
			expect(entries.map((entry) => entry.type)).toEqual(["message"]);
		});

		/**
		 * Pins the `--<cwd>--` level. pi composes it and collapsing it away was
		 * ruled out, so a chat log's path is the sessions root, that directory, and
		 * a timestamped filename — which is what `ActiveSessionInfo.path` carries.
		 */
		it("writes into pi's cwd-encoded directory under our sessions root", async () => {
			const { adapter, repo } = setup();

			const created = await repo.create({ cwd: CWD });

			expect(await adapter.exists(`${SESSIONS_ROOT}/--${CWD}--`)).toBe(true);
			const logs = adapter.filePaths();
			expect(logs).toHaveLength(1);
			expect(logs[0]).toStartWith(`${SESSIONS_ROOT}/--${CWD}--/`);
			expect(logs[0]).toEndWith(`_${(await created.getMetadata()).id}.jsonl`);
		});

		it("persists a rewound branch, which the hand-written manager kept only in memory", async () => {
			const { repo } = setup();

			const created = await repo.create({ cwd: CWD });
			const first = await created.appendEntry({ type: "message", id: "first", message: userMessage("first") }, "main");
			await created.appendEntry({ type: "message", id: "discarded", message: userMessage("discarded") }, "main");
			await created.moveLane("main", first.parentId);
			await created.appendEntry({ type: "message", id: "replacement", message: userMessage("replacement") }, "main");

			const listed = await repo.list();
			const reopened = await repo.open(listed[0]!);
			const messages = (await reopened.findEntriesOnBranch({ order: "oldestFirst" })).map((entry) =>
				entry.type === "message" && entry.message.role === "user" ? userText(entry.message) : null,
			);
			expect(messages).toEqual(["replacement"]);
		});

		it("sends a deleted session to trash rather than removing it", async () => {
			const { adapter, repo } = setup();
			const created = await repo.create({ cwd: CWD });
			const [metadata] = await repo.list();

			await repo.delete(metadata!);

			expect(adapter.trashed).toHaveLength(1);
			expect(adapter.trashed[0]).toEndWith(`_${(await created.getMetadata()).id}.jsonl`);
			expect(await repo.list()).toEqual([]);
		});

		it("lists nothing before the sessions folder exists", async () => {
			const { repo } = setup();

			expect(await repo.list()).toEqual([]);
		});
	});

	// The vault sync plugin arbitrates whole files last-writer-wins, so between
	// two of our appends a foreign file version can land on disk. These tests
	// stand in for that plugin with direct `adapter.write` calls — bypassing the
	// fs on purpose, the way a foreign writer would.
	describe("sync-drift repair net", () => {
		function setupWithDriftLog(): { adapter: MemoryAdapter; drifts: SessionDriftEvent[]; fs: ObsidianSessionFileSystem; repo: JsonlSessionRepo } {
			const adapter = new MemoryAdapter();
			const drifts: SessionDriftEvent[] = [];
			const fs = new ObsidianSessionFileSystem(adapter as unknown as DataAdapter, undefined, (event) => drifts.push(event));
			return { adapter, drifts, fs, repo: new JsonlSessionRepo({ fs, sessionsRoot: SESSIONS_ROOT }) };
		}

		/** Appends valid, lane-chained entries to the raw file, as the other device would. */
		async function appendForeignEntries(adapter: MemoryAdapter, path: string, ids: string[]): Promise<void> {
			const content = await adapter.read(path);
			const disk = scanDiskLines(content.split("\n"));
			let leaf = disk.laneLeaves.get("main") ?? null;
			let seq = disk.maxSeq;
			const additions: string[] = [];
			for (const id of ids) {
				seq += 1;
				additions.push(
					`${JSON.stringify({
						kind: "entry", seq, lane: "main", id, type: "message",
						parentId: leaf, timestamp: 2000 + seq,
						message: { role: "user", content: [{ type: "text", text: id }] },
					})}\n`,
				);
				leaf = id;
			}
			await adapter.write(path, content + additions.join(""));
		}

		async function branchTexts(repo: JsonlSessionRepo): Promise<Array<string | null>> {
			const [listed] = await repo.list();
			const reopened = await repo.open(listed!);
			const entries = await reopened.findEntriesOnBranch({ order: "oldestFirst" });
			return entries.map((entry) => (entry.type === "message" && entry.message.role === "user" ? userText(entry.message) : null));
		}

		/**
		 * The core scenario: device A appends, the sync plugin lands device B's
		 * version, A keeps typing against its stale in-memory view. The stale seq
		 * and stale parent would brick the file at next load; the net rewrites the
		 * line instead, and the merged content survives a real reopen.
		 */
		it("repairs a stale append after a foreign write lands between appends", async () => {
			const { adapter, drifts, repo } = setupWithDriftLog();
			const created = await repo.create({ cwd: CWD });
			const path = adapter.filePaths()[0]!;

			await created.appendEntry({ type: "message", id: "local-a", message: userMessage("local-a") }, "main");
			await appendForeignEntries(adapter, path, ["foreign-0", "foreign-1"]);
			await created.appendEntry({ type: "message", id: "local-b", message: userMessage("local-b") }, "main");

			expect(drifts).toEqual([{ path, action: "repaired", kind: "entry", seq: expect.any(Number) }]);
			expect(await branchTexts(repo)).toEqual(["local-a", "foreign-0", "foreign-1", "local-b"]);
		});

		/**
		 * The stale session never learns the disk's seq, so every later append is
		 * renumbered too — the file must stay loadable across arbitrarily many of
		 * them, which is what one read per append buys.
		 */
		it("keeps the file loadable across consecutive stale appends", async () => {
			const { adapter, repo } = setupWithDriftLog();
			const created = await repo.create({ cwd: CWD });
			const path = adapter.filePaths()[0]!;

			await created.appendEntry({ type: "message", id: "local-a", message: userMessage("local-a") }, "main");
			await appendForeignEntries(adapter, path, ["foreign-0", "foreign-1"]);
			await created.appendEntry({ type: "message", id: "local-b", message: userMessage("local-b") }, "main");
			await created.appendEntry({ type: "message", id: "local-c", message: userMessage("local-c") }, "main");
			await created.setName("Renamed after drift");

			expect(await branchTexts(repo)).toEqual(["local-a", "foreign-0", "foreign-1", "local-b", "local-c"]);
			const [listed] = await repo.list();
			expect(await (await repo.open(listed!)).getName()).toBe("Renamed after drift");
		});

		/**
		 * The same entry id arriving twice is the one thing a rewrite cannot fix —
		 * the id must be unique. pi's uuids make the collision practically
		 * unreachable, so this drives the fs choke point directly with the line pi
		 * would have sent; the valve is dropping it, and the next append must
		 * still land on a healthy file.
		 */
		it("drops an append whose id the disk already used", async () => {
			const { adapter, drifts, fs, repo } = setupWithDriftLog();
			const created = await repo.create({ cwd: CWD });
			const path = adapter.filePaths()[0]!;

			await created.appendEntry({ type: "message", id: "shared", message: userMessage("from A") }, "main");
			await appendForeignEntries(adapter, path, ["foreign-0"]);
			const before = await adapter.read(path);
			const collision = `${JSON.stringify({
				kind: "entry", seq: 2, lane: "main", id: "shared", type: "message",
				parentId: "shared", timestamp: 2000,
				message: { role: "user", content: [{ type: "text", text: "duplicate id" }] },
			})}\n`;
			unwrap(await fs.appendFile(path, collision));

			// The duplicate is dropped, and the next append is repaired onto the
			// foreign tail — the file stays loadable either way.
			expect(await adapter.read(path)).toBe(before);
			await created.appendEntry({ type: "message", id: "after", message: userMessage("after") }, "main");
			expect(drifts).toEqual([
				{ path, action: "dropped", kind: "entry" },
				{ path, action: "repaired", kind: "entry", seq: expect.any(Number) },
			]);
			expect(await branchTexts(repo)).toEqual(["from A", "foreign-0", "after"]);
		});

		it("passes ordinary back-to-back appends without touching the net", async () => {
			const { drifts, repo } = setupWithDriftLog();
			const created = await repo.create({ cwd: CWD });

			await created.appendEntry({ type: "message", id: "a", message: userMessage("a") }, "main");
			await created.appendEntry({ type: "message", id: "b", message: userMessage("b") }, "main");

			expect(drifts).toEqual([]);
			expect(await branchTexts(repo)).toEqual(["a", "b"]);
		});

		/**
		 * A fs instance that never wrote the file (a reload after the plugin
		 * restarted) has no baseline — its first append must verify by reading,
		 * not assume drift, and a correct line must pass byte-identical.
		 */
		it("verifies the first append of a fresh fs instance against the disk without rewriting", async () => {
			const { adapter, drifts, repo } = setupWithDriftLog();
			const created = await repo.create({ cwd: CWD });
			await created.appendEntry({ type: "message", id: "a", message: userMessage("a") }, "main");
			const path = adapter.filePaths()[0]!;
			const before = await adapter.read(path);

			const refreshed = new ObsidianSessionFileSystem(adapter as unknown as DataAdapter, undefined, (event) => drifts.push(event));
			const freshRepo = new JsonlSessionRepo({ fs: refreshed, sessionsRoot: SESSIONS_ROOT });
			const reopened = await freshRepo.open((await freshRepo.list())[0]!);
			await reopened.appendEntry({ type: "message", id: "b", message: userMessage("b") }, "main");

			expect(drifts).toEqual([]);
			const after = await adapter.read(path);
			expect(after.startsWith(before)).toBe(true);
			expect(await branchTexts(freshRepo)).toEqual(["a", "b"]);
		});
	});
});

function userMessage(text: string) {
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
}

function userText(message: { content: string | Array<{ type?: string; text?: string } | string> }): string {
	if (typeof message.content === "string") {
		return message.content;
	}
	return message.content
		.filter((part): part is { type: "text"; text: string } => typeof part !== "string" && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}
