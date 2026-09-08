import type { App, EventRef, TAbstractFile } from "obsidian";

/**
 * Watches the active session's JSONL file for changes made outside this plugin.
 *
 * Session writes from this plugin go through `DataAdapter.append`, which bypasses
 * `Vault`'s eventing — that was a deliberate choice to keep streaming cheap, and
 * it means the vault can still see edits arriving from everywhere *else*: a
 * second Obsidian window on the same vault, a concurrently running pi CLI, a
 * hand edit. The display name lives as a `{kind:"fact", fact:"name", name}` line
 * in that file, and pi's `getName()` reads an in-memory state hydrated once at
 * open, so without this watcher the panel shows a stale name forever.
 *
 * Like {@link activeNoteWatch} it registers nothing itself, so the owning view
 * keeps lifecycle control and this stays testable without an `ItemView`; nothing
 * fires at registration, and seeding the first comparison is the caller's job.
 * It hands back a disposer rather than the refs, though, because the debounce
 * outlives the subscription: `registerEvent` drops the vault listener at unload
 * but has no hook that could disarm a timer already armed, so a burst landing in
 * the last quiet period would still call `onChange` — against a view whose
 * service is being torn down. One handle covering both is what keeps them from
 * being half-wired; {@link watchWindowFocus} has the same shape for the same
 * reason.
 *
 * @param getWatchedPath Resolved fresh on every event, never captured — the
 * active session can be switched or created at any moment, and a path captured
 * at registration would keep watching a chat that is no longer open. Returning
 * null disables the watcher while there is no active session.
 * @param onChange Called at most once per quiet period, with the path that
 * changed. Whether the caller's own writes also surface here is unspecified
 * (mobile has no disk watcher; desktop may); the consumer must treat an event
 * as "the file may have drifted" and compare before reacting, not as proof of
 * an external edit.
 * @param debounceMs Trailing debounce. Streaming appends many lines in bursts;
 * each burst is one disk re-read, not one per line.
 * @returns The call that stops watching: it drops the vault subscription and
 * cancels a pending debounce, so nothing reaches `onChange` afterwards.
 */
export function watchSessionFile(
	app: App,
	getWatchedPath: () => string | null,
	onChange: (path: string) => void,
	debounceMs = 500,
): () => void {
	let timer: number | null = null;
	let pendingPath: string | null = null;

	const schedule = (path: string): void => {
		pendingPath = path;
		if (timer !== null) {
			return;
		}
		timer = window.setTimeout(() => {
			timer = null;
			const path = pendingPath;
			pendingPath = null;
			if (path !== null) {
				onChange(path);
			}
		}, debounceMs);
	};

	const ref: EventRef = app.vault.on("modify", (file: TAbstractFile) => {
		// Re-ask rather than capture: the watcher outlives session switches.
		if (getWatchedPath() === file.path) {
			schedule(file.path);
		}
	});

	return () => {
		app.vault.offref(ref);
		if (timer !== null) {
			window.clearTimeout(timer);
			timer = null;
		}
		pendingPath = null;
	};
}
