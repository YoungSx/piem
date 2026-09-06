/**
 * The two views the keychain adapter cuts out of one host store.
 *
 * The read-only {@link Keychain} and the writable {@link PluginSecretStore}
 * answer different questions about the same `app.secretStorage`, and the cases
 * that matter are the ones where those answers differ: a host readable but
 * missing the write members, a write the host refuses outright, and a write it
 * accepts and then loses. The last is the only thing a read-back can catch, so
 * it is the case that says whether the confirmation is doing any work.
 */

import { describe, expect, it } from "bun:test";
import { SecretStorageMock } from "./testUtils/obsidianStub";
import {
	createObsidianKeychain,
	createObsidianPluginSecrets,
	wrapPluginSecretStorage,
} from "./obsidianKeychain";

describe("createObsidianPluginSecrets", () => {
	it("is unavailable on a host with no secret storage at all", () => {
		const secrets = createObsidianPluginSecrets({});
		expect(secrets.available).toBe(false);
		expect(secrets.write("piem-oauth-a", "value")).toBe(false);
		expect(secrets.read("piem-oauth-a")).toBe("");
		expect(secrets.list()).toEqual([]);
	});

	it("is unavailable on a host that reads but cannot write, while the keychain still works", () => {
		// The asymmetry the sign-in gate exists for: an Obsidian old enough to
		// resolve an API-key binding but without the members a plugin-owned entry
		// needs. Neither view may be decided by the other's probe.
		const store = new SecretStorageMock({ "my-key": "sk-live" });
		const host = store.asReadOnlyHost();
		expect(createObsidianKeychain(host).read("my-key")).toBe("sk-live");
		expect(createObsidianPluginSecrets(host).available).toBe(false);
	});

	it("reports why it is unavailable", () => {
		const lines: string[] = [];
		createObsidianPluginSecrets(new SecretStorageMock().asReadOnlyHost(), { log: (line) => lines.push(line) });
		expect(lines.join("\n")).toContain("no writable secret storage");
	});

	it("is available on a host with the full surface", () => {
		const secrets = createObsidianPluginSecrets(new SecretStorageMock().asHost());
		expect(secrets.available).toBe(true);
	});
});

describe("wrapPluginSecretStorage", () => {
	it("round-trips a written value", () => {
		const store = new SecretStorageMock();
		const secrets = wrapPluginSecretStorage(store);
		expect(secrets.write("piem-oauth-abc", "payload")).toBe(true);
		expect(secrets.read("piem-oauth-abc")).toBe("payload");
		expect(store.entries.get("piem-oauth-abc")).toBe("payload");
	});

	it("reports false when the host refuses the write, and says why", () => {
		const store = new SecretStorageMock();
		store.throwOnWrite = true;
		const lines: string[] = [];
		const secrets = wrapPluginSecretStorage(store, (line) => lines.push(line));
		expect(secrets.write("piem-oauth-abc", "payload")).toBe(false);
		expect(lines.join("\n")).toContain("refused the write");
	});

	it("reports false for an id the host rejects", () => {
		// `setSecret` throws on a malformed id rather than returning, so the caller
		// only learns of it through this path.
		const secrets = wrapPluginSecretStorage(new SecretStorageMock());
		expect(secrets.write("Piem_OAuth", "payload")).toBe(false);
	});

	it("catches a write the host accepts and drops", () => {
		// The one failure the read-back can actually see. Without it this returns
		// true and the panel reports a sign-in that stored nothing.
		const store = new SecretStorageMock();
		store.dropWrites = true;
		const secrets = wrapPluginSecretStorage(store);
		expect(secrets.write("piem-oauth-abc", "payload")).toBe(false);
		expect(store.writeCalls).toEqual([{ id: "piem-oauth-abc", value: "payload" }]);
	});

	it("removes an entry, and reports an absent one as not removed", () => {
		const store = new SecretStorageMock({ "piem-oauth-abc": "payload" });
		const secrets = wrapPluginSecretStorage(store);
		expect(secrets.remove("piem-oauth-abc")).toBe(true);
		expect(store.entries.has("piem-oauth-abc")).toBe(false);
		expect(secrets.remove("piem-oauth-abc")).toBe(false);
	});

	it("degrades a throwing removal to false", () => {
		const store = new SecretStorageMock({ "piem-oauth-abc": "payload" });
		store.throwOnDelete = true;
		const secrets = wrapPluginSecretStorage(store);
		expect(secrets.remove("piem-oauth-abc")).toBe(false);
	});

	it("degrades a throwing read and a throwing list to empty answers", () => {
		const store = new SecretStorageMock({ "piem-oauth-abc": "payload" });
		store.throwOnRead = true;
		store.throwOnList = true;
		const secrets = wrapPluginSecretStorage(store);
		expect(secrets.read("piem-oauth-abc")).toBe("");
		expect(secrets.list()).toEqual([]);
	});

	it("lists every id the host holds, ours and everyone else's", () => {
		// Unfiltered on purpose: the credential layer owns the prefix, so it is the
		// only thing that knows what to filter for.
		const store = new SecretStorageMock({ "piem-oauth-abc": "a", "someones-key": "b" });
		expect(wrapPluginSecretStorage(store).list().sort()).toEqual(["piem-oauth-abc", "someones-key"]);
	});
});
