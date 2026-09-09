import type { App, TFile } from "obsidian";
import { getParentPath } from "../vault/path";
import { throwIfAborted } from "../tools/toolResult";
import { hasFileManager } from "../vault/trash";
import { applyMemoryEdits, MEMORY_HISTORY_ROOT, MEMORY_ROOT, memoryPath, type MemoryEdit } from "./memoryEdits";
import { readMemory, type MemoryReadOptions, type MemoryReadResult } from "./memoryRecall";

export interface MemoryUpdateResult {
	path: string;
	changed: boolean;
	/** The exact pre-change Markdown, readable with the ordinary read tool. */
	backupPath?: string;
	warning?: string;
}

const HISTORY_LIMIT = 20;
// All tool factories and conversations sharing this Vault share the queue.
// Obsidian.process also checks the text against edits made outside this queue.
const queues = new WeakMap<App["vault"], Map<string, Promise<void>>>();

/** Reliable memory writes over the Vault API; never uses the host filesystem. */
export class VaultMemory {
	constructor(private readonly app: App) {}

	read(options: MemoryReadOptions = {}, signal?: AbortSignal): Promise<MemoryReadResult> {
		return readMemory(this.app, options, signal);
	}

	async update(input: string | undefined, edits: readonly MemoryEdit[], signal?: AbortSignal): Promise<MemoryUpdateResult> {
		throwIfAborted(signal);
		const path = memoryPath(input);
		return this.serialize(path, async () => {
			throwIfAborted(signal);
			const vault = this.app.vault;
			const file = vault.getFileByPath(path);
			if (!file && vault.getAbstractFileByPath(path)) throw new Error(`Memory path is a folder: ${path}`);
			// A read error is not an empty file. Let it fail before creating a backup
			// or attempting a write, so damaged/unavailable storage cannot erase it.
			const before = file ? await vault.read(file) : "";
			throwIfAborted(signal);
			const after = applyMemoryEdits(before, edits);
			if (after === before) return { path, changed: false };
			let backupPath: string | undefined;
			if (file) {
				const relative = path.slice(MEMORY_ROOT.length + 1, -3);
				const historyFolder = `${MEMORY_HISTORY_ROOT}/${relative}`;
				// Keep names chronological across rapid writes, reloads, and a clock
				// moving backwards; a random UUID must not decide what gets trashed.
				const latest = this.historyFiles(historyFolder)[0]?.name.slice(0, 24);
				const previousTime = latest ? Date.parse(latest.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z")) || 0 : 0;
				const stamp = new Date(Math.max(Date.now(), previousTime + 1)).toISOString().replace(/[:.]/g, "-");
				backupPath = `${historyFolder}/${stamp}-${window.crypto.randomUUID()}.md`;
				await this.ensureParents(backupPath, signal);
				throwIfAborted(signal);
				await vault.create(backupPath, before);
				throwIfAborted(signal);
				await vault.process(file, (current) => {
					throwIfAborted(signal);
					if (current !== before) throw new Error("Memory changed while saving. Read it again and retry; no memory was overwritten.");
					return after;
				});
			} else {
				await this.ensureParents(path, signal);
				throwIfAborted(signal);
				// create refuses an occupied path, including a concurrent editor or
				// sync creation. It never falls back to overwriting the new file.
				await vault.create(path, after);
			}
			const result: MemoryUpdateResult = { path, changed: true, backupPath };
			// The commit has happened: cancellation or cleanup failure must never
			// report that it failed and encourage an unnecessary replay.
			if (backupPath && !signal?.aborted) {
				try {
					await this.pruneHistory(getParentPath(backupPath), signal);
				} catch {
					result.warning = "Memory saved. Some older recovery copies could not be removed.";
				}
			}
			return result;
		});
	}

	private async ensureParents(path: string, signal?: AbortSignal): Promise<void> {
		let current = "";
		for (const segment of getParentPath(path).split("/")) {
			throwIfAborted(signal);
			current = current ? `${current}/${segment}` : segment;
			if (this.app.vault.getFolderByPath(current)) continue;
			try {
				await this.app.vault.createFolder(current);
			} catch (error) {
				if (!this.app.vault.getFolderByPath(current)) throw error;
			}
		}
	}

	private historyFiles(folderPath: string): TFile[] {
		const folder = this.app.vault.getFolderByPath(folderPath);
		return (folder?.children ?? [])
			.map((child) => this.app.vault.getFileByPath(child.path))
			.filter((file): file is TFile => file !== null && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9-]{36}\.md$/.test(file.name))
			.sort((a, b) => b.name.localeCompare(a.name));
	}

	private async pruneHistory(folderPath: string, signal?: AbortSignal): Promise<void> {
		for (const file of this.historyFiles(folderPath).slice(HISTORY_LIMIT)) {
			if (signal?.aborted) return;
			if (!hasFileManager(this.app)) throw new Error("Trash is unavailable; retaining recovery copies.");
			await this.app.fileManager.trashFile(file);
		}
	}

	private async serialize<T>(path: string, run: () => Promise<T>): Promise<T> {
		let queue = queues.get(this.app.vault);
		if (!queue) {
			queue = new Map();
			queues.set(this.app.vault, queue);
		}
		const previous = queue.get(path) ?? Promise.resolve();
		const pending = previous.then(run);
		const settled = pending.then(() => undefined, () => undefined);
		queue.set(path, settled);
		try {
			return await pending;
		} finally {
			if (queue.get(path) === settled) queue.delete(path);
		}
	}
}
