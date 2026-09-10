import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { DataAdapter } from "obsidian";
import { flushRender, installDom } from "../testUtils/dom";
import { installObsidianStub } from "../testUtils/obsidianStub";
import type { JSX } from "react";

installObsidianStub();
const document = installDom();

// Dynamic imports so the mocked `obsidian` module wins over any cached real one.
const { DraftStore } = await import("../session/DraftStore");
const { useSessionDraft } = await import("./useSessionDraft");
const { createRoot } = await import("react-dom/client");

const SESSION_DIR = "sessions";
const cleanups: (() => Promise<void>)[] = [];
const stores: InstanceType<typeof DraftStore>[] = [];

class MemoryAdapter {
	private readonly files = new Map<string, string>();
	private readonly folders = new Set<string>();

	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.folders.has(path);
	}

	async mkdir(path: string): Promise<void> {
		this.folders.add(path);
	}

	async write(path: string, data: string): Promise<void> {
		this.files.set(path, data);
	}

	async read(path: string): Promise<string> {
		const content = this.files.get(path);
		if (content === undefined) {
			throw new Error(`Missing file: ${path}`);
		}
		return content;
	}

	async remove(path: string): Promise<void> {
		this.files.delete(path);
	}

	async rename(path: string, newPath: string): Promise<void> {
		const content = this.files.get(path);
		if (content === undefined) {
			throw new Error(`Missing file: ${path}`);
		}
		this.files.delete(path);
		this.files.set(newPath, content);
	}
}

/**
 * Exposes the hook's return value so a test can drive it, mirroring what the
 * composer does with the same three functions.
 */
interface Harness {
	current: ReturnType<typeof useSessionDraft>;
}

function Probe({ store, sessionId, harness }: { store: InstanceType<typeof DraftStore> | undefined; sessionId?: string; harness: Harness }): JSX.Element {
	harness.current = useSessionDraft(store, sessionId);
	return <span>{harness.current.draft}</span>;
}

