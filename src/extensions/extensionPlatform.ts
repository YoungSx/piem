import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { normalize } from "pathe";
import type { FetchFn } from "../net/obsidianFetch";
import { unavailable } from "./node/unavailable";

export interface ExtensionPlatformCallbacks {
	fetch: FetchFn;
	complete(model: Model<string>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>;
	readConfig(path: string): string | undefined;
	onError(error: unknown): void;
	activityChanged?(busy: boolean): void;
	beforeTimer?(): Promise<void>;
	afterTimer?(): Promise<void>;
}

export interface ExtensionPlatform {
	fetch: FetchFn;
	complete: ExtensionPlatformCallbacks["complete"];
	getEnvApiKey(provider?: string): undefined;
	getAgentDir(): string;
	readFileSync(path: string, encoding: string): string;
	existsSync(path: string): boolean;
	mkdirSync(...args: unknown[]): never;
	writeFileSync(...args: unknown[]): never;
	unlinkSync(...args: unknown[]): never;
	Text: new (...args: unknown[]) => object;
	BorderedLoader: new (...args: unknown[]) => object;
	process: Readonly<{ env: Readonly<Record<string, string | undefined>> }>;
	setTimeout(callback: (...args: unknown[]) => unknown, delay?: number, ...args: unknown[]): number;
	clearTimeout(id?: number): void;
}

interface Operation {
	controller: AbortController;
	pending: number;
	timers: Set<number>;
	drained: Promise<void>;
	finish(): void;
	unlink(): void;
}

const CONFIG_ROOT = "/extensions/config";
const aborted = (): Error => Object.assign(new Error("Extension operation was cancelled."), { name: "AbortError" });
const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));

