import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { App, Component, DataAdapter } from "obsidian";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { flushRender, installDom } from "../testUtils/dom";
import { installObsidianStub, resetNotices, shownNotices } from "../testUtils/obsidianStub";

installObsidianStub();
const document = installDom();
const { createRoot } = await import("react-dom/client");
const { ChatApp } = await import("./ChatApp");
const { ChatInputController } = await import("./ChatInputController");
const { ObsidianAgentService } = await import("../agent/ObsidianAgentService");
const { ObsidianSessionManager } = await import("../session/ObsidianSessionManager");
const { DEFAULT_SETTINGS } = await import("../settings");
const { Agent } = await import("@earendil-works/pi-agent-core");
const { DraftStore } = await import("../session/DraftStore");
const toolPairs = await import("./toolPair");

function latch(): { promise: Promise<void>; release: () => void } {
	let release!: () => void;
	return { promise: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
}

class DelayedReads extends MemoryAdapter {
	private blocked: { path: string; arrived: ReturnType<typeof latch>; wait: ReturnType<typeof latch>; fail: boolean } | null = null;

	hold(path: string, fail = false) {
		const blocked = { path, arrived: latch(), wait: latch(), fail };
		this.blocked = blocked;
		return { arrived: blocked.arrived.promise, release: () => { this.blocked = null; blocked.wait.release(); } };
	}

	override async read(path: string): Promise<string> {
		const blocked = this.blocked;
		if (blocked?.path === path) {
			blocked.arrived.release();
			await blocked.wait.promise;
			if (blocked.fail) throw new Error("Fixture read failed");
		}
		return super.read(path);
	}
}

const cleanups: Array<() => void | Promise<void>> = [];

async function fixture(language: "en" | "zh-cn" = "en") {
	const memory = new DelayedReads();
	// Drafts are sidecars, so their clear operation is allowed to hard-delete.
	memory.allowReplaceRemoval = true;
	const adapter = memory as unknown as DataAdapter;
	const settings = {
		...DEFAULT_SETTINGS,
		providers: [{ id: "test", name: "Test", baseUrl: "https://example.invalid", protocol: "openai-completions" as const, apiKey: "fixture", secretRef: "", source: "user" as const, oauthFlow: "" }],
		models: [{ id: "test", providerId: "test", modelApiId: "test", displayName: "Test", reasoning: false, supportsImages: false }],
		activeModelId: "test", sessionDir: "Sessions", userSkillsDir: "", language,
	};
	const seed = new ObsidianSessionManager(adapter, settings.sessionDir, "fixture");
	const sessions = [];
	for (const label of ["A", "B", "C"]) {
		const session = await seed.createSession({ provider: "test", modelId: "test", thinkingLevel: "off" });
		await seed.appendMessage({ role: "user", content: `Conversation ${label}`, timestamp: 1 });
		await seed.appendMessage({
			role: "assistant", content: [{ type: "text", text: `Reply ${label}` }], api: "openai-completions", provider: "test", model: "test",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: 2,
		});
		sessions.push(session);
	}
	const [a, b, c] = sessions;
	if (!a || !b || !c) throw new Error("Missing fixture session");
	let lastOpened = a.path;
	const manager = new ObsidianSessionManager(adapter, settings.sessionDir, "fixture", undefined, {
		read: () => lastOpened, write: (path) => { lastOpened = path; },
	});
	const app = {
		vault: { adapter, getName: () => "Fixture", getFiles: () => [], getFileByPath: () => null, getAbstractFileByPath: () => null },
		workspace: { getActiveViewOfType: () => null, getActiveFile: () => null, getLeavesOfType: () => [], getLastOpenFiles: () => [] },
	} as unknown as App;
	const stream = mock(() => { throw new Error("Opening a conversation must not call the provider"); });
	let toolsGate: ReturnType<typeof latch> | undefined;
	let toolsArrived: ReturnType<typeof latch> | undefined;
	const service = new ObsidianAgentService(app, () => settings, manager, {
		streamFn: stream,
		loadUserSkills: async () => ({ skills: [], diagnostics: [], searched: [] }),
		getExternalTools: async () => { toolsArrived?.release(); await toolsGate?.promise; return []; },
	});
	cleanups.push(() => service.dispose());
	await service.initialize();
	const draftStore = new DraftStore(adapter, settings.sessionDir);
	cleanups.push(async () => { await draftStore.flush(); draftStore.dispose(); });
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	const controller = new ChatInputController();
	root.render(<ChatApp service={service} component={{} as Component} inputController={controller} draftStore={draftStore} />);
	cleanups.push(() => root.unmount());
	await flushRender();
	return {
		memory, manager, service, host, controller, stream, app, settings, draftStore, a, b, c,
		lastOpened: () => lastOpened,
		holdTools: () => { toolsGate = latch(); toolsArrived = latch(); return { arrived: toolsArrived.promise, release: toolsGate.release }; },
	};
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	await flushRender();
	document.body.replaceChildren();
	resetNotices();
});

