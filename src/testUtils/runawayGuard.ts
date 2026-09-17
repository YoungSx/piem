/**
 * Test utilities to prevent uncontrolled spin loops and memory exhaustion in mocks.
 *
 * In tests where mock functions return synchronously (0ms delay), an unhandled
 * state machine loop or missing abort check can spin thousands of times per millisecond.
 * These guards turn an infinite spin into an instant, descriptive test failure before
 * memory can grow or freeze the host system.
 */

export interface RunawayGuardOptions {
	/** Maximum permitted calls before throwing. Defaults to 50. */
	maxCalls?: number;
	/** Descriptive label for the guarded function, included in the error message. */
	label?: string;
}

/**
 * Wraps a mock function (e.g. a test `StreamFn` or callback) with an invocation
 * counter that throws immediately if invoked beyond a safe bound.
 */
export function withRunawayGuard<T extends (...args: any[]) => any>(
	fn: T,
	options: RunawayGuardOptions = {},
): T {
	const maxCalls = options.maxCalls ?? 50;
	const label = options.label ?? "mock function";
	let calls = 0;

	return ((...args: Parameters<T>): ReturnType<T> => {
		calls += 1;
		if (calls > maxCalls) {
			throw new Error(
				`[RunawayGuard] ${label} exceeded maximum invocation limit (${maxCalls}) - probable runaway spin loop in test`,
			);
		}
		return fn(...args);
	}) as T;
}

/**
 * Creates an array collector that caps its maximum stored length.
 *
 * When tests record requests or contexts across stream calls, an uncontrolled loop
 * pushing to a bare array consumes memory quadratically. This helper keeps the
 * first `maxItems` and ignores subsequent pushes, ensuring bounded memory even
 * during runaway scenarios.
 */
export function createBoundedCollector<T>(maxItems = 100): {
	items: T[];
	push: (...elements: T[]) => void;
	totalPushed: () => number;
} {
	const items: T[] = [];
	let total = 0;
	return {
		items,
		push: (...elements: T[]) => {
			total += elements.length;
			for (const el of elements) {
				if (items.length < maxItems) {
					items.push(el);
				}
			}
		},
		totalPushed: () => total,
	};
}
