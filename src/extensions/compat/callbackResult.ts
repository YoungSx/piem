/**
 * Pi types these callbacks as void, but JavaScript may return promises. Invoke
 * synchronously in order, preserving their result solely for error observation.
 */
export function nativeCallbackResult(callbacks: readonly (() => unknown)[]): void | Promise<void> {
	const pending: Promise<unknown>[] = [];
	try {
		for (const callback of callbacks) {
			const value = callback();
			if (value !== null && (typeof value === "object" || typeof value === "function") && typeof Reflect.get(value, "then") === "function") {
				pending.push(Promise.resolve(value));
			}
		}
	} catch (error) {
		// Earlier callbacks may already have started async work. A later sync
		// exception must not leave those rejections unobserved.
		for (const promise of pending) void promise.catch(() => undefined);
		throw error;
	}
	if (pending.length) return Promise.all(pending).then(() => undefined);
}
