/**
 * The credential store pi resolves OAuth auth through.
 *
 * Three properties carry the whole design, and each has cases here rather than
 * a comment:
 *
 * 1. **Persistence survives a restart.** Issue #145's lesson is that a
 *    same-process read-back proves nothing, so the round-trip cases build a
 *    *second* store over the same backing entries — which is what a relaunch
 *    actually is from this layer's point of view.
 * 2. **`modify` is mutually exclusive per provider.** It is the only thing
 *    stopping two concurrent requests from both spending one refresh token, so
 *    there is a case that overlaps them deliberately and asserts one rotation.
 * 3. **Nothing unreadable becomes an error.** A corrupt entry has to read as
 *    "signed out", because a request that fails on storage instead gives the
 *    user no action to take.
 */

import { describe, expect, it } from "bun:test";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import type { PluginSecretStore } from "../keychain";
import { CREDENTIAL_ENTRY_PREFIX, PLUGIN_SECRETS_UNAVAILABLE, createKeychainCredentialStore, credentialEntryId } from "./credentialStore";

/**
 * A {@link PluginSecretStore} over a plain map.
 *
 * The map is passed in rather than owned so a test can hand the same entries to
 * a second store and model a restart. Failure switches mirror the adapter's
 * own reports: a refused write and a refused removal are the two the credential
 * layer has to turn into rejections.
 */
function secretsOver(
	entries: Map<string, string>,
	options: { available?: boolean; refuseWrites?: boolean; refuseRemovals?: boolean } = {},
): PluginSecretStore {
	return {
		available: options.available ?? true,
		read: (id) => entries.get(id) ?? "",
		list: () => [...entries.keys()],
		write: (id, value) => {
			if (options.refuseWrites) {
				return false;
			}
			entries.set(id, value);
			return true;
		},
		remove: (id) => (options.refuseRemovals ? false : entries.delete(id)),
	};
}

const OAUTH: Credential = { type: "oauth", access: "at-1", refresh: "rt-1", expires: 1_800_000_000_000 };

