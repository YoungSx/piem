import type { App } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { PLUGIN_ID } from "../constants";
import { maxResultsParameter } from "./parameters";
import { textResult, throwIfAborted } from "./toolResult";

/**
 * Reading and writing Obsidian's own settings, and an installed plugin's.
 *
 * The one question this pair exists to answer is "why can the agent read
 * `.obsidian/app.json` but not change it" — and the answer was never that
 * Obsidian was in the way. Obsidian exposes a proper door: `vault.getConfig` /
 * `vault.setConfig` for the app, and a live plugin's own `settings` plus
 * `saveData()` for a plugin. Both keep Obsidian in the loop, which is the whole
 * difference from editing `data.json` on disk. `setConfig` fires `config-changed`
 * so the app re-reads itself, and `saveData` stamps the modification time and
 * leaves the running plugin holding the value the user will see in its settings
 * tab. A file edit gets none of the three: the value lands on disk while the
 * running copy keeps the old one, and the next save from either side silently
 * overwrites it.
 *
 * That is also why this is a second, narrower door rather than a relaxation of
 * the first. {@link VaultExecutionEnv} still refuses every mutation under the
 * config directory, and it still will: a whole-file `write` of
 * `.obsidian/plugins/foo/data.json` is the thing that corrupts a plugin, because
 * it drops every key the model did not know about. Here every write goes through
 * one named key, merged into what is already there, which is the failure mode
 * the refusal was written against.
 *
 * The surface is undocumented, so it is probed rather than assumed — the same
 * discipline `hasFileManager` and `canOpenKeychainSettings` apply, for the same
 * reason: Obsidian's public `obsidian.d.ts` declares neither `App.plugins` nor
 * `Vault.getConfig`, and a build that lacks either must produce a refusal the
 * model can read rather than a `TypeError` it has to interpret.
 */

/** Which store a call addresses. */
const SettingsTarget = Type.Union([Type.Literal("app"), Type.Literal("plugin")]);

/**
 * `vault.getConfig` / `vault.setConfig`, the app's own settings store.
 *
 * Per-key rather than read-all: Obsidian's config map is keyed by setting name
 * with defaults applied underneath, and there is no public enumeration of it, so
 * a whole-store dump would have to be assembled by the model guessing key names.
 */
interface AppConfigStore {
	getConfig(key: string): unknown;
	setConfig(key: string, value: unknown): void;
}

/** One live community plugin, as far as this tool is concerned. */
interface PluginInstance {
	/** Public since 1.13.0; `undefined` for a plugin that has not been loaded. */
	settings?: unknown;
	saveData(data: unknown): Promise<void>;
}

/** A plugin's manifest, used only to name what was listed. */
interface PluginManifest {
	name?: string;
	version?: string;
}

/**
 * `app.plugins` — the community plugin manager.
 *
 * `plugins` holds live instances keyed by id, `manifests` holds every installed
 * plugin whether or not it is enabled, and `enabledPlugins` says which are on.
 * Listing needs all three: manifests alone cannot tell an installed-but-off
 * plugin from a running one, and instances alone cannot show a plugin the user
 * has installed and disabled.
 */
interface PluginManager {
	plugins?: Record<string, PluginInstance | undefined>;
	manifests?: Record<string, PluginManifest | undefined>;
	enabledPlugins?: Set<string>;
}

/** The fallback store: the plugin's `data.json`, read and written directly. */
interface PluginDataStore {
	readPluginData(id: string): Promise<unknown>;
	writePluginData(id: string, data: unknown): Promise<void>;
}

const GetSettingsParameters = Type.Object({
	target: Type.Union([Type.Literal("app"), Type.Literal("plugin")], {
		description: 'Whose settings to read. "app" is Obsidian itself (theme, editor, files and links). "plugin" is an installed plugin.',
	}),
	plugin: Type.Optional(
		Type.String({
			description:
				"Plugin id, exactly as listed — the folder name it is installed under (inside the Obsidian configuration folder), e.g. " +
				'"obsidian-timetracker". Omit with target "plugin" to list every installed plugin with its id, version, and whether it is enabled; ' +
				`omit with target "app" is refused, because a key is required there. This plugin's own id (${PLUGIN_ID}) is refused: the agent does not reconfigure itself.`,
		}),
	),
	key: Type.Optional(
		Type.String({
			description:
				"One setting's name. Omit to get a whole plugin's settings as one object. Required for target " +
				'"app" — Obsidian exposes its settings key by key, with no way to enumerate them.',
		}),
	),
	maxResults: maxResultsParameter(100),
});

