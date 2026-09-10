import type { ExtensionEntry, ExtensionHostCallbacks } from "./extensionHost";
import { unavailable } from "./node/unavailable";

/** Only the owning lane's current branch is exposed, never a different chat. */
export function createExtensionSession(callbacks: ExtensionHostCallbacks, assertActive: () => void) {
	const read = <T>(get: (() => T) | undefined, name: string): T => {
		assertActive();
		if (!get) return unavailable(`session.${name}`);
		return structuredClone(get());
	};
	const branch = (leafId?: string | null): ExtensionEntry[] => {
		const entries = read(callbacks.getBranch?.bind(callbacks), "getBranch");
		if (leafId === null) return [];
		if (leafId === undefined) return entries;
		const index = entries.findIndex(entry => entry.id === leafId);
		if (index < 0) throw new Error("Entry is not on the active conversation branch.");
		return entries.slice(0, index + 1);
	};
	return {
		getEntries: () => read(callbacks.getEntries.bind(callbacks), "getEntries"),
		getBranch: branch,
		getEntry: (id: string) => branch().find(entry => entry.id === id),
		getLeafId: () => branch().at(-1)?.id ?? null,
		getLeafEntry: () => branch().at(-1),
		getLabel: (id: string) => read(callbacks.getLabel ? () => callbacks.getLabel!(id) : undefined, "getLabel"),
		getSessionId: () => read(callbacks.getSessionId?.bind(callbacks), "getSessionId"),
		getSessionFile: () => read(callbacks.getSessionFile?.bind(callbacks), "getSessionFile"),
		getSessionName: () => read(callbacks.getSessionName?.bind(callbacks), "getSessionName"),
		getCwd: () => { assertActive(); return "/vault"; },
	};
}
