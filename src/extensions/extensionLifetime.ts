/** A cancelled invocation can never acquire a later invocation's capabilities. */
export interface ExtensionScope {
	readonly signal: AbortSignal;
	assertActive(): void;
}

export class ExtensionLifetime {
	private readonly shutdown = new AbortController();
	private readonly pending = new Set<AbortController>();
	private currentScope: ExtensionScope | undefined;
	private disposed = false;
	private generation = 0;

	assertActive(): void {
		if (this.disposed) throw new Error("Extension host was disposed.");
	}

	capture(): ExtensionScope {
		this.assertActive();
		if (this.currentScope) return this.currentScope;
		return this.scope(this.shutdown.signal);
	}

	/** Shared pi actions cannot identify an async caller after its first await. */
	assertInvocation(): void {
		this.assertActive();
		if (!this.currentScope) throw new Error("Extension action must begin synchronously inside its handler; use captured ctx capabilities after awaiting.");
		this.currentScope.assertActive();
	}

	private scope(signal: AbortSignal): ExtensionScope {
		const generation = this.generation;
		return {
			signal,
			assertActive: () => {
				this.assertActive();
				if (signal.aborted || generation !== this.generation) {
					throw new DOMException("Extension operation was cancelled.", "AbortError");
				}
			},
		};
	}

	/** Restore a captured lease while its callback enters another host capability. */
	withScope<T>(scope: ExtensionScope, work: () => T): T {
		scope.assertActive();
		const previous = this.currentScope;
		this.currentScope = scope;
		try { return work(); }
		finally { this.currentScope = previous; }
	}

	/** Successful handlers may keep UI callbacks; only unfinished work is revoked. */
	async run<T>(work: (scope: ExtensionScope) => Promise<T>): Promise<T> {
		this.assertActive();
		const controller = new AbortController();
		this.pending.add(controller);
		const previous = this.currentScope;
		const linked = linkedAbortSignal(controller.signal, previous?.signal);
		const scope = this.scope(linked.signal);
		this.currentScope = scope;
		let task: Promise<T>;
		try { task = work(scope); }
		catch (error) { this.pending.delete(controller); linked.dispose(); throw error; }
		finally { this.currentScope = previous; }
		try {
			const result = await abortable(task, scope.signal);
			scope.assertActive();
			return result;
		} finally { this.pending.delete(controller); linked.dispose(); }
	}

	cancel(): void {
		for (const controller of this.pending) controller.abort();
	}

	/** Retire all retained callbacks before dispatching a fresh shutdown context. */
	revoke(): void {
		this.generation++;
		this.cancel();
	}

	dispose(): void {
		this.disposed = true;
		this.shutdown.abort();
		this.cancel();
	}
}

/** Owns each added listener; releases it on success as well as cancellation. */
export function linkedAbortSignal(...signals: Array<AbortSignal | undefined>) {
	const controller = new AbortController();
	const abort = () => controller.abort();
	for (const signal of signals) {
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	}
	return {
		signal: controller.signal,
		dispose: () => { for (const signal of signals) signal?.removeEventListener("abort", abort); },
	};
}

/** A transport/handler that ignores abort cannot hold up the host indefinitely. */
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		void work.catch(() => undefined);
		throw new DOMException("Extension operation was cancelled.", "AbortError");
	}
	let onAbort: (() => void) | undefined;
	const cancelled = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(new DOMException("Extension operation was cancelled.", "AbortError"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try { return await Promise.race([work, cancelled]); }
	finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}
