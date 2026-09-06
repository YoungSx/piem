import { describe, expect, it } from "bun:test";
import { installObsidianStub } from "../testUtils/obsidianStub";
import {
	CUSTOM_PRESET_ID,
	PROVIDER_PRESETS,
	applyProviderPreset,
	findProviderPreset,
	matchProviderPreset,
	providerPresetLabel,
} from "./providerPresets";
import { matchVendorByHost } from "./vendorMatch";
import { emptyProviderConfig, type ProviderConfig } from "../modelConfig";
import { getT } from "../i18n";

// `ProviderModal` extends Obsidian's `Modal` at module scope, so the stub has to
// be registered before the import below resolves. The validator is reached
// through it deliberately: a preset that the form itself would reject is the one
// defect a table of literals can still have, and only the real rule catches it.
installObsidianStub();
const { validateProviderDraft } = await import("../ui/settings/ProviderModal");

const t = getT("en");

/**
 * A preset is a filled-in form, so these tests are mostly about the fill being
 * one the form would have accepted, and about the dropdown telling the truth
 * afterwards.
 *
 * The table's real failure mode is not a crash: a wrong path segment or a
 * protocol the vendor does not serve produces a row that saves, looks correct,
 * and fails only when the user finally sends a message — by which point the
 * error points at their key. So the shape invariants below are deliberately
 * pedantic about the seam that cannot be tested without a credential: how
 * `buildRequestUrl` will concatenate each base.
 */
describe("provider presets", () => {
	it("offers a usable form fill for every entry", () => {
		for (const preset of PROVIDER_PRESETS) {
			const draft: ProviderConfig = { ...emptyProviderConfig(), baseUrl: preset.baseUrl, protocol: preset.protocol };

			expect(validateProviderDraft(draft, t)).toBeUndefined();
		}
	});

	it("keeps ids and configurations unique, so the dropdown cannot shadow a row", () => {
		const ids = PROVIDER_PRESETS.map((preset) => preset.id);
		// The endpoint alone is no longer the identity: xAI's key row and its
		// subscription row are the same host and protocol, and the sign-in is what
		// separates them. Two entries agreeing on all three would make
		// `matchProviderPreset` pick whichever came first and relabel the other.
		const configurations = PROVIDER_PRESETS.map(
			(preset) => `${preset.protocol} ${preset.baseUrl} ${preset.oauthFlow ?? ""}`,
		);

		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(configurations).size).toBe(configurations.length);
		// The custom row's value must not collide with a real preset's.
		expect(ids).not.toContain(CUSTOM_PRESET_ID);
	});

	it("gives every entry a distinct label, since the label is all the user sees", () => {
		const labels = PROVIDER_PRESETS.map(providerPresetLabel);

		expect(new Set(labels).size).toBe(labels.length);
		expect(providerPresetLabel(findProviderPreset("anthropic")!)).toBe("Anthropic · api.anthropic.com");
	});

	it("stops an Anthropic base from ending at the version the shim appends", () => {
		// `anthropicSdk` posts to `${baseURL}/v1/messages`. A base ending in `/v1`
		// therefore asks for `/v1/v1/messages`, which 404s — and 404 from a vendor
		// host reads as "wrong model" far more easily than "wrong base URL".
		for (const preset of PROVIDER_PRESETS.filter((entry) => entry.protocol === "anthropic-messages")) {
			expect(preset.baseUrl.endsWith("/v1")).toBe(false);
		}
	});

	it("stops any base from already carrying the request path", () => {
		// The shims concatenate, so a base pasted straight from a curl example
		// would double the path. Cheap to assert, and the symptom is otherwise a
		// bare 404 with no hint at which field is wrong.
		for (const preset of PROVIDER_PRESETS) {
			expect(preset.baseUrl).not.toContain("/chat/completions");
			expect(preset.baseUrl).not.toContain("/responses");
			expect(preset.baseUrl).not.toContain("/v1/messages");
			expect(preset.baseUrl.endsWith("/")).toBe(false);
		}
	});

	it("marks every preset host as official, so a picked preset wears its vendor icon", () => {
		for (const preset of PROVIDER_PRESETS) {
			expect(matchVendorByHost(preset.baseUrl)).toBeDefined();
		}
	});
});

/**
 * What the dropdown reads off a draft.
 *
 * This is the half that can lie: the selection is derived, not stored, so a
 * loose comparison would show "OpenRouter" over a form that no longer holds
 * OpenRouter's configuration — and the user would trust the label over the
 * fields.
 */
