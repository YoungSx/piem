import { describe, expect, it } from "bun:test";
import type { Vault } from "obsidian";
import { installObsidianStub } from "../testUtils/obsidianStub";

installObsidianStub();
const { TFile, TFolder } = await import("obsidian");
const { builtinSkillVault } = await import("./builtinSkillVault");

function vaultFixture() {
	const contents = new Map<string, string>();
	const folders = new Set<string>();
	let beforeProcess: (() => void) | undefined;
	const fileAt = (path: string) => Object.assign(new TFile(), { path });
	const vault = {
		getAbstractFileByPath: (path: string) => contents.has(path) ? fileAt(path) : folders.has(path) ? Object.assign(new TFolder(), { path }) : null,
		read: async (file: { path: string }) => contents.get(file.path)!,
		createFolder: async (path: string) => { folders.add(path); },
		create: async (path: string, content: string) => {
			if (contents.has(path)) throw new Error("already exists");
			contents.set(path, content);
		},
		process: async (file: { path: string }, change: (text: string) => string) => {
			beforeProcess?.();
			contents.set(file.path, change(contents.get(file.path)!));
		},
	};
	return { files: builtinSkillVault(vault as unknown as Vault), contents, folders, beforeProcess: (callback: () => void) => { beforeProcess = callback; } };
}

const relative = "summarize/SKILL.md";
const target = `Piem/builtin-skills/${relative}`;

describe("official skill Vault writes", () => {
	it("creates visible parents and reads the resulting real Markdown", async () => {
		const h = vaultFixture();
		await h.files.write(relative, "First", undefined, new AbortController().signal);
		expect(h.folders).toEqual(new Set(["Piem", "Piem/builtin-skills", "Piem/builtin-skills/summarize"]));
		expect(h.contents.get(target)).toBe("First");
		expect(await h.files.read(relative)).toBe("First");
	});

	it("uses atomic process and refuses editor changes between read and update", async () => {
		const h = vaultFixture();
		h.contents.set(target, "Old");
		await h.files.write(relative, "Updated", "Old", new AbortController().signal);
		expect(h.contents.get(target)).toBe("Updated");
		h.beforeProcess(() => h.contents.set(target, "User edit"));
		await expect(h.files.write(relative, "Overwrite", "Updated", new AbortController().signal)).rejects.toThrow("changed");
		expect(h.contents.get(target)).toBe("User edit");
	});

	it("never turns a racing creation into an overwrite", async () => {
		const h = vaultFixture();
		h.contents.set(target, "User file");
		await expect(h.files.write(relative, "Default", undefined, new AbortController().signal)).rejects.toThrow("already exists");
		expect(h.contents.get(target)).toBe("User file");
	});

	it("refuses paths outside the skill directory and aborts inside the atomic callback", async () => {
		const h = vaultFixture();
		await expect(h.files.write("../secrets.md", "X", undefined, new AbortController().signal)).rejects.toThrow("Invalid");
		h.contents.set(target, "Old");
		const controller = new AbortController();
		h.beforeProcess(() => controller.abort());
		await expect(h.files.write(relative, "New", "Old", controller.signal)).rejects.toThrow();
		expect(h.contents.get(target)).toBe("Old");
	});

	it("treats a folder at the file path as an error, never as an absent file", async () => {
		const h = vaultFixture();
		h.folders.add(target);
		await expect(h.files.read(relative)).rejects.toThrow("folder");
	});
});
