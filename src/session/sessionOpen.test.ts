import { describe, expect, it, spyOn } from "bun:test";
import type { DataAdapter } from "obsidian";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { ObsidianSessionManager } from "./ObsidianSessionManager";

const ROOT = "Piem/chats";
const CWD = "piem";
const DEFAULTS = { provider: "deepseek", modelId: "deepseek-v4-pro" };

/** Real Pi logs; only the vault's I/O is in memory. */
class ObservedAdapter extends MemoryAdapter {
	readonly reads: string[] = [];
	readonly listings: string[] = [];
	writes = 0;

	override async read(path: string): Promise<string> {
		this.reads.push(path);
		return super.read(path);
	}

	override async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		this.listings.push(path);
		return super.list(path);
	}

	override async write(path: string, text: string): Promise<void> {
		this.writes += 1;
		await super.write(path, text);
	}

	override async append(path: string, text: string): Promise<void> {
		this.writes += 1;
		await super.append(path, text);
	}

	reset(): void {
		this.reads.length = 0;
		this.listings.length = 0;
		this.writes = 0;
	}
}

function manager(adapter: MemoryAdapter, cwd = CWD): ObsidianSessionManager {
	return new ObsidianSessionManager(adapter as unknown as DataAdapter, ROOT, cwd);
}

async function seed(adapter: MemoryAdapter, text: string, cwd = CWD): Promise<string> {
	const writer = manager(adapter, cwd);
	const info = await writer.createSession(DEFAULTS);
	await writer.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
	return info.path;
}

