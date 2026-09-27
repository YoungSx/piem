import { describe, expect, it } from "bun:test";
import { activeModelName, modelChoiceLabel, modelSwitcherTitle, type ModelTarget } from "./modelSwitcherCopy";
import { getT } from "../i18n";

const en = getT("en");
const zh = getT("zh-cn");

const opus = { id: "m-opus", name: "Opus 5", provider: "OpenRouter", icon: "piem-vendor-anthropic" };
const sonnet = { id: "m-sonnet", name: "Sonnet 5", provider: "Anthropic", icon: "piem-vendor-anthropic" };

/**
 * The switcher's two strings, which answer to different readers.
 *
 * The button face is glanced at in a sidebar that may be 300px wide; the
 * accessible name is read aloud in full. So one carries the model alone and the
 * other carries the endpoint — the information the header's model line used to
 * hold, and the reason removing that line was not a loss.
 */
describe("activeModelName", () => {
	it("shows the user's own name for the model, not the id sent to the server", () => {
		// `modelApiId` is what the wire needs; `displayName` is what the user typed
		// so a panel never has to show `qwen-token-plan-individual`.
		expect(activeModelName(target())).toBe("Opus 5");
	});

	it("names the builtin model when nothing is configured, rather than going blank", () => {
		// Not an error state: the builtin pair still answers requests, and a
		// switcher that showed nothing would read as a broken control.
		expect(activeModelName(target({ modelChoices: [], activeModelId: undefined }))).toBe("deepseek-v4-pro");
	});

	it("falls back to the builtin model when the stored id names nothing", () => {
		// A dangling `activeModelId` sends requests to the builtin catalog, so the
		// label has to agree with where they actually go.
		expect(activeModelName(target({ activeModelId: "deleted" }))).toBe("deepseek-v4-pro");
	});

	it("never translates the name, in either language", () => {
		expect(activeModelName(target({ activeModelId: sonnet.id }))).toBe("Sonnet 5");
	});
});

describe("modelSwitcherTitle", () => {
	it("leads with the verb, so the control announces that it can be changed", () => {
		// A name that is only the current value tells a screen reader user what the
		// panel is set to and not that they may set it — which is the whole point
		// of moving this out of the header.
		expect(modelSwitcherTitle(target(), en)).toBe("Switch model · Opus 5 · OpenRouter");
	});

	it("names the builtin pair the way the plugin's error messages do", () => {
		// `describeModelTarget` joins an unconfigured target with a slash; a
		// different join here would have the panel and the banner disagree about
		// what the user is talking to.
		expect(modelSwitcherTitle(target({ modelChoices: [], activeModelId: undefined }), en)).toBe(
			"Switch model · deepseek/deepseek-v4-pro",
		);
	});

	it("translates the verb, never the model or the endpoint", () => {
		expect(modelSwitcherTitle(target(), zh)).toBe("切换模型 · Opus 5 · OpenRouter");
	});
});

describe("modelChoiceLabel", () => {
	it("carries the endpoint even when only one is configured", () => {
		// Two providers can serve the same model, and a row whose shape changes the
		// moment a second provider is added is worse than a slightly longer line.
		expect(modelChoiceLabel(opus, en)).toBe("Opus 5 · OpenRouter");
	});

	it("says nothing about being active, which the menu marks with a check", () => {
		expect(modelChoiceLabel(opus, en)).not.toContain("active");
		expect(modelChoiceLabel(opus, zh)).not.toContain("当前");
	});

	it("drops the suffix rather than trailing a separator when the provider is gone", () => {
		expect(modelChoiceLabel({ ...opus, provider: "" }, en)).toBe("Opus 5");
	});
});

function target(overrides: Partial<ModelTarget> = {}): ModelTarget {
	return {
		modelChoices: [opus, sonnet],
		activeModelId: opus.id,
		// The resolved pair behind a *configured* model is the provider's uuid and
		// the raw api id, so these values stand for the builtin fallback only —
		// which is the one case the switcher reads them in.
		provider: "deepseek",
		modelId: "deepseek-v4-pro",
		...overrides,
	};
}