export function createGetSettingsTool(app: App): AgentTool<typeof GetSettingsParameters> {
	return {
		name: "get_settings",
		label: "Read settings",
		// Pure reads of Obsidian's own stores, same category as `ls` and the
		// metadata tools: no vault, editor, or network effect, so it is safe
		// beside any other call in a batch.
		executionMode: "parallel",
		description:
			"Read Obsidian's own settings, or an installed plugin's. " +
			'Call with target "plugin" and no plugin id to list every installed plugin with its id, version, and enabled state — that list is where a plugin id comes from. ' +
			'Then target "plugin" with the id to read that plugin\'s whole settings object, or add key for one setting. ' +
			'For target "app", key names an Obsidian setting such as "cssTheme", "spellcheck", "readableLineLength", "showLineNumber", or "attachmentFolderPath". ' +
			"Reads only. To change one, use update_setting — the same keys, one at a time, and the change is saved through Obsidian rather than by editing files. " +
			`Refuses ${PLUGIN_ID}, this plugin itself.`,
		parameters: GetSettingsParameters,
		execute: async (_toolCallId, params, signal) => {
			throwIfAborted(signal);
			if (params.target === "plugin" && params.plugin === undefined) {
				return listPlugins(app, params.maxResults ?? 100);
			}

			if (params.target === "app") {
				const config = appConfigStore(app);
				if (config === null) {
					throw new Error("This Obsidian build does not expose its settings store, so app settings cannot be read.");
				}
				if (params.key === undefined) {
					throw new Error('Reading target "app" needs a key: Obsidian exposes its settings one key at a time. Pass key, or use target "plugin" to list plugins first.');
				}
				// Reported as an explicit "not set" rather than a bare `null`:
				// `getConfig` substitutes Obsidian's built-in default for a known key
				// and yields `undefined` for a name it does not recognize at all, and a
				// bare `null` would leave a typo looking like a real setting value.
				const value = config.getConfig(params.key);
				return textResult(
					value === undefined
						? `app ${params.key} is not set, and is not a setting this Obsidian build knows. Check the spelling, or use a plugin's own settings instead.`
						: render("app", params.key, value),
					{ target: "app", key: params.key, set: value !== undefined },
				);
			}

			const id = requirePluginId(params.plugin);
			const loaded = livePlugin(app, id);
			if (loaded !== null) {
				const value = params.key === undefined ? loaded.settings : keyOf(asSettingsObject(loaded.settings, id), params.key);
				return textResult(render(`plugin:${id}`, params.key ?? "(all)", value), { target: "plugin", plugin: id, key: params.key, source: "plugin" });
			}

			const data = pluginDataStore(app);
			if (data === null) {
				throw new Error(`Plugin "${id}" is not loaded and this build cannot read plugin data files, so its settings cannot be read.`);
			}
			const stored = await data.readPluginData(id);
			const value = params.key === undefined ? stored : keyOf(asSettingsObject(stored, id), params.key);
			return textResult(render(`plugin:${id}`, params.key ?? "(all)", value), {
				target: "plugin",
				plugin: id,
				key: params.key,
				source: "data.json",
			});
		},
	};
}

const UpdateSettingParameters = Type.Object({
	target: SettingsTarget,
	plugin: Type.Optional(
		Type.String({
			description: `Plugin id for target "plugin", exactly as get_settings listed it. This plugin's own id (${PLUGIN_ID}) is refused.`,
		}),
	),
	key: Type.String({ description: "The one setting to change. Its whole value is replaced, so a list or object setting must be passed in complete form." }),
	value: Type.Unknown({ description: "The new value: a string, number, boolean, null, array, or object, matching the kind the setting already holds." }),
});

