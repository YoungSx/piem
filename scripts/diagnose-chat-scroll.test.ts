import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Window as HappyWindow } from "happy-dom";

const source = readFileSync(new URL("./diagnose-chat-scroll.js", import.meta.url), "utf8");

/** A fresh realm per test, with explicit clocks and observer delivery. */
function fixture() {
	const win = new HappyWindow() as unknown as Window & typeof globalThis;
	const doc = win.document;
	doc.body.innerHTML = `<div class="view-content private-note-title"><div class="piem-chat">
		<div class="piem-chat__transcript"><main class="piem-chat__messages" data-path="secret-note.md">
			<p>PRIVATE CHAT TEXT api-key-secret</p>
		</main><button class="piem-chat__latest">最新</button></div></div></div>`;
	const scroller = doc.querySelector<HTMLElement>("main")!;
	const latest = doc.querySelector<HTMLButtonElement>("button")!;
	const metrics = { top: 200, height: 1200 };
	let geometryReads = 0;
	Object.defineProperties(scroller, {
		clientHeight: { get: () => 400 },
		clientWidth: { get: () => 300 },
		scrollHeight: { get: () => { geometryReads++; return metrics.height; } },
		scrollWidth: { get: () => 300 },
		scrollTop: { get: () => metrics.top, set: () => { throw new Error("Diagnostic must not scroll"); } },
	});
	scroller.getBoundingClientRect = () => {
		geometryReads++;
		return { x: 0, y: 0, width: 312, height: 400, top: 0, right: 312, bottom: 400, left: 0, toJSON: () => ({}) };
	};
	scroller.scrollTo = () => { throw new Error("Diagnostic must not scroll"); };
	const timers = new Map<number, { callback: () => void; delay: number }>();
	let timerId = 0;
	win.setTimeout = ((callback: () => void, delay: number) => {
		timers.set(++timerId, { callback, delay });
		return timerId;
	}) as typeof win.setTimeout;
	win.clearTimeout = (id) => { if (typeof id === "number") timers.delete(id); };
	const connected = new Set<object>();
	class Observer {
		constructor(_callback: unknown) {}
		observe(): void { connected.add(this); }
		disconnect(): void { connected.delete(this); }
	}
	win.MutationObserver = Observer as unknown as typeof MutationObserver;
	win.ResizeObserver = Observer as unknown as typeof ResizeObserver;
	const logs: string[] = [];
	const scope: Record<string, unknown> = {
		document: doc, console: { log: (message: string) => logs.push(message) },
		fetch: () => { throw new Error("Diagnostic must not use the network"); },
	};
	const run = () => runInNewContext(source, scope) as { kind: string; stop(): string };
	return { win, doc, scroller, latest, metrics, timers, connected, logs, scope, run, geometryReads: () => geometryReads };
}

