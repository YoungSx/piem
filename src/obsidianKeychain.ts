/**
 * Adapts Obsidian's `app.secretStorage` to the read-only {@link Keychain}.
 *
 * This is the only file that touches the host's secret API, which is what keeps
 * the resolution rules in `settingsSecrets.ts` free of a platform. Its whole job
 * is turning an API that throws and returns `null` into one that is total and
 * speaks in empty strings.
 *
 * Everything here is defensive for a specific reason rather than out of habit:
 * secret resolution runs on the `onload` path, so a throw that escapes this
 * module does not fail a key — it fails the plugin. Every entry point therefore
 * degrades to "this keychain holds nothing" instead of propagating.
 *
 * Two views come out of the same store, and which one a caller gets is decided
 * by who owns the entries it will touch. {@link createObsidianKeychain} is
 * read-only, for entries the *user* made and may share; the plugin holds a
 * reference and nothing else. {@link createObsidianPluginSecrets} can write and
 * delete, for entries only an OAuth login can produce and only a logout should
 * remove. `keychain.ts` carries the full argument for the split; the point here
 * is that neither view can be mistaken for the other at a call site.
 */

import {
	UNAVAILABLE_KEYCHAIN,
	UNAVAILABLE_PLUGIN_SECRETS,
	type Keychain,
	type PluginSecretStore,
} from "./keychain";

/**
 * The slice of `SecretStorage` this adapter reads through.
 *
 * Declared structurally rather than imported from `obsidian` because the two
 * methods this adapter needs are not in `obsidian.d.ts` at all: `peekSecret`
 * shipped in 1.11.5 and `isEncryptionAvailable` in 1.12.4, and both remain
 * undocumented. They are optional here and probed before use.
 *
 * `getSecret` is deliberately absent from this interface. The official store
 * records an access timestamp and throttles its save on every `getSecret` call
 * — write amplification on a path the plugin hits once per request. Reading
 * without side effects is the whole reason `peekSecret` is required.
 */
export interface SecretStorageLike {
	/** Undocumented in `obsidian.d.ts`; reads without recording access. */
	peekSecret?(id: string): string | null;
	/** Undocumented; whether the host actually encrypts entries. */
	isEncryptionAvailable?(): boolean;
	listSecrets(): string[];
	/**
	 * Documented since 1.11.4. Throws when the platform has no secure-storage
	 * backend ("Secure storage is not available.") or the id is malformed, and
	 * otherwise records the value and hands the save off without awaiting it.
	 */
	setSecret?(id: string, secret: string): void;
	/**
	 * Undocumented in `obsidian.d.ts`, but shipped since the keychain landed and
	 * used by Obsidian's own keychain tab (its trash button and its rename path
	 * both call it). Returns whether an entry was actually there.
	 *
	 * Optional and probed like the other undocumented members: a host without it
	 * yields a store that cannot delete, which the credential layer reports
	 * instead of pretending a logout cleared anything.
	 */
	deleteSecret?(id: string): boolean;
}

/** The host surface this adapter reads its store off. */
export interface SecretStorageHost {
	secretStorage?: unknown;
}

/**
 * Narrows an unknown value to {@link SecretStorageLike} only when the whole
 * read surface is present.
 *
 * A partially shaped object is treated as absent, the same way a missing
 * `peekSecret` is: calling into an incomplete store would throw somewhere
 * deeper, where the failure is far harder to attribute than "no keychain here".
 */
export function asSecretStorage(candidate: unknown): SecretStorageLike | null {
	if (!candidate || typeof candidate !== "object") {
		return null;
	}
	const probe = candidate as Record<string, unknown>;
	const complete = typeof probe.peekSecret === "function" && typeof probe.listSecrets === "function";
	return complete ? (candidate as SecretStorageLike) : null;
}

export interface CreateObsidianKeychainOptions {
	/**
	 * Receives the reason a keychain came back unavailable, or a call failed.
	 *
	 * Injected rather than imported so this module stays free of the logger. The
	 * plugin routes it to debug level, where "is my key in the keychain?" gets a
	 * direct answer instead of a guess.
	 */
	log?: (message: string) => void;
}

/**
 * Wraps `app.secretStorage` as a read-only {@link Keychain}, or reports
 * unavailable.
 *
 * Total: an absent store, a partial one, or one that throws on its first probe
 * all resolve to {@link UNAVAILABLE_KEYCHAIN}. Nothing propagates to the caller.
 */
export function createObsidianKeychain(host: SecretStorageHost | null | undefined, options: CreateObsidianKeychainOptions = {}): Keychain {
	const log = options.log ?? ((): void => {});
	let storage: SecretStorageLike | null = null;
	try {
		storage = asSecretStorage(host?.secretStorage);
	} catch (error) {
		// A getter on `secretStorage` is not something Obsidian does today, but
		// reading a property is the one thing here that can throw before any
		// method is called, and this runs during onload.
		log(`Keychain probe failed; treating it as unavailable. ${String(error)}`);
		return UNAVAILABLE_KEYCHAIN;
	}
	if (!storage) {
		log("Obsidian exposes no readable secret storage on this version; keys stay in the vault config.");
		return UNAVAILABLE_KEYCHAIN;
	}
	return wrapSecretStorage(storage, log);
}

