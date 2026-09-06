import { afterEach, describe, expect, it } from "bun:test";
import { installDom } from "../../testUtils/dom";
import { installObsidianDomHelpers } from "../../testUtils/obsidianDom";
import { installObsidianStub, type ExtraButtonStub, type ToggleStub } from "../../testUtils/obsidianStub";
import { getT } from "../../i18n";

const document = installDom();
installObsidianDomHelpers();
installObsidianStub();

const { extensionsDefinitions } = await import("./extensionsDefinitions");
const { Setting } = await import("obsidian");
import { SettingsPanelState } from "./panelState";
import type { SettingsPanelHost } from "./panelHost";
import type { McpServerState } from "../../mcp/mcpManager";
import type { SkillRow } from "../../skills/skillManager";

const en = getT("en");

/**
 * What the Extensions page has to keep true across the declarative move.
 *
 * Its two sections previously depended on a shape the definitions cannot have:
 * containers created synchronously and filled by an async read. Rebuilding on
 * arrival replaces it, and the two failure modes that introduces are what these
 * assertions pin — a rebuild loop (revalidating forever because every build
 * schedules another), and a first paint that claims the vault is empty before it
 * has been looked at.
 */

interface Recorder {
	lists: number;
	refreshes: number;
}

function stubHost(overrides: Partial<SettingsPanelHost> = {}, record?: Recorder): SettingsPanelHost {
	const rows: SkillRow[] = [];
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
		refresh: () => {
			if (record) record.refreshes++;
		},
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
			list: async () => {
				if (record) record.lists++;
				return { rows };
			},
			catalog: () => [],
			fetchSource: async () => ({}) as Awaited<ReturnType<SettingsPanelHost["skills"]["fetchSource"]>>,
			install: async () => {},
			update: async () => ({}) as Awaited<ReturnType<SettingsPanelHost["skills"]["update"]>>,
			remove: async () => {},
			refreshAgent: async () => {},
			lastSkillLoad: () =>
				({ vault: [], user: { skills: [], searched: [], diagnostics: [] }, templates: [] }) as unknown as ReturnType<
					SettingsPanelHost["skills"]["lastSkillLoad"]
				>,
			userSkillsAvailable: false,
		},
		mcp: { states: () => [], test: async () => 0, reconnect: async () => undefined },
		...overrides,
	};
}

/** Lets the revalidation microtasks run without a timer. */
async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) {
		await Promise.resolve();
	}
}

describe("extensionsDefinitions", () => {
	it("declares both sections as lists, so their rows are indexed and mutable", async () => {
		const definitions = extensionsDefinitions(stubHost(), new SettingsPanelState());
		await settle();

		const lists = definitions.filter((entry) => (entry as { type?: string }).type === "list") as Array<{ heading?: string; addItem?: { name: string } }>;
		expect(lists.map((list) => list.heading)).toEqual([en.t("skills.heading"), en.t("mcp.heading")]);
		// The add affordance is the framework's, so a new server or skill is reached
		// the same way it is in every other plugin's list.
		expect(lists[0]?.addItem?.name).toBe(en.t("skills.import"));
		expect(lists[1]?.addItem?.name).toBe(en.t("mcp.add"));
	});

	it("discloses the pinned mount's lack of server push to every reader", async () => {
		const readNote = (host: SettingsPanelHost): string => {
			const lists = extensionsDefinitions(host, new SettingsPanelState()).filter(
				(entry) => (entry as { type?: string }).type === "list",
			) as Array<{ items?: { name?: string }[] }>;
			return lists[1]?.items?.[0]?.name ?? "";
		};

		const buffered = stubHost();
		expect(readNote(buffered)).toContain(en.t("mcp.bufferedNoPush"));

		// Mounting is pinned regardless of the reader's transport, so the same
		// limitation describes the fetch reader too — only tool calls follow it.
		const streaming = stubHost({ settings: { ...buffered.settings, networkTransport: "fetch" } });
		expect(readNote(streaming)).toContain(en.t("mcp.bufferedNoPush"));
		expect(readNote(streaming)).toContain(en.t("mcp.desc"));
		await settle();
	});

	it("stops revalidating once a read comes back unchanged", async () => {
		const record: Recorder = { lists: 0, refreshes: 0 };
		const host = stubHost({}, record);
		// One state across both builds, as the tab supplies: that is what lets the
		// second read compare against what the first one drew.
		const state = new SettingsPanelState();

		extensionsDefinitions(host, state);
		await settle();
		const afterFirst = record.refreshes;
		extensionsDefinitions(host, state);
		await settle();

		// The first read had nothing to compare against, so it asked for the rebuild
		// that put the rows on screen. The second found the same skills and must not
		// have asked again — asking every time is what would loop.
		expect(afterFirst).toBe(1);
		expect(record.lists).toBe(2);
		expect(record.refreshes).toBe(1);
	});

	it("does not claim the skills folder is empty before it has been read", async () => {
		const state = new SettingsPanelState();
		// The built-in section leads the page as a group; the vault folder is the
		// first list, so it is selected by type rather than by position.
		const vaultList = (host: SettingsPanelHost) =>
			extensionsDefinitions(host, state).filter((entry) => (entry as { type?: string }).type === "list")[0] as {
				items: Array<{ name: string }>;
			};

		// First build, before any read resolves: an empty sentence here would claim
		// the folder holds nothing when nobody has looked in it.
		expect(vaultList(stubHost()).items[0]?.name).toBe(en.t("skills.desc"));

		// Once a read has landed and come back with no rows, saying so is earned.
		await settle();
		expect(vaultList(stubHost()).items[0]?.name).toContain(en.t("skills.empty"));
	});

	it("hides the user-level section where its folders cannot exist", async () => {
		const definitions = extensionsDefinitions(stubHost(), new SettingsPanelState());
		await settle();

		// `userSkillsAvailable` is false in the stub, standing in for mobile: a
		// section promising skills that can never load is noise.
		const headings = definitions.map((entry) => (entry as { heading?: string }).heading);
		expect(headings).not.toContain(en.t("skills.userHeading"));
	});
});

