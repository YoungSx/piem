import { describe, expect, it } from "bun:test";
import type { DataAdapter } from "obsidian";
import { ObsidianSessionManager } from "./ObsidianSessionManager";
import { MemoryAdapter } from "../testUtils/memoryAdapter";

const ROOT = "My conversations";
const CWD = "obsidian-vault:Test";
const DEFAULTS = { provider: "test", modelId: "test", thinkingLevel: "off" as const };

class ObservedAdapter extends MemoryAdapter {
	readonly reads: string[] = [];
	afterRead?: (path: string) => void;
	failRead = new Set<string>();
	async read(path: string): Promise<string> {
		this.reads.push(path);
		if (this.failRead.has(path)) throw new Error("Read failed");
		const text = await super.read(path);
		this.afterRead?.(path);
		return text;
	}
}

function manager(adapter: MemoryAdapter, root = ROOT, cwd = CWD): ObsidianSessionManager {
	return new ObsidianSessionManager(adapter as unknown as DataAdapter, root, cwd);
}

async function seed(adapter: MemoryAdapter, text: string, root = ROOT, cwd = CWD): Promise<string> {
	const sessions = manager(adapter, root, cwd);
	await sessions.createSession(DEFAULTS);
	await sessions.appendMessage({ role: "user", content: text, timestamp: 1 });
	return sessions.getActiveSessionPath()!;
}

