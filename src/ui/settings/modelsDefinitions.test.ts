import { describe, expect, it } from "bun:test";
import { installDom } from "../../testUtils/dom";
import { installObsidianDomHelpers } from "../../testUtils/obsidianDom";
import { installObsidianStub } from "../../testUtils/obsidianStub";
import { getT } from "../../i18n";
import { NOOP_LOGGER } from "../../logging/Logger";
import { spyLogger } from "../../testUtils/logSpy";

installDom();
installObsidianDomHelpers();
installObsidianStub();

const { modelsDefinitions, logConnectionTest } = await import("./modelsDefinitions");
const { Setting } = await import("obsidian");
import type { SettingsPanelHost } from "./panelHost";

const en = getT("en");

function host(overrides: Partial<SettingsPanelHost> = {}): SettingsPanelHost {
	return {
		app: {} as SettingsPanelHost["app"],
		settings: {
			providers: [], models: [], networkTransport: "requestUrl", cacheRetention: "long", showAgentDetails: false, traceExpand: "collapsed",
			promptQueueStrategy: "afterRun",
			sendShortcut: "enter", language: "en", sessionRetention: 0, sessionDir: "piem/chats",
			userSkillsDir: "", disabledSkills: [], mcpServers: [], logLevel: "info",
		},
		save: async () => {}, refresh: () => {}, secretStorage: "manual", readSecret: () => "", signIn: undefined,
		logger: NOOP_LOGGER,
		describeTarget: () => "target", t: en, contextWindow: () => 128_000,
		countStoredSessions: async () => 0, missingBuiltinModel: () => undefined,
		activeSessionDir: () => "piem/chats", openLogView: () => {}, countLegacySessions: async () => ({ count: 0, dir: "" }),
		manifest: { version: "1.0.4" },
		skills: {
			list: async () => ({ rows: [] }) as unknown as Awaited<ReturnType<SettingsPanelHost["skills"]["list"]>>,
			catalog: () => [],
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

	/**
	 * Deleting a signed-in subscription row is the one deletion that touches the
	 * keychain: the stored credential is the plugin's own entry and outlives the
	 * row unless confirm signs it out first. The dialog also probes the sign-in
	 * state before opening (the sign-in button's pattern), so the copy names what
	 * confirm will actually do — asserted here through the echoed key.
	 */
	it("signs an OAuth row out before removing it on confirmed delete", async () => {
		const settings = host().settings;
		settings.providers.push({ id: "p-sub", name: "Sub", baseUrl: "https://sub.test", protocol: "openai-completions", apiKey: "", secretRef: "", source: "user", oauthFlow: "xai" });
		settings.models.push({ id: "m", providerId: "p-sub", modelApiId: "model", displayName: "Model", reasoning: false, supportsImages: false });
		let signOuts = 0;
		let saves = 0;
		const signIn = {
			canStore: () => true,
			actionsFor: (target: { flowId: string }) =>
				target.flowId
					? { method: "xAI", isSignedIn: async () => true, signIn: async () => {}, signOut: async () => { signOuts += 1; } }
					: undefined,
		};
		const current = host({
			settings,
			signIn: signIn as unknown as SettingsPanelHost["signIn"],
			save: async () => { saves += 1; },
		});
		const list = modelsDefinitions(current).find(
			(def) => (def as { heading?: string }).heading === en.t("settings.providersHeading"),
		) as { items?: Array<{ render?: (setting: unknown) => void }> };
		const setting = new (Setting as unknown as new (el: HTMLElement) => { extraButtons: Array<{ icon?: string; onClickHandler?: () => unknown }> })(document.createElement("div"));
		list.items?.[1]?.render?.(setting);
		const trash = setting.extraButtons.find((button) => button.icon === "trash-2");
		trash?.onClickHandler?.();
		await Promise.resolve();
		// The probe resolved before the dialog opened, and the copy names the
		// sign-out the confirm will perform.
		const shell = document.body.lastElementChild as HTMLElement;
		expect(shell.textContent).toContain(en.t("deletion.providerOauthSignOut"));
		const confirm = Array.from(shell.querySelectorAll("button")).at(-1) as HTMLButtonElement;
		confirm.click();
		await Promise.resolve();
		await Promise.resolve();
		expect(signOuts).toBe(1);
		expect(settings.providers).toHaveLength(0);
		expect(settings.models).toHaveLength(0);
		expect(saves).toBe(1);
	});

	it("draws the sign-in button only on a subscription row, key rows keep one door to their key", async () => {
		const settings = host().settings;
		settings.providers.push(
			{ id: "p-sub", name: "Sub", baseUrl: "https://sub.test", protocol: "openai-completions", apiKey: "", secretRef: "", source: "user", oauthFlow: "xai" },
			{ id: "p-key", name: "Key", baseUrl: "https://key.test", protocol: "openai-completions", apiKey: "", secretRef: "", source: "user", oauthFlow: "" },
		);
		// A minimal stand-in: this test pins where the button is drawn, not what the
		// session does — `signInSession.test.ts` owns that. What `actionsFor` accepts
		// mirrors the facade's own contract for one known flow.
		const signIn = {
			canStore: () => true,
			actionsFor: (target: { flowId: string }) =>
				target.flowId
					? { method: "xAI", isSignedIn: async () => false, signIn: async () => {}, signOut: async () => {} }
					: undefined,
		};
		const defs = modelsDefinitions(host({ settings, signIn: signIn as unknown as SettingsPanelHost["signIn"] }));
		const list = defs.find((def) => (def as { heading?: string }).heading === en.t("settings.providersHeading")) as {
			items?: Array<{ render?: (setting: unknown) => void }>;
		};
		// items[0] is the section note; the providers follow it.
		const rendered = list.items?.slice(1).map((item) => {
			const setting = new (Setting as unknown as new (el: HTMLElement) => { extraButtons: Array<{ icon?: string }> })(document.createElement("div"));
			item.render?.(setting);
			return setting.extraButtons.map((button) => button.icon);
		});
		// The button is the only difference between the two rows' controls — the
		// edit and delete pair is shared, so asserting the full sets keeps the
		// subscription row from silently dropping one of them too.
		expect(rendered?.[0]).toEqual(["key-round", "pencil", "trash-2"]);
		expect(rendered?.[1]).toEqual(["pencil", "trash-2"]);
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

	it("places the suggestion section between the model list and the network group", () => {
		const defs = modelsDefinitions(host()) as unknown as ReadonlyArray<Record<string, unknown>>;
		const indexOf = (match: (def: Record<string, unknown>) => boolean) => defs.findIndex(match);
		const models = indexOf((def) => def.heading === en.t("settings.modelsHeading"));
		const suggestion = indexOf((def) => def.name === en.t("quickActions.suggestSettings.name"));
		const network = indexOf((def) => def.heading === en.t("settings.networkHeading"));
		// Adjacent to the models it configures, ahead of the unrelated network rows.
		expect(models).toBeLessThan(suggestion);
		expect(suggestion).toBeLessThan(network);
	});
});

describe("suggestionSection", () => {
	/** Renders the suggestion section into a stub Setting and returns its row element. */
	function renderSection(current: SettingsPanelHost): HTMLElement {
		const item = modelsDefinitions(current).find((def) => (def as { name?: string }).name === en.t("quickActions.suggestSettings.name")) as {
			render?: (setting: unknown) => void;
		};
		expect(item).toBeDefined();
		const setting = new (Setting as unknown as new (el: HTMLElement) => { settingEl: HTMLElement })(document.createElement("div"));
		item.render?.(setting);
		return setting.settingEl;
	}

	function withModels(apiKey = "sk-1"): { current: SettingsPanelHost; settings: SettingsPanelHost["settings"]; saves: () => number } {
		const settings = host().settings;
		settings.providers.push({ id: "p", name: "Provider", baseUrl: "https://example.test", protocol: "openai-completions", apiKey, secretRef: "", source: "user", oauthFlow: "" });
		settings.models.push({ id: "m1", providerId: "p", modelApiId: "fast-model", displayName: "Fast", reasoning: false, supportsImages: false });
		// Follow-session resolves through the active model, so the fixture needs one
		// picked — otherwise the test row's target is "nothing configured" even
		// with a model present.
		settings.activeModelId = "m1";
		let saves = 0;
		const current = host({ settings, save: async () => { saves += 1; } });
		return { current, settings, saves: () => saves };
	}

	it("folds two rows behind an advanced disclosure, collapsed by default", () => {
		const { current } = withModels();
		const root = renderSection(current);

		const details = root.querySelector("details.piem-settings-advanced") as unknown as HTMLDetailsElement;
		expect(details).toBeDefined();
		// Most readers never think about suggestions: the group must not open itself.
		expect(details.open).toBe(false);
		expect(details.querySelector("summary")?.textContent).toContain(en.t("quickActions.suggestSettings.section"));
		const rows = details.querySelectorAll(".piem-settings-advanced__body > .setting-item");
		expect(rows).toHaveLength(2);
	});

	it("leads the dropdown with follow-session and offers the configured models after it", () => {
		const { current } = withModels();
		const root = renderSection(current);

		const select = root.querySelector("select.dropdown") as HTMLSelectElement;
		const options = Array.from(select.options);
		// "" IS the default — the session's model — so it leads the list and is
		// selected before the user touches anything.
		expect(options[0]?.value).toBe("");
		expect(options[0]?.textContent).toBe(en.t("quickActions.suggestSettings.followSession"));
		expect(select.value).toBe("");
		expect(options.slice(1).map((option) => option.value)).toEqual(["m1"]);
	});

	it("preselects the stored suggestion pick instead of follow-session", () => {
		const { current, settings } = withModels();
		settings.suggestionModelId = "m1";
		const root = renderSection(current);
		const select = root.querySelector("select.dropdown") as HTMLSelectElement;
		expect(select.value).toBe("m1");
	});

	it("writes the pick back and saves on change", async () => {
		const { current, settings, saves } = withModels();
		const root = renderSection(current);
		const select = root.querySelector("select.dropdown") as HTMLSelectElement;

		select.value = "m1";
		select.dispatchEvent(new Event("change"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settings.suggestionModelId).toBe("m1");
		expect(saves()).toBe(1);

		// Back to "" unsets rather than writing an empty string: undefined is what
		// the resolver reads as "follow the session".
		select.value = "";
		select.dispatchEvent(new Event("change"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settings.suggestionModelId).toBeUndefined();
		expect(saves()).toBe(2);
	});

	it("clears a stale verdict when the pick changes", async () => {
		const { current } = withModels("");
		const root = renderSection(current);
		const select = root.querySelector("select.dropdown") as HTMLSelectElement;
		const testButton = Array.from(root.querySelectorAll("button")).find((button) => button.textContent === en.t("test.button")) as HTMLButtonElement;
		expect(testButton).toBeDefined();

		// A deterministic fail with no network: the provider has no key, so the
		// probe short-circuits on the credential before any request is built.
		testButton.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		let verdict = root.querySelector(".piem-test-result") as HTMLElement;
		expect(verdict.classList.contains("piem-test-result--error")).toBe(true);
		expect(verdict.textContent).toContain("API key");

		// The verdict described the previous pick; the change must drop it rather
		// than let a red cross vouch for a model it never measured.
		select.value = "m1";
		select.dispatchEvent(new Event("change"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		verdict = root.querySelector(".piem-test-result") as HTMLElement;
		expect(verdict.textContent).toBe("");
		expect(verdict.className).not.toContain("piem-test-result--error");
	});

	it("fails the test row without reaching the network when nothing is configured", async () => {
		// Follow-session with an empty vault resolves to no pair at all: probing
		// would mean inventing a target, so the row says so before any request.
		const { current } = withModels();
		current.settings.providers = [];
		current.settings.models = [];
		const root = renderSection(current);

		const testButton = Array.from(root.querySelectorAll("button")).find((button) => button.textContent === en.t("test.button")) as HTMLButtonElement;
		testButton.click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		const verdict = root.querySelector(".piem-test-result") as HTMLElement;
		expect(verdict.classList.contains("piem-test-result--error")).toBe(true);
		expect(verdict.textContent).toBe(en.t("connectionTest.suggestionNoModel"));
	});
});

describe("logConnectionTest", () => {
	const started = Date.now();

	it("warns on a failed probe, carrying the endpoint's message", () => {
		const spy = spyLogger();
		logConnectionTest(host({ logger: spy.logger }), {
			kind: "provider",
			target: "OpenRouter",
			started,
			ok: false,
			detail: "endpoint answered 401",
		});
		expect(spy.records).toHaveLength(1);
		expect(spy.records[0]?.level).toBe("warn");
		expect(spy.records[0]?.message).toBe("Connection test failed (provider)");
		expect(spy.records[0]?.detail).toEqual({ target: "OpenRouter", ms: expect.any(Number), detail: "endpoint answered 401" });
	});

	it("warns on a thrown probe and names the provider for model rows", () => {
		const spy = spyLogger();
		logConnectionTest(host({ logger: spy.logger }), {
			kind: "model",
			target: "provider/model",
			provider: "Anthropic",
			started,
			error: new TypeError("fetch is not defined"),
		});
		expect(spy.records[0]?.level).toBe("warn");
		expect(spy.records[0]?.detail).toEqual({
			target: "provider/model",
			provider: "Anthropic",
			ms: expect.any(Number),
			error: expect.stringContaining("fetch"),
		});
	});

	it("infos on a pass and stays silent when there is nothing to log", () => {
		const spy = spyLogger();
		logConnectionTest(host({ logger: spy.logger }), { kind: "model", target: "provider/model", started, ok: true, detail: "replied" });
		expect(spy.records.map((record) => record.level)).toEqual(["info"]);

		logConnectionTest(host({ logger: spy.logger }), { kind: "model", target: "provider/model", started });
		expect(spy.records).toHaveLength(1);
	});
});