/**
 * The MCP row's enable switch, driven the way a user drives it.
 *
 * Obsidian's `ToggleComponent.setValue` calls the change callback whenever it
 * changes the value, so this row's handler can re-enter itself — and the version
 * these tests were written against did: it restored the switch with `setValue`
 * from inside its own `onChange`, which ran the *enable* path while the disable
 * dialog was still open, and opened a second dialog on every answer. In real
 * Obsidian 1.13.7 that read as a switch that sprang back on and a question that
 * would not go away.
 *
 * So the assertions are counts and positions rather than internal calls: how many
 * dialogs one flip opened, where the switch sits afterwards, how many saves it
 * cost, and what the flag on the settings object says.
 */
describe("the MCP enable toggle", () => {
	const NAME = "Smoke";
	const DIALOG_TITLE = en.t("confirmDelete.disableTitle", {
		subject: en.t("confirmDelete.mcpServerSubject", { name: NAME }),
	});

	// Dialogs are the only thing these tests put in the body; clearing it keeps one
	// test's open question from being counted by the next.
	afterEach(() => {
		document.body.replaceChildren();
	});

	function mount(enabled: boolean): {
		toggle: ToggleStub;
		dialogs: () => HTMLElement[];
		buttons: () => HTMLButtonElement[];
		flag: () => boolean | undefined;
		saves: () => number;
	} {
		let saves = 0;
		const server = { id: "mcp_1", name: NAME, url: "http://127.0.0.1:39991/mcp", token: "", secretRef: "", enabled };
		const base = stubHost();
		const host = stubHost({
			settings: { ...base.settings, mcpServers: [server] },
			save: async () => {
				saves += 1;
			},
			mcp: {
				states: () => [
					{ id: server.id, name: server.name, url: server.url, enabled: server.enabled, status: "untested", toolCount: 0 },
				],
				test: async () => 0,
				reconnect: async () => undefined,
			},
		});
		const lists = extensionsDefinitions(host, new SettingsPanelState()).filter(
			(entry) => (entry as { type?: string }).type === "list",
		) as Array<{ items?: Array<{ render?: (setting: unknown) => void }> }>;
		const container = document.createElement("div");
		// The stub records every control a row built; the real `Setting` type has no
		// such surface, so the cast goes through `unknown` to reach the stub's.
		const setting = new (Setting as unknown as new (el: HTMLElement) => { toggles: ToggleStub[] })(container);
		// items[0] is the section note; the configured servers follow it.
		lists[1]?.items?.[1]?.render?.(setting);
		const dialogs = (): HTMLElement[] =>
			Array.from(document.body.children).filter(
				(el) => el.firstElementChild?.textContent === DIALOG_TITLE,
			) as HTMLElement[];
		return {
			toggle: setting.toggles[0] as ToggleStub,
			dialogs,
			buttons: () => Array.from(dialogs()[0]?.querySelectorAll("button") ?? []),
			flag: () => host.settings.mcpServers[0]?.enabled,
			saves: () => saves,
		};
	}

	it("asks once, and leaves the switch where the user put it", async () => {
		const row = mount(true);
		row.toggle.toggle(false);
		await settle();

		expect(row.dialogs().length).toBe(1);
		// The flip is the pending intent, so it stands while the question is open.
		expect(row.toggle.getValue()).toBe(false);
		// And nothing is written until the question is answered.
		expect(row.flag()).toBe(true);
		expect(row.saves()).toBe(0);
	});

	it("confirming turns it off in one save, without reopening the question", async () => {
		const row = mount(true);
		row.toggle.toggle(false);
		await settle();
		const confirm = row.buttons().at(-1);
		expect(confirm?.textContent).toBe(en.t("confirmDelete.disable"));

		confirm?.click();
		await settle();

		expect(row.flag()).toBe(false);
		expect(row.saves()).toBe(1);
		expect(row.toggle.getValue()).toBe(false);
		expect(row.dialogs().length).toBe(0);
	});

	it("dismissing puts the switch back and writes nothing", async () => {
		const row = mount(true);
		row.toggle.toggle(false);
		await settle();
		const cancel = row.buttons().find((button) => button.textContent === en.t("confirmDelete.cancel"));

		cancel?.click();
		await settle();

		// The restore is programmatic, so it must not read as a fresh enable: the
		// row goes back to what is configured, and no save follows it.
		expect(row.toggle.getValue()).toBe(true);
		expect(row.flag()).toBe(true);
		expect(row.saves()).toBe(0);
		expect(row.dialogs().length).toBe(0);
	});

	it("turning a disabled server on goes straight through", async () => {
		const row = mount(false);
		row.toggle.toggle(true);
		await settle();

		// Enabling restores rather than destroys, so it asks nothing.
		expect(row.dialogs().length).toBe(0);
		expect(row.flag()).toBe(true);
		expect(row.saves()).toBe(1);
		expect(row.toggle.getValue()).toBe(true);
	});
});

