/**
 * pi's `CredentialStore`, backed by Obsidian's keychain.
 *
 * This is the whole of the impedance mismatch between the two sides, and there
 * are three of them rather than one:
 *
 * 1. **Sync host, async contract.** `secretStorage` is synchronous; pi's
 *    interface is promise-based. That part is trivial.
 * 2. **No lock host-side, mutual exclusion required.** pi runs OAuth refresh
 *    *inside* `modify`, and that is the only thing stopping two concurrent
 *    requests from both spending the same refresh token — one rotation wins and
 *    the other's token is already revoked when it lands. Obsidian offers no
 *    lock, so the exclusion is a per-provider promise chain here. Cross-process
 *    exclusion is out of reach (two Obsidian windows share the file, not a
 *    lock), which the interface explicitly allows.
 * 3. **One credential per provider, one string per entry.** A `Credential` is a
 *    small record; a keychain entry is a string. So the record is JSON in a
 *    single entry, and the entry carries its own `providerId` so nothing has to
 *    be recovered by reversing the id derivation below.
 *
 * What this store deliberately does *not* handle is API keys. Those reach pi as
 * `overrides.apiKey` on every request (see `src/net/streamFn.ts`), resolved from
 * settings, and their keychain entries are the user's own — created and named in
 * Obsidian's keychain tab, referenced by `secretRef`, never written by us. The
 * entries here are the mirror case: plugin-owned, unnameable by a user, and
 * deleted on logout. `src/keychain.ts` carries that argument in full.
 */

import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { isValidSecretId, type PluginSecretStore } from "../keychain";

/**
 * Prefix marking a keychain entry as this plugin's credential store.
 *
 * The namespace is shared with the user's own entries and with every other
 * plugin, so `list()` has to be able to tell ours apart, and a user reading
 * their keychain tab deserves to see which plugin an entry belongs to.
 */
export const CREDENTIAL_ENTRY_PREFIX = "piem-oauth-";

/** Obsidian's cap on an entry id, mirrored from {@link isValidSecretId}. */
const MAX_SECRET_ID_LENGTH = 64;

/**
 * The keychain entry id holding one provider's credential.
 *
 * Provider ids are `uuidv7()` in every row the plugin creates, plus the two
 * synthetic constants, so the derivation is usually the identity on a prefix.
 * It is not assumed to be: `normalizeProviderConfig` accepts any non-empty
 * string as an id, so a hand-edited `data.json` can carry characters Obsidian's
 * `validateId` rejects. Those are folded rather than refused, because refusing
 * would make sign-in impossible for a row that otherwise works.
 *
 * Folding can collide two provider ids onto one entry. That is why the stored
 * payload records its own `providerId` and {@link readEntry} checks it: a
 * collision reads as "no credential for this provider", which is the safe
 * answer, rather than as another provider's token.
 */
export function credentialEntryId(providerId: string): string {
	const folded = providerId.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
	return `${CREDENTIAL_ENTRY_PREFIX}${folded}`.slice(0, MAX_SECRET_ID_LENGTH);
}

/**
 * A credential as it sits in one keychain entry.
 *
 * `providerId` is stored rather than derived back out of the entry id for the
 * reason above, and because it makes `list()` a straight read instead of a
 * reverse mapping that would have to be kept in step with the folding rule.
 */
interface StoredCredential {
	providerId: string;
	credential: Credential;
}

/** Whether a parsed value is a credential shape pi would accept back. */
function isCredential(value: unknown): value is Credential {
	if (!value || typeof value !== "object") {
		return false;
	}
	const raw = value as Record<string, unknown>;
	if (raw.type === "api_key") {
		return raw.key === undefined || typeof raw.key === "string";
	}
	if (raw.type !== "oauth") {
		return false;
	}
	// The three fields `OAuthCredentials` requires. A record missing any of them
	// cannot be refreshed or turned into request auth, so it is not a credential
	// that happens to be stale — it is junk, and treating it as absent sends the
	// user back through login instead of failing every request on a bad refresh.
	return typeof raw.refresh === "string" && typeof raw.access === "string" && typeof raw.expires === "number";
}

