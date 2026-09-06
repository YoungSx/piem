/**
 * The plugin-level persistence boundary: what `loadSettings` and `saveSettings`
 * actually do to a plugin instance's store.
 *
 * `settingsSecrets.test.ts` covers the transform functions in isolation; this
 * file drives the real methods against an in-memory `loadData`/`saveData`, so
 * the round trip — read, resolve, mutate, persist, reload — is proven end to
 * end. The keychain behind it is a map, which is all `Keychain` is.
 */

import { describe, expect, it } from "bun:test";
import { installObsidianStub } from "./testUtils/obsidianStub";
// `main.ts` reaches the React tree (PiemChatView), and react-dom must be
// evaluated after the test DOM exists — every `src/ui` test holds this same
// ordering, and breaking it silently kills `useEffect` listeners there.
import { installDom } from "./testUtils/dom";
import type { LoggerLike } from "./logging/Logger";
import type PiemPluginType from "./main";
import type { Keychain } from "./keychain";
import type { SecretEnvironment } from "./keychainEnv";

// `main.ts` pulls in obsidian at runtime; the shared stub must exist first.
installObsidianStub();
installDom();

const { default: PiemPlugin } = await import("./main");
const { NOOP_LOGGER } = await import("./logging/Logger");
const { UNAVAILABLE_KEYCHAIN, UNAVAILABLE_PLUGIN_SECRETS } = await import("./keychain");

type PluginInstance = InstanceType<typeof PiemPluginType>;

interface StoredData {
	data: unknown;
}

interface HarnessOptions {
	/** Entries the keychain serves; the ids are whatever the blob references. */
	entries?: Record<string, string>;
	/** Replace the whole environment, for the no-keychain device. */
	keychain?: Keychain;
}

interface PluginHarness {
	plugin: PluginInstance;
	saved: () => { value: unknown; writes: number };
}

/**
 * A plugin instance with `loadData`/`saveData` backed by memory.
 *
 * `Object.create` deliberately skips Obsidian's constructor and this class's
 * field initializers, so the three collaborators the persistence boundary
 * reaches are injected exactly once, as `onload` would resolve them.
 */
function pluginWithData(initial: unknown, options: HarnessOptions = {}): PluginHarness {
	const store: StoredData = { data: initial };
	let writes = 0;
	const plugin = Object.create(PiemPlugin.prototype) as PluginInstance;
	const keychain = options.keychain ?? keychainFrom(options.entries ?? {});
	const environment: SecretEnvironment = {
		tier: () => (keychain.available ? "delegated" : "manual"),
		keychain: () => keychain,
		// Persistence never touches plugin-owned entries: OAuth credentials live in
		// the keychain outright, so nothing about them round-trips through
		// `data.json` for these tests to assert.
		pluginSecrets: () => UNAVAILABLE_PLUGIN_SECRETS,
	};

	(plugin as unknown as { log: LoggerLike }).log = NOOP_LOGGER;
	(plugin as unknown as { secretEnvironment: SecretEnvironment | null }).secretEnvironment = environment;
	(plugin as unknown as { loadData: () => Promise<unknown> }).loadData = async () => store.data;
	(plugin as unknown as { saveData: (data: unknown) => Promise<void> }).saveData = async (data: unknown) => {
		writes += 1;
		store.data = data;
	};

	return { plugin, saved: () => ({ value: store.data, writes }) };
}

/** A read-only {@link Keychain} over a map. */
function keychainFrom(entries: Record<string, string>): Keychain {
	const map = new Map(Object.entries(entries));
	return {
		available: true,
		encrypted: true,
		read: (id) => map.get(id) ?? "",
		list: () => [...map.keys()],
	};
}

describe("loadSettings", () => {
	it("resolves a bound provider's key from the keychain into memory", async () => {
		const { plugin } = pluginWithData(
			{ providers: [{ id: "p1", name: "A", baseUrl: "https://x/v1", apiKey: "", secretRef: "gateway-key", source: "user" }] },
			{ entries: { "gateway-key": "sk-vaulted" } },
		);

		await plugin.loadSettings();

		expect(plugin.settings.providers[0]?.apiKey).toBe("sk-vaulted");
	});

	it("leaves an unresolvable reference's key empty — dangling is normal", async () => {
		const { plugin } = pluginWithData(
			{ providers: [{ id: "p1", name: "A", baseUrl: "https://x/v1", apiKey: "", secretRef: "gone", source: "user" }] },
		);

		await plugin.loadSettings();

		expect(plugin.settings.providers[0]?.apiKey).toBe("");
		expect(plugin.settings.providers[0]?.secretRef).toBe("gone");
	});

	it("never writes: a load is a read, of the vault as much as of the keychain", async () => {
		const { plugin, saved } = pluginWithData(
			{ providers: [{ id: "p1", name: "A", baseUrl: "https://x/v1", apiKey: "", secretRef: "gateway-key", source: "user" }] },
			{ entries: { "gateway-key": "sk-vaulted" } },
		);

		await plugin.loadSettings();

		expect(saved().writes).toBe(0);
	});

	it("survives empty persisted data without provoking a write", async () => {
		const { plugin, saved } = pluginWithData(null);

		await plugin.loadSettings();

		expect(plugin.settings.providers).toEqual([]);
		expect(saved().writes).toBe(0);
	});
});

