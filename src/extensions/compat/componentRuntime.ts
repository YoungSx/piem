import { unavailable } from "../node/unavailable";

export interface CompatTui {
	requestRender(force?: boolean): void;
}

interface Runtime {
	disposed: boolean;
	cleanups: Set<() => void>;
}

const runtimes = new WeakMap<CompatTui, Runtime>();

/** Pi factories get only the refresh operation that a native surface can honor. */
export function createTui(requestRender: () => void): CompatTui {
	const runtime: Runtime = { disposed: false, cleanups: new Set() };
	const tui: CompatTui = new Proxy({ requestRender: (): void => {
		if (!runtime.disposed) requestRender();
	} }, {
		get(target, name, receiver): unknown {
			if (Object.prototype.hasOwnProperty.call(target, name)) return Reflect.get(target, name, receiver);
			return unavailable(`terminal operation TUI.${String(name)}`);
		},
	});
	runtimes.set(tui, runtime);
	return tui;
}

/** Register a component even if an outer community wrapper has no dispose(). */
export function registerTuiCleanup(tui: CompatTui, cleanup: () => void): () => void {
	const runtime = runtimes.get(tui);
	if (!runtime) return () => undefined;
	if (runtime.disposed) { cleanup(); return () => undefined; }
	runtime.cleanups.add(cleanup);
	return () => { runtime.cleanups.delete(cleanup); };
}

export function disposeTui(tui: CompatTui): void {
	const runtime = runtimes.get(tui);
	if (!runtime || runtime.disposed) return;
	runtime.disposed = true;
	const cleanups = [...runtime.cleanups];
	runtime.cleanups.clear();
	runComponentCleanups(cleanups);
}

/** A broken extension's cleanup must not strand its siblings' resources. */
export function runComponentCleanups(cleanups: readonly (() => void)[]): void {
	let failed = false;
	let firstError: unknown;
	for (const cleanup of cleanups) {
		try { cleanup(); }
		catch (error) { if (!failed) { failed = true; firstError = error; } }
	}
	if (failed) throw firstError;
}
