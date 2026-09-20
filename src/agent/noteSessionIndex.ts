/**
 * Lightweight in-memory index mapping note paths to recent session paths.
 *
 * Used to detect whether an active note was previously discussed in an earlier
 * conversation, so the empty screen can proactively offer a "resume discussion" chip.
 *
 * Kept strictly in memory with an optional localStorage cache (zero disk I/O, zero vault scans).
 * Maximum 50 entries to keep memory footprint negligible on mobile.
 */

export interface NoteSessionRecord {
	sessionPath: string;
	sessionTitle?: string;
	timestamp: number;
}

export class NoteSessionIndex {
	private readonly records = new Map<string, NoteSessionRecord>();
	private readonly maxEntries: number;
	private readonly storageKey?: string;

	constructor(maxEntries = 50, vaultKey?: string) {
		this.maxEntries = maxEntries;
		this.storageKey = vaultKey ? `piem:note_sessions:${vaultKey}` : undefined;
		this.loadFromStorage();
	}

	private loadFromStorage(): void {
		if (!this.storageKey || typeof window === "undefined" || !window.localStorage) {
			return;
		}
		try {
			const raw = window.localStorage.getItem(this.storageKey);
			if (!raw) return;
			const parsed = JSON.parse(raw) as Record<string, NoteSessionRecord>;
			if (typeof parsed === "object" && parsed !== null) {
				for (const [notePath, record] of Object.entries(parsed)) {
					if (record && typeof record.sessionPath === "string" && typeof record.timestamp === "number") {
						this.records.set(notePath, record);
					}
				}
			}
		} catch {
			// Ignore storage load errors
		}
	}

	private saveToStorage(): void {
		if (!this.storageKey || typeof window === "undefined" || !window.localStorage) {
			return;
		}
		try {
			const obj: Record<string, NoteSessionRecord> = {};
			for (const [k, v] of this.records.entries()) {
				obj[k] = v;
			}
			window.localStorage.setItem(this.storageKey, JSON.stringify(obj));
		} catch {
			// Ignore storage write errors (e.g. quota exceeded)
		}
	}

	/**
	 * Records a session touch for a note path.
	 */
	record(notePath: string, sessionPath: string, sessionTitle?: string): void {
		if (!notePath || !sessionPath) return;
		this.records.set(notePath, {
			sessionPath,
			sessionTitle,
			timestamp: Date.now(),
		});
		// Evict oldest if exceeding maxEntries
		if (this.records.size > this.maxEntries) {
			let oldestKey: string | undefined;
			let oldestTime = Infinity;
			for (const [key, val] of this.records.entries()) {
				if (val.timestamp < oldestTime) {
					oldestTime = val.timestamp;
					oldestKey = key;
				}
			}
			if (oldestKey) {
				this.records.delete(oldestKey);
			}
		}
		this.saveToStorage();
	}

	/**
	 * Checks if a note has a prior session different from the current one.
	 */
	has(notePath: string, currentSessionPath?: string | null): boolean {
		const rec = this.records.get(notePath);
		if (!rec) return false;
		if (currentSessionPath && rec.sessionPath === currentSessionPath) {
			return false;
		}
		return true;
	}

	/**
	 * Retrieves the prior session record for a note.
	 */
	get(notePath: string): NoteSessionRecord | undefined {
		return this.records.get(notePath);
	}

	clear(): void {
		this.records.clear();
		if (this.storageKey && typeof window !== "undefined" && window.localStorage) {
			try {
				window.localStorage.removeItem(this.storageKey);
			} catch {
				// Ignore
			}
		}
	}
}