describe("ObsidianSessionManager cold open", () => {
	it("reads only the requested conversation, including after a restart", async () => {
		const adapter = new ObservedAdapter();
		const path = await seed(adapter, "Target conversation");
		await seed(adapter, "Unrelated conversation".repeat(1_000));
		await seed(adapter, "Another vault name", "obsidian-vault:Old name");
		const original = adapter.contentOf(path);

		// Fresh managers model a process restart: metadata must not depend on a
		// warm cache to avoid reading every other conversation in the vault.
		for (let restart = 0; restart < 2; restart += 1) {
			adapter.reset();
			const reader = manager(adapter);
			const info = await reader.loadSession(path);

			expect(info.firstMessage).toBe("Target conversation");
			expect(adapter.reads.length).toBeGreaterThan(0);
			expect(adapter.reads.every((read) => read === path)).toBe(true);
			expect(adapter.listings).toEqual([]);
			expect(adapter.writes).toBe(0);
			expect(adapter.contentOf(path)).toBe(original);

			const live = reader.getSessionFor(path);
			adapter.reset();
			await reader.loadSession(path);
			expect(reader.getSessionFor(path)).toBe(live);
			expect(adapter.reads).toEqual([]);
			expect(adapter.writes).toBe(0);
		}
	});

	it("reads the native header after a file or vault-name change", async () => {
		const adapter = new ObservedAdapter();
		const oldPath = await seed(adapter, "Old vault conversation", "obsidian-vault:Old name");
		const path = oldPath.replace(/[^/]+$/, "hand-renamed.jsonl");
		await adapter.rename(oldPath, path);
		const expectedId = (JSON.parse(adapter.contentOf(path)!.split("\n")[0]!) as { id: string }).id;
		adapter.reset();

		const info = await manager(adapter).loadSession(path);

		expect(info.id).toBe(expectedId);
		expect(info.path).toBe(path);
		expect(info.firstMessage).toBe("Old vault conversation");
		expect(adapter.writes).toBe(0);
	});

	it("prepares a conversation without changing focus or the last-opened record", async () => {
		const adapter = new ObservedAdapter();
		const first = await seed(adapter, "Visible conversation");
		const second = await seed(adapter, "Prepared conversation");
		const store: { recorded: string | null } = { recorded: null };
		const reader = new ObsidianSessionManager(adapter as unknown as DataAdapter, ROOT, CWD, undefined, {
			read: () => store.recorded,
			write: (path) => { store.recorded = path; },
		});
		await reader.loadSession(first);
		adapter.reset();

		const prepared = await reader.prepareSession(second);

		expect(prepared.firstMessage).toBe("Prepared conversation");
		expect(reader.getActiveSessionPath()).toBe(first);
		expect(store.recorded).toBe(first);
		expect(adapter.writes).toBe(0);
		const live = reader.getSessionFor(second);
		adapter.reset();
		await reader.loadSession(second);
		expect(reader.getActiveSessionPath()).toBe(second);
		expect(store.recorded).toBe(second);
		expect(reader.getSessionFor(second)).toBe(live);
		expect(adapter.reads).toEqual([]);
	});

	it("commits prepared focus synchronously and rejects an unprepared target", async () => {
		const adapter = new ObservedAdapter();
		const first = await seed(adapter, "Visible conversation");
		const second = await seed(adapter, "Next conversation");
		const store: { recorded: string | null } = { recorded: null };
		const reader = new ObsidianSessionManager(adapter as unknown as DataAdapter, ROOT, CWD, undefined, {
			read: () => store.recorded,
			write: (path) => { store.recorded = path; },
		});
		await reader.loadSession(first);
		adapter.reset();

		expect(() => reader.focusSession(second)).toThrow();
		expect(reader.getActiveSessionPath()).toBe(first);
		expect(store.recorded).toBe(first);
		expect(adapter.reads).toEqual([]);

		await reader.prepareSession(second);
		adapter.reset();
		reader.focusSession(second);
		expect(reader.getActiveSessionPath()).toBe(second);
		expect(store.recorded).toBe(second);
		expect(adapter.reads).toEqual([]);
		expect(adapter.writes).toBe(0);
	});

	it.each([
		"Piem/chats-other/--piem--/outside.jsonl",
		"Piem/chats/flat.jsonl",
		"Piem/chats/--piem--/nested/deep.jsonl",
		"Piem/chats/--piem--/note.md",
		"Piem/chats/../outside.jsonl",
		"/Piem/chats/--piem--/absolute.jsonl",
	])("rejects a path outside the repository's listing boundary: %s", async (outside) => {
		const adapter = new ObservedAdapter();
		const path = await seed(adapter, "Keep focus here");
		const reader = manager(adapter);
		await reader.loadSession(path);
		// Put a valid log at the untrusted path. A rejection based only on the
		// file being absent would not protect the repository boundary.
		await adapter.write(outside, adapter.contentOf(path)!);
		adapter.reset();

		await expect(reader.loadSession(outside)).rejects.toThrow();

		expect(reader.getActiveSessionPath()).toBe(path);
		expect(adapter.reads).not.toContain(outside);
		expect(adapter.writes).toBe(0);
	});

	it.each(["header", "mutation"])("rejects a corrupt %s without changing the file", async (corruption) => {
		const adapter = new ObservedAdapter();
		const path = await seed(adapter, "Unreadable conversation");
		const original = adapter.contentOf(path)!;
		const broken = corruption === "header"
			? original.replace('"version":4', '"version":3')
			: `${original}{"kind":"entry","seq":999,"type":"unknown"}\n`;
		await adapter.write(path, broken);
		adapter.reset();

		await expect(manager(adapter).loadSession(path)).rejects.toThrow();

		expect(adapter.contentOf(path)).toBe(broken);
		expect(adapter.writes).toBe(0);
	});

	it("shares one native Session between overlapping cold opens", async () => {
		const adapter = new ObservedAdapter();
		const path = await seed(adapter, "Original message");
		const reader = manager(adapter);
		const open = spyOn(JsonlSessionRepo.prototype, "open");
		try {
			const [first, second] = await Promise.all([
				reader.loadSession(path).then(() => reader.getSessionFor(path)),
				reader.loadSession(path).then(() => reader.getSessionFor(path)),
			]);

			expect(open).toHaveBeenCalledTimes(1);
			expect(first).toBe(second);
			// Both callers may keep the returned handle. Their writes must share
			// Pi's mutation queue and survive a brand-new repository opening them.
			await Promise.all([
				first.appendMessage({ role: "user", content: "First caller", timestamp: 2 }),
				second.appendMessage({ role: "user", content: "Second caller", timestamp: 3 }),
			]);
		} finally {
			open.mockRestore();
		}
		expect((await manager(adapter).loadSession(path)).messageCount).toBe(3);
	});

	it("retries after a shared cold open failed", async () => {
		const adapter = new ObservedAdapter();
		const path = await seed(adapter, "Recovered conversation");
		const original = adapter.contentOf(path)!;
		await adapter.write(path, "unreadable header\n");
		const reader = manager(adapter);
		const failed = await Promise.allSettled([reader.loadSession(path), reader.loadSession(path)]);
		expect(failed.map((result) => result.status)).toEqual(["rejected", "rejected"]);

		await adapter.write(path, original);
		adapter.reset();
		expect((await reader.loadSession(path)).firstMessage).toBe("Recovered conversation");
		expect(adapter.writes).toBe(0);
	});
});
