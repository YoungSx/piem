import { describe, expect, it } from "bun:test";
import { installObsidianStub } from "../testUtils/obsidianStub";
import { createExtensionConfigStore, normalizeExtensionConfig, type ExtensionConfigData, type ExtensionConfigProjection } from "./extensionConfigStore";

// The restart evidence below reloads through the real settings normalizer, and
// `settings.ts` imports `obsidian`; register the stub before importing it.
installObsidianStub();
const { normalizeSettings } = await import("../settings");

/**
 * A settings file that survives a reload.
 *
 * `persist` copies the live map into `disk`, and `restart` reads it back the way
 * the plugin does — through {@link normalizeSettings} — so a test that stages a
 * value and asserts the in-memory object changed cannot pass by itself.
 */
function vault(disk: Record<string, unknown> = {}) {
	const state: { settings: { extensionConfig?: ExtensionConfigData } } = { settings: { extensionConfig: normalizeExtensionConfig(disk.extensionConfig) } };
	let saved = { ...disk };
	let fail: Error | undefined;
	const queued: Array<() => Promise<unknown>> = [];
	let tail: Promise<unknown> = Promise.resolve();
	const store = createExtensionConfigStore({
		getData: () => state.settings.extensionConfig,
		setData: data => { if (data) state.settings.extensionConfig = data; else delete state.settings.extensionConfig; },
		persist: async () => {
			if (fail) throw fail;
			saved = { ...saved, extensionConfig: structuredClone(state.settings.extensionConfig) };
		},
		queue: work => {
			const run = tail.then(work, work);
			queued.push(work);
			tail = run.catch(() => undefined);
			return run;
		},
	});
	return {
		store,
		get live() { return state.settings.extensionConfig; },
		get writes() { return queued.length; },
		breakSaving: (error: Error) => { fail = error; },
		fixSaving: () => { fail = undefined; },
		/** What a fresh plugin load would see. */
		restart: () => normalizeSettings(structuredClone(saved)).extensionConfig,
	};
}