/**
 * The adapter proper, over a store already known to be complete.
 *
 * Exported for tests, which hand in a mock rather than a host.
 */
export function wrapSecretStorage(storage: SecretStorageLike, log: (message: string) => void = () => {}): Keychain {
	return {
		available: true,
		encrypted: probeEncrypted(storage, log),
		read(id) {
			try {
				// `null` means "no such secret", which is a normal outcome and not
				// worth a log line: a dangling reference is an expected state.
				return storage.peekSecret?.(id) ?? "";
			} catch (error) {
				log(`Could not read secret ${id}. ${String(error)}`);
				return "";
			}
		},
		list() {
			try {
				const ids = storage.listSecrets();
				// The namespace is shared with every other plugin, so this returns
				// their ids too; filtering is the picker UI's job.
				return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
			} catch (error) {
				log(`Could not list secrets. ${String(error)}`);
				return [];
			}
		},
	};
}

/**
 * Whether the host encrypts what it stores, read once at wrap time.
 *
 * The answer is a property of the platform, not of an entry: Linux either has a
 * keyring service or it does not, and it does not flip between requests. Probing
 * once here keeps `encrypted` a `readonly` field rather than a method call that
 * could start throwing halfway through a session.
 */
function probeEncrypted(storage: SecretStorageLike, log: (message: string) => void): boolean {
	try {
		return storage.isEncryptionAvailable?.() ?? false;
	} catch (error) {
		log(`Could not probe keychain encryption; assuming none. ${String(error)}`);
		return false;
	}
}

/**
 * Narrows an unknown value to a store this plugin can also *write* through.
 *
 * Stricter than {@link asSecretStorage} and deliberately a separate question: a
 * host can be perfectly readable — which is all API-key resolution needs — while
 * missing `deleteSecret`, and answering the two with one probe would either
 * refuse reads on such a host or hand back a store whose logout silently does
 * nothing. Both members are required together for the same reason: a store that
 * can create a refresh token but not remove it cannot honour a sign-out.
 */
export function asWritableSecretStorage(candidate: unknown): SecretStorageLike | null {
	const storage = asSecretStorage(candidate);
	if (!storage) {
		return null;
	}
	return typeof storage.setSecret === "function" && typeof storage.deleteSecret === "function" ? storage : null;
}

/**
 * Wraps `app.secretStorage` as the plugin-owned {@link PluginSecretStore}, or
 * reports unavailable.
 *
 * Total in the same way {@link createObsidianKeychain} is, and for the same
 * reason: this is resolved once on the `onload` path, so an absent store, a
 * partial one, or a throwing probe all become "nothing can be stored here"
 * rather than a failed plugin load.
 */
export function createObsidianPluginSecrets(
	host: SecretStorageHost | null | undefined,
	options: CreateObsidianKeychainOptions = {},
): PluginSecretStore {
	const log = options.log ?? ((): void => {});
	let storage: SecretStorageLike | null = null;
	try {
		storage = asWritableSecretStorage(host?.secretStorage);
	} catch (error) {
		log(`Writable keychain probe failed; treating it as unavailable. ${String(error)}`);
		return UNAVAILABLE_PLUGIN_SECRETS;
	}
	if (!storage) {
		log("Obsidian exposes no writable secret storage on this version; subscription sign-in is unavailable.");
		return UNAVAILABLE_PLUGIN_SECRETS;
	}
	return wrapPluginSecretStorage(storage, log);
}

/**
 * The writable adapter proper, over a store already known to have both members.
 *
 * Exported for tests, which hand in a mock rather than a host.
 */
export function wrapPluginSecretStorage(
	storage: SecretStorageLike,
	log: (message: string) => void = () => {},
): PluginSecretStore {
	const read = (id: string): string => {
		try {
			return storage.peekSecret?.(id) ?? "";
		} catch (error) {
			log(`Could not read plugin secret ${id}. ${String(error)}`);
			return "";
		}
	};
	return {
		available: true,
		read,
		list() {
			try {
				const ids = storage.listSecrets();
				return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
			} catch (error) {
				log(`Could not list plugin secrets. ${String(error)}`);
				return [];
			}
		},
		write(id, value) {
			try {
				storage.setSecret?.(id, value);
			} catch (error) {
				// The two throws are "no secure-storage backend on this platform"
				// and "malformed id". Both are the host declining, and both are
				// worth a line: a caller that treats a decline as success is
				// exactly how a credential goes missing without a symptom.
				log(`Keychain refused the write for ${id}. ${String(error)}`);
				return false;
			}
			// Reading back proves the id round-tripped and no throw was swallowed
			// upstream. It cannot prove the value reached disk — see
			// {@link PluginSecretStore.write} — so this is a floor, not a
			// guarantee, and the honesty of that distinction is why it is stated
			// in the interface rather than implied by a `true` here.
			return read(id) === value;
		},
		remove(id) {
			try {
				return storage.deleteSecret?.(id) === true;
			} catch (error) {
				log(`Could not remove plugin secret ${id}. ${String(error)}`);
				return false;
			}
		},
	};
}
