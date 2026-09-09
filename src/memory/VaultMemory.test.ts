import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { installObsidianStub } from "../testUtils/obsidianStub";
import { stubWindowMembers } from "../testUtils/windowStub";
import { MEMORY_MAX_BYTES, MEMORY_PATH } from "./memoryEdits";

installObsidianStub();
const { MemoryVault } = await import("../testUtils/memoryVault");
const { VaultMemory } = await import("./VaultMemory");
let restoreWindow: () => void;
beforeEach(() => { restoreWindow = stubWindowMembers({ crypto: globalThis.crypto }); });
afterEach(() => restoreWindow());

describe("VaultMemory updates", () => {
	it("saves on the first occurrence and recalls it through a fresh instance", async () => {
		const vault = new MemoryVault();
		await new VaultMemory(vault.app).update(undefined, [{ type: "append", text: '- 2026-09-09 | vault-wide | User: "Reply in Chinese".' }]);
		const recall = await new VaultMemory(vault.app).read();
		expect(recall.documents).toHaveLength(1);
		expect(recall.documents[0]?.text).toContain("Reply in Chinese");
		expect(vault.writes).toEqual([MEMORY_PATH]);
	});

	it("corrects only the named scope and can restore the exact previous text", async () => {
		const initial = "# Memory\n- Project A: use npm\n- Project B: use npm\n";
		const vault = new MemoryVault({ [MEMORY_PATH]: initial });
		const memory = new VaultMemory(vault.app);
		const result = await memory.update(undefined, [{ type: "replace", oldText: "- Project A: use npm", newText: "- Project A: use bun" }]);
		expect(vault.contents.get(MEMORY_PATH)).toBe("# Memory\n- Project A: use bun\n- Project B: use npm\n");
		expect(result.backupPath).toBeDefined();
		expect(vault.contents.get(result.backupPath!)).toBe(initial);
		const recall = await memory.read({ query: "npm" });
		expect(recall.documents.map((doc) => doc.path)).toEqual([MEMORY_PATH]);
		expect(recall.documents[0]?.text).not.toContain("Project A: use npm");
		await memory.update(undefined, [{ type: "replace", oldText: vault.contents.get(MEMORY_PATH)!, newText: vault.contents.get(result.backupPath!)! }]);
		expect(vault.contents.get(MEMORY_PATH)).toBe(initial);
	});

	it("deduplicates append retries without losing distinct facts or creating recovery noise", async () => {
		const vault = new MemoryVault({ [MEMORY_PATH]: "- First fact\n" });
		const memory = new VaultMemory(vault.app);
		const edit = [{ type: "append" as const, text: "- Second fact" }];
		await memory.update(undefined, edit);
		const writes = vault.writes.length;
		expect(await memory.update(undefined, edit)).toEqual({ path: MEMORY_PATH, changed: false });
		expect(vault.writes).toHaveLength(writes);
		expect(vault.contents.get(MEMORY_PATH)).toBe("- First fact\n- Second fact\n");
	});

	it("restores exact whitespace after removing the last memory entry", async () => {
		const initial = "\n- User: reply in Chinese\n\n";
		const vault = new MemoryVault({ [MEMORY_PATH]: initial });
		const memory = new VaultMemory(vault.app);
		const removal = await memory.update(undefined, [{ type: "remove", oldText: initial }]);
		expect(vault.contents.get(MEMORY_PATH)).toBe("");
		await memory.update(undefined, [{ type: "replace", oldText: "", newText: vault.contents.get(removal.backupPath!)! }]);
		expect(vault.contents.get(MEMORY_PATH)).toBe(initial);
		await expect(memory.update(undefined, [{ type: "replace", oldText: "", newText: "overwrite" }])).rejects.toThrow("empty memory file");
		expect(vault.contents.get(MEMORY_PATH)).toBe(initial);
	});

	it("rejects an invalid batch before saving any of its changes", async () => {
		const initial = "duplicate duplicate\n";
		const vault = new MemoryVault({ [MEMORY_PATH]: initial });
		await expect(new VaultMemory(vault.app).update(undefined, [
			{ type: "append", text: "- Would otherwise be added" },
			{ type: "remove", oldText: "duplicate" },
		])).rejects.toThrow("exactly once");
		expect(vault.contents.get(MEMORY_PATH)).toBe(initial);
		expect(vault.writes).toEqual([]);
	});

	it("never treats a read failure as an empty memory file", async () => {
		const vault = new MemoryVault({ [MEMORY_PATH]: "keep me" });
		vault.failRead.add(MEMORY_PATH);
		await expect(new VaultMemory(vault.app).update(undefined, [{ type: "append", text: "new" }])).rejects.toThrow("Read failed");
		expect(vault.contents.get(MEMORY_PATH)).toBe("keep me");
		expect(vault.writes).toEqual([]);
	});

	it("keeps the original when recovery-copy creation fails", async () => {
		const vault = new MemoryVault({ [MEMORY_PATH]: "keep me" });
		vault.failCreate = true;
		await expect(new VaultMemory(vault.app).update(undefined, [{ type: "append", text: "new" }])).rejects.toThrow("Create failed");
		expect(vault.contents.get(MEMORY_PATH)).toBe("keep me");
		expect(vault.writes).toEqual([]);
	});

	it("retains the original and recovery copy if the atomic write fails", async () => {
		const vault = new MemoryVault({ [MEMORY_PATH]: "keep me" });
		vault.failProcess = true;
		await expect(new VaultMemory(vault.app).update(undefined, [{ type: "append", text: "new" }])).rejects.toThrow("Process failed");
		expect(vault.contents.get(MEMORY_PATH)).toBe("keep me");
		expect([...vault.contents.values()]).toEqual(["keep me", "keep me"]);
	});

	it("detects an editor or sync change between reading and committing", async () => {
		const vault = new MemoryVault({ [MEMORY_PATH]: "old text" });
		vault.beforeProcess = (path) => vault.put(path, "new text from editor");
		await expect(new VaultMemory(vault.app).update(undefined, [{ type: "append", text: "agent text" }])).rejects.toThrow("Memory changed");
		expect(vault.contents.get(MEMORY_PATH)).toBe("new text from editor");
	});

	it("serializes writers from different tool factories without losing appends", async () => {
		const vault = new MemoryVault();
		await Promise.all([
			new VaultMemory(vault.app).update(undefined, [{ type: "append", text: "- One" }]),
			new VaultMemory(vault.app).update(undefined, [{ type: "append", text: "- Two" }]),
		]);
		expect(vault.contents.get(MEMORY_PATH)).toBe("- One\n- Two\n");
	});

	it("releases the queue after a failure", async () => {
		const vault = new MemoryVault({ [MEMORY_PATH]: "before\n" });
		const memory = new VaultMemory(vault.app);
		await expect(memory.update(undefined, [{ type: "remove", oldText: "missing" }])).rejects.toThrow();
		await memory.update(undefined, [{ type: "append", text: "after" }]);
		expect(vault.contents.get(MEMORY_PATH)).toBe("before\nafter\n");
	});

	it("stops before committing if cancelled after making the backup", async () => {
		const vault = new MemoryVault({ [MEMORY_PATH]: "original" });
		const controller = new AbortController();
		vault.afterCreate = () => controller.abort();
		await expect(new VaultMemory(vault.app).update(undefined, [{ type: "append", text: "new" }], controller.signal)).rejects.toThrow("aborted");
		expect(vault.contents.get(MEMORY_PATH)).toBe("original");
	});

	it("reports a successful commit even if cancellation arrives after it", async () => {
		const vault = new MemoryVault({ [MEMORY_PATH]: "original\n" });
		const controller = new AbortController();
		vault.afterProcess = () => controller.abort();
		expect((await new VaultMemory(vault.app).update(undefined, [{ type: "append", text: "new" }], controller.signal)).changed).toBe(true);
		expect(vault.contents.get(MEMORY_PATH)).toBe("original\nnew\n");
	});

	it("bounds growth by bytes and permits reducing oversized legacy files", async () => {
		const legacy = "长".repeat(MEMORY_MAX_BYTES);
		const vault = new MemoryVault({ [MEMORY_PATH]: legacy });
		const memory = new VaultMemory(vault.app);
		await expect(memory.update(undefined, [{ type: "append", text: "more" }])).rejects.toThrow("may grow");
		await memory.update(undefined, [{ type: "replace", oldText: legacy, newText: "short\n" }]);
		expect(vault.contents.get(MEMORY_PATH)).toBe("short\n");
	});

	it("keeps the latest 20 recovery copies across rapid writes and a backwards clock", async () => {
		const vault = new MemoryVault({ [MEMORY_PATH]: "initial\n", "Piem/memory/history/MEMORY/manual.md": "keep this too" });
		const memory = new VaultMemory(vault.app);
		const backups: string[] = [];
		let id = 100;
		const restoreCrypto = stubWindowMembers({ crypto: { randomUUID: () => `${(id--).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000` } });
		setSystemTime(new Date("2026-09-09T00:00:00.000Z"));
		try {
			for (let n = 0; n < 23; n++) {
				if (n === 12) setSystemTime(new Date("2026-09-08T00:00:00.000Z"));
				const result = await memory.update(undefined, [{ type: "append", text: `entry ${n}` }]);
				backups.push(result.backupPath!);
			}
			expect(vault.trashed).toEqual(backups.slice(0, 3));
			expect(backups.filter((path) => vault.files.has(path))).toEqual(backups.slice(-20));
			expect(vault.contents.get("Piem/memory/history/MEMORY/manual.md")).toBe("keep this too");
		} finally {
			setSystemTime();
			restoreCrypto();
		}
	});

	it("reports cleanup trouble without claiming the memory write failed", async () => {
		const vault = new MemoryVault({ [MEMORY_PATH]: "initial\n" });
		vault.failTrash = true;
		const memory = new VaultMemory(vault.app);
		for (let n = 0; n < 20; n++) await memory.update(undefined, [{ type: "append", text: `entry ${n}` }]);
		const result = await memory.update(undefined, [{ type: "append", text: "final" }]);
		expect(result.changed).toBe(true);
		expect(result.warning).toContain("saved");
		expect(vault.contents.get(MEMORY_PATH)).toContain("final");
	});

	for (const path of ["../outside.md", "/tmp/secret.md", "Piem/memory-other/note.md", "Piem/memory/history/old.md", "Piem/memory/data.json", ".obsidian/plugins/piem/main.js"]) {
		it(`rejects an out-of-scope destination: ${path}`, async () => {
			const vault = new MemoryVault();
			await expect(new VaultMemory(vault.app).update(path, [{ type: "append", text: "x" }])).rejects.toThrow();
			expect(vault.writes).toEqual([]);
		});
	}
});