/** A deferred, for the cases that need two operations genuinely overlapping. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = (): void => {};
	const promise = new Promise<void>((settle) => {
		resolve = () => settle();
	});
	return { promise, resolve };
}

async function put(store: CredentialStore, providerId: string, credential: Credential): Promise<void> {
	await store.modify(providerId, async () => credential);
}

describe("credentialEntryId", () => {
	it("prefixes the provider id so the entry is attributable in the keychain tab", () => {
		expect(credentialEntryId("01a0744e-4953-76b6-9a10-c9263d9ee3f4")).toBe(
			`${CREDENTIAL_ENTRY_PREFIX}01a0744e-4953-76b6-9a10-c9263d9ee3f4`,
		);
	});

	it("folds characters Obsidian's id rule rejects instead of refusing the provider", () => {
		expect(credentialEntryId("My_Provider")).toBe(`${CREDENTIAL_ENTRY_PREFIX}my-provider`);
	});

	it("stays inside Obsidian's 64-character cap", () => {
		expect(credentialEntryId("x".repeat(120)).length).toBe(64);
	});
});

describe("createKeychainCredentialStore", () => {
	it("round-trips a credential through a simulated restart", async () => {
		const entries = new Map<string, string>();
		await put(createKeychainCredentialStore({ secrets: secretsOver(entries) }), "p1", OAUTH);
		// A second store over the same entries is what a relaunch looks like from
		// here: no shared memory, only what actually landed in the keychain.
		const reloaded = createKeychainCredentialStore({ secrets: secretsOver(entries) });
		expect(await reloaded.read("p1")).toEqual(OAUTH);
	});

	it("resolves undefined for a provider with nothing stored", async () => {
		const store = createKeychainCredentialStore({ secrets: secretsOver(new Map()) });
		expect(await store.read("p1")).toBeUndefined();
	});

	it("reads an unparseable entry as signed out, and says why", async () => {
		const entries = new Map([[credentialEntryId("p1"), "{not json"]]);
		const lines: string[] = [];
		const store = createKeychainCredentialStore({ secrets: secretsOver(entries), log: (line) => lines.push(line) });
		expect(await store.read("p1")).toBeUndefined();
		expect(lines.join("\n")).toContain("not valid JSON");
	});

	it("reads a credential missing its refresh token as signed out", async () => {
		// Not a stale credential — one that cannot be refreshed or turned into
		// request auth at all, so re-login is the only cure.
		const entries = new Map([
			[credentialEntryId("p1"), JSON.stringify({ providerId: "p1", credential: { type: "oauth", access: "at" } })],
		]);
		const store = createKeychainCredentialStore({ secrets: secretsOver(entries) });
		expect(await store.read("p1")).toBeUndefined();
	});

	it("refuses to hand one provider another's credential when their entry ids collide", async () => {
		// `credentialEntryId` folds, so two hand-edited provider ids can land on one
		// entry. The payload records its owner precisely so this reads as absent.
		const entries = new Map<string, string>();
		await put(createKeychainCredentialStore({ secrets: secretsOver(entries) }), "My_Provider", OAUTH);
		const store = createKeychainCredentialStore({ secrets: secretsOver(entries) });
		expect(await store.read("my-provider")).toBeUndefined();
		expect(await store.read("My_Provider")).toEqual(OAUTH);
	});
});

describe("modify", () => {
	it("leaves the entry alone when the mutation returns undefined", async () => {
		// pi's spelling for "another caller already rotated this"; writing here
		// would undo their work.
		const entries = new Map<string, string>();
		const store = createKeychainCredentialStore({ secrets: secretsOver(entries) });
		await put(store, "p1", OAUTH);
		const result = await store.modify("p1", async () => undefined);
		expect(result).toEqual(OAUTH);
		expect(await store.read("p1")).toEqual(OAUTH);
	});

	it("serializes two mutations so the second sees the first's write", async () => {
		const store = createKeychainCredentialStore({ secrets: secretsOver(new Map()) });
		const gate = deferred();
		const seen: (Credential | undefined)[] = [];
		const first = store.modify("p1", async (current) => {
			seen.push(current);
			await gate.promise;
			return OAUTH;
		});
		const second = store.modify("p1", async (current) => {
			seen.push(current);
			return { ...OAUTH, access: "at-2" };
		});
		gate.resolve();
		await Promise.all([first, second]);
		// The second mutation started only after the first had written, so it read
		// the stored credential rather than the empty state the first one saw.
		expect(seen).toEqual([undefined, OAUTH]);
	});

	it("refreshes once when two requests race a nearly-expired token", async () => {
		// pi's own double-checked pattern, run concurrently. Without the lock both
		// callers refresh and one rotation is immediately revoked upstream.
		const entries = new Map<string, string>();
		const store = createKeychainCredentialStore({ secrets: secretsOver(entries) });
		const stale: Credential = { type: "oauth", access: "at-old", refresh: "rt-old", expires: 0 };
		await put(store, "p1", stale);
		let refreshes = 0;
		const refresh = async (current: Credential | undefined): Promise<Credential | undefined> => {
			if (current?.type !== "oauth" || current.expires > Date.now()) {
				return undefined;
			}
			refreshes += 1;
			return { type: "oauth", access: `at-${refreshes}`, refresh: `rt-${refreshes}`, expires: Date.now() + 3_600_000 };
		};
		await Promise.all([store.modify("p1", refresh), store.modify("p1", refresh)]);
		expect(refreshes).toBe(1);
	});

	it("does not let one provider's slow mutation block another's", async () => {
		// The chain is per provider: a subscription mid-refresh must not stall a
		// read for an unrelated one.
		const store = createKeychainCredentialStore({ secrets: secretsOver(new Map()) });
		const gate = deferred();
		const slow = store.modify("p1", async () => {
			await gate.promise;
			return OAUTH;
		});
		expect(await store.modify("p2", async () => OAUTH)).toEqual(OAUTH);
		gate.resolve();
		await slow;
	});

	it("rejects when the keychain refuses the write rather than reporting a sign-in", async () => {
		// `Models.login()` treats a resolved modify as success, so swallowing this
		// is exactly how a panel claims a sign-in over an empty keychain.
		const store = createKeychainCredentialStore({ secrets: secretsOver(new Map(), { refuseWrites: true }) });
		await expect(store.modify("p1", async () => OAUTH)).rejects.toThrow("refused to store");
	});

	it("rejects on a device with no writable secret storage", async () => {
		const store = createKeychainCredentialStore({ secrets: secretsOver(new Map(), { available: false }) });
		await expect(store.modify("p1", async () => OAUTH)).rejects.toThrow(PLUGIN_SECRETS_UNAVAILABLE);
	});

	it("lets a rejection from the mutation through untouched", async () => {
		// pi wraps a failed OAuth refresh in its own `ModelsError`, keyed on the
		// cause reaching it.
		const store = createKeychainCredentialStore({ secrets: secretsOver(new Map()) });
		await expect(store.modify("p1", async () => {
			throw new Error("invalid_grant");
		})).rejects.toThrow("invalid_grant");
	});

	it("keeps serving later operations after one mutation fails", async () => {
		const store = createKeychainCredentialStore({ secrets: secretsOver(new Map()) });
		await expect(store.modify("p1", async () => {
			throw new Error("boom");
		})).rejects.toThrow("boom");
		expect(await store.modify("p1", async () => OAUTH)).toEqual(OAUTH);
	});
});

describe("delete", () => {
	it("removes the credential", async () => {
		const entries = new Map<string, string>();
		const store = createKeychainCredentialStore({ secrets: secretsOver(entries) });
		await put(store, "p1", OAUTH);
		await store.delete("p1");
		expect(await store.read("p1")).toBeUndefined();
		expect(entries.size).toBe(0);
	});

	it("treats an absent credential as already signed out", async () => {
		// Logout is idempotent by nature: the user asked to be signed out, and on a
		// store with nothing in it they are.
		const store = createKeychainCredentialStore({ secrets: secretsOver(new Map(), { refuseRemovals: true }) });
		await store.delete("p1");
	});

	it("rejects when the keychain refuses to remove a credential that is there", async () => {
		// The opposite of the case above, and the one that must not look like
		// success: a live refresh token surviving a sign-out is the failure.
		const entries = new Map<string, string>();
		await put(createKeychainCredentialStore({ secrets: secretsOver(entries) }), "p1", OAUTH);
		const store = createKeychainCredentialStore({ secrets: secretsOver(entries, { refuseRemovals: true }) });
		await expect(store.delete("p1")).rejects.toThrow("refused to remove");
	});
});

describe("list", () => {
	it("reports only this plugin's entries, naming the provider each belongs to", async () => {
		const entries = new Map<string, string>([["someones-api-key", "sk-live"]]);
		const store = createKeychainCredentialStore({ secrets: secretsOver(entries) });
		await put(store, "p1", OAUTH);
		await put(store, "p2", { type: "api_key", key: "sk-test" });
		expect((await store.list()).slice().sort((a, b) => a.providerId.localeCompare(b.providerId))).toEqual([
			{ providerId: "p1", type: "oauth" },
			{ providerId: "p2", type: "api_key" },
		]);
	});

	it("skips an entry it cannot read rather than failing the whole listing", async () => {
		const entries = new Map([[`${CREDENTIAL_ENTRY_PREFIX}broken`, "{not json"]]);
		const store = createKeychainCredentialStore({ secrets: secretsOver(entries) });
		expect(await store.list()).toEqual([]);
	});
});

describe("cancellation", () => {
	it("rejects a read, a mutation, and a removal on an already-aborted signal", async () => {
		const store = createKeychainCredentialStore({ secrets: secretsOver(new Map()) });
		const signal = AbortSignal.abort();
		await expect(store.read("p1", { signal })).rejects.toThrow();
		await expect(store.modify("p1", async () => OAUTH, { signal })).rejects.toThrow();
		await expect(store.delete("p1", { signal })).rejects.toThrow();
	});

	it("abandons a queued mutation aborted while it waited", async () => {
		// The wait can be a whole refresh round trip, so the signal has to be
		// re-checked inside the chain and not only at the door.
		const store = createKeychainCredentialStore({ secrets: secretsOver(new Map()) });
		const gate = deferred();
		const controller = new AbortController();
		const blocking = store.modify("p1", async () => {
			await gate.promise;
			return OAUTH;
		});
		let ran = false;
		const queued = store.modify("p1", async () => {
			ran = true;
			return { ...OAUTH, access: "at-2" };
		}, { signal: controller.signal });
		controller.abort();
		gate.resolve();
		await expect(queued).rejects.toThrow();
		await blocking;
		expect(ran).toBe(false);
	});
});
