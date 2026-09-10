import { afterAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import type { ExtensionUIAdapter } from "./extensionUI";
import { createExtensionHost, type ExtensionEntry, type ExtensionHostCallbacks } from "./extensionHost";
import { stubWindowMembers, stubWindowTimers } from "../testUtils/windowStub";

const restoreTimers = stubWindowTimers();
afterAll(restoreTimers);

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(yes => { resolve = yes; });
	return { promise, resolve };
}

function nativeUI() {
	let text = "";
	let registrations = 0;
	let resets = 0;
	let autocomplete: AutocompleteProvider = {
		getSuggestions: async () => null,
		applyCompletion: lines => ({ lines, cursorLine: 0, cursorCol: 0 }),
	};
	const statuses = new Map<string, string>();
	const widgets = new Map<string, string[]>();
	const adapter: ExtensionUIAdapter = {
		select: async (_title, choices) => choices[0], confirm: async () => true,
		input: async () => "native input", editor: async (_title, prefill) => prefill,
		getEditorText: () => text, setEditorText: value => { text = value; }, pasteToEditor: value => { text += value; },
		setStatus: (key, value) => { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
		setWidget: (key, value) => { if (value === undefined) widgets.delete(key); else widgets.set(key, value); },
		addAutocompleteProvider: factory => {
			autocomplete = factory(autocomplete);
			registrations++;
		},
		reset: () => { statuses.clear(); widgets.clear(); resets++; },
	};
	return { adapter, statuses, widgets, autocomplete: () => autocomplete, text: () => text, registrations: () => registrations, resets: () => resets };
}

async function makeHost(factory: ExtensionFactory, callbacks: Partial<ExtensionHostCallbacks> = {}) {
	return createExtensionHost([{ id: "native-contract", factory }], {
		getEntries: () => [], getBranch: () => [], getSessionId: () => "native-session", getSessionFile: () => "Piem/native.jsonl",
		notify: () => {}, isIdle: () => true, getSystemPrompt: () => "system", ...callbacks,
	});
}

describe("native extension host", () => {
	it("starts once when invoked, reports actual UI availability, and replays surfaces on a new panel", async () => {
		let context!: ExtensionContext;
		const seen: string[] = [];
		const host = await makeHost(pi => {
			pi.on("session_start", (event, ctx) => {
				context = ctx;
				seen.push(`${event.reason}:${ctx.mode}:${ctx.hasUI}`);
				ctx.ui.setStatus("state", "ready");
				ctx.ui.setWidget("tip", ["Hello"]);
				ctx.ui.addAutocompleteProvider(base => base);
			});
		});
		const a = nativeUI();
		const b = nativeUI();
		try {
			expect(seen).toEqual([]);
			host.attachUI(a.adapter);
			await Promise.all([host.start("new"), host.start("resume")]);
			expect(seen).toEqual(["new:rpc:true"]);
			const write = context.ui.setEditorText;
			host.cancel();
			write("survives a later turn");
			expect(a.text()).toBe("survives a later turn");
			host.attachUI(undefined);
			expect(context.hasUI).toBe(false);
			expect(context.mode).toBe("print");
			expect(() => write("hidden")).toThrow("not attached");
			host.attachUI(b.adapter);
			expect(b.statuses.get("state")).toBe("ready");
			expect(b.widgets.get("tip")).toEqual(["Hello"]);
			expect(b.registrations()).toBe(1);
			write("returned conversation");
			expect(b.text()).toBe("returned conversation");
			expect(a.resets()).toBe(1);
			await host.start();
			expect(seen).toHaveLength(1);
		} finally { host.dispose(); }
		expect(() => context.ui).toThrow();
	});

	it("print mode never claims UI and still refuses terminal-only operations", async () => {
		let context!: ExtensionContext;
		const host = await makeHost(pi => { pi.on("session_start", (_event, ctx) => { context = ctx; }); });
		try {
			await host.start();
			expect(context.mode).toBe("print");
			expect(context.hasUI).toBe(false);
			expect(context.ui.theme.fg("accent", "Hello")).toBe("Hello");
			expect(() => context.ui.setWidget("terminal", () => ({ render: () => [], invalidate: () => {} }))).toThrow("not attached");
			expect(() => context.ui.onTerminalInput(() => undefined)).toThrow("terminal-only");
		} finally { host.dispose(); }
	});

	it("revokes a cancelled handler's retained methods across an await", async () => {
		const entered = deferred<void>();
		const resume = deferred<void>();
		const finished = deferred<void>();
		let retained!: () => string;
		let waitForIdle!: () => Promise<void>;
		let waits = 0;
		let staleFailure: unknown;
		const host = await makeHost(pi => {
			pi.registerCommand("delayed", { handler: async (_args, ctx) => {
				retained = ctx.ui.getEditorText;
				waitForIdle = ctx.waitForIdle;
				entered.resolve();
				await resume.promise;
				try { ctx.ui.setEditorText("stale"); } catch (error) { staleFailure = error; }
				finished.resolve();
			} });
		}, { waitForIdle: async () => { waits++; } });
		const ui = nativeUI();
		host.attachUI(ui.adapter);
		try {
			const run = host.run("delayed");
			await entered.promise;
			host.cancel();
			await expect(run).rejects.toThrow("cancelled");
			expect(() => retained()).toThrow("cancelled");
			expect(() => waitForIdle()).toThrow("cancelled");
			expect(waits).toBe(0);
			await host.beforeAgentStart("new prompt", undefined, "system");
			resume.resolve();
			await finished.promise;
			expect(staleFailure).toBeInstanceOf(DOMException);
			expect(ui.text()).toBe("");
		} finally { resume.resolve(); host.dispose(); }
	});

	it("refreshes the real branch before an invocation and returns defensive copies", async () => {
		let entries: ExtensionEntry[] = [];
		const stored = [{ id: "branch-entry", type: "message", message: { role: "user", content: "saved" } }];
		const host = await makeHost(pi => {
			pi.registerCommand("branch", { handler: async (_args, ctx) => {
				const branch = ctx.sessionManager.getBranch();
				expect(branch.map(entry => entry.id)).toEqual(["branch-entry"]);
				expect(ctx.sessionManager.getSessionId()).toBe("native-session");
				branch.length = 0;
				expect(ctx.sessionManager.getBranch()).toHaveLength(1);
				expect(() => ctx.sessionManager.getBranch("other-conversation")).toThrow("active conversation branch");
			} });
		}, { refreshSession: async () => { entries = stored; }, getEntries: () => entries, getBranch: () => entries });
		try { await host.run("branch"); expect(stored).toHaveLength(1); }
		finally { host.dispose(); }
	});

	it("rejects shared pi writes resumed after cancellation without affecting a later invocation", async () => {
		const entered = deferred<void>();
		const resume = deferred<void>();
		const finished = deferred<void>();
		const writes: string[] = [];
		let failure: unknown;
		const host = await makeHost(pi => {
			pi.registerCommand("write", { handler: async () => { pi.setLabel("entry", "current"); } });
			pi.registerCommand("late", { handler: async () => {
				entered.resolve();
				await resume.promise;
				try { pi.setLabel("entry", "stale"); } catch (error) { failure = error; }
				finished.resolve();
			} });
		}, { setLabel: (_id, label) => { writes.push(label ?? ""); } });
		try {
			const run = host.run("late");
			await entered.promise;
			host.cancel();
			await expect(run).rejects.toThrow("cancelled");
			await host.run("write");
			resume.resolve();
			await finished.promise;
			expect(String(failure)).toContain("synchronously");
			expect(writes).toEqual(["current"]);
		} finally { resume.resolve(); host.dispose(); }
	});

	it("a cancelled startup is not re-emitted and does not disable later commands", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		let starts = 0;
		let commands = 0;
		const host = await makeHost(pi => {
			pi.on("session_start", async () => { starts++; entered.resolve(); await release.promise; });
			pi.registerCommand("ok", { handler: async () => { commands++; } });
		});
		try {
			const start = host.start();
			await entered.promise;
			host.cancel();
			await expect(start).rejects.toThrow("cancelled");
			await host.run("ok");
			expect(starts).toBe(1);
			expect(commands).toBe(1);
		} finally { release.resolve(); host.dispose(); }
	});

	it("keeps a completed startup handler's callbacks when a later startup dialog is cancelled", async () => {
		const entered = deferred<void>();
		const release = deferred<boolean>();
		let completed!: ExtensionContext;
		let pending!: ExtensionContext;
		let starts = 0;
		const host = await makeHost(pi => {
			pi.on("session_start", (_event, ctx) => {
				starts++;
				completed = ctx;
				ctx.ui.addAutocompleteProvider(base => ({ ...base, getSuggestions: async () => ({
					prefix: "", items: [{ value: ctx.ui.getEditorText(), label: "surviving provider" }],
				}) }));
			});
			pi.on("session_start", async (_event, ctx) => {
				pending = ctx;
				ctx.ui.addAutocompleteProvider(base => ({ ...base, getSuggestions: async () => {
					ctx.ui.getEditorText();
					return { prefix: "", items: [{ value: "pending", label: "cancelled provider" }] };
				} }));
				entered.resolve();
				await ctx.ui.confirm("Continue", "Startup prompt");
			});
		});
		const first = nativeUI();
		first.adapter.confirm = () => release.promise;
		const second = nativeUI();
		host.attachUI(first.adapter);
		try {
			const start = host.start();
			await entered.promise;
			host.cancel();
			await expect(start).rejects.toThrow("cancelled");
			expect(() => pending.ui.getEditorText()).toThrow("cancelled");
			completed.ui.setEditorText("retained callback");
			expect(first.text()).toBe("retained callback");
			const suggestions = await first.autocomplete().getSuggestions([""], 0, 0, { signal: new AbortController().signal });
			expect(suggestions?.items[0]?.value).toBe("retained callback");
			host.attachUI(second.adapter);
			expect(second.registrations()).toBe(1);
			completed.ui.setEditorText("new panel");
			expect(second.text()).toBe("new panel");
			await host.start();
			expect(starts).toBe(1);
		} finally { release.resolve(false); host.dispose(); }
	});

	it("does not apply an old message replacement when its handler returns after Stop", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		const host = await makeHost(pi => {
			pi.on("message_end", async event => {
				entered.resolve();
				await release.promise;
				if (event.message.role === "user") return { message: { ...event.message, content: "stale" } };
				return undefined;
			});
		});
		const message: AgentMessage = { role: "user", content: "original", timestamp: 1 };
		try {
			const event = host.emitAgentEvent({ type: "message_end", message });
			await entered.promise;
			host.cancel();
			await expect(event).rejects.toThrow("cancelled");
			release.resolve();
			await Promise.resolve();
			await Promise.resolve();
			expect(message.content).toBe("original");
		} finally { release.resolve(); host.dispose(); }
	});

	it("chains before-agent prompt changes and applies final-message replacement to the caller's message", async () => {
		const events: string[] = [];
		const host = await makeHost(pi => {
			pi.on("before_agent_start", event => {
				expect(event.prompt).toBe("hello");
				return { systemPrompt: `${event.systemPrompt}\nextra`, message: { customType: "native", content: "context", display: false } };
			});
			pi.on("before_agent_start", (event, ctx) => {
				expect(event.systemPrompt).toBe("system\nextra");
				expect(ctx.getSystemPrompt()).toBe("system\nextra");
				return { systemPrompt: `${event.systemPrompt}\nlast` };
			});
			pi.on("message_end", event => event.message.role === "user" ? { message: { ...event.message, content: "replaced" } } : undefined);
			pi.on("message_end", event => {
				if (event.message.role === "user") expect(event.message.content).toBe("replaced");
				return event.message.role === "user" ? { message: { ...event.message, content: "replaced again" } } : undefined;
			});
			pi.on("turn_start", event => { events.push(`turn-${event.turnIndex}`); });
			pi.on("agent_settled", () => { events.push("settled"); });
		});
		try {
			const changed = await host.beforeAgentStart("hello", undefined, "system");
			expect(changed?.systemPrompt).toBe("system\nextra\nlast");
			expect(changed?.messages?.[0]?.customType).toBe("native");
			const message: AgentMessage = { role: "user", content: "original", timestamp: 1 };
			await host.emitAgentEvent({ type: "message_end", message });
			expect(message.content).toBe("replaced again");
			await host.emitAgentEvent({ type: "agent_start" });
			await host.emitAgentEvent({ type: "turn_start" });
			await host.emitAgentEvent({ type: "turn_end", message, toolResults: [] });
			await host.emitAgentEvent({ type: "turn_start" });
			await host.settled();
			expect(events).toEqual(["turn-0", "turn-1", "settled"]);
		} finally { host.dispose(); }
	});

	it("skips branch reads when no handler uses an event", async () => {
		let reads = 0;
		const host = await makeHost(() => {}, { refreshSession: async () => { reads++; } });
		try {
			await host.start();
			const messages: AgentMessage[] = [{ role: "user", content: "original", timestamp: 1 }];
			const transformed = await host.transformContext(messages);
			expect(transformed).toEqual(messages);
			expect(transformed).not.toBe(messages);
			await host.beforeAgentStart("hello", undefined, "system");
			await host.emitAgentEvent({ type: "agent_start" });
			await host.emitAgentEvent({ type: "turn_start" });
			await host.settled();
			expect(reads).toBe(0);
		} finally { host.dispose(); }
	});

	it("releases retained contexts immediately and runs shutdown once with a fresh read view", async () => {
		let old!: ExtensionContext;
		const events: string[] = [];
		const release = deferred<void>();
		const host = await makeHost(pi => {
			pi.on("session_start", (_event, ctx) => { old = ctx; });
			pi.on("session_shutdown", async (event, ctx) => {
				events.push(`${event.reason}:${ctx.sessionManager.getSessionId()}:${ctx.hasUI}`);
				expect(() => old.sessionManager.getSessionId()).toThrow("cancelled");
				await release.promise;
				expect(ctx.signal?.aborted).toBe(false);
				expect(ctx.getSystemPrompt()).toBe("system");
			});
		});
		await host.start();
		host.dispose("reload");
		host.dispose("quit");
		expect(() => old.isIdle()).toThrow();
		release.resolve();
		await host.closed();
		expect(events).toEqual(["reload:native-session:false"]);
	});

	it("shutdown reads configured metadata with a fresh signal but cannot start model requests", async () => {
		const priorRun = new AbortController();
		priorRun.abort();
		const model: Model<"openai-completions"> = {
			id: "configured", name: "Configured", provider: "configured", api: "openai-completions", baseUrl: "https://example.test",
			reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		let modelRequests = 0;
		const host = await makeHost(pi => {
			pi.on("session_shutdown", async (_event, ctx) => {
				expect(ctx.signal?.aborted).toBe(false);
				expect(ctx.model?.id).toBe(model.id);
				expect(ctx.thinkingLevel).toBe("off");
				expect(ctx.modelRegistry.getAvailable()).toEqual([model]);
				await expect(ctx.modelRegistry.complete(model, { messages: [] })).rejects.toThrow("disposed");
			});
		}, {
			getSignal: () => priorRun.signal, getModel: () => model, getModels: () => [model], getThinkingLevel: () => "off",
			complete: async () => { modelRequests++; throw new Error("Shutdown must not call transport"); },
		});
		await host.start();
		host.dispose();
		await host.closed();
		expect(modelRequests).toBe(0);
	});

	it("bounds unfinished shutdown cleanup to one second and revokes its retained reads", async () => {
		const timers = new Map<number, { run: () => void; delay: number }>();
		let nextTimer = 0;
		const restore = stubWindowMembers({
			setTimeout: (run: () => void, delay: number) => { const id = ++nextTimer; timers.set(id, { run, delay }); return id; },
			clearTimeout: (id: number) => { timers.delete(id); },
		});
		const release = deferred<void>();
		const finished = deferred<void>();
		let cleanup!: ExtensionContext;
		let signal!: AbortSignal | undefined;
		let delayedFailure: unknown;
		const host = await makeHost(pi => {
			pi.on("session_shutdown", async (_event, ctx) => {
				cleanup = ctx;
				signal = ctx.signal;
				await release.promise;
				try { ctx.sessionManager.getSessionId(); } catch (error) { delayedFailure = error; }
				finished.resolve();
			});
		});
		try {
			await host.start();
			host.dispose();
			expect(cleanup.sessionManager.getSessionId()).toBe("native-session");
			expect(signal?.aborted).toBe(false);
			const timer = [...timers.values()][0]!;
			expect(timer.delay).toBe(1000);
			timer.run();
			await expect(host.closed()).rejects.toThrow("cancelled");
			expect(signal?.aborted).toBe(true);
			expect(timers.size).toBe(0);
			expect(() => cleanup.getSystemPrompt()).toThrow("disposed");
			release.resolve();
			await finished.promise;
			expect(delayedFailure).toBeInstanceOf(Error);
		} finally { release.resolve(); host.dispose(); restore(); }
	});
});
