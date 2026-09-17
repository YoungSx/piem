import { describe, expect, it } from "bun:test";
import { installObsidianStub } from "../testUtils/obsidianStub";
import type { App, TFile, TFolder } from "obsidian";

installObsidianStub();

// Dynamic imports so the mocked module wins over any cached real one.
const { TFile: TFileClass, TFolder: TFolderClass } = await import("obsidian");
const { createLsTool } = await import("./searchTools");

/**
 * A vault with the index/disk asymmetry Obsidian really has: `Notes/` is
 * indexed, `.obsidian/` is on disk only. Collapsing the two would let the
 * config-directory case pass against a vault that does not exist.
 */
function createApp(): App {
	const indexedFolders = ["Notes", "Notes/sub"];
	const indexedFiles = ["Notes/a.md", "Notes/sub/b.md"];
	const diskFolders = [".obsidian", ".obsidian/plugins", ".obsidian/plugins/piem"];
	const diskFiles = [".obsidian/app.json"];
	const indexedChildrenOf = (path: string): Array<TFile | TFolder> => [
		...indexedFiles.filter((child) => parentOf(child) === path).map(makeFile),
		...indexedFolders.filter((child) => parentOf(child) === path).map((child) => makeFolder(child, indexedChildrenOf(child))),
	];
	return {
		vault: {
			getFolderByPath: (path: string) => (indexedFolders.includes(path) ? makeFolder(path, indexedChildrenOf(path)) : null),
			getRoot: () => makeFolder("", indexedChildrenOf("")),
			adapter: {
				exists: async (path: string) => diskFolders.includes(path) || diskFiles.includes(path),
				stat: async (path: string) => {
					if (diskFolders.includes(path)) return { type: "folder" as const, ctime: 0, mtime: 0, size: 0 };
					if (diskFiles.includes(path)) return { type: "file" as const, ctime: 0, mtime: 0, size: 0 };
					return null;
				},
				list: async (path: string) => ({
					folders: diskFolders.filter((child) => parentOf(child) === path),
					files: diskFiles.filter((child) => parentOf(child) === path),
				}),
			},
		},
	} as unknown as App;
}

describe("ls", () => {
	it("lists an indexed folder from the vault index", async () => {
		const result = await createLsTool(createApp()).execute("ls-1", { path: "Notes" });

		expect((result.content[0] as { text: string }).text).toBe("file\tNotes/a.md\nfolder\tNotes/sub");
	});

	it("lists the config directory through the adapter", async () => {
		const result = await createLsTool(createApp()).execute("ls-2", { path: ".obsidian" });

		expect((result.content[0] as { text: string }).text).toBe("file\t.obsidian/app.json\nfolder\t.obsidian/plugins");
	});

	it("reports a folder that is neither indexed nor on disk", async () => {
		const tool = createLsTool(createApp());

		await expect(tool.execute("ls-3", { path: "Missing" })).rejects.toThrow("Folder not found: Missing");
	});
});

function makeFolder(path: string, children: Array<TFile | TFolder>): TFolder {
	const folder: TFolder = new TFolderClass();
	folder.path = path;
	folder.name = path.split("/").pop() ?? path;
	folder.children = children;
	return folder;
}

function makeFile(path: string): TFile {
	const file: TFile = new TFileClass();
	file.path = path;
	file.name = path.split("/").pop() ?? path;
	return file;
}

function parentOf(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}