describe("matchProviderPreset", () => {
	it("recognizes each preset from its own values", () => {
		for (const preset of PROVIDER_PRESETS) {
			expect(matchProviderPreset({ ...preset, oauthFlow: preset.oauthFlow ?? "" })?.id).toBe(preset.id);
		}
	});

	it("requires the protocol to agree, not just the URL", () => {
		// Same endpoint, different wire format: a different configuration, and one
		// that would fail at send time. The dropdown must not claim the preset.
		expect(matchProviderPreset({ baseUrl: "https://openrouter.ai/api/v1", protocol: "anthropic-messages", oauthFlow: "" })).toBeUndefined();
	});

	it("forgives a trailing slash and host case, which reach the same server", () => {
		expect(matchProviderPreset({ baseUrl: "https://openrouter.ai/api/v1/", protocol: "openai-completions", oauthFlow: "" })?.id).toBe("openrouter");
		expect(matchProviderPreset({ baseUrl: "https://OpenRouter.ai/api/v1", protocol: "openai-completions", oauthFlow: "" })?.id).toBe("openrouter");
	});

	it("does not forgive path case, which does not", () => {
		// `/API/V1` is a different path to the server, and one it rejects. Reporting
		// it as the preset would hide a typo behind a confident label.
		expect(matchProviderPreset({ baseUrl: "https://openrouter.ai/API/V1", protocol: "openai-completions", oauthFlow: "" })).toBeUndefined();
	});

	it("answers nothing for a blank or unparseable URL rather than throwing", () => {
		expect(matchProviderPreset({ baseUrl: "", protocol: "openai-completions", oauthFlow: "" })).toBeUndefined();
		expect(matchProviderPreset({ baseUrl: "   ", protocol: "openai-completions", oauthFlow: "" })).toBeUndefined();
		expect(matchProviderPreset({ baseUrl: "api.openai.com/v1", protocol: "openai-completions", oauthFlow: "" })).toBeUndefined();
	});

	it("keeps a hand-typed gateway custom", () => {
		expect(matchProviderPreset({ baseUrl: "https://my-gateway.example.com/v1", protocol: "openai-completions", oauthFlow: "" })).toBeUndefined();
	});

	it("tells two presets apart when only the sign-in differs", () => {
		// xAI serves the same host and protocol to a pasted key and to a Grok
		// subscription. Without the sign-in in the key, whichever entry came first
		// in the table would claim both rows and silently relabel the other.
		const key = { baseUrl: "https://api.x.ai/v1", protocol: "openai-responses" } as const;
		expect(matchProviderPreset({ ...key, oauthFlow: "" })?.id).toBe("xai");
		expect(matchProviderPreset({ ...key, oauthFlow: "xai" })?.id).toBe("xai-subscription");
	});

	it("keeps a row custom when it names a sign-in no preset uses at that endpoint", () => {
		expect(
			matchProviderPreset({ baseUrl: "https://api.x.ai/v1", protocol: "openai-responses", oauthFlow: "kimi-coding" }),
		).toBeUndefined();
	});
});

describe("applyProviderPreset", () => {
	const preset = findProviderPreset("openrouter");

	it("resolves by dropdown value, and treats the custom row as no preset", () => {
		expect(preset?.name).toBe("OpenRouter");
		expect(findProviderPreset(CUSTOM_PRESET_ID)).toBeUndefined();
		expect(findProviderPreset("not-a-preset")).toBeUndefined();
	});

	it("fills a blank form", () => {
		const applied = applyProviderPreset(emptyProviderConfig(), preset!);

		expect(applied.name).toBe("OpenRouter");
		expect(applied.baseUrl).toBe("https://openrouter.ai/api/v1");
		expect(applied.protocol).toBe("openai-completions");
	});

	it("switches every owned field when the preset changes", () => {
		const anthropic = applyProviderPreset(emptyProviderConfig(), findProviderPreset("anthropic")!);
		const switched = applyProviderPreset(anthropic, preset!);

		expect(switched.name).toBe("OpenRouter");
		expect(switched.baseUrl).toBe("https://openrouter.ai/api/v1");
		expect(switched.protocol).toBe("openai-completions");
	});

	it("takes over a name the user wrote, because a preset owns it", () => {
		// The form hides the name row while a preset is selected, so there is no
		// user value to protect here — keeping "Work account" over OpenRouter's
		// endpoint would leave a label nobody could correct without switching to
		// Custom, which is exactly what someone who wants their own name does.
		const own: ProviderConfig = { ...emptyProviderConfig(), name: "Work account" };

		expect(applyProviderPreset(own, preset!).name).toBe("OpenRouter");
	});

	it("leaves the credential alone", () => {
		// A stray dropdown change must not throw away a pasted key: the connection
		// test reports the mismatch immediately, and the field is right there.
		const withKey: ProviderConfig = { ...emptyProviderConfig(), apiKey: "sk-typed", secretRef: "" };
		const applied = applyProviderPreset(withKey, preset!);

		expect(applied.apiKey).toBe("sk-typed");
		expect(applied.id).toBe(withKey.id);
		expect(applied.source).toBe("user");
	});

	it("writes the sign-in a subscription preset owns", () => {
		const applied = applyProviderPreset(emptyProviderConfig(), findProviderPreset("kimi-coding")!);

		expect(applied.oauthFlow).toBe("kimi-coding");
		expect(applied.baseUrl).toBe("https://api.kimi.com/coding");
		expect(applied.protocol).toBe("anthropic-messages");
	});

	it("clears the sign-in when switching to a preset that takes a key", () => {
		// The dangerous direction. A leftover sign-in would leave a row that ignores
		// the key the user is about to paste — the same class of lie as a stale base
		// URL, and harder to spot because nothing on the form would say so.
		const subscription = applyProviderPreset(emptyProviderConfig(), findProviderPreset("xai-subscription")!);
		expect(subscription.oauthFlow).toBe("xai");

		expect(applyProviderPreset(subscription, findProviderPreset("xai")!).oauthFlow).toBe("");
	});

	it("leaves a leftover key harmless on a subscription row", () => {
		// Deliberately not cleared, for the same reason as above — and safe, because
		// the provider a signed-in row produces advertises no api-key auth at all,
		// so there is nothing that could send it.
		const withKey: ProviderConfig = { ...emptyProviderConfig(), apiKey: "sk-typed" };
		const applied = applyProviderPreset(withKey, findProviderPreset("xai-subscription")!);

		expect(applied.apiKey).toBe("sk-typed");
		expect(applied.oauthFlow).toBe("xai");
	});
});
