import { describe, expect, it } from "bun:test";
import { installObsidianStub } from "../testUtils/obsidianStub";
import type { App } from "obsidian";

installObsidianStub();

const { createGetSettingsTool, createUpdateSettingTool } = await import("./settingsTools");
const { PLUGIN_ID } = await import("../constants");

/**
 * A stand-in for the three undocumented stores the tools reach for, wired so a
 * test can tell the three answers apart: the app's config map, a live plugin's
 * `settings` plus `saveData`, and the `data.json` fallback for a plugin that is
 * not running. Omit any of them to model a build that lacks that surface, which
 * is the case the probes exist for.
 *
 * `app.plugins` is attached only when `manifests` or `live` is supplied, so the
 * no-arguments call models a build with no plugin manager at all while the
 * data.json-only tests model one where every plugin is disabled.
 */
function settingsApp(overrides: {
	config?: Record<string, unknown>;
	manifests?: Record<string, { name?: string; version?: string }>;
	enabled?: string[];
	live?: Record<string, { settings?: unknown; saveData?(data: unknown): Promise<void> }>;
	data?: Record<string, unknown>;
} = {}) {
	const config = { ...overrides.config };
	const files: Record<string, unknown> = { ...overrides.data };
	const vault: Record<string, unknown> = {};
	if (overrides.config !== undefined) {
		vault.getConfig = (key: string) => config[key];
		vault.setConfig = (key: string, value: unknown) => {
			config[key] = value;
		};
	}
	if (overrides.data !== undefined) {
		vault.readPluginData = async (id: string) => files[id] ?? null;
		vault.writePluginData = async (id: string, data: unknown) => {
			files[id] = data;
		};
	}
	const app: Record<string, unknown> = { vault };
	if (overrides.manifests !== undefined || overrides.live !== undefined) {
		app.plugins = {
			plugins: { ...overrides.live },
			manifests: overrides.manifests ?? {},
			enabledPlugins: new Set(overrides.enabled ?? []),
		};
	}
	return { app: app as unknown as App, config, files };
}

function textOf(result: Awaited<ReturnType<ReturnType<typeof createGetSettingsTool>["execute"]>>): string {
	const content = result.content[0];
	if (content?.type !== "text") {
		throw new Error("Expected a text result");
	}
	return content.text;
}

