import { afterEach, describe, expect, it } from "bun:test";
import { installDom } from "../../testUtils/dom";
import { installObsidianDomHelpers } from "../../testUtils/obsidianDom";
import { installObsidianStub, type ToggleStub } from "../../testUtils/obsidianStub";
import { getT } from "../../i18n";

const document = installDom();
installObsidianDomHelpers();
installObsidianStub();

const { extensionsDefinitions } = await import("./extensionsDefinitions");
const { Setting } = await import("obsidian");
import { SettingsPanelState } from "./panelState";
import type { SettingsPanelHost } from "./panelHost";
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
		refresh: () => {
			if (record) record.refreshes++;
		},
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
			list: async () => {
				if (record) record.lists++;
				return { rows };
			},
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
		mcp: { states: () => [], test: async () => 0 },
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

		// First build, before any read resolves: an empty sentence here would claim
		// the folder holds nothing when nobody has looked in it.
		const first = extensionsDefinitions(stubHost(), state)[0] as { items: Array<{ name: string }> };
		expect(first.items[0]?.name).toBe(en.t("skills.desc"));

		// Once a read has landed and come back with no rows, saying so is earned.
		await settle();
		const second = extensionsDefinitions(stubHost(), state)[0] as { items: Array<{ name: string }> };
		expect(second.items[0]?.name).toContain(en.t("skills.empty"));
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
