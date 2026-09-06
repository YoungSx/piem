import { describe, expect, it } from "bun:test";
import { installDom } from "../../testUtils/dom";
import { installObsidianDomHelpers } from "../../testUtils/obsidianDom";
import { installObsidianStub } from "../../testUtils/obsidianStub";
import { getT } from "../../i18n";
import { NOOP_LOGGER } from "../../logging/Logger";

installDom();
installObsidianDomHelpers();
installObsidianStub();

const { buildSettingDefinitions } = await import("./settingDefinitions");
import { SettingsPanelState } from "./panelState";
import type { SettingsPanelHost } from "./panelHost";

const en = getT("en");

/**
 * What the declarative migration has to preserve.
 *
 * The definitions are the search index: a page missing from this array is a
 * group of settings a user cannot find by typing its name, and that failure is
 * invisible in the panel itself — the rows still render, so only a search that
 * comes up empty reveals it. So the load-bearing assertions are the presence and
 * naming of every page, and the one ordering property Obsidian relies on: that
 * building the definitions does not itself render, since `getSettingDefinitions`
 * runs at registration purely to index and the tabs behind these pages read the
 * vault and probe the agent.
 */

/**
 * A host that answers every call without touching a vault.
 *
 * Every async member resolves rather than rejects: a page factory that runs is
 * allowed to reach them, and a rejection would surface as an unhandled promise
 * rather than as the assertion that actually failed.
 */
function stubHost(overrides: Partial<SettingsPanelHost> = {}): SettingsPanelHost {
	const skillLoad = { vault: [], user: { skills: [], searched: [], diagnostics: [] } };
	return {
		app: {} as SettingsPanelHost["app"],
		settings: {
			providers: [],
			models: [],
			networkTransport: "requestUrl",
			cacheRetention: "long",
			showAgentDetails: false,
			traceExpand: "collapsed",
			promptQueueStrategy: "afterRun",
			sendShortcut: "enter",
			language: "en",
			sessionRetention: 0,
			sessionDir: "piem/chats",
			userSkillsDir: "",
			disabledSkills: [],
			mcpServers: [],
			logLevel: "info",
		},
		save: async () => {},
		refresh: () => {},
		logger: NOOP_LOGGER,
		secretStorage: "manual",
		readSecret: () => "",
		signIn: undefined,
		describeTarget: () => "target",
		t: en,
		contextWindow: () => 128_000,
		countStoredSessions: async () => 0,
		missingBuiltinModel: () => undefined,
		activeSessionDir: () => "piem/chats",
		openLogView: () => {},
		countLegacySessions: async () => ({ count: 0, dir: "" }),
		manifest: { version: "1.0.4" },
		skills: {
			list: async () => ({ rows: [] }) as unknown as Awaited<ReturnType<SettingsPanelHost["skills"]["list"]>>,
			catalog: () => [],
			fetchSource: async () => ({}) as Awaited<ReturnType<SettingsPanelHost["skills"]["fetchSource"]>>,
			install: async () => {},
			update: async () => ({}) as Awaited<ReturnType<SettingsPanelHost["skills"]["update"]>>,
			remove: async () => {},
			refreshAgent: async () => {},
			lastSkillLoad: () => skillLoad as unknown as ReturnType<SettingsPanelHost["skills"]["lastSkillLoad"]>,
			userSkillsAvailable: false,
		},
		mcp: { states: () => [], test: async () => 0, reconnect: async () => undefined },
		...overrides,
	};
}