describe("get_settings", () => {
	it("lists installed plugins with their id, version, and enabled state", async () => {
		const { app } = settingsApp({
			manifests: {
				"obsidian-calendar": { name: "Calendar", version: "2.4.0" },
				timetable: { name: "Timetable", version: "0.3.1" },
			},
			enabled: ["timetable"],
		});

		const result = await createGetSettingsTool(app).execute("tool-call", { target: "plugin" });

		expect(textOf(result)).toBe("disabled obsidian-calendar 2.4.0  (Calendar)\nenabled  timetable 0.3.1  (Timetable)");
		expect(result.details).toMatchObject({ count: 2, returnedCount: 2 });
	});

	it("reads a loaded plugin's whole settings, and a single key out of them", async () => {
		const { app } = settingsApp({ live: { timetable: { settings: { dayLength: 45, hideWeekends: true } } } });
		const tool = createGetSettingsTool(app);

		const whole = await tool.execute("tool-call", { target: "plugin", plugin: "timetable" });
		const one = await tool.execute("tool-call", { target: "plugin", plugin: "timetable", key: "dayLength" });

		expect(textOf(whole)).toContain("\"dayLength\": 45");
		expect(whole.details).toMatchObject({ source: "plugin", key: undefined });
		expect(textOf(one)).toBe("plugin:timetable dayLength = 45");
		expect(one.details).toMatchObject({ key: "dayLength" });
	});

	it("falls back to a plugin's data.json when it is not loaded, and says which", async () => {
		const { app } = settingsApp({ data: { timetable: { dayLength: 30 } } });

		const result = await createGetSettingsTool(app).execute("tool-call", { target: "plugin", plugin: "timetable" });

		expect(textOf(result)).toContain("\"dayLength\": 30");
		// The model acts on this: a value read off disk belongs to a plugin that is
		// not running, which changes what a follow-up write should do.
		expect(result.details).toMatchObject({ source: "data.json" });
	});

	it("reads one Obsidian setting by key", async () => {
		const { app } = settingsApp({ config: { spellcheck: true, tabSize: 4 } });

		const result = await createGetSettingsTool(app).execute("tool-call", { target: "app", key: "tabSize" });

		expect(textOf(result)).toBe("app tabSize = 4");
	});

	it("names a misspelled app key rather than answering a bare null", async () => {
		const { app } = settingsApp({ config: { spellcheck: true } });

		const result = await createGetSettingsTool(app).execute("tool-call", { target: "app", key: "spellchek" });

		// `getConfig` yields undefined for a name it does not know. Reporting that
		// as `null` would make a typo look like a setting that exists and is unset.
		expect(textOf(result)).toContain("not a setting this Obsidian build knows");
		expect(result.details).toMatchObject({ set: false });
	});

	it("requires a key for the app, and lists plugins when the id is left off", async () => {
		const { app } = settingsApp({ config: { spellcheck: true }, manifests: { timetable: { name: "Timetable" } } });

		await expect(createGetSettingsTool(app).execute("tool-call", { target: "app" })).rejects.toThrow(/needs a key/);
		// No id lists rather than refusing, so that is the one way to discover one.
		await expect(createGetSettingsTool(app).execute("tool-call", { target: "plugin", key: "dayLength" })).resolves.toBeDefined();
	});

	it("reads a plugin that is in the registry but has no save path yet", async () => {
		// The read and the write answer different questions about a live instance:
		// membership of the registry says what the plugin currently holds, while
		// `saveData` says whether a change can be routed through it. Splitting them
		// keeps a plugin partway through loading from reading a file that is one
		// write behind, without letting a write skip the plugin it could have used.
		const { app } = settingsApp({ live: { timetable: { settings: { dayLength: 45 } } }, data: { timetable: { dayLength: 30 } } });

		const read = await createGetSettingsTool(app).execute("tool-call", { target: "plugin", plugin: "timetable" });
		const write = await createUpdateSettingTool(app).execute("tool-call", { target: "plugin", plugin: "timetable", key: "dayLength", value: 60 });

		expect(read.details).toMatchObject({ source: "plugin" });
		expect(write.details).toMatchObject({ writtenVia: "data.json" });
	});

	it("reads a plugin that is in the registry but has no save path yet", async () => {
		// The read and the write answer different questions about a live instance:
		// membership of the registry says what the plugin currently holds, while
		// `saveData` says whether a change can be routed through it. Splitting them
		// keeps a plugin partway through loading from reading a file that is one
		// write behind, without letting a write skip the plugin it could have used.
		const { app } = settingsApp({ live: { timetable: { settings: { dayLength: 45 } } }, data: { timetable: { dayLength: 30 } } });

		const read = await createGetSettingsTool(app).execute("tool-call", { target: "plugin", plugin: "timetable" });
		const write = await createUpdateSettingTool(app).execute("tool-call", { target: "plugin", plugin: "timetable", key: "dayLength", value: 60 });

		expect(read.details).toMatchObject({ source: "plugin" });
		expect(write.details).toMatchObject({ writtenVia: "data.json" });
	});

	it("refuses this plugin's own settings on both paths", async () => {
		const { app } = settingsApp({ live: { [PLUGIN_ID]: { settings: { providerApiKeys: {} } } } });
		const tool = createGetSettingsTool(app);

		// The one thing in this module that is a policy rather than a technical
		// limit, so it is asserted on the read side too: a read that works while the
		// write refuses would only teach the model to route around the write.
		await expect(tool.execute("tool-call", { target: "plugin", plugin: PLUGIN_ID })).rejects.toThrow(/does not reconfigure itself/);
		await expect(tool.execute("tool-call", { target: "plugin", plugin: PLUGIN_ID, key: "providerApiKeys" })).rejects.toThrow(/does not reconfigure itself/);
	});

	it("refuses with a readable error when the build has no settings store", async () => {
		const { app } = settingsApp();

		await expect(createGetSettingsTool(app).execute("tool-call", { target: "app", key: "spellcheck" })).rejects.toThrow(
			/does not expose its settings store/,
		);
		await expect(createGetSettingsTool(app).execute("tool-call", { target: "plugin" })).rejects.toThrow(/does not expose the plugin manager/);
	});
});