describe("manual chat scroll diagnostic", () => {
	it("records a farther position after Latest without reading content or scrolling", () => {
		const f = fixture();
		const probe = f.run();
		f.metrics.top = 260;
		f.scroller.dispatchEvent(new f.win.Event("scroll", { bubbles: false }));
		f.latest.click();
		f.metrics.top = 800;
		f.scroller.dispatchEvent(new f.win.Event("scroll"));
		f.scroller.dispatchEvent(new f.win.Event("scrollend"));
		const text = probe.stop();
		const report = JSON.parse(text);
		expect(report.beforeLatest[0].scrollTop).toBe(260);
		expect(report.final[0].scrollTop).toBe(800);
		expect(report.reason).toBe("latest-scrollend");
		for (const secret of ["PRIVATE CHAT TEXT", "api-key-secret", "private-note-title", "secret-note.md"]) {
			expect(text).not.toContain(secret);
		}
		expect(f.scroller.textContent).toContain("PRIVATE CHAT TEXT");
		expect(f.timers.size).toBe(0);
		expect(f.connected.size).toBe(0);
	});

	it("does not force layout on mousemove and keeps event storage bounded", () => {
		const f = fixture();
		const probe = f.run();
		const before = f.geometryReads();
		f.scroller.dispatchEvent(new f.win.PointerEvent("pointerdown", { clientX: 305, clientY: 80, buttons: 1, bubbles: true }));
		for (let i = 0; i < 1000; i++) {
			f.scroller.dispatchEvent(new f.win.PointerEvent("pointermove", { clientX: 305, clientY: 100, buttons: 1, bubbles: true }));
			f.scroller.dispatchEvent(new f.win.Event("scroll"));
		}
		expect(f.geometryReads()).toBe(before);
		const report = JSON.parse(probe.stop());
		expect(report.events.length).toBe(240);
		expect(report.events[0].type).toBe("pointerdown");
		expect(report.omittedEvents).toBeGreaterThan(0);
	});

	it("stops automatically, releases resources and returns the same report again", () => {
		const f = fixture();
		const probe = f.run();
		const deadline = [...f.timers.values()].find(timer => timer.delay === 60_000)!;
		deadline.callback();
		const saved = probe.stop();
		const logs = f.logs.length;
		f.scroller.dispatchEvent(new f.win.Event("scroll"));
		f.latest.click();
		expect(probe.stop()).toBe(saved);
		expect(f.logs.length).toBe(logs);
		expect(f.timers.size).toBe(0);
		expect(f.connected.size).toBe(0);
		expect(JSON.parse(saved).reason).toBe("timeout");
	});

	it("stops the previous probe before a second paste and leaves only one pair of observers", () => {
		const f = fixture();
		const first = f.run();
		const second = f.run();
		expect(first).not.toBe(second);
		expect(f.connected.size).toBe(2);
		expect(f.timers.size).toBe(1);
		second.stop();
		expect(f.connected.size).toBe(0);
		expect(f.timers.size).toBe(0);
	});

	it("uses the focused pop-out document and declines a window without a chat", () => {
		const f = fixture();
		f.scope.activeDocument = f.doc;
		f.scope.document = new HappyWindow().document;
		const probe = f.run();
		expect(JSON.parse(probe.stop()).initial[0].clientHeight).toBe(400);
		delete f.scope.activeDocument;
		expect(f.run).toThrow("Open the Piem chat panel");
		expect(f.connected.size).toBe(0);
	});

	it("declines ambiguous panels instead of combining two conversations", () => {
		const f = fixture();
		const second = f.scroller.cloneNode(true) as HTMLElement;
		Object.defineProperty(second, "clientHeight", { value: 400 });
		second.getBoundingClientRect = f.scroller.getBoundingClientRect;
		f.doc.body.append(second);
		expect(f.run).toThrow("ambiguous-target");
		expect(f.connected.size).toBe(0);
		expect(f.timers.size).toBe(0);
	});

	it("still cleans up if reading the final layout fails, without exposing error details", () => {
		const f = fixture();
		const probe = f.run();
		f.scroller.getBoundingClientRect = () => { throw new Error("PRIVATE/VAULT/PATH"); };
		const report = probe.stop();
		expect(report).toContain("geometry-unavailable");
		expect(report).not.toContain("PRIVATE/VAULT/PATH");
		expect(f.connected.size).toBe(0);
		expect(f.timers.size).toBe(0);
	});

	it("waits for the main scroller, not a descendant's scrollend", () => {
		const f = fixture();
		const probe = f.run();
		f.latest.click();
		f.scroller.querySelector("p")!.dispatchEvent(new f.win.Event("scrollend"));
		expect(f.connected.size).toBe(2);
		f.metrics.top = 800;
		f.scroller.dispatchEvent(new f.win.Event("scrollend"));
		expect(f.connected.size).toBe(0);
		expect(JSON.parse(probe.stop()).final[0].scrollTop).toBe(800);
	});

	it("rolls back installed listeners and observers when startup fails", () => {
		const f = fixture();
		const listeners: { target: EventTarget; type: string; fn: EventListenerOrEventListenerObject; capture: boolean }[] = [];
		for (const target of [f.doc, f.scroller]) {
			const add = target.addEventListener.bind(target);
			const remove = target.removeEventListener.bind(target);
			target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, options: AddEventListenerOptions) => {
				listeners.push({ target, type, fn, capture: options.capture ?? false }); add(type, fn, options);
			}) as typeof target.addEventListener;
			target.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, options: EventListenerOptions) => {
				const index = listeners.findIndex(entry => entry.target === target && entry.type === type && entry.fn === fn && entry.capture === (options.capture ?? false));
				if (index >= 0) listeners.splice(index, 1);
				remove(type, fn, options);
			}) as typeof target.removeEventListener;
		}
		f.win.ResizeObserver = class {
			constructor() { throw new Error("private-vault-name"); }
		} as unknown as typeof ResizeObserver;
		expect(f.run).toThrow("probe-start-failed");
		expect(listeners.length).toBe(0);
		expect(f.connected.size).toBe(0);
		expect(f.timers.size).toBe(0);
		expect(f.scope.piemScrollProbe).toBeUndefined();
	});
});