describe("Opening a stored conversation", () => {
	for (const language of ["en", "zh-cn"] as const) {
		it(`announces the pending read in ${language}, preserves the visible chat, and refuses sends`, async () => {
			const { service, memory, manager, host, controller, stream, draftStore, a, b } = await fixture(language);
			controller.prefill("Keep this draft");
			await flushRender();
			const gate = memory.hold(b.path);
			const opening = service.openSession(b.path);
			try {
				await gate.arrived;
				await flushRender();
				expect(host.querySelector(".piem-chat")?.getAttribute("aria-busy")).toBe("true");
				expect(host.querySelector('.piem-chat__status[role="status"]')?.textContent).toContain(language === "en" ? "Opening chat…" : "正在打开对话…");
				expect(host.querySelector(".piem-chat__spinner")).not.toBeNull();
				expect(host.querySelector<HTMLButtonElement>(".piem-chat__send-button")?.disabled).toBe(true);
				expect(service.getSnapshot().session?.path).toBe(a.path);
				expect(manager.getActiveSessionPath()).toBe(a.path);
				expect(host.textContent).toContain("Conversation A");
				controller.submit();
				expect(await service.sendPrompt("Must not reach either chat")).toBe(false);
				expect(stream).not.toHaveBeenCalled();
				expect(host.querySelector("textarea")?.value).toBe("Keep this draft");
			} finally { gate.release(); await opening; }
			await flushRender();
			expect(host.querySelector(".piem-chat")?.getAttribute("aria-busy")).toBe("false");
			expect(host.querySelector(".piem-chat__spinner")).toBeNull();
			expect(service.getSnapshot().session?.path).toBe(b.path);
			expect(host.textContent).toContain("Conversation B");
			expect(host.querySelector("textarea")?.value).toBe("");
			expect(await draftStore.get(a.id)).toBe("Keep this draft");
			await service.openSession(a.path);
			await flushRender();
			expect(host.querySelector("textarea")?.value).toBe("Keep this draft");
		});
	}

	it("keeps the previous chat focused until runtime setup also finishes", async () => {
		const { service, manager, host, holdTools, a, b } = await fixture();
		const gate = holdTools();
		const opening = service.openSession(b.path);
		try {
			await gate.arrived;
			service.setActiveNotePath("Changed.md");
			await flushRender();
			expect(service.getSnapshot().session?.path).toBe(a.path);
			expect(manager.getActiveSessionPath()).toBe(a.path);
			expect(host.textContent).toContain("Conversation A");
			expect(host.querySelector(".piem-chat__spinner")).not.toBeNull();
		} finally { gate.release(); await opening; }
		expect(service.getSnapshot().session?.path).toBe(b.path);
	});

	it("does not redraw the visible history merely to announce a cold selection", async () => {
		const { service, memory, host, b } = await fixture();
		const planner = spyOn(toolPairs, "planToolPairs");
		const gate = memory.hold(b.path);
		const opening = service.openSession(b.path);
		try {
			await gate.arrived;
			await flushRender();
			expect(host.querySelector(".piem-chat__spinner")).not.toBeNull();
			expect(planner).not.toHaveBeenCalled();
		} finally { gate.release(); await opening; planner.mockRestore(); }
	});

	it("focuses a warm conversation without first publishing another loading frame", async () => {
		const { service, manager, a, b } = await fixture();
		await service.openSession(b.path);
		await flushRender();
		const seen: Array<{ path: string | undefined; opening: boolean }> = [];
		const unsubscribe = service.subscribe((snapshot) => seen.push({ path: snapshot.session?.path, opening: !!snapshot.isOpeningSession }));
		seen.length = 0;
		try { await service.openSession(a.path); }
		finally { unsubscribe(); }
		expect(seen).toEqual([{ path: a.path, opening: false }]);
		expect(manager.getActiveSessionPath()).toBe(a.path);
	});

	it("keeps whitespace in a draft when Enter arrives in the unannounced warm switch", async () => {
		const { service, controller, draftStore, stream, a, b } = await fixture();
		await service.openSession(b.path);
		await flushRender();
		const draft = "  Keep this draft\n\n";
		controller.prefill(draft);
		await flushRender();
		const opening = service.openSession(a.path);
		// No render or await: the controller still holds the previous snapshot,
		// although the service's synchronous navigation guard is already active.
		controller.submit();
		await opening;
		await flushRender();
		expect(stream).not.toHaveBeenCalled();
		expect(await draftStore.get(b.id)).toBe(draft);
	});

	it("does not arm an edit or fork while another conversation is opening", async () => {
		const { service, memory, host, controller, b } = await fixture();
		controller.prefill("Keep this draft");
		await flushRender();
		const gate = memory.hold(b.path);
		const opening = service.openSession(b.path);
		try {
			await gate.arrived;
			await flushRender();
			const edit = host.querySelector<HTMLButtonElement>('button[aria-label="Edit and resend"]');
			expect(edit).not.toBeNull();
			edit!.click();
			const fork = host.querySelector<HTMLButtonElement>('button[aria-label="Fork a new chat from here"]');
			expect(fork).not.toBeNull();
			fork!.click();
			expect(document.querySelector(".modal-container")).toBeNull();
			expect(host.querySelector("textarea")?.value).toBe("Keep this draft");
			expect(await service.forkSessionAt(0)).toBe(false);
		} finally { gate.release(); await opening; }
	});

	it("clears the opening state after a failed read and leaves the old chat usable", async () => {
		const { service, memory, host, a, b } = await fixture();
		const gate = memory.hold(b.path, true);
		const opening = service.openSession(b.path);
		await gate.arrived;
		gate.release();
		await opening;
		await flushRender();
		expect(service.getSnapshot().session?.path).toBe(a.path);
		expect(host.querySelector(".piem-chat")?.getAttribute("aria-busy")).toBe("false");
		expect(host.querySelector(".piem-chat__spinner")).toBeNull();
		expect(shownNotices).toHaveLength(1);
	});

	it("shows only the latest selection when an earlier cold read finishes late", async () => {
		const { service, memory, manager, a, b, c, lastOpened } = await fixture();
		const gate = memory.hold(b.path);
		const seen: string[] = [];
		const unsubscribe = service.subscribe((snapshot) => { if (snapshot.session) seen.push(snapshot.session.path); });
		const first = service.openSession(b.path);
		await gate.arrived;
		const latest = service.openSession(c.path);
		gate.release();
		await Promise.all([first, latest]);
		unsubscribe();
		expect(seen.every((path) => path === a.path || path === c.path)).toBe(true);
		expect(service.getSnapshot().session?.path).toBe(c.path);
		expect(manager.getActiveSessionPath()).toBe(c.path);
		expect(lastOpened()).toBe(c.path);
	});

	it("returning to the visible chat cancels a pending selection", async () => {
		const { service, memory, host, a, b } = await fixture();
		const gate = memory.hold(b.path);
		const opening = service.openSession(b.path);
		await gate.arrived;
		await service.openSession(a.path);
		await flushRender();
		expect(host.querySelector(".piem-chat")?.getAttribute("aria-busy")).toBe("false");
		gate.release();
		await opening;
		expect(service.getSnapshot().session?.path).toBe(a.path);
	});

	it("a new chat supersedes a pending stored conversation", async () => {
		const { service, memory, a, b } = await fixture();
		const gate = memory.hold(b.path);
		const opening = service.openSession(b.path);
		await gate.arrived;
		const newChat = service.newSession();
		gate.release();
		await newChat;
		const fresh = service.getSnapshot().session?.path;
		await opening;
		expect(fresh).not.toBe(a.path);
		expect(fresh).not.toBe(b.path);
		expect(service.getSnapshot().session?.path).toBe(fresh);
		expect(service.getSnapshot().isOpeningSession).toBe(false);
	});

	it("coalesces duplicate selections through runtime setup", async () => {
		const { service, holdTools, b } = await fixture();
		const gate = holdTools();
		const first = service.openSession(b.path);
		await gate.arrived;
		const duplicate = service.openSession(b.path);
		gate.release();
		await Promise.all([first, duplicate]);
		expect(service.getSnapshot().session?.path).toBe(b.path);
		expect(shownNotices).toHaveLength(0);
	});

	it("does not create a runtime after disposal while disk is still pending", async () => {
		const { service, memory, manager, a, b } = await fixture();
		const gate = memory.hold(b.path);
		const opening = service.openSession(b.path);
		await gate.arrived;
		service.dispose();
		gate.release();
		await opening;
		expect(service.getKnownSessions()).toHaveLength(0);
		expect(manager.getActiveSessionPath()).toBe(a.path);
		expect(shownNotices).toHaveLength(0);
	});

	it("does not subscribe an agent after disposal during extension tool preparation", async () => {
		const { service, holdTools, manager, a, b } = await fixture();
		const subscribe = spyOn(Agent.prototype, "subscribe");
		const gate = holdTools();
		const opening = service.openSession(b.path);
		try {
			await gate.arrived;
			service.dispose();
			gate.release();
			await opening;
			expect(subscribe).not.toHaveBeenCalled();
			expect(service.getKnownSessions()).toHaveLength(0);
			expect(manager.getActiveSessionPath()).toBe(a.path);
		} finally { gate.release(); subscribe.mockRestore(); }
	});

	it("does not rebuild an agent after disposal during initial session hydration", async () => {
		const { memory, app, settings, a } = await fixture();
		const manager = new ObsidianSessionManager(memory as unknown as DataAdapter, settings.sessionDir, "fixture", undefined, { read: () => a.path, write: () => {} });
		const service = new ObsidianAgentService(app, () => settings, manager, { loadUserSkills: async () => ({ skills: [], diagnostics: [], searched: [] }) });
		const gate = memory.hold(a.path);
		const opening = service.initialize();
		await gate.arrived;
		service.dispose();
		gate.release();
		await opening;
		expect(service.getKnownSessions()).toHaveLength(0);
	});

	it("a preparation failure does not prevent the next selection from opening", async () => {
		const { service, manager, b, c } = await fixture();
		const claim = spyOn(manager, "claimOperation").mockImplementationOnce(() => () => { throw new Error("Fixture cleanup failed"); });
		try {
			await service.openSession(b.path).catch(() => undefined);
			await service.openSession(c.path);
			expect(service.getSnapshot().session?.path).toBe(c.path);
			expect(service.getSnapshot().isOpeningSession).toBe(false);
		} finally { claim.mockRestore(); }
	});
});
