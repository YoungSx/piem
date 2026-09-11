import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { normalize } from "pathe";
import type { FetchFn } from "../net/obsidianFetch";
import { unavailable } from "./node/unavailable";
import { EXTENSION_CONFIG_ROOT, type ExtensionConfigStore } from "./extensionConfigStore";

export interface ExtensionPlatformCallbacks {
	fetch: FetchFn;
	complete(model: Model<string>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>;
	/**
	 * Namespaced JSON configuration. Absent means no extension may read or write
	 * one — the operations fail visibly rather than reading an empty store.
	 */
	config?: ExtensionConfigStore;
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
	mkdirSync(path: string, options?: unknown): void;
	writeFileSync(path: string, data: string, encoding?: string): void;
	unlinkSync(path: string): void;
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
	/**
	 * Resolves an extension-supplied path to a file name inside one namespace.
	 *
	 * The owner is the view's, never the path's: a scoped extension can only
	 * name a file, so no spelling of `path` reaches another extension's data.
	 * The root and `.json` restriction is kept as the outer guard, which also
	 * rejects any `..` that survived normalization.
	 */
	const configFile = (path: string): string => {
		assertActive();
		const name = normalize(path);
		if (!name.startsWith(`${EXTENSION_CONFIG_ROOT}/`) || !name.endsWith(".json")) return unavailable("reads outside extension JSON snapshots");
		const file = name.slice(EXTENSION_CONFIG_ROOT.length + 1);
		// A subdirectory is outside the flat namespace, not a missing file: reporting
		// ENOENT would invite an extension to keep trying deeper paths.
		if (file.includes("/")) return unavailable("reads outside extension JSON snapshots");
		return file;
	};
	const requireStore = (): ExtensionConfigStore => callbacks.config ?? unavailable("extension configuration");
	/**
	 * The five `fs` members bound to one extension's namespace.
	 *
	 * `mkdirSync` accepts the config root itself, because upstream extensions
	 * create the agent directory before writing into it and that directory does
	 * exist here. Any other path still fails: this is a namespaced key/value
	 * store, not a filesystem, and pretending otherwise would be the silent
	 * no-op the bridge exists to avoid.
	 */
	const configView = (owner: string | undefined): Pick<ExtensionPlatform, "readFileSync" | "existsSync" | "mkdirSync" | "writeFileSync" | "unlinkSync"> => {
		const read = (path: string): string | undefined => {
			const file = configFile(path);
			return owner === undefined ? unavailable("extension configuration") : requireStore().read(owner, file);
		};
		const write = (path: string, text: string | undefined): void => {
			const file = configFile(path);
			if (owner === undefined) return unavailable("extension configuration");
			requireStore().stage(owner, file, text);
		};
		return {
			readFileSync: (path, encoding) => {
				if (encoding !== "utf8" && encoding !== "utf-8") return unavailable("non-UTF-8 resource reads");
				const value = read(path);
				if (value === undefined) throw Object.assign(new Error(`No extension config snapshot: ${path}`), { code: "ENOENT", path });
				return value;
			},
			existsSync: path => read(path) !== undefined,
			// Upstream creates the agent directory before writing into it. The root
			// already exists as a namespace; any other path is a real directory
			// request this host cannot honour.
			mkdirSync: path => {
				assertActive();
				if (owner === undefined) return unavailable("extension configuration");
				if (normalize(path) !== EXTENSION_CONFIG_ROOT) unavailable("fs.mkdirSync");
			},
			writeFileSync: (path, data, encoding) => {
				if (encoding !== undefined && encoding !== "utf8" && encoding !== "utf-8") return unavailable("non-UTF-8 resource writes");
				if (typeof data !== "string") return unavailable("non-text resource writes");
				write(path, data);
			},
			unlinkSync: path => write(path, undefined),
		};
	};
	class UnsupportedTerminal {
		constructor() { unavailable("terminal UI"); }
	}
	const platform: ExtensionPlatform = {
		fetch: (input, init) => request(signal => callbacks.fetch(input, { ...init, signal }), init?.signal ?? (input instanceof Request ? input.signal : undefined)),
		complete: (model, context, options) => request(signal => callbacks.complete(model, context, { ...options, signal }), options?.signal),
		getEnvApiKey: () => undefined,
		getAgentDir: () => EXTENSION_CONFIG_ROOT,
		...configView(undefined),
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
		/**
		 * The platform one audited extension receives. Its configuration view is
		 * bound here, at construction, so ownership cannot be argued at call time.
		 */
		forExtension: (owner: string): ExtensionPlatform => ({ ...platform, ...configView(owner) }),
		/** Retain physical IO without delaying the caller's timeout or abort. */
		trackRequest: (settled: Promise<void>): void => {
			const scope = requireScope();
			scope.pending++;
			void settled.then(() => release(scope), () => release(scope));
		},
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
