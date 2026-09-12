import type { FetchFn } from "../net/obsidianFetch";
import { abortable, linkedAbortSignal } from "./extensionLifetime";

const MAX_REQUESTS = 4;
const MAX_TIMERS = 64;
const REQUEST_TIMEOUT_MS = 15_000;
let nextTimer = 0;

/** Shared by generations of one host; aborted native IO still occupies its slot. */
export function createExtensionRequestPool(fetch: FetchFn): FetchFn {
	let pending = 0;
	return async (input, init) => {
		if (pending >= MAX_REQUESTS) throw new Error(`At most ${MAX_REQUESTS} extension background requests may be outstanding.`);
		pending++;
		try { return await fetch(input, init); }
		finally { pending--; }
	};
}

interface Timer {
	native?: number;
	interval: boolean;
	callback: (...args: unknown[]) => unknown;
	args: unknown[];
	delay: number;
	cancel?(): void;
}

/**
 * Resources for a reviewed background factory, independent of chat operations.
 * The injected fetch must settle with physical IO, not an earlier abort race.
 * No global API is replaced; disposal revokes retained closures immediately.
 */
export function createExtensionResources(options: { fetch: FetchFn; onError(error: unknown): void }) {
	const lifetime = new AbortController();
	const shutdown = new AbortController();
	const timers = new Map<number, Timer>();
	const tasks = new Set<Promise<unknown>>();
	let requests = 0;
	let closing = false;
	const assertActive = (): void => {
		if (lifetime.signal.aborted) throw new DOMException("Extension background resources were disposed.", "AbortError");
	};
	const report = (error: unknown): void => {
		if (lifetime.signal.aborted) return;
		try { options.onError(error); } catch { /* Error reporting must not leak a rejected callback. */ }
	};
	const clear = (id?: number): void => {
		if (id === undefined) return;
		const timer = timers.get(id);
		if (!timer) return;
		timers.delete(id);
		if (timer.native !== undefined) window.clearTimeout(timer.native);
		timer.cancel?.();
	};
	const schedule = (id: number, timer: Timer): void => {
		timer.native = window.setTimeout(() => {
			timer.native = undefined;
			if (lifetime.signal.aborted || timers.get(id) !== timer) return;
			const task = Promise.resolve().then(() => {
				assertActive();
				if (timers.get(id) !== timer) return;
				return timer.callback(...timer.args);
			});
			tasks.add(task);
			void task.catch(report).finally(() => {
				tasks.delete(task);
				if (timer.interval && !closing && !lifetime.signal.aborted && timers.get(id) === timer) schedule(id, timer);
				else clear(id);
			});
		}, timer.delay);
	};
	const addTimer = (interval: boolean, callback: (...args: unknown[]) => unknown, delay = 0, args: unknown[] = []): number => {
		assertActive();
		if (typeof callback !== "function") throw new TypeError("Extension timers require a function callback.");
		if (closing && interval) throw new Error("Cannot start an interval while an extension is closing.");
		if (timers.size + tasks.size >= MAX_TIMERS) throw new Error(`At most ${MAX_TIMERS} extension timers or pending callbacks are supported.`);
		// Match Node's finite timer range. Intervals never overlap async callbacks.
		const timeout = !Number.isFinite(delay) || delay < 1 || delay > 2_147_483_647 ? 1 : Math.trunc(delay);
		const id = ++nextTimer;
		const timer: Timer = { interval, callback, args, delay: timeout };
		timers.set(id, timer);
		schedule(id, timer);
		return id;
	};
	const fetch: FetchFn = async (input, init) => {
		assertActive();
		if (requests >= MAX_REQUESTS) throw new Error(`At most ${MAX_REQUESTS} extension background requests may be outstanding.`);
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Extension background requests require HTTP or HTTPS.");
		const source = init?.signal ?? (typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined);
		const linked = linkedAbortSignal(lifetime.signal, source ?? undefined);
		if (linked.signal.aborted) { linked.dispose(); throw new DOMException("Extension request was cancelled.", "AbortError"); }
		const deadline = new AbortController();
		const request = linkedAbortSignal(linked.signal, deadline.signal);
		requests++;
		const timer = window.setTimeout(() => deadline.abort(), REQUEST_TIMEOUT_MS);
		try {
			return await abortable(Promise.resolve().then(() => {
				assertActive();
				if (request.signal.aborted) throw new DOMException("Extension request was cancelled.", "AbortError");
				return options.fetch(input, { ...init, signal: request.signal });
			}), request.signal);
		} finally { requests--; window.clearTimeout(timer); request.dispose(); linked.dispose(); }
	};
	const delay = <T = undefined>(ms = 0, value?: T, settings?: { signal?: AbortSignal; ref?: boolean }): Promise<T | undefined> => {
		return new Promise((resolve, reject) => {
			assertActive();
			const signal = settings?.signal;
			if (signal?.aborted) { reject(new DOMException("The operation was aborted.", "AbortError")); return; }
			let id: number;
			const abort = (): void => clear(id);
			id = addTimer(false, () => {
				signal?.removeEventListener("abort", abort);
				const timer = timers.get(id);
				if (timer) timer.cancel = undefined;
				resolve(value);
			}, ms);
			timers.get(id)!.cancel = () => {
				signal?.removeEventListener("abort", abort);
				reject(new DOMException("The operation was aborted.", "AbortError"));
			};
			signal?.addEventListener("abort", abort, { once: true });
		});
	};
	return {
		signal: lifetime.signal,
		shutdownSignal: shutdown.signal,
		assertActive,
		fetch,
		setTimeout: (callback: (...args: unknown[]) => unknown, ms?: number, ...args: unknown[]) => addTimer(false, callback, ms, args),
		clearTimeout: clear,
		setInterval: (callback: (...args: unknown[]) => unknown, ms?: number, ...args: unknown[]) => addTimer(true, callback, ms, args),
		clearInterval: clear,
		// `ref` has no process-liveness effect in a WebView; every timer is owned.
		timersPromises: Object.freeze({ setTimeout: delay }),
		beginShutdown(): void {
			closing = true;
			shutdown.abort();
			for (const [id, timer] of timers) if (timer.interval) clear(id);
		},
		dispose(): void {
			if (lifetime.signal.aborted) return;
			shutdown.abort();
			lifetime.abort();
			for (const id of timers.keys()) clear(id);
		},
	};
}
