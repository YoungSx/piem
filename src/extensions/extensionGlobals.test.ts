import { afterEach, describe, expect, it } from "bun:test";
import { webcrypto } from "node:crypto";
// Keep the event and target in one realm even after UI tests install a DOM.
import { Event, EventTarget } from "happy-dom";
import { createExtensionCrypto, createExtensionDocument, createExtensionGlobals, createExtensionPerformance, type ExtensionDocument } from "./extensionGlobals";
import { stubWindowMembers } from "../testUtils/windowStub";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function documentView() {
	const target = new EventTarget();
	let visibilityState = "visible";
	const signals = { active: new AbortController(), shutdown: new AbortController() };
	const errors: unknown[] = [];
	const counts = { added: 0, removed: 0 };
	cleanups.push(stubWindowMembers({ document: {
		get visibilityState() { return visibilityState; },
		addEventListener: (...args: Parameters<EventTarget["addEventListener"]>) => { counts.added++; target.addEventListener(...args); },
		removeEventListener: (...args: Parameters<EventTarget["removeEventListener"]>) => { counts.removed++; target.removeEventListener(...args); },
	} }));
	const view = createExtensionDocument(signals.active.signal, signals.shutdown.signal, error => errors.push(error))!;
	cleanups.push(() => signals.active.abort());
	return { view, target, signals, counts, errors, hide: () => { visibilityState = "hidden"; target.dispatchEvent(new Event("visibilitychange")); } };
}

describe("extension Web globals", () => {
	it("forwards real visibility and sanitized event data with DOM listener identity, once and abort cleanup", async () => {
		const { view, target, signals, counts, hide, errors } = documentView();
		const seen: unknown[] = [];
		function handler(this: ExtensionDocument, event: unknown) { seen.push({ receiver: this, event, state: view.visibilityState }); }
		view.addEventListener("visibilitychange", handler);
		view.addEventListener("visibilitychange", handler);
		expect(counts.added).toBe(1);
		hide();
		expect(seen).toHaveLength(1);
		const first = seen[0] as { receiver: unknown; event: Record<string, unknown>; state: string };
		expect(first.receiver).toBe(view);
		expect(first.state).toBe("hidden");
		expect(first.event.target).toBe(view);
		expect(first.event.currentTarget).toBe(view);
		expect(first.event.composedPath).toBeUndefined();
		expect(Object.getPrototypeOf(first.event)).toBeNull();
		expect(Object.getPrototypeOf(view)).toBeNull();
		expect(Reflect.get(view, "defaultView")).toBeUndefined();
		view.removeEventListener("visibilitychange", handler, true);
		expect(counts.removed).toBe(0);
		view.removeEventListener("visibilitychange", handler);
		expect(counts.removed).toBe(1);
		let once = 0;
		view.addEventListener("pagehide", { handleEvent: () => { once++; } }, { once: true });
		target.dispatchEvent(new Event("pagehide")); target.dispatchEvent(new Event("pagehide"));
		expect(once).toBe(1);
		const extra = new AbortController();
		view.addEventListener("pagehide", () => {}, { signal: extra.signal });
		extra.abort();
		expect(counts.added).toBe(counts.removed);
		const failure = new Error("event failure");
		view.addEventListener("pagehide", async () => { throw failure; });
		target.dispatchEvent(new Event("pagehide"));
		await Promise.resolve();
		expect(errors).toEqual([failure]);
		signals.shutdown.abort();
		expect(counts.added).toBe(counts.removed);
		expect(() => view.addEventListener("pagehide", () => {})).toThrow("disposed");
		expect(() => view.visibilityState).toThrow("disposed");
		view.removeEventListener("pagehide", handler);
	});

	it("cleans callbacks on resource abort and rejects unowned or unsupported DOM access", () => {
		const { view, signals, counts } = documentView();
		expect(() => view.addEventListener("click", () => {})).toThrow("only visibilitychange and pagehide");
		for (let i = 0; i < 64; i++) view.addEventListener("pagehide", () => {});
		expect(() => view.addEventListener("pagehide", () => {})).toThrow("At most 64");
		signals.active.abort();
		expect(counts.added).toBe(counts.removed);
		expect(() => createExtensionDocument(undefined, undefined, () => {})).toThrow("owned background lifetime");
	});

	it("provides bound crypto and monotonic time views while keeping registered values private", () => {
		cleanups.push(stubWindowMembers({ crypto: webcrypto, performance }));
		const crypto = createExtensionCrypto();
		const clock = createExtensionPerformance();
		const values = new Uint8Array(16);
		expect(crypto.getRandomValues(values)).toBe(values);
		expect(values.some(value => value !== 0)).toBe(true);
		expect(crypto.randomUUID()).toMatch(/^[0-9a-f-]{36}$/);
		expect(clock.timeOrigin).toBe(performance.timeOrigin);
		expect(clock.now()).toBeGreaterThanOrEqual(0);
		const one = createExtensionGlobals({ crypto, performance: clock }), two = createExtensionGlobals({ crypto, performance: clock });
		const key = Symbol.for("piem.test.private-globals");
		one[key] = "one"; two[key] = "two";
		expect(one[key]).toBe("one"); expect(two[key]).toBe("two");
		expect(Reflect.set(one, "crypto", {})).toBe(false);
		expect(Reflect.setPrototypeOf(one, {})).toBe(false);
		expect(one.window).toBe(one);
		expect(one.self).toBe(one);
		expect(one.globalThis).toBe(one);
		expect(one.global).toBe(one);
		expect(one.XMLHttpRequest).toBeUndefined();
	});
});