describe("buildSettingDefinitions", () => {
	it("exposes every tab as a navigable page, so each enters the settings search", () => {
		const definitions = buildSettingDefinitions(stubHost(), new SettingsPanelState());

		expect(definitions.map((entry) => (entry as { type?: string }).type)).toEqual(["page", "page", "page", "page"]);
		expect(definitions.map((entry) => (entry as { name: string }).name)).toEqual([
			en.t("settings.tabModels"),
			en.t("settings.tabChat"),
			en.t("settings.tabExtensions"),
			en.t("settings.tabGeneral"),
		]);
	});

	it("names pages in the host's language, so a language change re-labels the navigation", () => {
		const zh = getT("zh-cn");
		const definitions = buildSettingDefinitions(stubHost({ t: zh }), new SettingsPanelState());

		expect((definitions[0] as { name: string }).name).toBe(zh.t("settings.tabModels"));
		// The guard against a copy regression that would make this test tautological:
		// if the two languages ever shipped the same string the assertion above
		// would pass against a hardcoded label.
		expect(zh.t("settings.tabModels")).not.toBe(en.t("settings.tabModels"));
	});

	it("builds without probing live state, so indexing costs nothing", () => {
		let reads = 0;
		const host = stubHost({
			// Resolving the active target reads the selected model; the Models page
			// defers it into a render callback for exactly this reason.
			describeTarget: () => {
				reads++;
				return "target";
			},
		});

		buildSettingDefinitions(host, new SettingsPanelState());

		expect(reads).toBe(0);
	});

	it("declares every page's rows inline, so none is drawn outside the index", () => {
		const definitions = buildSettingDefinitions(stubHost(), new SettingsPanelState());

		// A page carrying a `page` factory instead of `items` renders imperatively,
		// which is exactly the state this migration removed: its rows would be on
		// screen but absent from search. No page may have one.
		for (const page of definitions) {
			expect((page as { items?: unknown[] }).items).toBeArray();
			expect((page as { page?: unknown }).page).toBeUndefined();
		}
	});

	it("puts the Chat tab's ordinary toggle in a real control definition", () => {
		const definitions = buildSettingDefinitions(stubHost(), new SettingsPanelState());
		const chat = definitions[1] as { items: Array<{ name?: string; control?: { type?: string; key?: string } }> };
		const details = chat.items.find((item) => item.name === en.t("settings.showAgentDetails"));

		expect(details?.control).toEqual({ type: "toggle", key: "showAgentDetails" });
	});

	it("puts the mid-reply queueing choice behind its own entry, with the pick on show", () => {
		// A page rather than a Chat-tab row because the choice needs a paragraph
		// before it is safe to make — chiefly the paragraph saying that neither
		// option interrupts (issue #289). `displayValue` is what answers "which one
		// am I on?" without opening it.
		const host = stubHost();
		const definitions = buildSettingDefinitions(host, new SettingsPanelState());
		const chat = definitions[1] as {
			items: Array<{
				name?: string;
				desc?: string;
				displayValue?: () => string;
				items?: Array<{ name?: string; control?: { type?: string; key?: string; options?: Record<string, string> } }>;
			}>;
		};
		const page = chat.items.find((item) => item.name === en.t("settings.queueStrategy"));

		expect(page?.desc).toBe(en.t("settings.queueStrategyDesc"));
		expect(page?.displayValue?.()).toBe(en.t("settings.queueStrategyAfterRun"));
		expect(page?.items?.[0]?.control).toEqual({
			type: "dropdown",
			key: "promptQueueStrategy",
			options: {
				afterRun: en.t("settings.queueStrategyAfterRun"),
				afterTurn: en.t("settings.queueStrategyAfterTurn"),
			},
		});

		// Read through a function, not captured: a value changed inside the page has
		// to show on the entry the reader comes back to.
		host.settings.promptQueueStrategy = "afterTurn";
		expect(page?.displayValue?.()).toBe(en.t("settings.queueStrategyAfterTurn"));
	});

	it("offers the trace expand mode as a three-option dropdown", () => {
		const definitions = buildSettingDefinitions(stubHost(), new SettingsPanelState());
		const chat = definitions[1] as { items: Array<{ name?: string; control?: { type?: string; key?: string; options?: Record<string, string> } }> };
		const expand = chat.items.find((item) => item.name === en.t("settings.traceExpand"));

		expect(expand?.control).toEqual({
			type: "dropdown",
			key: "traceExpand",
			options: {
				collapsed: en.t("settings.traceExpandCollapsed"),
				highValue: en.t("settings.traceExpandHighValue"),
				expanded: en.t("settings.traceExpandExpanded"),
			},
		});
	});
});