export function createUpdateSettingTool(app: App): AgentTool<typeof UpdateSettingParameters> {
	return {
		name: "update_setting",
		label: "Update setting",
		// See `move_note`: Obsidian's own stores are outside the file-mutation queue
		// this tool set interlocks through `VaultExecutionEnv`, so the sequential pin
		// is the only thing keeping a settings write from racing another write to the
		// same store in one batch.
		executionMode: "sequential",
		description:
			"Change one setting, in Obsidian or in an installed plugin, and save it the way that plugin saves its own settings. " +
			'Use target "app" with key for an Obsidian setting (for example key "cssTheme" or "spellcheck"); use target "plugin" with the plugin id for a plugin\'s own setting. ' +
			"Call get_settings first to see the current value and, for a plugin, to get its id. " +
			"Replaces the one key and leaves every other setting alone, so passing a list or object in full is required. " +
			"The new value must be the same kind as the current one — a setting that holds a list is not replaced with a string — which is checked before anything is saved. " +
			"A plugin that is not currently loaded has its data.json updated instead, and the result says so. " +
			`Refuses ${PLUGIN_ID}, this plugin itself: the agent does not reconfigure itself. ` +
			"This is the one supported way to change settings; writing a settings file directly is refused.",
		parameters: UpdateSettingParameters,
		execute: async (_toolCallId, params, signal) => {
			throwIfAborted(signal);
			if (params.target === "app") {
				const config = appConfigStore(app);
				if (config === null) {
					throw new Error("This Obsidian build does not expose its settings store, so the setting cannot be changed.");
				}
				// Before the write, so a refused call leaves nothing behind.
				assertSameKind("Obsidian", config.getConfig(params.key), params.value, params.key);
				throwIfAborted(signal);
				config.setConfig(params.key, params.value);
				return textResult(`Set Obsidian setting ${params.key} to ${preview(params.value)}.`, {
					target: "app",
					key: params.key,
					value: params.value,
				});
			}

			const id = requirePluginId(params.plugin);
			const loaded = livePlugin(app, id);
			if (loaded !== null && typeof loaded.saveData === "function") {
				const current = asSettingsObject(loaded.settings, id);
				assertSameKind(`Plugin "${id}"`, keyOf(current, params.key), params.value, params.key);
				// Last cancellation point before the change: `saveData` is a single
				// write, so reporting failure after it would leave the model re-applying
				// a change that landed.
				throwIfAborted(signal);
				current[params.key] = params.value;
				await loaded.saveData(current);
				return textResult(`Set ${params.key} on plugin ${id} to ${preview(params.value)} and saved it through the plugin.`, {
					target: "plugin",
					plugin: id,
					key: params.key,
					value: params.value,
					writtenVia: "plugin",
				});
			}

			const data = pluginDataStore(app);
			if (data === null) {
				throw new Error(`Plugin "${id}" cannot be saved through the plugin, and this build cannot write plugin data files, so its settings cannot be changed.`);
			}
			const stored = await data.readPluginData(id);
			const settings = asSettingsObject(stored, id);
			assertSameKind(`Plugin "${id}"`, keyOf(settings, params.key), params.value, params.key);
			throwIfAborted(signal);
			settings[params.key] = params.value;
			await data.writePluginData(id, settings);
			return textResult(
				`Set ${params.key} on plugin ${id} to ${preview(params.value)} in its data.json. The plugin is not running, so it picks the value up when it next starts.`,
				{ target: "plugin", plugin: id, key: params.key, value: params.value, writtenVia: "data.json" },
			);
		},
	};
}

/* ------------------------------------------------------------------ probes */

/** `app.vault` as far as the settings store is concerned, or `null` if absent. */
function appConfigStore(app: App): AppConfigStore | null {
	const store = app.vault as Partial<AppConfigStore> | undefined;
	return typeof store?.getConfig === "function" && typeof store.setConfig === "function" ? (store as AppConfigStore) : null;
}

/** `app.vault`'s plugin-data members, or `null` if either is absent. */
function pluginDataStore(app: App): PluginDataStore | null {
	const store = app.vault as Partial<PluginDataStore> | undefined;
	return typeof store?.readPluginData === "function" && typeof store.writePluginData === "function" ? (store as PluginDataStore) : null;
}

/** `app.plugins` as far as the live instances are concerned, or `null` if absent. */
function pluginManager(app: App): PluginManager | null {
	const manager = (app as { plugins?: PluginManager }).plugins;
	return typeof manager?.plugins === "object" ? manager : null;
}

/**
 * The running plugin, or `null` when it is not running.
 *
 * `null` is the normal answer for a disabled plugin, not an error: that is what
 * sends the caller to the data.json fallback, and the difference is reported
 * rather than thrown. Membership of the registry is all this checks — whether
 * the instance can be saved *through* is the write path's own question, so a
 * plugin partway through loading still reads from memory instead of from a file
 * that is one write behind.
 */
function livePlugin(app: App, id: string): PluginInstance | null {
	const loaded = pluginManager(app)?.plugins?.[id];
	return loaded !== null && typeof loaded === "object" ? loaded : null;
}

/* ------------------------------------------------------------------ guards */