describe("update_setting", () => {
	it("changes an app setting through the config store", async () => {
		const { app, config } = settingsApp({ config: { spellcheck: true } });

		const result = await createUpdateSettingTool(app).execute("tool-call", { target: "app", key: "spellcheck", value: false });

		expect(config.spellcheck).toBe(false);
		expect(textOf(result)).toBe("Set Obsidian setting spellcheck to false.");
		expect(result.details).toMatchObject({ target: "app", key: "spellcheck", value: false });
	});

	it("saves a loaded plugin's change through the plugin, leaving its other keys alone", async () => {
		const saved: unknown[] = [];
		const live = { timetable: { settings: { dayLength: 45, hideWeekends: true }, saveData: async (data: unknown) => void saved.push(data) } };
		const { app } = settingsApp({ live });

		const result = await createUpdateSettingTool(app).execute("tool-call", { target: "plugin", plugin: "timetable", key: "dayLength", value: 60 });

		expect(live.timetable.settings).toEqual({ dayLength: 60, hideWeekends: true });
		expect(saved).toEqual([{ dayLength: 60, hideWeekends: true }]);
		// The report is the only thing telling the model a running plugin was updated
		// in place, so it must not be the phrasing used for the file fallback.
		expect(result.details).toMatchObject({ writtenVia: "plugin" });
		expect(textOf(result)).toContain("saved it through the plugin");
	});

	it("writes a plugin's data.json when the plugin is not running, and says so", async () => {
		const { app, files } = settingsApp({ data: { timetable: { dayLength: 30, hideWeekends: false } } });

		const result = await createUpdateSettingTool(app).execute("tool-call", { target: "plugin", plugin: "timetable", key: "dayLength", value: 60 });

		expect(files.timetable).toEqual({ dayLength: 60, hideWeekends: false });
		expect(result.details).toMatchObject({ writtenVia: "data.json" });
		expect(textOf(result)).toContain("not running");
	});

	it("refuses a value of a different kind than the one stored", async () => {
		const { app, config } = settingsApp({ config: { enabledCssSnippets: ["a", "b"] } });

		const error = await createUpdateSettingTool(app)
			.execute("tool-call", { target: "app", key: "enabledCssSnippets", value: "a" })
			.then(() => null, (reason: unknown) => reason);

		// Both kinds are named so the model can fix the call in one turn, and
		// nothing is written — the guard runs before the store is touched.
		expect((error as Error).message).toBe('Obsidian setting "enabledCssSnippets" currently holds a array, so it cannot be replaced with a string. Read it with get_settings and pass a complete array.');
		expect(config.enabledCssSnippets).toEqual(["a", "b"]);
	});

	it("applies the same kind guard to a plugin's settings", async () => {
		const saved: unknown[] = [];
		const live = { timetable: { settings: { hideWeekends: true }, saveData: async (data: unknown) => void saved.push(data) } };
		const { app } = settingsApp({ live });

		await expect(
			createUpdateSettingTool(app).execute("tool-call", { target: "plugin", plugin: "timetable", key: "hideWeekends", value: "yes" }),
		).rejects.toThrow(/currently holds a boolean/);
		expect(saved).toEqual([]);
	});

	it("lets a setting move through null, which is how Obsidian spells 'unset'", async () => {
		const { app, config } = settingsApp({ config: { spellcheckLanguages: null } });

		await createUpdateSettingTool(app).execute("tool-call", { target: "app", key: "spellcheckLanguages", value: ["en", "de"] });

		// `null` is the value a setting holds between being unset and being set, so
		// guarding it as its own kind would block every setting that has one.
		expect(config.spellcheckLanguages).toEqual(["en", "de"]);
	});

	it("allows any kind where the setting is not set yet", async () => {
		const { app, config } = settingsApp({ config: { tabSize: 4 } });

		await createUpdateSettingTool(app).execute("tool-call", { target: "app", key: "brandNew", value: { nested: true } });

		expect(config.brandNew).toEqual({ nested: true });
	});

	it("refuses this plugin's own settings, on the read-through path too", async () => {
		const { app } = settingsApp({ live: { [PLUGIN_ID]: { settings: {}, saveData: async () => {} } } });

		await expect(
			createUpdateSettingTool(app).execute("tool-call", { target: "plugin", plugin: PLUGIN_ID, key: "defaultProvider", value: "openai" }),
		).rejects.toThrow(/does not reconfigure itself/);
	});

	it("reports a plugin whose settings are not a keyed object", async () => {
		const { app } = settingsApp({ data: { odd: [1, 2, 3] } });

		await expect(
			createUpdateSettingTool(app).execute("tool-call", { target: "plugin", plugin: "odd", key: "thing", value: 1 }),
		).rejects.toThrow(/stores its settings as array data/);
	});

	it("refuses with a readable error when the build has no settings store", async () => {
		const { app } = settingsApp();

		await expect(createUpdateSettingTool(app).execute("tool-call", { target: "app", key: "spellcheck", value: false })).rejects.toThrow(
			/does not expose its settings store/,
		);
		await expect(
			createUpdateSettingTool(app).execute("tool-call", { target: "plugin", plugin: "absent", key: "k", value: 1 }),
		).rejects.toThrow(/cannot be saved through the plugin/);
	});

	it("rejects before touching the store when the signal is already aborted", async () => {
		const { app, config } = settingsApp({ config: { spellcheck: true } });
		const controller = new AbortController();
		controller.abort();

		// A tool that ignores the signal resolves normally, and pi records that stale
		// result as a success, so the write has to be refused rather than land.
		const error = await createUpdateSettingTool(app)
			.execute("tool-call", { target: "app", key: "spellcheck", value: false }, controller.signal)
			.then(() => null, (reason: unknown) => reason);

		expect((error as Error | null)?.message).toBe("Operation aborted");
		expect(config.spellcheck).toBe(true);
	});
});
