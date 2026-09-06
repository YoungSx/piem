/**
 * Covers the settings-blob layer: how keychain references become plaintext on
 * load, and how the same blob is flattened for disk on save. The in-memory
 * settings always hold plaintext; these functions are the whole of the
 * translation between that invariant and `data.json`.
 *
 * The keychain itself is a two-method interface, so the tests hand in a map
 * behind that interface and never touch Obsidian. The plugin-level boundary —
 * `loadSettings` and `saveSettings` calling into these — is covered in
 * `settingsPersistence.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import { installObsidianStub } from "./testUtils/obsidianStub";
import type { Keychain } from "./keychain";
import type { PiemSettings } from "./settings";

// The module under test imports `settings.ts` type-only, but the tests use
// `normalizeSettings` from it, and that file imports `obsidian`; register the
// stub before any import of it.
installObsidianStub();

const { resolveSecretRefs, persistedSettings } = await import("./settingsSecrets");
const { normalizeSettings } = await import("./settings");

/** A keychain serving entries from a plain map, the shape every case wants. */
function keychainWith(entries: Record<string, string> = {}): Keychain {
	const map = new Map(Object.entries(entries));
	return {
		available: true,
		encrypted: true,
		read: (id) => map.get(id) ?? "",
		list: () => [...map.keys()],
	};
}

/** A normalized settings blob holding one ref-bound provider. */
function withProvider(overrides: Partial<PiemSettings["providers"][number]>): PiemSettings {
	return normalizeSettings({
		providers: [{ id: "prov-1", name: "A", baseUrl: "https://a.example.com", protocol: "openai-completions", apiKey: "", secretRef: "", source: "user", oauthFlow: "", ...overrides }],
	});
}

/** A normalized settings blob holding one MCP server. */
function withMcpServer(overrides: Partial<PiemSettings["mcpServers"][number]>): PiemSettings {
	return normalizeSettings({
		mcpServers: [{ id: "mcp-a", name: "A", url: "https://a.example.com", token: "", secretRef: "", enabled: true, ...overrides }],
	});
}

describe("resolveSecretRefs", () => {
	it("fills a ref-bound provider's key from the keychain", () => {
		const settings = withProvider({ secretRef: "my-gateway-key" });

		resolveSecretRefs(settings, keychainWith({ "my-gateway-key": "sk-resolved" }));

		expect(settings.providers[0]?.apiKey).toBe("sk-resolved");
	});

	it("fills a ref-bound MCP token the same way", () => {
		const settings = withMcpServer({ secretRef: "my-server-token" });

		resolveSecretRefs(settings, keychainWith({ "my-server-token": "tok-resolved" }));

		expect(settings.mcpServers[0]?.token).toBe("tok-resolved");
	});

	it("resolves a dangling reference to an empty key rather than throwing", () => {
		// The entry may have been deleted from Obsidian's own UI; requests will
		// fail on auth, which is the honest outcome, and the panel reports the
		// dangling ref.
		const settings = withProvider({ secretRef: "deleted-entry", apiKey: "stale" });

		resolveSecretRefs(settings, keychainWith());

		expect(settings.providers[0]?.apiKey).toBe("");
		expect(settings.providers[0]?.secretRef).toBe("deleted-entry");
	});

	it("leaves inline credentials alone — there the plaintext is the storage", () => {
		const settings = normalizeSettings({
			providers: [{ id: "prov-1", name: "A", baseUrl: "https://a.example.com", protocol: "openai-completions", apiKey: "sk-inline", secretRef: "", source: "user", oauthFlow: "" }],
			mcpServers: [{ id: "mcp-a", name: "A", url: "https://a.example.com", token: "tok-inline", secretRef: "", enabled: true }],
		});

		resolveSecretRefs(settings, keychainWith());

		expect(settings.providers[0]?.apiKey).toBe("sk-inline");
		expect(settings.mcpServers[0]?.token).toBe("tok-inline");
	});

	it("overwrites whatever the blob carried for a ref-bound field", () => {
		// The keychain entry is the durable home; a synced blob's stale plaintext
		// must not survive a load that can resolve the truth.
		const settings = withProvider({ secretRef: "my-gateway-key", apiKey: "stale-copy" });

		resolveSecretRefs(settings, keychainWith({ "my-gateway-key": "sk-fresh" }));

		expect(settings.providers[0]?.apiKey).toBe("sk-fresh");
	});
});

describe("persistedSettings", () => {
	it("blanks a ref-bound provider key — the keychain entry is the home", () => {
		const settings = withProvider({ secretRef: "my-gateway-key" });
		resolveSecretRefs(settings, keychainWith({ "my-gateway-key": "sk-resolved" }));

		const persisted = persistedSettings(settings);

		expect(persisted.providers?.[0]?.apiKey).toBe("");
		expect(persisted.providers?.[0]?.secretRef).toBe("my-gateway-key");
	});

	it("blanks a ref-bound MCP token the same way", () => {
		const settings = withMcpServer({ secretRef: "my-server-token" });
		resolveSecretRefs(settings, keychainWith({ "my-server-token": "tok-resolved" }));

		const persisted = persistedSettings(settings);

		expect(persisted.mcpServers?.[0]?.token).toBe("");
	});

	it("keeps inline credentials verbatim — there the plaintext is the storage", () => {
		const settings = normalizeSettings({
			providers: [{ id: "prov-1", name: "A", baseUrl: "https://a.example.com", protocol: "openai-completions", apiKey: "sk-inline", secretRef: "", source: "user", oauthFlow: "" }],
			mcpServers: [{ id: "mcp-a", name: "A", url: "https://a.example.com", token: "tok-inline", secretRef: "", enabled: true }],
		});

		const persisted = persistedSettings(settings);

		expect(persisted.providers?.[0]?.apiKey).toBe("sk-inline");
		expect(persisted.mcpServers?.[0]?.token).toBe("tok-inline");
	});

	it("carries the rest of the blob through untouched", () => {
		const settings = normalizeSettings({ logLevel: "debug" });

		const persisted = persistedSettings(settings);

		expect(persisted.logLevel).toBe("debug");
	});

	it("leaves the in-memory settings alone — only the returned copy is flattened", () => {
		const settings = withProvider({ secretRef: "my-gateway-key" });
		resolveSecretRefs(settings, keychainWith({ "my-gateway-key": "sk-resolved" }));

		const persisted = persistedSettings(settings);

		expect(persisted.providers?.[0]?.apiKey).toBe("");
		expect(settings.providers[0]?.apiKey).toBe("sk-resolved");
	});
});
