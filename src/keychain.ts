/**
 * The read-only view of Obsidian's keychain this plugin resolves its API keys
 * through.
 *
 * Everything about this module follows from one decision: **the plugin does not
 * write to the keychain.** Entries are created and named by the user through
 * Obsidian's own keychain settings tab, and `data.json` stores only the id of
 * the entry a provider is bound to. What used to live here — a two-phase
 * relocation protocol that wrote a key across and deferred erasing the disk
 * copy by a session — existed solely because `setSecret` returns before its save
 * lands and so cannot be trusted (issue #145). With no writes there is nothing
 * to distrust, and the whole protocol is gone.
 *
 * The consequences worth stating, because they are what keep the design honest:
 *
 * - A reference can dangle. The user may delete an entry we point at, from a UI
 *   this plugin has no part in. `read` therefore returns `""` for a missing
 *   entry rather than treating it as exceptional, and the panel reports the
 *   dangling ref instead of silently sending an empty key.
 * - Removal is not our business. An entry may be shared by several providers,
 *   or by another plugin entirely, so deleting a provider must never delete the
 *   entry it referenced. There is deliberately no `remove` on this interface.
 *
 * Free of `obsidian` imports: the store arrives as a {@link Keychain}, so every
 * rule that reads through it is checkable without a platform.
 */

/**
 * A secret store, reduced to the two questions resolution asks of it.
 *
 * Both methods are total and synchronous. Total because resolution runs on the
 * `onload` path, where a throw takes the whole plugin down with it; synchronous
 * because Obsidian's own API is, and wrapping it in promises would buy nothing
 * but a colour change across every caller.
 */
export interface Keychain {
	/** Whether this store can actually be read from. */
	readonly available: boolean;
	/**
	 * Whether the host encrypts what it stores.
	 *
	 * False on a Linux desktop with no keyring service, where Obsidian falls back
	 * to writing entries unencrypted. It does not gate delegation — an
	 * unencrypted keychain entry is still outside the synced vault, which is the
	 * larger of the two wins — but the panel has to say so.
	 */
	readonly encrypted: boolean;
	/** The stored secret, or `""` when the id names nothing. Absence is normal. */
	read(id: string): string;
	/** Every id this store holds, including other plugins' and the user's own. */
	list(): string[];
}

/** A keychain that holds nothing, for hosts without usable secret storage. */
export const UNAVAILABLE_KEYCHAIN: Keychain = {
	available: false,
	encrypted: false,
	read: () => "",
	list: () => [],
};

/**
 * Obsidian's own constraint on an entry id: lowercase alphanumerics and dashes,
 * at most 64 characters.
 *
 * Mirrored rather than probed through the host's `validateId`, so a persisted
 * reference can be judged without a platform. Verified against the shipped
 * implementation, which is literally this regex and this bound.
 */
const VALID_SECRET_ID = /^[a-z0-9-]{1,64}$/;

/**
 * Whether a string could name a keychain entry.
 *
 * Used to drop garbage out of a hand-edited `data.json` at load. A well-formed
 * id that names nothing is *not* rejected here — that is a dangling reference,
 * which the panel reports, and discarding it would silently lose the binding the
 * user set up when the entry comes back.
 */
export function isValidSecretId(value: string): boolean {
	return VALID_SECRET_ID.test(value);
}

/**
 * The plugin-owned slice of the same host store, which this plugin *does* write.
 *
 * Separate from {@link Keychain} because the two answer to different owners, and
 * that difference is the whole reason the read-only rule above survives:
 *
 * - A {@link Keychain} entry is the **user's**. They create it in Obsidian's own
 *   keychain tab, name it, and may share it between providers or plugins. We
 *   hold a reference and nothing more, so writing or deleting one would be us
 *   editing somebody else's record.
 * - An entry reached through this interface is the **plugin's**. Nothing but an
 *   OAuth login can produce its value — a refresh token is not something a user
 *   can paste, and there is no id for them to pick — so the entry has no
 *   existence outside the flow that created it. Logging out has to be able to
 *   delete it, because leaving a live refresh token behind after the user asked
 *   to be signed out is the failure, not the cleanup.
 *
 * Sync and total for the same reasons {@link Keychain} is: the host's API is
 * synchronous, and resolution runs where a throw is expensive. Serialization and
 * the async surface pi's `CredentialStore` wants are added a layer up, in
 * `src/auth/credentialStore.ts`, so this stays a thin honest view of the host.
 */
export interface PluginSecretStore {
	/**
	 * Whether entries can actually be written here.
	 *
	 * False on the manual tier, where OAuth login is refused outright rather
	 * than falling back to `data.json`: a refresh token is a long-lived
	 * credential and `data.json` lives inside the synced vault.
	 */
	readonly available: boolean;
	/** The stored value, or `""` when the id names nothing. */
	read(id: string): string;
	/**
	 * Every id the host store holds, this plugin's and everyone else's.
	 *
	 * Unfiltered, exactly as {@link Keychain.list} is, because the namespace is
	 * genuinely shared and a filter belongs to whoever knows what it is looking
	 * for — here, the credential layer, which owns the id prefix.
	 */
	list(): string[];
	/**
	 * Stores a value, reporting whether the host took it.
	 *
	 * What `false` means is narrower than it looks, and the narrowness is the
	 * point. Obsidian's `setSecret` returns `void` and hands the actual save to
	 * `adapter.save(...)` without awaiting or checking it (verified against the
	 * shipped 1.13.7 implementation), so **durability is not observable from a
	 * plugin at all** — that is the same gap issue #145 hit, and it cannot be
	 * closed from this side. What is observable is a refusal: `setSecret` throws
	 * when the platform has no secure-storage backend and when the id is
	 * malformed. So `false` means "the host declined this write", which is worth
	 * reporting because it is otherwise silent, and `true` means "accepted, and
	 * a read-back agrees" — not "on disk". The only test of durability is a
	 * restart, which is why the acceptance criteria for OAuth demand one.
	 */
	write(id: string, value: string): boolean;
	/** Removes an entry, reporting whether one was there. */
	remove(id: string): boolean;
}

/** A plugin-owned store for hosts that cannot keep secrets outside the vault. */
export const UNAVAILABLE_PLUGIN_SECRETS: PluginSecretStore = {
	available: false,
	read: () => "",
	list: () => [],
	write: () => false,
	remove: () => false,
};
