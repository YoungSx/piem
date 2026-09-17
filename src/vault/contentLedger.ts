import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import type { VaultExecutionEnv } from "./VaultExecutionEnv";

/**
 * Per-session view over the shared {@link VaultExecutionEnv} that remembers
 * what this session last saw of each file and refuses to overwrite a file
 * that changed behind its back.
 *
 * Why a wrapper, not env-level state: pi's mutation queue keys per-path locks
 * off env object identity, and piem deliberately shares one env across every
 * session so those locks interlock cross-session. The shared env therefore has
 * no caller identity — it cannot know which session is writing, so it cannot
 * know which content to compare against. The wrapper carries that one bit of
 * per-session state (the last-seen ledger) while delegating everything else.
 *
 * Semantics:
 * - `readTextFile` / `readBinaryFile` record the full content that came back
 *   (the read tool may hand the model a truncated slice; the ledger always
 *   keeps the whole file).
 * - `writeFile` with a string becomes a CAS against the recorded content via
 *   {@link VaultExecutionEnv.compareAndWriteFile}: the comparison runs inside
 *   `vault.process`, so a writer whose baseline went stale gets an explicit
 *   conflict error instead of silently clobbering a concurrent edit — the
 *   user's hard requirement. Nothing recorded means blind write, same as
 *   before (ponytail: a never-read overwrite is a different failure mode, and
 *   team members will not carry `write` at all, so the strict "read first"
 *   rule is deferred until a run proves it necessary).
 * - A successful write records the new content, so a session may keep editing
 *   its own freshly written file without re-reading.
 *
 * The proxy passes every other member through untouched, and the three
 * intercepted methods still bind to the real env, so private state and the
 * mutation queue see consistent calls.
 */
export function withContentLedger(env: VaultExecutionEnv): ExecutionEnv {
	const lastSeen = new Map<string, string>();

	const remember = (path: string, text: string): void => {
		// Track bounded recent files only: the ledger is an accuracy guard, not
		// history, and unbounded full-content snapshots per session would leak.
		if (text.length > MAX_TRACKED_CHARS) {
			return;
		}
		lastSeen.delete(path);
		if (lastSeen.size >= MAX_LEDGER_ENTRIES) {
			const oldest = lastSeen.keys().next();
			if (!oldest.done) {
				lastSeen.delete(oldest.value);
			}
		}
		lastSeen.set(path, text);
	};

	return new Proxy(env, {
		get(target, property) {
			switch (property) {
				case "readTextFile":
					return async (path: string, contextOrSignal?: Context | AbortSignal) => {
						const result = await target.readTextFile(path, contextOrSignal);
						if (result.ok) {
							remember(path, result.value);
						}
						return result;
					};
				case "readBinaryFile":
					return async (path: string, contextOrSignal?: Context | AbortSignal) => {
						const result = await target.readBinaryFile(path, contextOrSignal);
						// Decoding images into garbage strings is harmless here: the
						// write tool only emits text, so a text write over a binary
						// path fails the CAS it could never honestly pass.
						if (result.ok && result.value.byteLength <= MAX_TRACKED_CHARS) {
							remember(path, new TextDecoder().decode(result.value));
						}
						return result;
					};
				case "writeFile":
					return async (path: string, content: string | Uint8Array, contextOrSignal?: Context | AbortSignal) => {
						if (typeof content !== "string") {
							return target.writeFile(path, content, contextOrSignal);
						}
						const expected = lastSeen.get(path);
						const result =
							expected !== undefined
								? await target.compareAndWriteFile(path, content, expected, contextOrSignal)
								: await target.writeFile(path, content, contextOrSignal);
						if (result.ok) {
							remember(path, content);
						}
						return result;
					};
				default: {
					const value: unknown = Reflect.get(target, property, target);
					return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
				}
			}
		},
	});
}

/** Full-content entries the ledger keeps per session. */
const MAX_LEDGER_ENTRIES = 64;

/** Files larger than this are read but not tracked; writes to them stay blind. */
const MAX_TRACKED_CHARS = 1_048_576;
