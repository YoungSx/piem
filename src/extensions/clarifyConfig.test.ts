import { describe, expect, it } from "bun:test";
import { installObsidianStub } from "../testUtils/obsidianStub";
import type { PiemSettings } from "../settings";

// `settings.ts` imports `obsidian`, and both the projection and the normalizer
// below reach it; register the stub before either import.
installObsidianStub();
const { clarifyModelProjection } = await import("./clarifyConfig");
const { normalizeSettings } = await import("../settings");

/**
 * Settings holding one credentialed provider with two models, plus a third
 * model whose provider has no key — the case upstream would happily pin and
 * this host must refuse.
 */
function settingsWith(pinned?: string): PiemSettings {
	return normalizeSettings({
		providers: [
			{ id: "research", name: "Research", baseUrl: "https://research.test/v1", protocol: "openai-responses", apiKey: "research-key", secretRef: "", source: "user", oauthFlow: "" },
			{ id: "keyless", name: "Keyless", baseUrl: "https://keyless.test/v1", protocol: "openai-completions", apiKey: "", secretRef: "", source: "user", oauthFlow: "" },
		],
		models: [
			{ id: "alpha", providerId: "research", modelApiId: "alpha", displayName: "Alpha", reasoning: false, supportsImages: false },
			{ id: "beta", providerId: "research", modelApiId: "beta", displayName: "Beta", reasoning: false, supportsImages: false },
			{ id: "orphan", providerId: "keyless", modelApiId: "orphan", displayName: "Orphan", reasoning: false, supportsImages: false },
		],
		clarifyModelId: pinned,
	} as Partial<PiemSettings>);
}

function host(pinned?: string) {
	const state = { settings: settingsWith(pinned) };
	let fail: Error | undefined;
	const saves: Array<string | undefined> = [];
	const projection = clarifyModelProjection({
		getSettings: () => state.settings,
		persist: async () => {
			if (fail) throw fail;
			saves.push(state.settings.clarifyModelId);
		},
		assertOwner: () => {},
	});
	return {
		projection, saves,
		get pinnedId() { return state.settings.clarifyModelId; },
		breakSaving: (error: Error) => { fail = error; },
		/** What a fresh plugin load would restore from the saved value. */
		restart: () => normalizeSettings({ ...settingsWith(state.settings.clarifyModelId) }).clarifyModelId,
	};
}

describe("clarify model projection", () => {
	it("reads the pinned choice as upstream's own config file", () => {
		expect(host("beta").projection.read()).toBe('{"provider":"research","model":"beta"}');
		expect(host().projection.read()).toBeUndefined();
		// A pin whose provider lost its credential still reports the pair, so
		// upstream can name it in "Clarify model not found: keyless/orphan".
		// Returning undefined would be indistinguishable from never pinning one,
		// and the rewrite would quietly fall back to the session model instead.
		expect(host("orphan").projection.read()).toBe('{"provider":"keyless","model":"orphan"}');
	});

	it("pins only a configured, credentialed model", async () => {
		const owner = host();
		await owner.projection.write('{"provider":"research","model":"beta"}');
		expect(owner.pinnedId).toBe("beta");
		expect(owner.restart()).toBe("beta");
		expect(owner.projection.read()).toBe('{"provider":"research","model":"beta"}');
		// Upstream writes any pair its registry can name; this host refuses one
		// that is not configured with credentials instead of storing it.
		for (const text of ['{"provider":"research","model":"missing"}', '{"provider":"keyless","model":"orphan"}', '{"provider":"other","model":"beta"}']) {
			await expect(owner.projection.write(text)).rejects.toThrow("Not a configured model with credentials");
		}
		for (const text of ["{}", '{"provider":"research"}', '{"model":"beta"}', '{"provider":5,"model":"beta"}']) {
			await expect(owner.projection.write(text)).rejects.toThrow("needs provider and model names");
		}
		await expect(owner.projection.write("not json")).rejects.toThrow();
		// Every refusal left the previous pin in place.
		expect(owner.pinnedId).toBe("beta");
	});

	it("clears the pin and skips a write that would change nothing", async () => {
		const owner = host("beta");
		const before = owner.saves.length;
		await owner.projection.write('{"provider":"research","model":"beta"}');
		expect(owner.saves.length).toBe(before);
		await owner.projection.write(undefined);
		expect(owner.pinnedId).toBeUndefined();
		expect(owner.restart()).toBeUndefined();
		const cleared = owner.saves.length;
		await owner.projection.write(undefined);
		expect(owner.saves.length).toBe(cleared);
	});

	it("restores the previous pin when the settings write is rejected", async () => {
		const owner = host("alpha");
		owner.breakSaving(new Error("Vault is read-only"));
		await expect(owner.projection.write('{"provider":"research","model":"beta"}')).rejects.toThrow("Vault is read-only");
		expect(owner.pinnedId).toBe("alpha");
		expect(owner.restart()).toBe("alpha");
		await expect(owner.projection.write(undefined)).rejects.toThrow("Vault is read-only");
		expect(owner.pinnedId).toBe("alpha");
	});

	it("refuses to write once a newer host owns the conversation", async () => {
		const state = { settings: settingsWith("alpha") };
		const projection = clarifyModelProjection({
			getSettings: () => state.settings,
			persist: async () => { throw new Error("Should not persist"); },
			assertOwner: () => { throw new Error("Extension session is no longer available."); },
		});
		await expect(projection.write('{"provider":"research","model":"beta"}')).rejects.toThrow("no longer available");
		expect(state.settings.clarifyModelId).toBe("alpha");
	});
});
