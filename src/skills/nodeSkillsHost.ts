import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { Platform } from "obsidian";

/** Obsidian injects a module lookup on desktop; mobile may throw or return nothing. */
export type HostRequire = (id: string) => unknown;

declare const require: HostRequire;

function hostModuleLookup(id: string): unknown {
	return require(id);
}

/**
 * The home directory, only when the host supplies the filesystem Pi's skill
 * loader needs. Check members, not module truthiness: mobile shims may return
 * undefined or partial objects without throwing. This probe performs no I/O
 * and does not initialize the Node execution environment.
 */
export function nodeSkillsHome(lookup: HostRequire | null = hostModuleLookup): string | undefined {
	// Obsidian's mobile emulator reports every attempted Node lookup as a
	// visible notice, even when the caller catches it. Never probe on mobile.
	if (Platform.isMobile || !lookup) return undefined;
	try {
		const fs = lookup("node:fs/promises") as Record<string, unknown> | undefined;
		const path = lookup("node:path") as Record<string, unknown> | undefined;
		const os = lookup("node:os") as { homedir?: () => unknown } | undefined;
		if (
			!["readFile", "lstat", "readdir", "realpath"].every((name) => typeof fs?.[name] === "function") ||
			!["resolve", "isAbsolute", "join", "basename"].every((name) => typeof path?.[name] === "function") ||
			typeof os?.homedir !== "function"
		) {
			return undefined;
		}
		const home = os.homedir();
		return typeof home === "string" && home.length > 0 ? home : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Only the caller owns the returned environment and must clean it up.
 *
 * The local import is bundled into main.js as a lazy initializer. Importing
 * Pi's public /node entry at this file's top level would request Node builtins
 * while the plugin loads on mobile. Unexpected bridge failures deliberately
 * propagate to the loader's diagnostics instead of masquerading as no skills.
 */
export async function createUserSkillsEnv(lookup?: HostRequire | null): Promise<ExecutionEnv | undefined> {
	const home = nodeSkillsHome(lookup);
	if (home === undefined) return undefined;
	const { createNodeSkillsEnv } = await import("./nodeSkillsEnv");
	return createNodeSkillsEnv(home);
}
