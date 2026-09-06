import { describe, expect, it } from "bun:test";
import { installDom } from "../../testUtils/dom";
import { installObsidianDomHelpers } from "../../testUtils/obsidianDom";
import { installObsidianStub } from "../../testUtils/obsidianStub";
import { getT } from "../../i18n";

installDom();
installObsidianDomHelpers();
installObsidianStub();

const { modelsDefinitions } = await import("./modelsDefinitions");
import type { SettingsPanelHost } from "./panelHost";

const en = getT("en");

function host(overrides: Partial<SettingsPanelHost> = {}): SettingsPanelHost {
	return {
		app: {} as SettingsPanelHost["app"],
		settings: {
			providers: [], models: [], networkTransport: "requestUrl", cacheRetention: "long", showAgentDetails: false, traceExpand: "collapsed",
			promptQueueStrategy: "afterRun",
			sendShortcut: "enter", language: "en", sessionRetention: 0, sessionDir: "piem/chats",
			userSkillsDir: "", mcpServers: [], logLevel: "info",
		},
		save: async () => {}, refresh: () => {}, secretStorage: "manual", readSecret: () => "", signIn: undefined,
		describeTarget: () => "target", t: en, contextWindow: () => 128_000,
		countStoredSessions: async () => 0, missingBuiltinModel: () => undefined,
		activeSessionDir: () => "piem/chats", openLogView: () => {}, countLegacySessions: async () => ({ count: 0, dir: "" }),
		manifest: { version: "1.0.4" },
		skills: {
			list: async () => ({ rows: [] }) as unknown as Awaited<ReturnType<SettingsPanelHost["skills"]["list"]>>,
			fetchSource: async () => ({}) as Awaited<ReturnType<SettingsPanelHost["skills"]["fetchSource"]>>,
			install: async () => {}, update: async () => ({}) as Awaited<ReturnType<SettingsPanelHost["skills"]["update"]>>,
			remove: async () => {}, refreshAgent: async () => {},
			lastSkillLoad: () => ({ vault: [], user: { skills: [], searched: [], diagnostics: [] } }) as unknown as ReturnType<SettingsPanelHost["skills"]["lastSkillLoad"]>,
			userSkillsAvailable: false,
		},
		mcp: { states: () => [], test: async () => 0, reconnect: async () => undefined },
		...overrides,
	};
}

describe("modelsDefinitions", () => {
	it("exposes provider and model collections as mutable lists", () => {
		const settings = host().settings;
		settings.providers.push({ id: "p", name: "Provider", baseUrl: "https://example.test", protocol: "openai-completions", apiKey: "", secretRef: "", source: "user", oauthFlow: "" });
		settings.models.push({ id: "m", providerId: "p", modelApiId: "model", displayName: "Model", reasoning: false, supportsImages: false });
		const defs = modelsDefinitions(host({ settings }));
		const lists = defs.filter((def) => (def as { type?: string }).type === "list") as Array<{
			heading?: string;
			items?: Array<{ name?: string }>;
			search?: unknown;
		}>;

		expect(lists.map((list) => list.heading)).toEqual([en.t("settings.providersHeading"), en.t("settings.modelsHeading")]);
		// Matched by name rather than counted: each list also carries its section
		// note, and a count would break on copy rather than on a missing row.
		expect(lists[1]?.items?.map((item) => item.name)).toContain("Model");
		// One model is below the threshold, so no search input: a box over a single
		// row costs more attention than it saves.
		expect(lists[1]?.search).toBeUndefined();
	});

	it("offers the list's own search once the models outgrow a glance", () => {
		const settings = host().settings;
		settings.providers.push({ id: "p", name: "Provider", baseUrl: "https://example.test", protocol: "openai-completions", apiKey: "", secretRef: "", source: "user", oauthFlow: "" });
		for (let i = 0; i < 8; i++) {
			settings.models.push({ id: `m${i}`, providerId: "p", modelApiId: `model-${i}`, displayName: `Model ${i}`, reasoning: false, supportsImages: false });
		}
		const models = modelsDefinitions(host({ settings })).find((def) => (def as { heading?: string }).heading === en.t("settings.modelsHeading")) as {
			search?: { match(definition: { name: string; desc?: string }, query: string): boolean };
		};

		// The framework owns the query and reapplies it after each render, which is
		// what replaced writing it into a DOM attribute and reading it back before a
		// rebuild.
		expect(models.search).toBeDefined();
		expect(models.search?.match({ name: "Model 3", desc: "openai · Provider" }, "MODEL 3")).toBe(true);
		// Matched against the description too, so a reader can filter by the provider
		// a model rides on rather than only by its name.
		expect(models.search?.match({ name: "Model 3", desc: "openai · Provider" }, "provider")).toBe(true);
		expect(models.search?.match({ name: "Model 3", desc: "openai · Provider" }, "anthropic")).toBe(false);
	});

	it("binds the prompt-cache row to the setting, with every level pi accepts", () => {
		// The declarative `key` is a bare string Obsidian does not check against the
		// settings object, so a typo here renders a working-looking dropdown that
		// writes nowhere — see `controlKeys`. The option keys matter for the same
		// reason in the other direction: they are the values written, so one that is
		// not a `CacheRetention` would be silently refused on selection.
		const network = modelsDefinitions(host()).find(
			(def) => (def as { heading?: string }).heading === en.t("settings.networkHeading"),
		) as { items?: Array<{ name?: string; control?: { type?: string; key?: string; options?: Record<string, string> } }> };
		const row = network.items?.find((item) => item.name === en.t("settings.cacheRetention"));

		expect(row?.control).toMatchObject({ type: "dropdown", key: "cacheRetention" });
		expect(Object.keys(row?.control?.options ?? {})).toEqual(["long", "short", "none"]);
	});

	it("does not probe live target state while definitions are indexed", () => {
		let reads = 0;
		modelsDefinitions(host({ describeTarget: () => { reads++; return "target"; } }));
		expect(reads).toBe(0);
	});

	it("keeps active-model changes local so its dropdown does not lose focus", () => {
		const settings = host().settings;
		settings.providers.push({ id: "p", name: "Provider", baseUrl: "https://example.test", protocol: "openai-completions", apiKey: "", secretRef: "", source: "user", oauthFlow: "" });
		settings.models.push(
			{ id: "m1", providerId: "p", modelApiId: "one", displayName: "One", reasoning: false, supportsImages: false },
			{ id: "m2", providerId: "p", modelApiId: "two", displayName: "Two", reasoning: false, supportsImages: false },
		);
		const current = host({ settings });
		const defs = modelsDefinitions(current);
		const active = defs.find((def) => (def as { name?: string }).name === en.t("settings.activeModelHeading")) as { render?: unknown; control?: unknown };
		expect(active.render).toBeFunction();
		// The handler is deliberately a render escape hatch, not a control: its
		// job is to update the status and model suffixes without rebuilding focus.
		expect(active.control).toBeUndefined();
	});
});