describe("extension config store", () => {
	it("persists a staged write across a restart and keeps namespaces apart", async () => {
		const disk = vault();
		disk.store.stage("pi-web-search", "web-search.json", '{"provider":"research","model":"beta"}');
		disk.store.stage("pi-clarify", "clarify.json", '{"provider":"research","model":"alpha"}');
		// Staging is not saving. A reload before the flush must not claim the value.
		expect(disk.restart()).toBeUndefined();
		await disk.store.flush();
		const restored = disk.restart();
		expect(restored).toEqual({
			"pi-web-search": { "web-search.json": '{"provider":"research","model":"beta"}' },
			"pi-clarify": { "clarify.json": '{"provider":"research","model":"alpha"}' },
		});
		// A second store over the restored file reads each owner's own value only.
		const reloaded = vault({ extensionConfig: restored });
		expect(reloaded.store.read("pi-web-search", "web-search.json")).toBe('{"provider":"research","model":"beta"}');
		expect(reloaded.store.read("pi-clarify", "web-search.json")).toBeUndefined();
		expect(reloaded.store.read("pi-web-search", "clarify.json")).toBeUndefined();
	});

	it("restores the previous value and reports the failure when the save is rejected", async () => {
		const disk = vault({ extensionConfig: { "pi-clarify": { "clarify.json": '{"provider":"research","model":"alpha"}' } } });
		disk.breakSaving(new Error("Vault is read-only"));
		disk.store.stage("pi-clarify", "clarify.json", '{"provider":"research","model":"beta"}');
		await expect(disk.store.flush()).rejects.toThrow("Vault is read-only");
		expect(disk.live).toEqual({ "pi-clarify": { "clarify.json": '{"provider":"research","model":"alpha"}' } });
		expect(disk.restart()).toEqual({ "pi-clarify": { "clarify.json": '{"provider":"research","model":"alpha"}' } });
		// The failure is reported once; a later write is not stranded behind it.
		await disk.store.flush();
		disk.fixSaving();
		disk.store.stage("pi-clarify", "clarify.json", '{"provider":"research","model":"beta"}');
		await disk.store.flush();
		expect(disk.restart()).toEqual({ "pi-clarify": { "clarify.json": '{"provider":"research","model":"beta"}' } });
	});

	it("clears an entry and drops the owner with its last file", async () => {
		const disk = vault({ extensionConfig: { "pi-clarify": { "clarify.json": "{}", "extra.json": "{}" } } });
		disk.store.stage("pi-clarify", "extra.json", undefined);
		await disk.store.flush();
		expect(disk.restart()).toEqual({ "pi-clarify": { "clarify.json": "{}" } });
		disk.store.stage("pi-clarify", "clarify.json", undefined);
		await disk.store.flush();
		expect(disk.restart()).toBeUndefined();
		expect(disk.live).toBeUndefined();
		// Clearing what is already absent is not a write.
		const before = disk.writes;
		disk.store.stage("pi-clarify", "clarify.json", undefined);
		expect(disk.writes).toBe(before);
	});

	it("bounds owners, files and payload size against an untrusted extension", async () => {
		const disk = vault();
		for (let index = 0; index < 8; index++) {
			disk.store.stage(`ext-${index}`, "config.json", "{}");
		}
		await disk.store.flush();
		expect(() => disk.store.stage("ext-9", "config.json", "{}")).toThrow("At most 8 extensions");
		// An owner already present keeps writing; the cap is on new owners.
		disk.store.stage("ext-0", "second.json", "{}");
		disk.store.stage("ext-0", "third.json", "{}");
		disk.store.stage("ext-0", "fourth.json", "{}");
		await disk.store.flush();
		expect(() => disk.store.stage("ext-0", "fifth.json", "{}")).toThrow("At most 4 configuration files");
		// Replacing an existing file at the cap is still allowed.
		disk.store.stage("ext-0", "second.json", '{"kept":true}');
		expect(() => disk.store.stage("ext-0", "config.json", "x".repeat(4097))).toThrow("4096 bytes");
		for (const name of ["../escape.json", "nested/file.json", "config.js", ".hidden.json", ""]) {
			expect(() => disk.store.stage("ext-0", name, "{}")).toThrow("Invalid extension config file name");
		}
		for (const owner of ["../other", "a/b", ""]) {
			expect(() => disk.store.stage(owner, "config.json", "{}")).toThrow("Invalid extension config owner");
		}
		await disk.store.flush();
		expect(Object.keys(disk.restart() ?? {})).toHaveLength(8);
		expect(disk.restart()?.["ext-0"]?.["second.json"]).toBe('{"kept":true}');
	});

	it("drops out-of-bounds stored data on load rather than trusting the file", () => {
		const oversized = "x".repeat(4097);
		expect(normalizeExtensionConfig({
			"pi-clarify": { "clarify.json": "{}", "bad name.json": "{}", "script.js": "{}", "big.json": oversized, "n.json": 5 },
			"../escape": { "clarify.json": "{}" },
			"pi-empty": { "only.js": "{}" },
			"pi-wrong": "text",
		})).toEqual({ "pi-clarify": { "clarify.json": "{}" } });
		for (const value of [undefined, null, "text", 5, [], {}, { "pi-x": {} }]) expect(normalizeExtensionConfig(value)).toBeUndefined();
	});

	it("routes a projected file to its owner's setting instead of storing a copy", async () => {
		const disk = vault();
		let pinned: string | undefined = "alpha";
		const projection: ExtensionConfigProjection = {
			owner: "pi-clarify", file: "clarify.json",
			read: () => pinned && JSON.stringify({ provider: "research", model: pinned }) || undefined,
			write: async text => {
				if (text === undefined) { pinned = undefined; return; }
				const parsed = JSON.parse(text) as { model?: unknown };
				if (parsed.model !== "beta") throw new Error("Not a configured model with credentials");
				pinned = "beta";
			},
		};
		const projected = createExtensionConfigStore({
			getData: () => disk.live, setData: () => {}, persist: async () => {}, queue: work => work(),
			projections: [projection],
		});
		expect(projected.read("pi-clarify", "clarify.json")).toBe('{"provider":"research","model":"alpha"}');
		projected.stage("pi-clarify", "clarify.json", '{"provider":"research","model":"beta"}');
		await projected.flush();
		expect(projected.read("pi-clarify", "clarify.json")).toBe('{"provider":"research","model":"beta"}');
		// The projected value is never duplicated into the stored map.
		expect(disk.live).toBeUndefined();
		projected.stage("pi-clarify", "clarify.json", '{"provider":"research","model":"gamma"}');
		await expect(projected.flush()).rejects.toThrow("Not a configured model");
		expect(projected.read("pi-clarify", "clarify.json")).toBe('{"provider":"research","model":"beta"}');
		projected.stage("pi-clarify", "clarify.json", undefined);
		await projected.flush();
		expect(projected.read("pi-clarify", "clarify.json")).toBeUndefined();
	});
});