/**
 * The retry button lives on failed MCP rows only. What matters beyond its
 * existence: it rides ahead of edit and delete (fixing is the next likely
 * action), the click fences double fires, and the verdict line repaints from
 * what the manager now reports once the reconnect settles.
 */
describe("the MCP retry button", () => {
	const SERVER = { id: "mcp_1", name: "Hub", url: "http://127.0.0.1:39991/mcp", token: "", secretRef: "", enabled: true };

	function renderRow(mcp: SettingsPanelHost["mcp"]): { container: HTMLElement; extraButtons: ExtraButtonStub[] } {
		const base = stubHost();
		const host = stubHost({
			settings: { ...base.settings, mcpServers: [{ ...SERVER }] },
			mcp,
		});
		const lists = extensionsDefinitions(host, new SettingsPanelState()).filter(
			(entry) => (entry as { type?: string }).type === "list",
		) as Array<{ items?: Array<{ render?: (setting: unknown) => void }> }>;
		const container = document.createElement("div");
		const setting = new (Setting as unknown as new (el: HTMLElement) => { extraButtons: ExtraButtonStub[] })(container);
		// items[0] is the section note; the configured servers follow it.
		lists[1]?.items?.[1]?.render?.(setting);
		return { container, extraButtons: setting.extraButtons };
	}

	const verdictText = (container: HTMLElement): string =>
		container.querySelector(".piem-settings-effect")?.textContent ?? "";

	it("appears only on failed rows, ahead of edit and delete", async () => {
		const rowMcp = (status: "error" | "ok"): SettingsPanelHost["mcp"] => ({
			states: () => [{ ...SERVER, status, toolCount: status === "ok" ? 3 : 0, error: status === "error" ? "boom" : undefined }],
			test: async () => 0,
			reconnect: async () => undefined,
		});

		const errorTooltips = renderRow(rowMcp("error")).extraButtons.map((button) => button.tooltip);
		expect(errorTooltips[0]).toBe(en.t("mcp.retry"));
		// Fixing comes first; edit and delete keep their established order.
		expect(errorTooltips.slice(1)).toEqual([en.t("mcp.edit"), en.t("mcp.delete")]);

		const okTooltips = renderRow(rowMcp("ok")).extraButtons.map((button) => button.tooltip);
		expect(okTooltips).toEqual([en.t("mcp.edit"), en.t("mcp.delete")]);
	});

	it("reconnects once, fences the double click, and repaints the verdict", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let current: McpServerState = { ...SERVER, status: "error", toolCount: 0, error: "boom" };
		let reconns = 0;
		const { container, extraButtons } = renderRow({
			states: () => [current],
			test: async () => 0,
			reconnect: async () => {
				reconns += 1;
				await gate;
				current = { ...SERVER, status: "ok", toolCount: 3 };
			},
		});
		const retry = extraButtons[0]!;
		expect(verdictText(container)).toBe(en.t("mcp.statusError", { error: "boom" }));

		retry.click();
		await settle();

		// Held open: the fence is up and the verdict says connecting, not silence.
		expect(reconns).toBe(1);
		expect(retry.extraSettingsEl.classList.contains("is-disabled")).toBe(true);
		expect(verdictText(container)).toBe(en.t("mcp.statusConnecting"));

		// Same in-flight attempt → the fence refuses a second run.
		retry.click();
		await settle();
		expect(reconns).toBe(1);

		release?.();
		await settle();

		expect(verdictText(container)).toBe(en.t("mcp.statusOk", { tools: 3 }));
		expect(retry.extraSettingsEl.classList.contains("is-disabled")).toBe(false);
	});

	it("a retry that fails again lands back on the error verdict", async () => {
		const { container, extraButtons } = renderRow({
			states: () => [{ ...SERVER, status: "error", toolCount: 0, error: "still down" }],
			test: async () => 0,
			reconnect: async () => undefined,
		});
		const retry = extraButtons[0]!;

		retry.click();
		await settle();

		expect(verdictText(container)).toBe(en.t("mcp.statusError", { error: "still down" }));
	});
});

