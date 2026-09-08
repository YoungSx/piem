/**
 * The boundary where keychain references become plaintext and back.
 *
 * `PiemSettings` holds plaintext in memory — every reader (`getApiKey`, the
 * connection test, `streamFn`) depends on that and none of them learns where a
 * key actually lives. This module is the whole of the translation between that
 * invariant and the disk: on load, a non-empty `secretRef` on a provider or MCP
 * server is resolved through the keychain and its `apiKey`/`token` field filled
 * in; on save, the same fields are written back out blanked.
 *
 * The rule both directions share is that a set `secretRef` and a non-empty
 * plaintext field are never both true on disk. The in-memory copy of the
 * plaintext is real but transient — it is what this session reads — while the
 * keychain entry is the durable home. `data.json` holds only the reference,
 * which is a user-chosen id and not sensitive.
 *
 * Being a snapshot taken at load, the in-memory copy can drift from its entry
 * while the session runs. The policy is that drift heals at the boundary where
 * credentials are about to be used, not in the background: the edit forms
 * resolve their own draft on open (the keychain is the home, the snapshot only
 * a cache of it), and the panel's reconnect re-runs
 * {@link resolveSecretRefs} before connecting. The reads are cheap and
 * idempotent, so staleness survives only until the next boundary.
 *
 * Free of `obsidian` imports at runtime: the keychain arrives as a
 * {@link Keychain}, and the only import from `settings.ts` is type-only and
 * therefore erased.
 */

// Type-only, so nothing from `settings.ts` (and therefore nothing from
// `obsidian`) is pulled in at runtime; the import is erased at compile time.
import type { PiemSettings } from "./settings";
import type { Keychain } from "./keychain";

/**
 * Fills every reference-bound credential in from the keychain.
 *
 * Mutates `settings` in place, which is what the load path wants: this runs
 * right after `normalizeSettings` and the object it produces is the one every
 * consumer then holds.
 *
 * A missing entry resolves to `""` rather than an error — a dangling reference
 * is an expected state (the user deleted the entry from Obsidian's own UI) and
 * the panel reports it; requests fail on auth until it is re-bound, which is
 * the honest outcome. Fields whose `secretRef` is empty are left alone: their
 * plaintext is the storage, on the manual tier.
 */
export function resolveSecretRefs(settings: PiemSettings, keychain: Keychain): void {
	for (const provider of settings.providers) {
		if (provider.secretRef) {
			provider.apiKey = keychain.read(provider.secretRef);
		}
	}
	for (const server of settings.mcpServers) {
		if (server.secretRef) {
			server.token = keychain.read(server.secretRef);
		}
	}
}

/**
 * The settings blob as it should be persisted.
 *
 * A credential bound to a keychain entry goes out with its plaintext field
 * blanked — the entry is the home, and writing the value here would undo the
 * whole point. Fields are blanked rather than deleted so the JSON shape stays
 * stable and a rolled-back build still parses it. Inline credentials (empty
 * `secretRef`, the manual tier) keep their value: there, the plaintext *is* the
 * storage.
 */
export function persistedSettings(settings: PiemSettings): Partial<PiemSettings> {
	return {
		...settings,
		providers: settings.providers.map((provider) => ({
			...provider,
			apiKey: provider.secretRef ? "" : provider.apiKey,
		})),
		mcpServers: settings.mcpServers.map((server) => ({
			...server,
			token: server.secretRef ? "" : server.token,
		})),
	};
}
