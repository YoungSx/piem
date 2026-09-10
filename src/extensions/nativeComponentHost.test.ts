import { afterAll, describe, expect, it } from "bun:test";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { stubWindowTimers } from "../testUtils/windowStub";
import { createExtensionHost, type ExtensionHostCallbacks } from "./extensionHost";
import type { ExtensionShortcutAction, ExtensionUIAdapter, NativeExtensionSurface } from "./extensionUI";
import type { CompatComponent, NativeComponentNode } from "./compat/componentTree";
import { Text } from "./compat/components";
import { BorderedLoader } from "./compat/loader";
import { SelectList } from "./compat/selectList";
import { getSelectListTheme } from "./compat/theme";

afterAll(stubWindowTimers());

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(yes => { resolve = yes; });
	return { promise, resolve };
}

async function drain(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }

function adapter() {
	const widgets = new Map<string, NativeExtensionSurface>();
	const shown = deferred<{ surface: NativeExtensionSurface; signal: AbortSignal }>();
	let text = "";
	let shows = 0;
	let shortcuts: readonly ExtensionShortcutAction[] = [];
	const ui: ExtensionUIAdapter = {
		select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined,
		getEditorText: () => text, setEditorText: value => { text = value; }, pasteToEditor: value => { text += value; },
		setStatus: () => {}, addAutocompleteProvider: () => {},
		setWidget: key => { widgets.delete(key); },
		setComponentWidget: (key, surface) => { if (surface) widgets.set(key, surface); else widgets.delete(key); },
		showComponent: (surface, signal) => {
			shows++;
			shown.resolve({ surface, signal });
			return new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
		},
		setShortcuts: value => { shortcuts = value; },
		reset: () => { widgets.clear(); shortcuts = []; },
	};
	return { ui, widgets, shown, text: () => text, shows: () => shows, shortcuts: () => shortcuts };
}

function selectNode(surface: NativeExtensionSurface): Extract<NativeComponentNode, { kind: "select" }> {
	const find = (node: NativeComponentNode): Extract<NativeComponentNode, { kind: "select" }> | undefined => {
		if (node.kind === "select") return node;
		if (node.kind === "container") for (const child of node.children) { const found = find(child); if (found) return found; }
		return undefined;
	};
	const node = find(surface.getSnapshot());
	if (!node) throw new Error("Expected native select");
	return node;
}

async function host(factory: ExtensionFactory, callbacks: Partial<ExtensionHostCallbacks> = {}) {
	return createExtensionHost([{ id: "native-components", factory }], {
		getEntries: () => [], getSessionId: () => "native-session", getSystemPrompt: () => "system", isIdle: () => true,
		notify: () => {}, ...callbacks,
	});
}

