import { describe, expect, it } from "bun:test";
import { installDom } from "../../testUtils/dom";
import { installObsidianDomHelpers } from "../../testUtils/obsidianDom";
import { installObsidianStub, platformMock } from "../../testUtils/obsidianStub";
import { getT } from "../../i18n";

installDom();
installObsidianDomHelpers();
installObsidianStub();

const { generalDefinitions } = await import("./generalDefinitions");
import type { SettingsPanelHost } from "./panelHost";

const en = getT("en");

function host(overrides: Partial<SettingsPanelHost> = {}): SettingsPanelHost {
	return {
		app: {} as SettingsPanelHost["app"],
		settings: {
			providers: [],
			models: [],
			networkTransport: "requestUrl",
			cacheRetention: "long",
			showAgentDetails: false,
		traceExpand: "collapsed",
			sendShortcut: "enter",
			language: "en",
			sessionRetention: 0,
			sessionDir: "piem/chats",
			userSkillsDir: "",
			mcpServers: [],
			logLevel: "info",
		},
		save: async () => {},
		refresh: () => {},
		secretStorage: "manual",
		readSecret: () => "",
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
			fetchSource: async () => ({}) as Awaited<ReturnType<SettingsPanelHost["skills"]["fetchSource"]>>,
			install: async () => {},
			update: async () => ({}) as Awaited<ReturnType<SettingsPanelHost["skills"]["update"]>>,
			remove: async () => {},
			refreshAgent: async () => {},
			lastSkillLoad: () => ({ vault: [], user: { skills: [], searched: [], diagnostics: [] } }) as unknown as ReturnType<SettingsPanelHost["skills"]["lastSkillLoad"]>,
			userSkillsAvailable: false,
		},
		mcp: { states: () => [], test: async () => 0 },
		...overrides,
	};
}

/**
 * The rows that most directly answer a settings search: language, keyboard,
 * logging, and privacy/version information. These assertions inspect definition
 * objects rather than the old DOM so a CSS rearrangement cannot make a setting
 * vanish from search unnoticed.
 */
describe("generalDefinitions", () => {
	it("puts the three stored settings behind typed controls", () => {
		const definitions = generalDefinitions(host()) as Array<{
			name?: string;
			type?: string;
			heading?: string;
			control?: { type?: string; key?: string };
			items?: Array<{ name: string; control?: { type?: string; key?: string } }>;
		}>;
		const language = definitions.find((item) => item.name === en.t("settings.languageHeading"));
		const shortcuts = definitions.find((item) => item.heading === en.t("settings.shortcutsHeading"));
		const logs = definitions.find((item) => item.heading === en.t("settings.logsHeading"));

		expect(language?.control).toMatchObject({ type: "dropdown", key: "language" });
		expect(shortcuts?.items?.[0]?.control).toMatchObject({ type: "dropdown", key: "sendShortcut" });
		expect(logs?.items?.[0]?.control).toMatchObject({ type: "dropdown", key: "logLevel" });
	});

	it("keeps opening the log viewer an action, not a fake stored value", () => {
		let opens = 0;
		const definitions = generalDefinitions(host({ openLogView: () => opens++ }));
		const logs = definitions.find((item) => (item as { heading?: string }).heading === en.t("settings.logsHeading")) as {
			items: Array<{ name: string; action?: () => void }>;
		};
		const viewer = logs.items.find((item) => item.name === en.t("settings.logViewerName"));

		expect(viewer?.action).toBeFunction();
		viewer?.action?.();
		expect(opens).toBe(1);
	});

	it("adds the mobile shortcut consequence into the indexed description", () => {
		const wasMobile = platformMock.isMobile;
		platformMock.isMobile = true;
		try {
			const shortcuts = generalDefinitions(host()).find((item) => (item as { heading?: string }).heading === en.t("settings.shortcutsHeading")) as {
				items: Array<{ desc?: string }>;
			};
			expect(shortcuts.items[0]?.desc).toContain(en.t("settings.sendShortcutMobileNote"));
		} finally {
			platformMock.isMobile = wasMobile;
		}
	});
});
