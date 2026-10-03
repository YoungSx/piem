import type { CodemodeStoreWrites } from "@earendil-works/pi-codemode";

export const CODEMODE_STORE_ENTRY_TYPE = "codemode-store";

/** Replay Pi's successful writes along the active branch; never merge sibling branches. */
export function readCodemodeStore(entries: readonly { type: string; customType?: string; data?: unknown }[]): Record<string, unknown> {
	const store = new Map<string, unknown>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== CODEMODE_STORE_ENTRY_TYPE || !isStoreWrites(entry.data)) continue;
		for (const key of entry.data.delete) store.delete(key);
		for (const [key, value] of Object.entries(entry.data.set)) store.set(key, value);
	}
	return Object.fromEntries(store);
}

function isStoreWrites(data: unknown): data is CodemodeStoreWrites {
	if (!data || typeof data !== "object") return false;
	const value = data as Partial<CodemodeStoreWrites>;
	return value.set !== null && typeof value.set === "object" && !Array.isArray(value.set)
		&& Array.isArray(value.delete) && value.delete.every(key => typeof key === "string");
}
