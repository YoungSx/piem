import { afterAll, describe, expect, it } from "bun:test";
import type { App, EventRef } from "obsidian";
import { installObsidianStub } from "../testUtils/obsidianStub";
import { stubWindowTimers } from "../testUtils/windowStub";

installObsidianStub();

/*
 * The watcher debounces through `window.setTimeout`, so a bare
 * `bun test <this file>` has to provide one. Without it the file passed only
 * under a full `bun test`, on a `window` some UI component test installed first.
 */
const restoreWindowTimers = stubWindowTimers();

afterAll(() => {
	restoreWindowTimers();
});

const { watchSessionFile } = await import("./sessionFileWatch");

/**
 * A vault that actually dispatches, which the shared plugin-loader fake does
 * not: its `on` returns an empty object and never fires. Mirrors the fake in
 * `activeNoteWatch.test.ts` so both watcher modules are tested against the same
 * contract shape.
 */
class FakeVault {
	private readonly handlers = new Map<string, Set<(file: { path: string }) => void>>();

	on(name: string, callback: (file: { path: string }) => void): EventRef {
		const existing = this.handlers.get(name) ?? new Set<(file: { path: string }) => void>();
		existing.add(callback);
		this.handlers.set(name, existing);
		return { name, callback } as unknown as EventRef;
	}

	/** What `Events.offref` does to a ref this `on` handed out. */
	offref(ref: EventRef): void {
		const { name, callback } = ref as unknown as { name: string; callback: (file: { path: string }) => void };
		this.handlers.get(name)?.delete(callback);
	}

	trigger(name: string, path: string): void {
		for (const callback of this.handlers.get(name) ?? []) {
			callback({ path });
		}
	}

	handlerCount(name: string): number {
		return this.handlers.get(name)?.size ?? 0;
	}
}

function createApp(): { app: App; vault: FakeVault } {
	const vault = new FakeVault();
	return { app: { vault } as unknown as App, vault };
}

/** Long enough for the trailing debounce to settle; short enough to keep tests fast. */
const DEBOUNCE_MS = 10;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 4));

describe("watchSessionFile", () => {
	it("subscribes to vault modify events and hands back one disposer", () => {
		const { app, vault } = createApp();

		const stop = watchSessionFile(app, () => null, () => undefined, DEBOUNCE_MS);

		expect(typeof stop).toBe("function");
		expect(vault.handlerCount("modify")).toBe(1);
	});

	it("drops the subscription when disposed", async () => {
		const { app, vault } = createApp();
		const seen: string[] = [];

		const stop = watchSessionFile(app, () => "Piem/chats/a.jsonl", (path) => seen.push(path), DEBOUNCE_MS);
		stop();
		vault.trigger("modify", "Piem/chats/a.jsonl");
		await settle();

		expect(vault.handlerCount("modify")).toBe(0);
		expect(seen).toEqual([]);
	});

	it("cancels a debounce that was already armed when disposed", async () => {
		const { app, vault } = createApp();
		const seen: string[] = [];

		const stop = watchSessionFile(app, () => "Piem/chats/a.jsonl", (path) => seen.push(path), DEBOUNCE_MS);
		// The ordinary shape of a panel closing: a burst lands, then the view
		// unloads inside the same quiet period. Dropping the subscription alone
		// leaves the armed timer to fire afterwards, calling back into a service
		// that is being torn down — which is the whole reason this returns a
		// disposer rather than the refs.
		vault.trigger("modify", "Piem/chats/a.jsonl");
		stop();
		await settle();

		expect(seen).toEqual([]);
	});

	it("does not report anything before an event fires", async () => {
		const { app } = createApp();
		const seen: string[] = [];

		watchSessionFile(app, () => "Piem/chats/a.jsonl", (path) => seen.push(path), DEBOUNCE_MS);
		await settle();

		// Seeding the first comparison is the caller's job, matching the
		// `activeNoteWatch` contract: a consumer that wants only changes is not
		// forced to filter a synthetic first call.
		expect(seen).toEqual([]);
	});

	it("reports the watched path when it is modified", async () => {
		const { app, vault } = createApp();
		const seen: string[] = [];

		watchSessionFile(app, () => "Piem/chats/a.jsonl", (path) => seen.push(path), DEBOUNCE_MS);
		vault.trigger("modify", "Piem/chats/a.jsonl");
		await settle();

		expect(seen).toEqual(["Piem/chats/a.jsonl"]);
	});

	it("ignores modifications to every other file", async () => {
		const { app, vault } = createApp();
		const seen: string[] = [];

		watchSessionFile(app, () => "Piem/chats/a.jsonl", (path) => seen.push(path), DEBOUNCE_MS);
		// Notes and sibling sessions share the vault; only the active chat's file
		// can carry an external rename that matters to the open panel.
		vault.trigger("modify", "Notes/today.md");
		vault.trigger("modify", "Piem/chats/other.jsonl");
		await settle();

		expect(seen).toEqual([]);
	});

	it("re-resolves the watched path on every event rather than capturing it", async () => {
		const { app, vault } = createApp();
		const seen: string[] = [];
		let watched: string | null = "Piem/chats/a.jsonl";

		watchSessionFile(app, () => watched, (path) => seen.push(path), DEBOUNCE_MS);
		watched = "Piem/chats/b.jsonl";
		vault.trigger("modify", "Piem/chats/b.jsonl");
		await settle();

		// The active session can be switched or created at any moment; a path
		// captured at registration would keep watching a chat that is no longer
		// open and miss the one that is.
		expect(seen).toEqual(["Piem/chats/b.jsonl"]);
	});

	it("stops watching while there is no active session", async () => {
		const { app, vault } = createApp();
		const seen: string[] = [];
		let watched: string | null = null;

		watchSessionFile(app, () => watched, (path) => seen.push(path), DEBOUNCE_MS);
		vault.trigger("modify", "Piem/chats/a.jsonl");
		await settle();

		expect(seen).toEqual([]);
	});

	it("collapses a burst of modifications into one callback", async () => {
		const { app, vault } = createApp();
		const seen: string[] = [];

		watchSessionFile(app, () => "Piem/chats/a.jsonl", (path) => seen.push(path), DEBOUNCE_MS);
		// Streaming appends many lines in quick succession; the disk re-read that
		// answers the event is a whole-file parse, so one per burst, not per line.
		vault.trigger("modify", "Piem/chats/a.jsonl");
		vault.trigger("modify", "Piem/chats/a.jsonl");
		vault.trigger("modify", "Piem/chats/a.jsonl");
		await settle();

		expect(seen).toEqual(["Piem/chats/a.jsonl"]);
	});
});