/**
 * The built-in section and the per-skill disable switch.
 *
 * The switch's whole contract is one array on the settings object: removing the
 * name enables, appending it disables. The panel renders the agent's catalog
 * rather than the folder, so a disabled skill keeps its row — a switch that
 * vanished with its own flip could never be turned back on. And the mount must
 * not save: `setValue` is called to reflect stored state before the change
 * callback is registered, so a fresh render writes nothing.
 */
describe("the built-in skills section", () => {
	const summarize = { name: "summarize", description: "Summarize", content: "body", filePath: "/__piem_builtin_skills__/summarize/SKILL.md" };
	const custom = { name: "custom", description: "Custom", content: "body", filePath: "/Piem/skills/custom/SKILL.md" };
	const catalog: SettingsPanelHost["skills"]["catalog"] = () => [
		{ skill: summarize, source: "builtin" },
		{ skill: custom, source: "vault" },
	];

	function mount(disabled: string[] = []) {
		let saves = 0;
		const base = stubHost();
		const host = stubHost({
			settings: { ...base.settings, disabledSkills: [...disabled] },
			save: async () => {
				saves += 1;
			},
			skills: { ...base.skills, catalog },
		});
		// The built-in group leads the page; its first item is the section note.
		const group = extensionsDefinitions(host, new SettingsPanelState())[0] as {
			heading?: string;
			items: Array<{ name?: string; render?: (setting: unknown) => void }>;
		};
		return { group, host, saves: () => saves };
	}

	function renderRow(group: { items: Array<{ name?: string; render?: (setting: unknown) => void }> }, name: string): ToggleStub {
		const container = document.createElement("div");
		const setting = new (Setting as unknown as new (el: HTMLElement) => { toggles: ToggleStub[] })(container);
		const row = group.items.find((item) => item.name === name);
		if (!row) throw new Error(`no builtin row named ${name}`);
		row.render?.(setting);
		return setting.toggles[0] as ToggleStub;
	}

	it("splits the built-in rows from the vault list", async () => {
		const { group } = mount();
		await settle();

		expect(group.heading).toBe(en.t("skills.builtinHeading"));
		// Only the built-in layer belongs here: the vault skill rides in the
		// folder's own list below, not in a row that delete could never remove.
		expect(group.items.map((item) => item.name)).toEqual([en.t("skills.builtinDesc"), summarize.name]);
	});

	it("flipping the switch writes the disabled list and saves", async () => {
		const { group, host, saves } = mount();
		const toggle = renderRow(group, summarize.name);
		expect(toggle.getValue()).toBe(true);

		toggle.toggle(false);
		await settle();

		expect(host.settings.disabledSkills).toEqual(["summarize"]);
		expect(saves()).toBe(1);
		expect(toggle.getValue()).toBe(false);

		toggle.toggle(true);
		await settle();

		expect(host.settings.disabledSkills).toEqual([]);
		expect(saves()).toBe(2);
	});

	it("renders a disabled skill with its switch down, without saving on mount", async () => {
		const { group, host, saves } = mount(["summarize"]);
		const toggle = renderRow(group, summarize.name);

		// The switch reflects stored state and the mount itself writes nothing —
		// `setValue` runs before the change callback exists to hear it.
		expect(toggle.getValue()).toBe(false);
		expect(host.settings.disabledSkills).toEqual(["summarize"]);
		expect(saves()).toBe(0);
	});
});
