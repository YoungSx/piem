import { TFile, TFolder, type Vault } from "obsidian";
import { BUILTIN_SKILLS_DIR, isSkillResourcePath } from "./builtinSkillPackage";

/** The installer's file operations have create-only and compare-before-write semantics. */
export interface BuiltinSkillFiles {
	read(path: string): Promise<string | undefined>;
	write(path: string, content: string, expected: string | undefined, signal: AbortSignal): Promise<void>;
}

export function builtinSkillVault(vault: Vault): BuiltinSkillFiles {
	function destination(path: string): string {
		if (!isSkillResourcePath(path)) throw new Error("Invalid built-in skill path.");
		return `${BUILTIN_SKILLS_DIR}/${path}`;
	}
	return {
		async read(path) {
			const file = vault.getAbstractFileByPath(destination(path));
			if (file === null) return undefined;
			if (!(file instanceof TFile)) throw new Error("A folder occupies the skill file path.");
			return vault.read(file);
		},
		async write(path, content, expected, signal) {
			const target = destination(path);
			signal.throwIfAborted();
			if (expected !== undefined) {
				const file = vault.getAbstractFileByPath(target);
				if (!(file instanceof TFile)) throw new Error("Skill changed during update.");
				await vault.process(file, (current) => {
					signal.throwIfAborted();
					if (current !== expected) throw new Error("Skill changed during update.");
					return content;
				});
				return;
			}
			let parent = "";
			for (const part of target.split("/").slice(0, -1)) {
				parent = parent ? `${parent}/${part}` : part;
				signal.throwIfAborted();
				const existing = vault.getAbstractFileByPath(parent);
				if (existing instanceof TFolder) continue;
				if (existing) throw new Error("A file occupies the skill folder path.");
				try {
					await vault.createFolder(parent);
				} catch (error) {
					if (!(vault.getAbstractFileByPath(parent) instanceof TFolder)) throw error;
				}
			}
			signal.throwIfAborted();
			// Vault.create refuses a racing file; do not turn that into modify.
			await vault.create(target, content);
		},
	};
}