describe("saveSettings", () => {
	it("blanks a bound key on disk while memory keeps it", async () => {
		const { plugin, saved } = pluginWithData(
			{ providers: [{ id: "p1", name: "A", baseUrl: "https://x/v1", apiKey: "", secretRef: "gateway-key", source: "user" }] },
			{ entries: { "gateway-key": "sk-vaulted" } },
		);
		await plugin.loadSettings();

		await plugin.saveSettings();

		const persisted = saved().value as { providers: Record<string, unknown>[] };
		expect(persisted.providers[0]).toEqual({ id: "p1", name: "A", baseUrl: "https://x/v1", protocol: "openai-completions", apiKey: "", secretRef: "gateway-key", source: "user" });
		expect(plugin.settings.providers[0]?.apiKey).toBe("sk-vaulted");
	});

	it("keeps an inline key on disk — there the plaintext is the storage", async () => {
		const { plugin, saved } = pluginWithData(
			{ providers: [{ id: "p1", name: "A", baseUrl: "https://x/v1", apiKey: "sk-inline", secretRef: "", source: "user" }] },
			{ keychain: UNAVAILABLE_KEYCHAIN },
		);
		await plugin.loadSettings();

		await plugin.saveSettings();

		const persisted = saved().value as { providers: { apiKey: string }[] };
		expect(persisted.providers[0]?.apiKey).toBe("sk-inline");
	});

	it("blanks a bound MCP token on disk the same way", async () => {
		const { plugin, saved } = pluginWithData(
			{ mcpServers: [{ id: "m1", name: "M", url: "https://m.example.com", token: "", secretRef: "server-token", enabled: true }] },
			{ entries: { "server-token": "tok-vaulted" } },
		);
		await plugin.loadSettings();

		await plugin.saveSettings();

		const persisted = saved().value as { mcpServers: { token: string; secretRef: string }[] };
		expect(persisted.mcpServers[0]?.token).toBe("");
		expect(persisted.mcpServers[0]?.secretRef).toBe("server-token");
		expect(plugin.settings.mcpServers[0]?.token).toBe("tok-vaulted");
	});
});

describe("the round trip", () => {
	it("reloads a saved blob back into the same plaintext, through the keychain", async () => {
		const { plugin, saved } = pluginWithData(
			{ providers: [{ id: "p1", name: "A", baseUrl: "https://x/v1", apiKey: "", secretRef: "gateway-key", source: "user" }] },
			{ entries: { "gateway-key": "sk-vaulted" } },
		);
		await plugin.loadSettings();
		await plugin.saveSettings();

		// A second plugin instance, as the next Obsidian launch is.
		const second = pluginWithData(saved().value, { entries: { "gateway-key": "sk-vaulted" } });
		await second.plugin.loadSettings();

		expect(second.plugin.settings.providers[0]?.apiKey).toBe("sk-vaulted");
	});

	it("drops nothing when the entry vanishes: the binding survives, the key does not", async () => {
		const { plugin, saved } = pluginWithData(
			{ providers: [{ id: "p1", name: "A", baseUrl: "https://x/v1", apiKey: "", secretRef: "gateway-key", source: "user" }] },
			{ entries: { "gateway-key": "sk-vaulted" } },
		);
		await plugin.loadSettings();
		await plugin.saveSettings();

		// Same blob, but the user deleted the keychain entry in between — the
		// state a synced vault meeting a wiped keyring takes. The reference
		// must survive so re-creating the entry restores the key.
		const second = pluginWithData(saved().value, { entries: {} });
		await second.plugin.loadSettings();

		expect(second.plugin.settings.providers[0]?.apiKey).toBe("");
		expect(second.plugin.settings.providers[0]?.secretRef).toBe("gateway-key");
	});
});