describe("native component host lifecycle", () => {
	it("retires every widget and runtime even when a component cleanup throws", async () => {
		let context!: ExtensionContext;
		let cleaned = 0;
		let notifying = true;
		const instance = await host(pi => pi.on("session_start", (_event, ctx) => {
			context = ctx;
			ctx.ui.setWidget("broken", () => ({ render: () => ["Broken cleanup"], invalidate: () => {}, dispose: () => { throw new Error("Cleanup failed"); } }));
			ctx.ui.setWidget("remaining", () => ({ render: () => ["Remaining"], invalidate: () => {}, dispose: () => { cleaned++; } }));
		}), { notify: () => { if (!notifying) throw new Error("Notice owner retired"); } });
		const ui = adapter(); instance.attachUI(ui.ui);
		await instance.start();
		notifying = false;
		expect(() => instance.dispose()).not.toThrow();
		expect(cleaned).toBe(1);
		expect(ui.widgets.size).toBe(0);
		expect(() => context.ui).toThrow("disposed");
	});

	it("runs native SelectList callbacks in the original scope through wrappers", async () => {
		let result: unknown;
		const labels: string[] = [];
		const instance = await host(pi => {
			pi.registerCommand("choose", { handler: async (_args, ctx) => {
				result = await ctx.ui.custom<string>((_tui, _theme, _keys, done) => {
					const list = new SelectList([{ value: "a", label: "First" }, { value: "b", label: "Second" }], 2, getSelectListTheme());
					list.onSelect = item => { ctx.ui.setEditorText(item.value); pi.setLabel("entry", item.value); done(item.value); };
					let component: CompatComponent = list;
					for (let i = 0; i < 5; i++) { const child = component; component = { render: width => child.render(width), invalidate: () => child.invalidate() }; }
					return component;
				});
			} });
		}, { setLabel: (_id, value) => labels.push(value ?? "") });
		const ui = adapter(); instance.attachUI(ui.ui);
		try {
			const run = instance.run("choose");
			const { surface, signal } = await ui.shown.promise;
			selectNode(surface).onSelectionChange(1);
			await drain();
			expect(selectNode(surface).selectedIndex).toBe(1);
			const old = selectNode(surface);
			old.onSelect(1);
			await run;
			expect(result).toBe("b"); expect(ui.text()).toBe("b"); expect(labels).toEqual(["b"]);
			expect(signal.aborted).toBe(true);
			old.onSelect(0);
			expect(labels).toEqual(["b"]);
		} finally { instance.dispose(); }
	});

	it("recreates widgets on panel remount and retires their old callbacks and refreshes", async () => {
		let ctx!: ExtensionContext;
		let mounted = 0;
		let disposed = 0;
		const refresh: Array<() => void> = [];
		const instance = await host(pi => pi.on("session_start", (_event, context) => {
			ctx = context;
			ctx.ui.setWidget("choices", tui => {
				mounted++;
				refresh.push(() => tui.requestRender());
				const list = new SelectList([{ value: String(mounted), label: "Choose" }], 2, getSelectListTheme());
				list.onSelect = item => ctx.ui.setEditorText(item.value);
				return { render: width => list.render(width), invalidate: () => list.invalidate(), dispose: () => { disposed++; list.dispose(); } };
			});
		}));
		const first = adapter(); const second = adapter(); instance.attachUI(first.ui);
		try {
			await instance.start();
			const originalSurface = first.widgets.get("choices")!;
			const original = selectNode(originalSurface);
			instance.cancel();
			original.onSelect(0);
			expect(first.text()).toBe("1");
			instance.attachUI(second.ui);
			expect(mounted).toBe(2); expect(disposed).toBe(1); expect(first.widgets.size).toBe(0);
			original.onSelect(0); refresh[0]!(); await drain();
			expect(second.text()).toBe("");
			selectNode(second.widgets.get("choices")!).onSelect(0);
			expect(second.text()).toBe("2");
			ctx.ui.setWidget("choices", undefined);
			expect(disposed).toBe(2); expect(second.widgets.size).toBe(0);
		} finally { instance.dispose(); }
	});

	it("disposes extension-owned async callback work when its widget leaves a panel", async () => {
		const entered = deferred<void>(); const release = deferred<void>(); const finished = deferred<void>();
		let skipped = false;
		const instance = await host(pi => pi.on("session_start", (_event, ctx) => {
			ctx.ui.setWidget("async-choice", () => {
				const controller = new AbortController();
				const list = new SelectList([{ value: "a", label: "First" }], 1, getSelectListTheme());
				list.onSelect = async () => {
					entered.resolve(); await release.promise;
					if (controller.signal.aborted) skipped = true;
					else ctx.ui.setEditorText("Choice");
					finished.resolve();
				};
				return { render: width => list.render(width), invalidate: () => list.invalidate(), dispose: () => { controller.abort(); list.dispose(); } };
			});
		}));
		const first = adapter(); const second = adapter(); instance.attachUI(first.ui);
		try {
			await instance.start(); selectNode(first.widgets.get("async-choice")!).onSelect(0); await entered.promise;
			instance.attachUI(second.ui); release.resolve(); await finished.promise;
			expect(second.text()).toBe(""); expect(skipped).toBe(true);
		} finally { release.resolve(); instance.dispose(); }
	});

	it("retains successful startup contexts for the same conversation while old surfaces retire", async () => {
		// Pi callbacks are void and may launch work the host cannot observe. Their
		// owner must cancel that work in dispose; the startup context itself remains
		// usable when this conversation's panel is mounted again.
		let ctx!: ExtensionContext;
		const instance = await host(pi => pi.on("session_start", (_event, context) => { ctx = context; }));
		const first = adapter(); const second = adapter(); instance.attachUI(first.ui);
		try {
			await instance.start(); instance.attachUI(second.ui);
			ctx.ui.setEditorText("Same conversation");
			expect(first.text()).toBe(""); expect(second.text()).toBe("Same conversation");
		} finally { instance.dispose(); }
	});

	it("removes a prior widget when its replacement factory fails", async () => {
		let ctx!: ExtensionContext;
		const instance = await host(pi => pi.on("session_start", (_event, context) => { ctx = context; ctx.ui.setWidget("tip", () => new Text("Original")); }));
		const ui = adapter(); instance.attachUI(ui.ui);
		try {
			await instance.start();
			expect(ui.widgets.has("tip")).toBe(true);
			expect(() => ctx.ui.setWidget("tip", () => { throw new Error("Factory failed"); })).toThrow("Factory failed");
			expect(ui.widgets.has("tip")).toBe(false);
		} finally { instance.dispose(); }
	});

	it("does not let an outer widget factory overwrite a reentrant replacement", async () => {
		const instance = await host(pi => pi.on("session_start", (_event, ctx) => {
			ctx.ui.setWidget("tip", () => {
				ctx.ui.setWidget("tip", () => new Text("Newest"));
				return new Text("Old outer");
			});
		}));
		const ui = adapter(); instance.attachUI(ui.ui);
		try {
			await instance.start();
			expect(ui.widgets.get("tip")?.getSnapshot()).toMatchObject({ kind: "text", text: "Newest" });
		} finally { instance.dispose(); }
	});

	it("cancels a pending async custom factory and aborts any late loader without mounting", async () => {
		const entered = deferred<void>(); const release = deferred<void>(); const finished = deferred<void>();
		let loader: BorderedLoader | undefined;
		let lateFailure: unknown;
		const instance = await host(pi => pi.registerCommand("wait", { handler: async (_args, ctx) => {
			await ctx.ui.custom(async (tui, theme) => {
				entered.resolve(); await release.promise;
				loader = new BorderedLoader(tui, theme, "Late work");
				try { ctx.ui.setEditorText("Late draft"); } catch (error) { lateFailure = error; }
				finished.resolve(); return loader;
			});
		} }));
		const ui = adapter(); instance.attachUI(ui.ui);
		try {
			const run = instance.run("wait");
			await entered.promise; instance.cancel();
			await expect(run).rejects.toThrow("cancelled");
			release.resolve(); await finished.promise; await drain();
			expect(loader?.signal.aborted).toBe(true); expect(ui.shows()).toBe(0); expect(ui.text()).toBe("");
			expect(lateFailure).toBeInstanceOf(Error);
		} finally { release.resolve(); instance.dispose(); }
	});

	it("native cancellation invokes loader onAbort once and closes its wrapped resources", async () => {
		let loader!: BorderedLoader; let aborts = 0; let result: unknown;
		const instance = await host(pi => pi.registerCommand("loader", { handler: async (_args, ctx) => {
			result = await ctx.ui.custom((tui, theme, _keys, done) => {
				loader = new BorderedLoader(tui, theme, "Working");
				loader.onAbort = () => { aborts++; done("cancelled"); };
				return { render: width => loader.render(width), invalidate: () => loader.invalidate() };
			});
		} }));
		const ui = adapter(); instance.attachUI(ui.ui);
		try {
			const run = instance.run("loader"); const { surface, signal } = await ui.shown.promise;
			surface.cancel(); surface.cancel(); await run;
			expect(result).toBe("cancelled"); expect(aborts).toBe(1); expect(loader.signal.aborted).toBe(true); expect(signal.aborted).toBe(true);
		} finally { instance.dispose(); }
	});

	it("done retires a custom surface synchronously before another retained action", async () => {
		const selected: string[] = [];
		const instance = await host(pi => pi.registerCommand("once", { handler: async (_args, ctx) => {
			await ctx.ui.custom((_tui, _theme, _keys, done) => {
				const list = new SelectList([{ value: "a", label: "First" }, { value: "b", label: "Second" }], 2, getSelectListTheme());
				list.onSelect = item => { selected.push(item.value); done(item.value); };
				return list;
			});
		} }));
		const ui = adapter(); instance.attachUI(ui.ui);
		try {
			const run = instance.run("once"); const { surface } = await ui.shown.promise;
			const snapshot = selectNode(surface);
			snapshot.onSelect(0); snapshot.onSelect(1);
			await run; expect(selected).toEqual(["a"]);
		} finally { instance.dispose(); }
	});

	it("observes asynchronous widget callback failures and retires the failed surface", async () => {
		const notices: string[] = [];
		let reject!: (reason: unknown) => void;
		const failure = new Promise<void>((_resolve, no) => { reject = no; });
		// Keep a failing host from polluting Bun's process-level rejection handler;
		// the assertions still require the host to observe and report the rejection.
		void failure.catch(() => undefined);
		const instance = await host(pi => pi.on("session_start", (_event, ctx) => {
			ctx.ui.setWidget("failing-choice", () => {
				const list = new SelectList([{ value: "a", label: "First" }], 1, getSelectListTheme());
				list.onSelect = () => failure;
				return list;
			});
		}), { notify: message => notices.push(message) });
		const ui = adapter(); instance.attachUI(ui.ui);
		try {
			await instance.start(); selectNode(ui.widgets.get("failing-choice")!).onSelect(0);
			reject(new Error("Async callback failed")); await drain();
			expect(notices).toEqual(["Async callback failed"]); expect(ui.widgets.has("failing-choice")).toBe(false);
		} finally { instance.dispose(); }
	});

	it("ignores a callback rejection that arrives after the widget is already retired", async () => {
		const notices: string[] = [];
		let reject!: (reason: unknown) => void;
		const failure = new Promise<void>((_resolve, no) => { reject = no; });
		void failure.catch(() => undefined);
		let ctx!: ExtensionContext;
		const instance = await host(pi => pi.on("session_start", (_event, context) => {
			ctx = context;
			ctx.ui.setWidget("choice", () => { const list = new SelectList([{ value: "a", label: "First" }], 1, getSelectListTheme()); list.onSelect = () => failure; return list; });
		}), { notify: message => notices.push(message) });
		const ui = adapter(); instance.attachUI(ui.ui);
		try {
			await instance.start(); selectNode(ui.widgets.get("choice")!).onSelect(0);
			ctx.ui.setWidget("choice", undefined); reject(new Error("Late callback failed")); await drain();
			expect(notices).toEqual([]); expect(ui.widgets.size).toBe(0);
		} finally { instance.dispose(); }
	});

	it("synchronous done avoids mounting and retires loader resources", async () => {
		let loader!: BorderedLoader; let result: unknown;
		const instance = await host(pi => pi.registerCommand("early", { handler: async (_args, ctx) => {
			result = await ctx.ui.custom((tui, theme, _keys, done) => { loader = new BorderedLoader(tui, theme, "Early"); done("finished"); return loader; });
		} }));
		const ui = adapter(); instance.attachUI(ui.ui);
		try { await instance.run("early"); expect(result).toBe("finished"); expect(ui.shows()).toBe(0); expect(loader.signal.aborted).toBe(true); }
		finally { instance.dispose(); }
	});

	it("rejects arbitrary interactive renderers before displaying a dead dialog", async () => {
		const instance = await host(pi => pi.registerCommand("unsupported", { handler: async (_args, ctx) => {
			await ctx.ui.custom(() => ({ render: () => ["Press a terminal key"], invalidate: () => {}, handleInput: () => {} }));
		} }));
		const ui = adapter(); instance.attachUI(ui.ui);
		try { await expect(instance.run("unsupported")).rejects.toThrow("custom input without supported native components"); expect(ui.shows()).toBe(0); }
		finally { instance.dispose(); }
	});

	it("rejects a text-only tree with an arbitrary input handler", async () => {
		const instance = await host(pi => pi.registerCommand("text-input", { handler: async (_args, ctx) => {
			await ctx.ui.custom(() => { const text = new Text("Press a terminal key"); return { render: width => text.render(width), invalidate: () => {}, handleInput: () => {} }; });
		} }));
		const ui = adapter(); instance.attachUI(ui.ui);
		try {
			const outcome = instance.run("text-input").then(() => "success", error => String(error));
			await drain();
			const mounted = ui.shows();
			instance.cancel(); await outcome;
			expect(mounted).toBe(0);
		} finally { instance.dispose(); }
	});

	it("coalesces refresh bursts and prevents queued renders after removal", async () => {
		let ctx!: ExtensionContext; let refresh!: () => void; let renders = 0;
		const instance = await host(pi => pi.on("session_start", (_event, context) => {
			ctx = context; ctx.ui.setWidget("tip", tui => { refresh = () => tui.requestRender(); return { render: () => { renders++; return [String(renders)]; }, invalidate: () => {} }; });
		}));
		const ui = adapter(); instance.attachUI(ui.ui);
		try {
			await instance.start(); expect(renders).toBe(1);
			refresh(); refresh(); refresh(); await drain(); expect(renders).toBe(2);
			refresh(); ctx.ui.setWidget("tip", undefined); await drain(); expect(renders).toBe(2);
		} finally { instance.dispose(); }
	});

	it("does not let requestRender called by render starve the event loop", async () => {
		let renders = 0;
		const instance = await host(pi => pi.on("session_start", (_event, ctx) => {
			ctx.ui.setWidget("self-refresh", tui => ({
				invalidate: () => {},
				render: () => { renders++; if (renders < 50) tui.requestRender(); return ["Static content"]; },
			}));
		}));
		const ui = adapter(); instance.attachUI(ui.ui);
		try { await instance.start(); await drain(); expect(renders).toBeLessThanOrEqual(2); }
		finally { instance.dispose(); }
	});
});

