import { afterAll, describe, expect, it, spyOn } from "bun:test";
import type { App, DataAdapter } from "obsidian";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory, SessionBeforeForkEvent, SessionBeforeSwitchEvent } from "@earendil-works/pi-coding-agent";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { installObsidianStub } from "../testUtils/obsidianStub";
import { stubWindowTimers } from "../testUtils/windowStub";

installObsidianStub();
const restoreTimers = stubWindowTimers();
afterAll(restoreTimers);
const { ObsidianAgentService } = await import("./ObsidianAgentService");
const { ObsidianSessionManager } = await import("../session/ObsidianSessionManager");
const { DEFAULT_SETTINGS } = await import("../settings");

function harness(factory: ExtensionFactory, pauseReply?: () => Promise<void>) {
	const adapter = new MemoryAdapter() as unknown as DataAdapter;
	const sessions = new ObsidianSessionManager(adapter, "Piem/sessions", "obsidian-vault:Navigation test");
	const settings = {
		...DEFAULT_SETTINGS,
		providers: [{ id: "test", name: "Test", baseUrl: "https://test.invalid/v1", protocol: "openai-completions" as const,
			apiKey: "test-key", secretRef: "", source: "user" as const, oauthFlow: "" as const }],
		models: [{ id: "test", providerId: "test", modelApiId: "test", displayName: "Test", reasoning: false, supportsImages: false }],
		activeModelId: "test",
	};
	const app = {
		vault: { adapter, getName: () => "Navigation test", getFiles: () => [], getFileByPath: () => null,
			getAbstractFileByPath: () => null, read: async () => "", cachedRead: async () => "" },
		workspace: { getActiveViewOfType: () => null, getActiveFile: () => null },
	} as unknown as App;
	const streamFn: StreamFn = model => {
		const message: AssistantMessage = {
			role: "assistant", content: [{ type: "text", text: "Saved reply" }], api: model.api, provider: model.provider,
			model: model.id, timestamp: Date.now(), stopReason: "stop", usage: { input: 2, output: 2, cacheRead: 0,
				cacheWrite: 0, totalTokens: 4, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const stream = createAssistantMessageEventStream();
		const done = () => { stream.push({ type: "done", reason: "stop", message }); stream.end(message); };
		if (pauseReply) void pauseReply().then(done);
		else done();
		return stream;
	};
	const service = new ObsidianAgentService(app, () => settings, sessions, {
		streamFn, extensionFactories: [{ id: "navigation-test", factory }],
		loadUserSkills: async () => ({ skills: [], diagnostics: [], searched: [] }),
	});
	const target = async () => {
		const current = service.getActiveSessionPath();
		const info = await sessions.createSession({ provider: "test", modelId: "test", thinkingLevel: "off" });
		if (current) sessions.focusSession(current);
		return info.path;
	};
	return { service, sessions, target };
}

function gate() {
	let release!: () => void;
	const promise = new Promise<void>(resolve => { release = resolve; });
	return { promise, release };
}

describe("extension vetoes before native session navigation", () => {
	it.each([false, true])("initializes a dormant source before its first navigation (loaded: %s)", async loaded => {
		const order: string[] = [];
		const { service, target } = harness(pi => {
			let ready = false;
			pi.on("session_start", () => { ready = true; order.push("start"); });
			pi.on("session_before_switch", () => { expect(ready).toBe(true); order.push("before"); return { cancel: true }; });
		});
		try {
			if (loaded) await target();
			await service.initialize();
			const source = service.getActiveSessionPath();
			const destination = await target();
			expect(order).toEqual([]);
			await service.openSession(destination);
			expect(order).toEqual(["start", "before"]);
			expect(service.getActiveSessionPath()).toBe(source);
		} finally { service.dispose(); }
	});

	it.each([false, true])("refuses a startup-triggered selection without waiting on that startup itself (same target: %s)", async sameTarget => {
		const order: string[] = [];
		let nested = "";
		const { service, target } = harness(pi => {
			pi.on("session_start", async () => {
				order.push("start");
				await service.openSession(nested);
				order.push("ready");
			});
			pi.on("session_before_switch", () => { order.push("before"); return { cancel: true }; });
		});
		try {
			await service.initialize();
			const source = service.getActiveSessionPath();
			nested = await target();
			await service.openSession(sameTarget ? nested : await target());
			expect(order).toEqual(["start", "ready", "before"]);
			expect(service.getActiveSessionPath()).toBe(source);
		} finally { service.dispose(); }
	});

	it("cancels forks before copying and passes the real reply entry and at position", async () => {
		let cancel = true;
		const events: SessionBeforeForkEvent[] = [];
		let switches = 0;
		const { service, sessions } = harness(pi => {
			pi.on("session_before_fork", (event, ctx) => {
				expect(ctx.sessionManager.getEntry(event.entryId)?.type).toBe("message");
				events.push(event);
				return { cancel };
			});
			pi.on("session_before_switch", () => { switches++; return { cancel: true }; });
		});
		try {
			await service.sendPrompt("Fork this answer");
			const source = service.getActiveSessionPath();
			const copy = spyOn(sessions, "forkSession");
			const index = service.getSnapshot().messages.length - 1;
			expect(await service.forkSessionAt(index)).toBe(false);
			expect(copy).not.toHaveBeenCalled();
			expect(service.getActiveSessionPath()).toBe(source);
			expect(await sessions.listSessions()).toHaveLength(1);
			cancel = false;
			expect(await service.forkSessionAt(index)).toBe(true);
			expect(copy).toHaveBeenCalledTimes(1);
			expect(events.map(event => event.position)).toEqual(["at", "at"]);
			expect(switches).toBe(0);
			expect(await sessions.listSessions()).toHaveLength(2);
			expect(service.getSnapshot().messages.at(-1)?.role).toBe("assistant");
		} finally { service.dispose(); }
	});

	it.each([false, true])("cancels new and open before creating or preparing a session (throw: %s)", async throws => {
		const events: SessionBeforeSwitchEvent[] = [];
		const { service, sessions, target } = harness(pi => {
			pi.on("session_before_switch", event => {
				events.push(event);
				if (throws) throw new Error("Navigation handler failed");
				return { cancel: true };
			});
		});
		try {
			await service.sendPrompt("Keep this conversation");
			const source = service.getActiveSessionPath();
			const destination = await target();
			const prepare = spyOn(sessions, "prepareSession");
			const create = spyOn(sessions, "createBlankSession");
			await service.openSession(destination);
			expect(prepare).not.toHaveBeenCalled();
			expect(service.getActiveSessionPath()).toBe(source);
			expect(service.getSnapshot().isOpeningSession).toBe(false);
			await service.newSession();
			expect(create).not.toHaveBeenCalled();
			expect(service.getActiveSessionPath()).toBe(source);
			expect(events).toEqual([
				{ type: "session_before_switch", reason: "resume", targetSessionFile: destination },
				{ type: "session_before_switch", reason: "new" },
			]);
		} finally { service.dispose(); }
	});

	it("lets a newer cold choice finish while the previous veto handler is still waiting", async () => {
		const entered = gate(), held = gate();
		let blocked = "";
		const { service, target } = harness(pi => {
			pi.on("session_before_switch", async event => {
				if (event.targetSessionFile === blocked) { entered.release(); await held.promise; }
			});
		});
		try {
			await service.sendPrompt("Source");
			blocked = await target();
			const latest = await target();
			const first = service.openSession(blocked);
			await entered.promise;
			await service.openSession(latest);
			expect(service.getActiveSessionPath()).toBe(latest);
			held.release();
			await first;
			expect(service.getActiveSessionPath()).toBe(latest);
		} finally { held.release(); service.dispose(); }
	});

	it("allows a handler to await another cold selection without waiting on its own queue", async () => {
		let first = "", replacement = "";
		const { service, target } = harness(pi => {
			pi.on("session_before_switch", async event => {
				if (event.targetSessionFile === first) await service.openSession(replacement);
			});
		});
		try {
			await service.sendPrompt("Source");
			first = await target();
			replacement = await target();
			await service.openSession(first);
			expect(service.getActiveSessionPath()).toBe(replacement);
		} finally { service.dispose(); }
	});

	it("preserves a readable snapshot for two immediate selections before a handler starts", async () => {
		const { service, target } = harness(pi => {
			pi.on("session_before_switch", (_event, ctx) => { expect(ctx.sessionManager.getLeafId()).toBeString(); });
		});
		try {
			await service.sendPrompt("Source");
			const first = await target(), latest = await target();
			await Promise.all([service.openSession(first), service.openSession(latest)]);
			expect(service.getSnapshot().session?.path).toBe(latest);
		} finally { service.dispose(); }
	});

	it("does not create a new chat after its awaited handler was superseded", async () => {
		const entered = gate(), held = gate();
		const { service, sessions, target } = harness(pi => {
			pi.on("session_before_switch", async event => {
				if (event.reason === "new") { entered.release(); await held.promise; }
			});
		});
		try {
			await service.sendPrompt("Source");
			const latest = await target();
			const create = spyOn(sessions, "createBlankSession");
			const pending = service.newSession();
			await entered.promise;
			await service.openSession(latest);
			held.release();
			await pending;
			expect(create).not.toHaveBeenCalled();
			expect(service.getActiveSessionPath()).toBe(latest);
		} finally { held.release(); service.dispose(); }
	});

	it("does not publish a blank chat whose preparation finished after a newer selection", async () => {
		const entered = gate(), held = gate();
		const { service, sessions, target } = harness(pi => { pi.on("session_before_switch", () => {}); });
		try {
			await service.sendPrompt("Source");
			const latest = await target();
			const create = sessions.createBlankSession.bind(sessions);
			let stalePath = "";
			spyOn(sessions, "createBlankSession").mockImplementation(async (...args) => {
				const result = await create(...args);
				stalePath = result.path;
				entered.release();
				await held.promise;
				return result;
			});
			const pending = service.newSession();
			await entered.promise;
			await service.openSession(latest);
			held.release();
			await pending;
			expect(service.getActiveSessionPath()).toBe(latest);
			expect(sessions.getActiveSessionPath()).toBe(latest);
			expect(service.getSnapshot().session?.path).toBe(latest);
			expect(sessions.isLoaded(stalePath)).toBe(false);
		} finally { held.release(); service.dispose(); }
	});

	it("does not wait for a background handler before switching and lets the source finish", async () => {
		const entered = gate(), held = gate();
		let pendingReply = true;
		const owners: string[] = [];
		const { service, target, sessions } = harness(pi => {
			pi.on("message_start", async () => {
				if (pendingReply) { pendingReply = false; entered.release(); await held.promise; }
			});
			pi.on("session_before_switch", (_event, ctx) => { owners.push(ctx.sessionManager.getSessionFile()!); });
		});
		try {
			await service.initialize();
			const source = service.getActiveSessionPath()!;
			const destination = await target();
			const running = service.sendPrompt("Background answer");
			await entered.promise;
			await service.openSession(destination);
			expect(service.getActiveSessionPath()).toBe(destination);
			expect(owners).toEqual([source]);
			held.release();
			expect(await running).toBe(true);
			expect(JSON.stringify(await sessions.getSessionFor(source).getLog())).toContain("Saved reply");
			expect(service.getActiveSessionPath()).toBe(destination);
		} finally { held.release(); service.dispose(); }
	});

	it("stopping a delayed fork leaves no copied session and no late focus change", async () => {
		const entered = gate(), held = gate();
		const { service, sessions } = harness(pi => {
			pi.on("session_before_fork", async () => { entered.release(); await held.promise; });
		});
		try {
			await service.sendPrompt("Source");
			const source = service.getActiveSessionPath()!;
			const pending = service.forkSessionAt(service.getSnapshot().messages.length - 1);
			await entered.promise;
			await service.abortSession(source);
			expect(await pending).toBe(false);
			held.release();
			expect(await sessions.listSessions()).toHaveLength(1);
			expect(service.getActiveSessionPath()).toBe(source);
		} finally { held.release(); service.dispose(); }
	});

	it("keeps observing a running answer while a switch handler waits for input", async () => {
		const provider = gate(), reply = gate(), entered = gate(), held = gate();
		let answers = 0;
		const { service, target } = harness(pi => {
			pi.on("session_before_switch", async () => { entered.release(); await held.promise; return { cancel: true }; });
			pi.on("message_end", event => { if (event.message.role === "assistant") answers++; });
		}, () => { provider.release(); return reply.promise; });
		try {
			await service.initialize();
			const destination = await target();
			const running = service.sendPrompt("Finish while choosing");
			await provider.promise;
			const opening = service.openSession(destination);
			await entered.promise;
			reply.release();
			expect(await running).toBe(true);
			expect(answers).toBe(1);
			held.release();
			await opening;
			expect(service.getSnapshot().errorMessage).toBeUndefined();
		} finally { reply.release(); held.release(); service.dispose(); }
	});
});