export interface KeychainCredentialStoreOptions {
	/** The plugin-owned slice of the host keychain. */
	secrets: PluginSecretStore;
	/**
	 * Receives the reason an entry was ignored or a write refused.
	 *
	 * Injected rather than imported so this module stays free of the logger. The
	 * plugin routes it to debug level, which is where "why am I signed out
	 * again?" gets an answer.
	 */
	log?: (message: string) => void;
}

/**
 * Message the store rejects with when the device cannot keep a secret.
 *
 * A distinct constant because the UI has to be able to say this one thing
 * clearly: sign-in is unavailable *here*, and no retry will change it.
 */
export const PLUGIN_SECRETS_UNAVAILABLE = "This device has no writable secret storage, so a subscription sign-in cannot be stored.";

/**
 * Builds the credential store pi resolves OAuth auth through.
 *
 * The returned store is safe to share across every `Models` instance the plugin
 * builds — and it has to be, because `requireModelsBundle` rebuilds that
 * instance whenever a provider row changes. A store per bundle would put each
 * rebuild's refresh behind a different lock, which is precisely the double-spend
 * the lock exists to prevent.
 */
export function createKeychainCredentialStore(options: KeychainCredentialStoreOptions): CredentialStore {
	const { secrets } = options;
	const log = options.log ?? ((): void => {});
	/**
	 * One promise chain per provider id.
	 *
	 * Keyed by provider rather than globally so a slow refresh for one
	 * subscription cannot hold up a read for another. Entries are never pruned:
	 * the map holds one settled promise per provider the session touched, which
	 * is bounded by the number of configured rows.
	 */
	const chains = new Map<string, Promise<unknown>>();

	/**
	 * Runs `task` after everything already queued for `providerId`.
	 *
	 * The chain advances to `task`'s settled promise, not to its start, or two
	 * `modify` calls would overlap and the second would read the credential the
	 * first had not written yet. Failures are absorbed into the chain so one
	 * rejected write does not poison every later operation, while still
	 * rejecting for the caller that owns it.
	 */
	const enqueue = <T>(providerId: string, task: () => Promise<T>): Promise<T> => {
		const previous = chains.get(providerId) ?? Promise.resolve();
		const result = previous.then(task, task);
		chains.set(
			providerId,
			result.catch(() => undefined),
		);
		return result;
	};

	/**
	 * The credential stored for one provider, or undefined.
	 *
	 * Every way of not having a usable credential — absent entry, unparseable
	 * JSON, a shape pi would not accept, a payload recorded against a different
	 * provider — resolves to undefined rather than an error. A request must be
	 * able to report "this provider is not configured", and a corrupt entry that
	 * threw instead would make every request fail with a storage error the user
	 * cannot act on. Each case logs, so the reason is recoverable.
	 */
	const readEntry = (providerId: string): Credential | undefined => {
		const id = credentialEntryId(providerId);
		if (!isValidSecretId(id)) {
			log(`Provider ${providerId} cannot be given a valid keychain entry id; treating it as signed out.`);
			return undefined;
		}
		const raw = secrets.read(id);
		if (!raw) {
			return undefined;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			log(`Keychain entry ${id} is not valid JSON; treating it as signed out. ${String(error)}`);
			return undefined;
		}
		if (!parsed || typeof parsed !== "object") {
			log(`Keychain entry ${id} does not hold a credential record; treating it as signed out.`);
			return undefined;
		}
		const stored = parsed as Partial<StoredCredential>;
		if (stored.providerId !== providerId) {
			// Either a folded id collision (see `credentialEntryId`) or an entry
			// left behind by a renamed provider. Both mean this provider has no
			// credential, and claiming otherwise would hand it someone else's token.
			log(`Keychain entry ${id} belongs to provider ${String(stored.providerId)}, not ${providerId}; treating it as signed out.`);
			return undefined;
		}
		if (!isCredential(stored.credential)) {
			log(`Keychain entry ${id} holds no usable credential; treating it as signed out.`);
			return undefined;
		}
		return stored.credential;
	};

	/** Persists a credential, or throws with the reason the host declined. */
	const writeEntry = (providerId: string, credential: Credential): void => {
		if (!secrets.available) {
			throw new Error(PLUGIN_SECRETS_UNAVAILABLE);
		}
		const id = credentialEntryId(providerId);
		if (!isValidSecretId(id)) {
			throw new Error(`Provider id ${providerId} cannot be stored in the keychain.`);
		}
		const payload: StoredCredential = { providerId, credential };
		if (!secrets.write(id, JSON.stringify(payload))) {
			// Throwing is the point. `Models.login()` reports success on a
			// resolved `modify`, so swallowing this would show the user a signed-in
			// panel over an empty keychain — the failure mode issue #145 was about.
			throw new Error(`The keychain refused to store the credential for ${providerId}.`);
		}
	};

	/** Removes a credential. Absent is success; a refused removal is not. */
	const deleteEntry = (providerId: string): void => {
		const id = credentialEntryId(providerId);
		if (!isValidSecretId(id) || !secrets.read(id)) {
			// Nothing there. Logout is idempotent by nature — the user asked to be
			// signed out and they are — so this is success, not a missing entry.
			return;
		}
		if (!secrets.remove(id)) {
			throw new Error(`The keychain refused to remove the credential for ${providerId}.`);
		}
	};

	return {
		async read(providerId, operation) {
			operation?.signal?.throwIfAborted();
			// Queued like the writes so a read cannot observe a half-finished
			// refresh: `modify` rotates the token and persists it, and a read that
			// slipped between those two would hand out an already-revoked access
			// token.
			return enqueue(providerId, async () => {
				operation?.signal?.throwIfAborted();
				return readEntry(providerId);
			});
		},

		async list(operation) {
			operation?.signal?.throwIfAborted();
			// Not queued, and not per-provider: this enumerates the whole store for
			// status UI, so there is no single chain it belongs to. A credential
			// mid-rotation is still the same provider with the same type, which is
			// all this reports — no secret is read out here.
			const infos: CredentialInfo[] = [];
			for (const id of secrets.list()) {
				if (!id.startsWith(CREDENTIAL_ENTRY_PREFIX)) {
					continue;
				}
				const raw = secrets.read(id);
				if (!raw) {
					continue;
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(raw);
				} catch {
					// Already logged by `readEntry` whenever this provider is actually
					// used; a listing is not the place to shout about it again.
					continue;
				}
				const stored = parsed as Partial<StoredCredential>;
				if (typeof stored?.providerId === "string" && isCredential(stored.credential)) {
					infos.push({ providerId: stored.providerId, type: stored.credential.type });
				}
			}
			return infos;
		},

		async modify(providerId, fn, operation) {
			operation?.signal?.throwIfAborted();
			return enqueue(providerId, async () => {
				// Re-checked inside the chain: the wait can be long — a refresh round
				// trip ahead of us in the queue — and the caller may have given up.
				operation?.signal?.throwIfAborted();
				const current = readEntry(providerId);
				const next = await fn(current);
				operation?.signal?.throwIfAborted();
				if (next === undefined) {
					// pi's contract: undefined means "leave the entry alone". It is how
					// a double-checked refresh reports that another caller already
					// rotated the token, so writing here would undo that work.
					return current;
				}
				writeEntry(providerId, next);
				return next;
			});
		},

		async delete(providerId, operation) {
			operation?.signal?.throwIfAborted();
			await enqueue(providerId, async () => {
				operation?.signal?.throwIfAborted();
				deleteEntry(providerId);
			});
		},
	};
}