/** Each statically compiled factory closes over its own platform, never a global current host. */
export function createExtensionPlatform(callbacks: ExtensionPlatformCallbacks) {
	let disposed = false;
	let operation: Operation | undefined;
	const report = (error: unknown): void => {
		try { callbacks.onError(error); } catch { /* An error sink must not create an unhandled timer rejection. */ }
	};
	const announce = (busy: boolean): void => {
		try { callbacks.activityChanged?.(busy); } catch (error) { report(error); }
	};
	const assertActive = (): void => {
		if (disposed) throw new Error("Extension platform was disposed.");
		if (operation?.controller.signal.aborted) throw aborted();
	};
	const assertScope = (scope: Operation): void => {
		if (disposed || scope.controller.signal.aborted) throw aborted();
		if (operation !== scope) throw new Error("Extension operation has already finished.");
	};
	const requireScope = (): Operation => {
		assertActive();
		if (!operation) throw new Error("An extension operation is required.");
		return operation;
	};
	const release = (scope: Operation): void => {
		scope.pending--;
		if (scope.pending !== 0) return;
		scope.unlink();
		if (operation === scope) operation = undefined;
		scope.finish();
		announce(false);
	};
	const cancelScope = (scope: Operation): void => {
		scope.controller.abort();
		for (const id of scope.timers) {
			window.clearTimeout(id);
			scope.timers.delete(id);
			release(scope);
		}
	};

	/** Retain the actual promise even if its consumer has already observed cancellation. */
	const track = <T>(scope: Operation, work: () => Promise<T> | T, signal = scope.controller.signal, held = false): Promise<T> => {
		if (!held) scope.pending++;
		const actual = Promise.resolve().then(() => {
			assertScope(scope);
			if (signal.aborted) throw aborted();
			return work();
		}).then(value => {
			assertScope(scope);
			if (signal.aborted) throw aborted();
			return value;
		});
		void actual.then(() => release(scope), () => release(scope));
		return new Promise<T>((resolve, reject) => {
			const onAbort = (): void => { reject(aborted()); };
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
			void actual.then(value => {
				signal.removeEventListener("abort", onAbort);
				if (disposed || signal.aborted) reject(aborted());
				else resolve(value);
			}, error => {
				signal.removeEventListener("abort", onAbort);
				reject(asError(error));
			});
		});
	};
	const request = <T>(work: (signal: AbortSignal) => Promise<T>, extra?: AbortSignal | null): Promise<T> => {
		const scope = requireScope();
		const controller = new AbortController();
		const sources = new Set([scope.controller.signal, ...(extra ? [extra] : [])]);
		const forward = (): void => controller.abort();
		for (const source of sources) {
			source.addEventListener("abort", forward, { once: true });
			if (source.aborted) forward();
		}
		return track(scope, async () => {
			try { return await work(controller.signal); }
			finally { for (const source of sources) source.removeEventListener("abort", forward); }
		}, controller.signal).finally(() => {
			// Also handles an already-aborted caller, whose transport was never invoked.
			for (const source of sources) source.removeEventListener("abort", forward);
		});
	};
	const configPath = (path: string): string => {
		assertActive();
		const name = normalize(path);
		if (!name.startsWith(`${CONFIG_ROOT}/`) || !name.endsWith(".json")) return unavailable("reads outside extension JSON snapshots");
		return name;
	};
	class UnsupportedTerminal {
		constructor() { unavailable("terminal UI"); }
	}
	const platform: ExtensionPlatform = {
		fetch: (input, init) => request(signal => callbacks.fetch(input, { ...init, signal }), init?.signal ?? (input instanceof Request ? input.signal : undefined)),
		complete: (model, context, options) => request(signal => callbacks.complete(model, context, { ...options, signal }), options?.signal),
		getEnvApiKey: () => undefined,
		getAgentDir: () => CONFIG_ROOT,
		readFileSync: (path, encoding) => {
			if (encoding !== "utf8" && encoding !== "utf-8") return unavailable("non-UTF-8 resource reads");
			const name = configPath(path);
			const value = callbacks.readConfig(name);
			if (value === undefined) throw Object.assign(new Error(`No extension config snapshot: ${name}`), { code: "ENOENT", path: name });
			return value;
		},
		existsSync: path => callbacks.readConfig(configPath(path)) !== undefined,
		mkdirSync: () => unavailable("fs.mkdirSync"),
		writeFileSync: () => unavailable("fs.writeFileSync"),
		unlinkSync: () => unavailable("fs.unlinkSync"),
		Text: UnsupportedTerminal,
		BorderedLoader: UnsupportedTerminal,
		process: Object.freeze({ env: Object.freeze({}) }),
		setTimeout: (callback, delay = 0, ...args) => {
			const scope = requireScope();
			scope.pending++;
			const id = window.setTimeout(() => {
				scope.timers.delete(id);
				void track(scope, async () => {
					await callbacks.beforeTimer?.();
					assertScope(scope);
					await callback(...args);
					assertScope(scope);
					await callbacks.afterTimer?.();
					assertScope(scope);
				}, scope.controller.signal, true).catch(error => {
					if (!disposed && !scope.controller.signal.aborted) report(error);
				});
			}, delay);
			scope.timers.add(id);
			return id;
		},
		clearTimeout: id => {
			if (id === undefined || !operation?.timers.delete(id)) return;
			window.clearTimeout(id);
			release(operation);
		},
	};
	return {
		platform,
		withOperation: <T>(work: (signal: AbortSignal) => Promise<T> | T, signal?: AbortSignal): Promise<T> => {
			try {
				assertActive();
				if (operation) throw new Error("An extension operation is already running.");
				if (signal?.aborted) throw aborted();
			} catch (error) { return Promise.reject(asError(error)); }
			let finish!: () => void;
			const drained = new Promise<void>(resolve => { finish = resolve; });
			const scope: Operation = { controller: new AbortController(), pending: 1, timers: new Set(), drained, finish, unlink: () => signal?.removeEventListener("abort", forward) };
			const forward = (): void => cancelScope(scope);
			operation = scope;
			signal?.addEventListener("abort", forward, { once: true });
			announce(true);
			return track(scope, () => work(scope.controller.signal), scope.controller.signal, true);
		},
		assertActive,
		getSignal: (): AbortSignal => requireScope().controller.signal,
		cancel: (): void => { if (operation) cancelScope(operation); },
		dispose: (): void => {
			if (disposed) return;
			disposed = true;
			if (operation) cancelScope(operation);
		},
		drain: (): Promise<void> => operation?.drained ?? Promise.resolve(),
		get busy(): boolean { return operation !== undefined; },
	};
}
