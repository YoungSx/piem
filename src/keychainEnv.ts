/**
 * Decides what this device can offer for API keys, once per plugin load.
 *
 * Three states, resolved from capabilities rather than a version table:
 *
 * - `delegated` — Obsidian's `secretStorage` exposes the full read surface the
 *   plugin needs (`peekSecret` to resolve a binding, `listSecrets` for the
 *   picker). Keys live in the keychain under ids the user chose; `data.json`
 *   holds only references.
 * - `delegated-unencrypted` — same as above, but `isEncryptionAvailable`
 *   answered false: a Linux desktop with no keyring service. Obsidian still
 *   stores entries, just without encrypting them. Delegation keeps working —
 *   an unencrypted keychain entry is still outside the synced vault — and the
 *   panel says what it means.
 * - `manual` — nothing above held. Keys stay in `data.json` as plaintext, and
 *   the panel offers a collapsible fallback field. This is also where every
 *   failure mode lands: an old Obsidian, a partial store, a throwing probe.
 *
 * There is no version constant here. The capability matrix was measured across
 * five shipped builds (1.11.4/1.11.5/1.12.4/1.12.7/1.13.7): `peekSecret` since
 * 1.11.5, `isEncryptionAvailable` since 1.12.4. Probing the store's own shape
 * is the same decision with none of the maintenance — a future Obsidian that
 * renames or drops a method degrades to `manual` instead of passing a version
 * check and then throwing.
 */

import { createObsidianKeychain, createObsidianPluginSecrets, type SecretStorageHost } from "./obsidianKeychain";
import { UNAVAILABLE_KEYCHAIN, UNAVAILABLE_PLUGIN_SECRETS, type Keychain, type PluginSecretStore } from "./keychain";

/** What this device offers for keys, for the settings panel's copy. */
export type SecretStorageTier = "delegated" | "delegated-unencrypted" | "manual";

export interface SecretEnvironment {
	/** Which state is in effect. Drives both control flow and panel copy. */
	tier(): SecretStorageTier;
	/**
	 * The keychain to resolve references against.
	 *
	 * {@link UNAVAILABLE_KEYCHAIN} on the `manual` tier, so callers can resolve
	 * unconditionally rather than branching first.
	 */
	keychain(): Keychain;
	/**
	 * The store the plugin writes its own credentials into.
	 *
	 * A second question, not a second spelling of {@link keychain}: the tier above
	 * is decided by what can be *read*, because that is all an API-key binding
	 * needs, while an OAuth credential also has to be created and deleted. A host
	 * can be readable and still refuse both, so this resolves independently and
	 * reports {@link PluginSecretStore.available} for the UI to gate sign-in on.
	 *
	 * {@link UNAVAILABLE_PLUGIN_SECRETS} when nothing can be stored, so callers
	 * again resolve unconditionally. There is deliberately no `data.json`
	 * fallback: a refresh token is long-lived and that file is inside the synced
	 * vault, so the honest answer on such a host is that sign-in is unavailable.
	 */
	pluginSecrets(): PluginSecretStore;
}

export interface CreateSecretEnvironmentOptions {
	/**
	 * The running `App`, which is where `secretStorage` lives.
	 *
	 * Required rather than read off a global: the plugin already holds its own
	 * `this.app`, and reaching around it would make this module's dependency on
	 * the host invisible at the call site.
	 */
	host: SecretStorageHost | null;
	/**
	 * Injectable for tests; defaults to {@link createObsidianKeychain}.
	 *
	 * The whole decision reduces to "is the keychain readable", so the probe is
	 * the seam the tests cut through.
	 */
	createKeychain?: (host: SecretStorageHost | null) => Keychain;
	/**
	 * Injectable for tests; defaults to {@link createObsidianPluginSecrets}.
	 *
	 * A separate seam from {@link createKeychain} so a test can model the real
	 * asymmetry — a host that reads fine but refuses to write — which is the case
	 * the sign-in gate exists for and the one a single probe would hide.
	 */
	createPluginSecrets?: (host: SecretStorageHost | null) => PluginSecretStore;
	/**
	 * Receives the reason this device fell back to manual keys. Injectable so
	 * the module stays free of the logger; the plugin routes it to debug level,
	 * where an "is my key in the keychain?" question gets a direct answer.
	 */
	log?: (message: string) => void;
}

/**
 * Resolves the state for this device once per plugin load.
 *
 * Total by construction: every failure mode resolves to `manual` and nothing
 * propagates. Capability detection runs on the `onload` path, so a throw here
 * takes the whole plugin down with it; degrading to manual keys is always
 * preferable to not loading.
 */
export function createSecretEnvironment(options: CreateSecretEnvironmentOptions): SecretEnvironment {
	const log = options.log ?? ((): void => {});
	// Resolved before the tier, and independently of it, so a host that reads but
	// refuses to write still lands on `delegated` for API keys while reporting
	// sign-in as unavailable. Its own try/catch for the same reason every probe
	// here has one: this runs during onload.
	let pluginSecrets: PluginSecretStore = UNAVAILABLE_PLUGIN_SECRETS;
	try {
		const createSecrets = options.createPluginSecrets ?? ((host) => createObsidianPluginSecrets(host, { log }));
		pluginSecrets = createSecrets(options.host);
	} catch (error) {
		log(`Writable keychain probe failed; subscription sign-in stays unavailable. ${String(error)}`);
	}
	const manual: SecretEnvironment = {
		tier: () => "manual",
		keychain: () => UNAVAILABLE_KEYCHAIN,
		pluginSecrets: () => pluginSecrets,
	};
	try {
		const create = options.createKeychain ?? ((host) => createObsidianKeychain(host, { log }));
		const keychain = create(options.host);
		if (!keychain.available) {
			// The adapter already logged why.
			return manual;
		}
		return {
			tier: () => (keychain.encrypted ? "delegated" : "delegated-unencrypted"),
			keychain: () => keychain,
			pluginSecrets: () => pluginSecrets,
		};
	} catch (error) {
		log(`Keychain probe failed; keys stay in this vault's plugin config. ${String(error)}`);
		return manual;
	}
}