describe("bounded conversation search", () => {
	it("returns a source conversation and entry from the configured folder", async () => {
		const adapter = new ObservedAdapter();
		const path = await seed(adapter, "决定采用 Markdown 记忆");
		adapter.reads.length = 0;
		const result = await manager(adapter).searchStoredSessionsPage("Markdown");
		expect(result.hits).toHaveLength(1);
		expect(result.hits[0]).toMatchObject({ path, entryType: "message", snippet: "决定采用 Markdown 记忆" });
		expect(result.hits[0]?.sessionId).toBeTruthy();
		expect(result.hits[0]?.entryId).toBeTruthy();
		// Header and body share the one read: no duplicate full-log load.
		expect(adapter.reads).toEqual([path]);
	});

	it("paginates before reading headers, even when there are no hits", async () => {
		const adapter = new ObservedAdapter();
		for (let n = 0; n < 25; n++) {
			const path = await seed(adapter, `fact ${n}`);
			adapter.setMtime(path, n + 1);
		}
		adapter.reads.length = 0;
		const sessions = manager(adapter);
		const first = await sessions.searchStoredSessionsPage("absent");
		expect(first.hits).toEqual([]);
		expect(first.nextOffset).toBe(20);
		expect(first.scanned).toBe(20);
		expect(adapter.reads).toHaveLength(20);
		const second = await sessions.searchStoredSessionsPage("fact", { offset: first.nextOffset! });
		expect(second.hits).toHaveLength(5);
		expect(second.nextOffset).toBeNull();
		expect(new Set(adapter.reads).size).toBe(25);
	});

	it("searches conversation text without exposing raw tool results", async () => {
		const adapter = new ObservedAdapter();
		const sessions = manager(adapter);
		await sessions.createSession(DEFAULTS);
		await sessions.appendMessage({ role: "user", content: "visible decision", timestamp: 1 });
		await sessions.appendMessage({
			role: "toolResult", toolCallId: "t1", toolName: "read",
			content: [{ type: "text", text: "tool-only payload" }], isError: false, timestamp: 2,
		});
		expect((await sessions.searchStoredSessionsPage("tool-only")).hits).toEqual([]);
		const visible = await sessions.searchStoredSessionsPage("decision");
		expect(visible.hits.map((hit) => hit.snippet)).toEqual(["visible decision"]);
	});

	it("stops after a bounded byte budget and can continue the remaining page", async () => {
		const adapter = new ObservedAdapter();
		for (let n = 0; n < 6; n++) {
			const path = await seed(adapter, `marker ${n} ${"x".repeat(1_500_000)}`);
			adapter.setMtime(path, n + 1);
		}
		adapter.reads.length = 0;
		const sessions = manager(adapter);
		const first = await sessions.searchStoredSessionsPage("marker");
		expect(first.hits).toHaveLength(5);
		expect(first.nextOffset).toBe(5);
		expect(adapter.reads).toHaveLength(5);
		const rest = await sessions.searchStoredSessionsPage("marker", { offset: first.nextOffset! });
		expect(rest.hits).toHaveLength(1);
		expect(rest.nextOffset).toBeNull();
	});

	it("skips an oversized file without reading its header or blocking healthy chats", async () => {
		const adapter = new ObservedAdapter();
		const large = await seed(adapter, "x".repeat(2 * 1024 * 1024 + 1));
		const healthy = await seed(adapter, "find this marker");
		adapter.reads.length = 0;
		const result = await manager(adapter).searchStoredSessionsPage("marker");
		expect(result.skipped).toEqual([large]);
		expect(result.hits.map((hit) => hit.path)).toEqual([healthy]);
		expect(adapter.reads).toEqual([healthy]);
	});

	it("never rewrites a torn or unterminated log during search", async () => {
		const adapter = new ObservedAdapter();
		const broken = await seed(adapter, "marker in a torn chat");
		const unfinished = await seed(adapter, "marker without final newline");
		const healthy = await seed(adapter, "marker in a healthy chat");
		await adapter.append(broken, '{"kind":');
		await adapter.write(unfinished, adapter.contentOf(unfinished)!.trimEnd());
		const before = new Map(adapter.filePaths().map((path) => [path, adapter.contentOf(path)]));
		const result = await manager(adapter).searchStoredSessionsPage("marker");
		expect(result.hits.map((hit) => hit.path)).toEqual([healthy]);
		expect(result.skipped.sort()).toEqual([broken, unfinished].sort());
		expect(new Map(adapter.filePaths().map((path) => [path, adapter.contentOf(path)]))).toEqual(before);
		expect(adapter.removed).toEqual([]);
		expect(adapter.trashed).toEqual([]);
	});

	it("reports a failed header read and still searches the next file", async () => {
		const adapter = new ObservedAdapter();
		const broken = await seed(adapter, "not readable");
		const healthy = await seed(adapter, "marker");
		adapter.failRead.add(broken);
		const result = await manager(adapter).searchStoredSessionsPage("marker");
		expect(result.hits.map((hit) => hit.path)).toEqual([healthy]);
		expect(result.skipped).toEqual([broken]);
	});

	it("cancels after one read without reading the remaining headers", async () => {
		const adapter = new ObservedAdapter();
		await seed(adapter, "first");
		await seed(adapter, "second");
		adapter.reads.length = 0;
		const controller = new AbortController();
		adapter.afterRead = () => controller.abort();
		await expect(manager(adapter).searchStoredSessionsPage("marker", { signal: controller.signal })).rejects.toThrow("aborted");
		expect(adapter.reads).toHaveLength(1);
	});

	it("does not read an out-of-scope conversation or create a missing chat directory", async () => {
		const adapter = new ObservedAdapter();
		await seed(adapter, "foreign root", "Other chats");
		await seed(adapter, "foreign vault", ROOT, "obsidian-vault:Other");
		adapter.reads.length = 0;
		expect((await manager(adapter).searchStoredSessionsPage("foreign")).hits).toEqual([]);
		expect(adapter.reads).toEqual([]);
		expect(await adapter.exists(`${ROOT}/--obsidian-vault-Test--`)).toBe(false);
	});

	it("rejects invalid parameters and an already cancelled request without disk reads", async () => {
		const adapter = new ObservedAdapter();
		const sessions = manager(adapter);
		await expect(sessions.searchStoredSessionsPage(" ")).rejects.toThrow("non-empty");
		await expect(sessions.searchStoredSessionsPage("fact", { offset: -1 })).rejects.toThrow("offset");
		await expect(sessions.searchStoredSessionsPage("fact", { signal: AbortSignal.abort() })).rejects.toThrow("aborted");
		expect(adapter.reads).toEqual([]);
	});
});
