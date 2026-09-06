/**
 * Remembers what each tracked file looked like after *our* last write to it,
 * so the next write can tell "drifted on disk" from "that was me".
 *
 * Why a fingerprint instead of content hashing: the vault sync plugin
 * arbitrates whole files last-writer-wins, so the only question worth asking
 * before an append is "did something outside this plugin touch the file since
 * I last wrote it?". `mtimeMs`+`size` answers that in one `stat` with no read;
 * a content hash would need a full read of a chat log on every single
 * message. Collisions of the fingerprint (same mtime+size, different content)
 * are possible in theory but require the foreign writer to land on exactly
 * our byte length and our millisecond — and the fs-level repair net (C2.4)
 * still catches the damage at the append itself.
 *
 * Deliberately not `mtimeMs` alone: a same-size rewrite that keeps the
 * millisecond is the one case `size` alone also misses, and the pair costs
 * nothing extra. Deliberately not a full `stat` snapshot: only two fields are
 * needed and `FileInfo` invites over-broad comparisons.
 */
export interface FileFingerprint {
	mtimeMs: number;
	size: number;
}

/**
 * Per-path fingerprint store. The fs layer owns one instance; the session
 * layer can consult the same instance for its checkpoints without doing its
 * own stats.
 *
 * The store never stats anything itself — it is a dumb ledger. Callers decide
 * when to remember (`remember`), when to compare (`check`), and when to drop a
 * path (`forget`), which keeps the I/O policy in the hands of the code that
 * knows whether a write is about to happen.
 */
export class DiskSentinel {
	private readonly fingerprints = new Map<string, FileFingerprint>();

	/**
	 * Records the fingerprint a path had right after our own write. The caller
	 * passes what `fileInfo`/`stat` reported post-write; from then on a
	 * matching `check` means "quiet", anything else means "someone else wrote".
	 */
	remember(path: string, fingerprint: FileFingerprint): void {
		this.fingerprints.set(path, { ...fingerprint });
	}

	/**
	 * Compares a freshly observed fingerprint against the remembered one.
	 *
	 * - `"same"` — nothing has touched the path since our last write.
	 * - `"drifted"` — an outside writer landed between our write and now.
	 * - `"unknown"` — we never wrote this path (or forgot it). The caller
	 *   decides how to bootstrap: usually observe-then-remember, never treat
	 *   unknown as drift, because drift is an assertion about *someone else's*
	 *   write and we have no baseline to assert against.
	 */
	check(path: string, observed: FileFingerprint): "same" | "drifted" | "unknown" {
		const baseline = this.fingerprints.get(path);
		if (!baseline) {
			return "unknown";
		}
		return baseline.mtimeMs === observed.mtimeMs && baseline.size === observed.size ? "same" : "drifted";
	}

	/** Drops a path's baseline: after a delete, a rename, or a full reload. */
	forget(path: string): void {
		this.fingerprints.delete(path);
	}

	/** Whether a baseline exists, for callers that only want the bootstrap hint. */
	known(path: string): boolean {
		return this.fingerprints.has(path);
	}
}
