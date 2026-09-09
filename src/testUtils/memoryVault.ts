import type { App, TFile, TFolder } from "obsidian";
import { TFile as FileClass, TFolder as FolderClass } from "obsidian";
import { getParentPath } from "../vault/path";

/** Vault fixture with atomic process semantics and observable failure points. */
export class MemoryVault {
	readonly contents = new Map<string, string>();
	readonly reads: string[] = [];
	readonly writes: string[] = [];
	readonly trashed: string[] = [];
	readonly files = new Map<string, TFile>();
	readonly folders = new Map<string, TFolder>();
	failRead = new Set<string>();
	failCreate = false;
	failProcess = false;
	failTrash = false;
	beforeProcess?: (path: string) => void;
	afterProcess?: () => void;
	afterRead?: () => void;
	afterCreate?: (path: string) => void;
	private tick = 0;

	constructor(initial: Record<string, string> = {}) {
		this.mkdir("");
		for (const [path, text] of Object.entries(initial)) this.put(path, text);
	}

	put(path: string, text: string): TFile {
		let file = this.files.get(path);
		if (!file) {
			file = new FileClass();
			file.path = path;
			file.name = path.slice(path.lastIndexOf("/") + 1);
			file.extension = path.split(".").at(-1) ?? "";
			file.parent = this.mkdir(getParentPath(path));
			file.parent.children.push(file);
			this.files.set(path, file);
		}
		this.contents.set(path, text);
		file.stat = { size: new TextEncoder().encode(text).byteLength, ctime: 1, mtime: ++this.tick };
		return file;
	}

	mkdir(path: string): TFolder {
		const existing = this.folders.get(path);
		if (existing) return existing;
		const folder = new FolderClass();
		folder.path = path;
		folder.name = path.slice(path.lastIndexOf("/") + 1);
		folder.children = [];
		this.folders.set(path, folder);
		if (path) {
			folder.parent = this.mkdir(getParentPath(path));
			folder.parent.children.push(folder);
		}
		return folder;
	}

	readonly app = {
		vault: {
			getFileByPath: (path: string) => this.files.get(path) ?? null,
			getFolderByPath: (path: string) => this.folders.get(path) ?? null,
			getAbstractFileByPath: (path: string) => this.files.get(path) ?? this.folders.get(path) ?? null,
			getRoot: () => this.folders.get("")!,
			getFiles: () => [...this.files.values()],
			getMarkdownFiles: () => [...this.files.values()].filter((file) => file.extension === "md"),
			read: async (file: TFile) => {
				this.reads.push(file.path);
				if (this.failRead.has(file.path)) throw new Error("Read failed");
				const text = this.contents.get(file.path);
				if (text === undefined) throw new Error("File not found");
				this.afterRead?.();
				return text;
			},
			create: async (path: string, text: string) => {
				if (this.failCreate) throw new Error("Create failed");
				if (this.files.has(path) || this.folders.has(path)) throw new Error("File already exists");
				this.writes.push(path);
				const file = this.put(path, text);
				this.afterCreate?.(path);
				return file;
			},
			createFolder: async (path: string) => this.mkdir(path),
			process: async (file: TFile, transform: (text: string) => string) => {
				this.beforeProcess?.(file.path);
				if (this.failProcess) throw new Error("Process failed");
				const current = this.contents.get(file.path);
				if (current === undefined) throw new Error("File not found");
				const next = transform(current);
				this.writes.push(file.path);
				this.put(file.path, next);
				this.afterProcess?.();
				return next;
			},
		},
		fileManager: {
			trashFile: async (file: TFile) => {
				if (this.failTrash) throw new Error("Trash failed");
				this.trashed.push(file.path);
				this.files.delete(file.path);
				this.contents.delete(file.path);
				if (file.parent) file.parent.children = file.parent.children.filter((child) => child.path !== file.path);
			},
		},
	} as unknown as App;
}
