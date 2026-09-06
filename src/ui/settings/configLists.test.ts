import { describe, expect, it } from "bun:test";
import type { ModelConfig, ProviderConfig } from "../../modelConfig";
import {
	describeModelDeletion,
	describeProviderDeletion,
	removeModel,
	removeProvider,
	replaceById,
	type ConfigLists,
} from "./configLists";
import { getT } from "../../i18n";

const en = getT("en");
const zh = getT("zh-cn");

/**
 * Deletion is the panel's only silently destructive path.
 *
 * A wrong successor after deleting the active model does not look like a bug:
 * the row vanishes as asked, and the next prompt quietly travels to a different
 * endpoint than the user configured. These cover that arithmetic.
 */

function provider(id: string, name = id): ProviderConfig {
	return { id, name, baseUrl: `https://${id}.test/v1`, protocol: "openai-completions", apiKey: "k", secretRef: "", source: "user", oauthFlow: "" };
}

function model(id: string, providerId: string): ModelConfig {
	return { id, providerId, modelApiId: `${id}-api`, displayName: id, reasoning: false, supportsImages: false };
}

function lists(overrides: Partial<ConfigLists> = {}): ConfigLists {
	return { providers: [], models: [], ...overrides };
}

describe("replaceById", () => {
	it("replaces in place, preserving order", () => {
		const list = [provider("a"), provider("b"), provider("c")];
		replaceById(list, { ...provider("b"), name: "renamed" });
		expect(list.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
		expect(list[1]?.name).toBe("renamed");
	});

	it("appends an entry that is not there yet", () => {
		// The edit modal is opened with a row that could have been deleted from
		// another panel in the meantime; appending beats dropping the user's edit.
		const list = [provider("a")];
		replaceById(list, provider("b"));
		expect(list.map((entry) => entry.id)).toEqual(["a", "b"]);
	});
});

describe("removeProvider", () => {
	it("takes the models it served with it", () => {
		const state = lists({
			providers: [provider("p1"), provider("p2")],
			models: [model("m1", "p1"), model("m2", "p2"), model("m3", "p1")],
		});
		removeProvider(state, "p1");
		expect(state.providers.map((entry) => entry.id)).toEqual(["p2"]);
		expect(state.models.map((entry) => entry.id)).toEqual(["m2"]);
	});

	it("moves the active selection to a survivor", () => {
		const state = lists({
			providers: [provider("p1"), provider("p2")],
			models: [model("m1", "p1"), model("m2", "p2")],
			activeModelId: "m1",
		});
		removeProvider(state, "p1");
		expect(state.activeModelId).toBe("m2");
	});

	it("leaves the active selection alone when it survives", () => {
		const state = lists({
			providers: [provider("p1"), provider("p2")],
			models: [model("m1", "p1"), model("m2", "p2")],
			activeModelId: "m2",
		});
		removeProvider(state, "p1");
		expect(state.activeModelId).toBe("m2");
	});

	it("clears the selection when nothing is left", () => {
		// An absent `activeModelId` is the signal that no configured model
		// applies, so it has to be deleted rather than left naming a dead row.
		const state = lists({ providers: [provider("p1")], models: [model("m1", "p1")], activeModelId: "m1" });
		removeProvider(state, "p1");
		expect(state.models).toEqual([]);
		expect("activeModelId" in state).toBe(false);
	});
});

describe("removeModel", () => {
	it("keeps the provider and the other models", () => {
		const state = lists({ providers: [provider("p1")], models: [model("m1", "p1"), model("m2", "p1")] });
		removeModel(state, "m1");
		expect(state.providers.map((entry) => entry.id)).toEqual(["p1"]);
		expect(state.models.map((entry) => entry.id)).toEqual(["m2"]);
	});

	it("reassigns the active model when it is the one deleted", () => {
		const state = lists({
			providers: [provider("p1")],
			models: [model("m1", "p1"), model("m2", "p1")],
			activeModelId: "m1",
		});
		removeModel(state, "m1");
		expect(state.activeModelId).toBe("m2");
	});

	it("leaves the active model alone when another is deleted", () => {
		const state = lists({
			providers: [provider("p1")],
			models: [model("m1", "p1"), model("m2", "p1")],
			activeModelId: "m1",
		});
		removeModel(state, "m2");
		expect(state.activeModelId).toBe("m1");
	});
});

describe("describeProviderDeletion", () => {
	it("names the models that go with it", () => {
		const lines = describeProviderDeletion([model("m1", "p1"), model("m2", "p1")], en);
		expect(lines[1]).toBe("The 2 models served by it are removed too: m1, m2.");
	});

	it("uses the singular for one model", () => {
		expect(describeProviderDeletion([model("m1", "p1")], en)[1]).toBe("The model served by it is removed too: m1.");
	});

	it("keeps the count and names when translated", () => {
		const lines = describeProviderDeletion([model("m1", "p1"), model("m2", "p1")], zh);
		expect(lines[1]).toBe("由它提供服务的 2 个模型也会被移除：m1, m2。");
	});

	it("says nothing about models when none are bound", () => {
		expect(describeProviderDeletion([], en)).toHaveLength(1);
	});
});

describe("describeModelDeletion", () => {
	it("names the successor when the active model is the one going", () => {
		const target = model("m1", "p1");
		const state = lists({ models: [target, model("m2", "p1")], activeModelId: "m1" });
		expect(describeModelDeletion(state, target, en)[1]).toBe("It is the default model, so m2 takes over when it goes.");
	});

	it("says nothing replaces it when the active model is the only one", () => {
		const target = model("m1", "p1");
		const state = lists({ models: [target], activeModelId: "m1" });
		expect(describeModelDeletion(state, target, en)[1]).toBe(
			"It is the only model, and nothing takes its place — add another before your next message.",
		);
	});

	it("stays quiet for an inactive model", () => {
		const target = model("m1", "p1");
		expect(describeModelDeletion(lists({ models: [target], activeModelId: "m2" }), target, en)).toHaveLength(1);
	});
});