describe("native extension shortcut lifetime", () => {
	it("rejects duplicate normalized shortcuts across extensions", async () => {
		await expect(createExtensionHost([
			{ id: "one", factory: pi => pi.registerShortcut("ctrl+shift+k", { handler: () => {} }) },
			{ id: "two", factory: pi => pi.registerShortcut("shift+ctrl+k", { handler: () => {} }) },
		], { getEntries: () => [], notify: () => {} })).rejects.toThrow("Duplicate extension shortcut");
	});

	it("does not revive an old shortcut when the same adapter is attached again", async () => {
		let calls = 0;
		const instance = await host(pi => pi.registerShortcut("ctrl+k", { handler: ctx => { calls++; ctx.ui.setEditorText("Shortcut"); } }));
		const first = adapter(); const second = adapter(); instance.attachUI(first.ui);
		try {
			const old = first.shortcuts()[0]!;
			await old.run(); expect(calls).toBe(1);
			instance.attachUI(second.ui);
			await expect(old.run()).rejects.toThrow("inactive panel");
			instance.attachUI(first.ui);
			await expect(old.run()).rejects.toThrow("inactive panel");
			await first.shortcuts()[0]!.run(); expect(calls).toBe(2);
		} finally { instance.dispose(); }
	});

	it("cancels a pending shortcut on panel switch and blocks its late editor write", async () => {
		const entered = deferred<void>(); const release = deferred<void>(); const finished = deferred<void>();
		let lateFailure: unknown;
		const instance = await host(pi => pi.registerShortcut("ctrl+k", { handler: async ctx => {
			entered.resolve(); await release.promise;
			try { ctx.ui.setEditorText("Old panel"); } catch (error) { lateFailure = error; }
			finished.resolve();
		} }));
		const first = adapter(); const second = adapter(); instance.attachUI(first.ui);
		try {
			const running = first.shortcuts()[0]!.run(); await entered.promise;
			instance.attachUI(second.ui); await expect(running).rejects.toThrow("cancelled");
			release.resolve(); await finished.promise; expect(lateFailure).toBeInstanceOf(Error); expect(second.text()).toBe("");
		} finally { release.resolve(); instance.dispose(); }
	});
});
