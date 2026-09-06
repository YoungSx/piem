import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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

function Probe({ store, sessionId, harness }: { store: InstanceType<typeof DraftStore>; sessionId?: string; harness: Harness }): JSX.Element {
	harness.current = useSessionDraft(store, sessionId);
	return <span>{harness.current.draft}</span>;
}

describe("useSessionDraft", () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(() => {
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
});

function createStore(): InstanceType<typeof DraftStore> {
	return new DraftStore(new MemoryAdapter() as unknown as DataAdapter, SESSION_DIR);
}

async function mount(
	store: InstanceType<typeof DraftStore>,
	sessionId: string | undefined,
): Promise<{ harness: Harness; render: (next?: string) => Promise<void>; unmount: () => Promise<void> }> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	const harness: Harness = { current: { draft: "", setDraft: () => undefined, clearDraft: () => undefined } };

	const render = async (next?: string): Promise<void> => {
		root.render(<Probe store={store} sessionId={next} harness={harness} />);
		await flushRender();
	};
	await render(sessionId);

	return {
		harness,
		render,
		unmount: async () => {
			root.unmount();
			await flushRender();
			await store.flush();
		},
	};
}