describe("useSessionDraft", () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) await cleanup();
		for (const store of stores.splice(0)) store.dispose();
		document.body.replaceChildren();
	});

	it("restores the stored draft when a chat is adopted", async () => {
		const store = createStore();
		await store.set("session-a", "written earlier");

		const { harness } = await mount(store, "session-a");
		expect(harness.current.draft).toBe("written earlier");
	});

	it("hands the outgoing chat's text back before adopting the next one", async () => {
		const store = createStore();
		const { harness, render } = await mount(store, "session-a");

		harness.current.setDraft("half a question for A");
		await flushRender();

		await render("session-b");
		// The draft must not follow the switch; that is how text got sent to the
		// wrong conversation.
		expect(harness.current.draft).toBe("");
		expect(await store.get("session-a")).toBe("half a question for A");
	});

	it("brings the draft back when the reader returns to that chat", async () => {
		const store = createStore();
		const { harness, render } = await mount(store, "session-a");

		harness.current.setDraft("still unfinished");
		await flushRender();
		await render("session-b");
		await render("session-a");

		expect(harness.current.draft).toBe("still unfinished");
	});

	it.each(["restore", "clear"])("keeps a late %s in its original chat after another draft is loaded", async (operation) => {
		const store = createStore();
		await store.set("session-a", "A before sending");
		await store.set("session-b", "B still being written");
		const { harness, render } = await mount(store, "session-a");
		const { setDraft, clearDraft } = harness.current;
		await render("session-b");

		// A send may refuse after the reader has switched chats. Its captured
		// callback must restore A without resetting B's editor or ready state.
		if (operation === "restore") setDraft("A returned after a failed send");
		else clearDraft();
		await flushRender();
		expect(harness.current.ready).toBe(true);
		expect(harness.current.draft).toBe("B still being written");
		expect(await store.get("session-b")).toBe("B still being written");
		const expectedA = operation === "restore" ? "A returned after a failed send" : "";
		expect(await store.get("session-a")).toBe(expectedA);

		await render("session-a");
		expect(harness.current.ready).toBe(true);
		expect(harness.current.draft).toBe(expectedA);
	});

	it.each(["restore", "clear"])("does not invalidate another chat's pending read with a late %s", async (operation) => {
		const store = createStore();
		const { harness, render } = await mount(store, "session-a");
		harness.current.setDraft("A before sending");
		await flushRender();
		const { setDraft, clearDraft } = harness.current;
		let finishRead!: (text: string) => void;
		const read = spyOn(store, "get").mockImplementationOnce(() => new Promise<string>((resolve) => { finishRead = resolve; }));
		try {
			await render("session-b");
			expect(harness.current.ready).toBe(false);
			if (operation === "restore") setDraft("A returned after a failed send");
			else clearDraft();
			finishRead("B on disk");
			await flushRender();
			expect(harness.current.ready).toBe(true);
			expect(harness.current.draft).toBe("B on disk");
		} finally { read.mockRestore(); }
	});

	it.each(["restore", "clear"])("persists a late %s after unmount without changing a replacement panel", async (operation) => {
		const store = createStore();
		await store.set("session-a", "A before sending");
		await store.set("session-b", "B still being written");
		const original = await mount(store, "session-a");
		const { setDraft, clearDraft } = original.harness.current;
		await original.unmount();
		const replacement = await mount(store, "session-b");
		if (operation === "restore") setDraft("A returned after closing");
		else clearDraft();
		await flushRender();
		expect(replacement.harness.current.ready).toBe(true);
		expect(replacement.harness.current.draft).toBe("B still being written");
		const expectedA = operation === "restore" ? "A returned after closing" : "";
		expect(await store.get("session-a")).toBe(expectedA);
		await replacement.render("session-a");
		expect(replacement.harness.current.ready).toBe(true);
		expect(replacement.harness.current.draft).toBe(expectedA);
	});

	it("writes the pending draft on unmount, since teardown cancels the debounce", async () => {
		const store = createStore();
		const { harness, unmount } = await mount(store, "session-a");

		harness.current.setDraft("typed just before closing");
		await flushRender();
		await unmount();

		expect(await store.get("session-a")).toBe("typed just before closing");
	});

	it("clears the draft after a send", async () => {
		const store = createStore();
		const { harness } = await mount(store, "session-a");

		harness.current.setDraft("about to send");
		await flushRender();
		harness.current.clearDraft();
		await flushRender();

		expect(harness.current.draft).toBe("");
		expect(await store.get("session-a")).toBe("");
	});

	it("keeps each chat's unsent text to itself", async () => {
		// Why the scope exists at all: a half-written question for one chat must
		// not appear in another's composer, and switching back has to find it
		// where it was left. Forking makes this the everyday case — the copy is a
		// new session, so it opens on an empty composer of its own.
		const store = createStore();
		const mounted = await mount(store, "chat-1");

		mounted.harness.current.setDraft("Cautious phrasing");
		await mounted.render("chat-2");

		expect(mounted.harness.current.draft).toBe("");
		mounted.harness.current.setDraft("Bold phrasing");
		await mounted.render("chat-1");

		expect(mounted.harness.current.draft).toBe("Cautious phrasing");
		await mounted.render("chat-2");
		expect(mounted.harness.current.draft).toBe("Bold phrasing");
	});

	it("holds an empty draft while no chat is active", async () => {
		const store = createStore();
		const { harness } = await mount(store, undefined);

		expect(harness.current.draft).toBe("");
	});

	it("supports a panel without a draft store and clears its draft on a session switch", async () => {
		const { harness, render } = await mount(undefined, "session-a");
		expect(harness.current.ready).toBe(true);
		harness.current.setDraft("A in memory");
		await flushRender();
		expect(harness.current.draft).toBe("A in memory");
		await render("session-b");
		expect(harness.current.ready).toBe(true);
		expect(harness.current.draft).toBe("");
	});

	it("keeps a newer write when the initial stored draft arrives late", async () => {
		const store = createStore();
		let finishRead!: (text: string) => void;
		const read = spyOn(store, "get").mockImplementationOnce(() => new Promise<string>((resolve) => { finishRead = resolve; }));
		try {
			const { harness } = await mount(store, "session-a");
			expect(harness.current.ready).toBe(false);
			harness.current.setDraft("Newer extension text");
			await flushRender();
			expect(harness.current.ready).toBe(true);
			finishRead("Old disk text");
			await flushRender();
			expect(harness.current.draft).toBe("Newer extension text");
		} finally { read.mockRestore(); }
		expect(await store.get("session-a")).toBe("Newer extension text");
	});

	it("does not resurrect a cleared draft when a pending read settles", async () => {
		const store = createStore();
		let finishRead!: (text: string) => void;
		const read = spyOn(store, "get").mockImplementationOnce(() => new Promise<string>((resolve) => { finishRead = resolve; }));
		try {
			const { harness } = await mount(store, "session-a");
			harness.current.clearDraft();
			finishRead("Already sent");
			await flushRender();
			expect(harness.current.ready).toBe(true);
			expect(harness.current.draft).toBe("");
		} finally { read.mockRestore(); }
	});

	it("leaves an unread draft intact when switching away and ignores its late result", async () => {
		const store = createStore();
		await store.set("session-a", "A on disk");
		await store.set("session-b", "B on disk");
		let finishRead!: (text: string) => void;
		const originalGet = store.get.bind(store);
		const read = spyOn(store, "get").mockImplementation((scope) => scope === "session-a"
			? new Promise<string>((resolve) => { finishRead = resolve; }) : originalGet(scope));
		try {
			const { harness, render } = await mount(store, "session-a");
			expect(harness.current.ready).toBe(false);
			await render("session-b");
			expect(harness.current.draft).toBe("B on disk");
			finishRead("Late A");
			await flushRender();
			expect(harness.current.draft).toBe("B on disk");
			expect(await originalGet("session-a")).toBe("A on disk");
		} finally { read.mockRestore(); }
	});

	it("does not save a blank placeholder when unmounted before the read completes", async () => {
		const store = createStore();
		await store.set("session-a", "A on disk");
		let finishRead!: (text: string) => void;
		const read = spyOn(store, "get").mockImplementationOnce(() => new Promise<string>((resolve) => { finishRead = resolve; }));
		try {
			const { harness, unmount } = await mount(store, "session-a");
			expect(harness.current.ready).toBe(false);
			await unmount();
			finishRead("A on disk");
			await flushRender();
		} finally { read.mockRestore(); }
		expect(await store.get("session-a")).toBe("A on disk");
	});

	it("waits for a fresh adoption when returning to the same chat through an empty panel", async () => {
		const store = createStore();
		await store.set("session-a", "A on disk");
		const { harness, render } = await mount(store, "session-a");
		await render(undefined);
		let finishRead!: (text: string) => void;
		const read = spyOn(store, "get").mockImplementationOnce(() => new Promise<string>((resolve) => { finishRead = resolve; }));
		try {
			await render("session-a");
			expect(harness.current.ready).toBe(false);
			expect(harness.current.draft).toBe("");
			finishRead("Reloaded A");
			await flushRender();
			expect(harness.current.ready).toBe(true);
			expect(harness.current.draft).toBe("Reloaded A");
		} finally { read.mockRestore(); }
	});
});

function createStore(): InstanceType<typeof DraftStore> {
	const store = new DraftStore(new MemoryAdapter() as unknown as DataAdapter, SESSION_DIR);
	stores.push(store);
	return store;
}

async function mount(
	store: InstanceType<typeof DraftStore> | undefined,
	sessionId: string | undefined,
): Promise<{ harness: Harness; render: (next?: string) => Promise<void>; unmount: () => Promise<void> }> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	const harness: Harness = { current: { draft: "", ready: false, setDraft: () => undefined, clearDraft: () => undefined } };

	const render = async (next?: string): Promise<void> => {
		root.render(<Probe store={store} sessionId={next} harness={harness} />);
		await flushRender();
	};
	await render(sessionId);
	let unmounted = false;
	const unmount = async (): Promise<void> => {
		if (unmounted) return;
		unmounted = true;
		root.unmount();
		await flushRender();
		await store?.flush();
		host.remove();
	};
	cleanups.push(unmount);

	return {
		harness,
		render,
		unmount,
	};
}