function requirePluginId(plugin: string | undefined): string {
	if (plugin === undefined) {
		throw new Error('target "plugin" needs a plugin id. Call get_settings with target "plugin" and no id to list the installed ones.');
	}
	// The one refusal in this module, and the reason the two tools' descriptions
	// both name it: an agent that could rewrite its own provider, endpoint, or key
	// through a settings door is a settings door with no one holding the other
	// end. `VaultExecutionEnv` refuses the same folder for the same reason; this
	// is the API-shaped door into it, so it has to repeat the rule.
	if (plugin === PLUGIN_ID) {
		throw new Error(`Refusing to read or change ${PLUGIN_ID}'s own settings: the agent does not reconfigure itself.`);
	}
	return plugin;
}

/**
 * A plugin's settings as a mutable object, or a refusal naming why not.
 *
 * A plugin whose `data.json` is a bare array or scalar cannot have one of its
 * settings replaced — there is no key to put it under — and that is worth an
 * error rather than a silent no-op.
 */
function asSettingsObject(settings: unknown, id: string): Record<string, unknown> {
	if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
		throw new Error(`Plugin "${id}" stores its settings as ${jsonKind(settings)} data, which has no named keys. Read it whole with get_settings instead.`);
	}
	return settings as Record<string, unknown>;
}

/** The one value at `key`, or `undefined` when the setting is not set. */
function keyOf(settings: Record<string, unknown>, key: string): unknown {
	return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : undefined;
}

/**
 * Refuses a value of a different kind than the one already stored.
 *
 * The check is per kind, not per value, because these stores are untyped and
 * Obsidian reads them back with no validation: a boolean set to the string
 * `"false"` is truthy, and an object setting overwritten with a string breaks
 * whatever plugin reads it. Reporting both kinds means the model can correct the
 * call in one turn rather than discovering the breakage later.
 *
 * `null` is compatible with everything, in both directions. Obsidian itself
 * writes `null` for "not configured" (`spellcheckLanguages`, `nativeMenus`,
 * `userIgnoreFilters` all default to it), so it is the value a setting holds
 * between being unset and being set, not a kind of its own.
 */
function assertSameKind(owner: string, current: unknown, next: unknown, key: string): void {
	if (current === undefined || current === null || next === null) {
		return;
	}
	const before = jsonKind(current);
	const after = jsonKind(next);
	if (before !== after) {
		throw new Error(`${owner} setting "${key}" currently holds a ${before}, so it cannot be replaced with a ${after}. Read it with get_settings and pass a complete ${before}.`);
	}
}

function jsonKind(value: unknown): string {
	if (value === null) {
		return "null";
	}
	if (Array.isArray(value)) {
		return "array";
	}
	if (typeof value === "object") {
		return "object";
	}
	return typeof value;
}

/* ----------------------------------------------------------------- output */

/**
 * Every installed plugin, one row each.
 *
 * Sorted by id so two calls in a row are diffable, and the id leads the row
 * because it is the field every follow-up call needs.
 */
function listPlugins(app: App, maxResults: number): ReturnType<typeof textResult> {
	const manager = pluginManager(app);
	if (manager === null) {
		throw new Error("This Obsidian build does not expose the plugin manager, so installed plugins cannot be listed.");
	}
	const manifests = manager.manifests ?? {};
	const enabled = manager.enabledPlugins ?? new Set<string>();
	const rows = Object.keys(manifests)
		.sort()
		.map((id) => {
			const manifest = manifests[id];
			const name = manifest?.name ?? id;
			const version = manifest?.version ? ` ${manifest.version}` : "";
			return `${enabled.has(id) ? "enabled  " : "disabled "}${id}${version}  (${name})`;
		});
	const shown = rows.slice(0, maxResults);
	if (rows.length === 0) {
		return textResult("(no community plugins installed)", { target: "plugin", count: 0, returnedCount: 0 });
	}
	if (shown.length < rows.length) {
		shown.push(`… ${rows.length - shown.length} more; raise maxResults to see them.`);
	}
	return textResult(shown.join("\n"), { target: "plugin", count: rows.length, returnedCount: shown.length });
}

/** One read, as a labeled line so a bare value never has to be guessed at. */
function render(target: string, key: string, value: unknown): string {
	return `${target} ${key} = ${JSON.stringify(value, null, 2)}`;
}

/** The new value inside a one-line report, truncated so a big one cannot flood the transcript. */
function preview(value: unknown): string {
	const rendered = JSON.stringify(value) ?? String(value);
	return rendered.length > 200 ? `${rendered.slice(0, 200)}…` : rendered;
}
