import { expect, it } from "bun:test";
import type { DataAdapter } from "obsidian";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { ObsidianSessionFileSystem } from "./ObsidianSessionFileSystem";
import { VaultSessionRepository } from "./SessionRepository";
import { ObsidianSessionManager } from "./ObsidianSessionManager";
import { jsonEqual } from "./jsonEqual";
import type { Entry } from "./sessionTypes";

async function fixture() {
	const adapter = new MemoryAdapter();
	const root = "Piem/chats";
	const path = `${root}/--vault--/legacy.jsonl`;
	await adapter.mkdir(root);
	await adapter.mkdir(`${root}/--vault--`);
	const entries: Array<Entry & { kind: "entry" }> = [
		{ kind: "entry", id: "first", parentId: null, type: "message", message: { role: "user", content: "Before", timestamp: 1 }, seq: 1, timestamp: 1 },
		{ kind: "entry", id: "orphan", parentId: "missing", type: "message", message: { role: "user", content: "After missing parent", timestamp: 2 }, seq: 2, timestamp: 2 },
		{ kind: "entry", id: "child", parentId: "orphan", type: "message", message: { role: "user", content: "Child", timestamp: 3 }, seq: 3, timestamp: 3 },
	];
	const original = [
		{ kind: "header", v: 4, id: "legacy", cwd: "vault", createdAt: 1 },
		...entries,
		{ kind: "lane", seq: 4, lane: "main", leafId: "child" },
		{ kind: "lane", seq: 5, lane: "earlier", leafId: "first" },
		{ kind: "fact", seq: 6, fact: "name", name: "Old chat" },
		{ kind: "fact", seq: 7, fact: "label", targetId: "orphan", label: "Saved" },
		{ kind: "value", op: "set", seq: 8, namespace: "pi.operation.meta", key: "run", value: { lane: "main", sourceTipId: "child", intent: {}, startedAt: 8 } },
	].map(item => JSON.stringify(item)).join("\n") + "\n";
	await adapter.write(path, original);
	const repo = new VaultSessionRepository({ fileSystem: new ObsidianSessionFileSystem(adapter as unknown as DataAdapter), sessionsRoot: root });
	return { adapter, repo, root, path, original, entries };
}

it("lists and probes legacy history without migrating or writing any files", async () => {
	const { adapter, root, path, original } = await fixture();
	adapter.write = () => { throw new Error("Read-only probe wrote a file"); };
	adapter.append = () => { throw new Error("Read-only probe appended a file"); };
	const manager = new ObsidianSessionManager(adapter as unknown as DataAdapter, root, "vault");
	expect(await manager.resolveResumeCandidate()).toMatchObject({ path, name: "Old chat", messageCount: 3, firstMessage: "Before" });
	expect((await manager.findAllOpenRunOperationsFor(path)).get("main")).toMatchObject([{ id: "run" }]);
	expect(await adapter.read(path)).toBe(original);
	expect(adapter.filePaths()).toEqual([path]);
});

it("migrates reordered message fields and missing-parent boundaries without losing data", async () => {
	const { adapter, repo, path, original, entries } = await fixture();
	const metadata = (await repo.list())[0]!;
	const session = await repo.open(metadata);
	try {
		expect(await session.findEntries()).toEqual(entries.map(({ kind: _kind, ...entry }) => entry));
		expect((await session.view().findEntries()).map(entry => entry.id)).toEqual(["orphan", "child"]);
		expect((await session.view("earlier").findEntries()).map(entry => entry.id)).toEqual(["first"]);
		expect(await session.getLabel("orphan")).toBe("Saved");
		expect(await session.getName()).toBe("Old chat");
		await session.appendMessage("Can continue");
	} finally { await session.close(); }
	expect(await adapter.read(adapter.filePaths().find(file => file.endsWith(".legacy"))!)).toBe(original);
	const reopened = await repo.open(metadata);
	try { expect(await reopened.findEntries()).toHaveLength(4); }
	finally { await reopened.close(); }
	expect(JSON.parse((await adapter.read(path)).split("\n")[0]!).v).toBe(6);
});

it("ignores object key order but still rejects lost content and reordered arrays", () => {
	expect(jsonEqual({ a: 1, b: { x: 2, y: 3 } }, { b: { y: 3, x: 2 }, a: 1 })).toBe(true);
	expect(jsonEqual({ content: "original" }, { content: "changed" })).toBe(false);
	expect(jsonEqual([1, 2], [2, 1])).toBe(false);
});

it("refuses changed staged content before replacing the original conversation", async () => {
	const { adapter, repo, path, original } = await fixture();
	const append = adapter.append.bind(adapter);
	adapter.append = (file, text) => append(file, file.endsWith(".migrating.tmp") ? text.replace("After missing parent", "Changed staged content") : text);
	await expect(repo.open((await repo.list())[0]!)).rejects.toThrow("Conversation migration verification failed");
	expect(await adapter.read(path)).toBe(original);
	expect(adapter.filePaths().some(file => file.endsWith(".legacy"))).toBe(false);
});
