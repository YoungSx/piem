import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { App } from "obsidian";
import { flushRender, installDom } from "../testUtils/dom";
import { installObsidianStub, lastMenu, platformMock, resetMenus } from "../testUtils/obsidianStub";
import type { ChatSnapshot } from "../agent/ObsidianAgentService";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextFill, UsageTotals } from "../agent/usage";
import type { ActiveSessionInfo } from "../session/ObsidianSessionManager";

installObsidianStub();
const document = installDom();

// Dynamic imports so the mocked `obsidian` module wins over any cached real one.
const { ChatHeader } = await import("./ChatHeader");
const { createRoot: createRootImpl } = await import("react-dom/client");

let createRootSync: typeof createRootImpl;

const app = {} as App;

interface RenderOptions {
	/** Passed through as the header's `onOpenSettings`; omitted means unreachable. */
	onOpenSettings?: () => void;
	/** Passed through as the header's `onExportSession`; omitted means unreachable. */
	onExportSession?: () => void;
	/** The vault's stored chats; the history controls gate on there being two. */
	sessions?: ActiveSessionInfo[];
}

async function renderHeader(snapshot: ChatSnapshot, options: RenderOptions = {}): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = roots.get(host) ?? createRootSync(host);
	roots.set(host, root);
	root.render(
		<ChatHeader
			app={app}
			snapshot={snapshot}
			sessions={options.sessions ?? []}
			onOpenSession={() => undefined}
			onNewSession={() => undefined}
			onRenameSession={() => undefined}
			onDeleteSession={() => undefined}
			onExportSession={options.onExportSession}
			onOpenSettings={options.onOpenSettings}
		/>,
	);
	await flushRender();
	return host;
}

/** Presses the overflow button and returns the menu production code built. */
async function openOverflow(host: HTMLElement): Promise<ReturnType<typeof lastMenu>> {
	const button = host.querySelector<HTMLButtonElement>('.piem-chat__header-actions button[aria-label="More chat actions"]');
	if (!button) {
		throw new Error("no overflow button");
	}
	button.click();
	await flushRender();
	return lastMenu();
}

/**
 * The header carries the chat's name and its session controls, and nothing else.
 *
 * Two evictions are pinned here, both against the same defect — anything parked
 * in this row is read before the conversation the reader opened the panel for.
 * The context meter, the spend counter and the compaction notice went to
 * `ChatStatusBar.test.tsx` with their markup. The model line went to
 * `ModelSwitcher.test.tsx`, which is where the control that changes it now lives.
 * What is asserted here is that none of them come back.
 *
 * A third evicted thing is pinned one describe down, in the overflow menu rather
 * than the row: the slash-command catalogue, which now lives only in the
 * composer's `/` menu (`CommandMenu.test.tsx`).
 */
describe("ChatHeader scope", () => {
	beforeEach(() => {
		createRootSync = createRootImpl;
		document.body.replaceChildren();
	});

	afterEach(() => {
		document.body.replaceChildren();
	});

	it("keeps live readouts out of the header, even with agent details on", async () => {
		const host = await renderHeader(snapshot({ showAgentDetails: true, usage: { tokens: 4_200, cost: 0.02, requests: 3 } }));

		expect(host.querySelector(".piem-chat__statusbar")).toBeNull();
		expect(host.querySelector(".piem-chat__context")).toBeNull();
		expect(host.querySelector(".piem-chat__usage")).toBeNull();
	});

	it("says nothing about compaction, which the status bar above the composer reports", async () => {
		const host = await renderHeader(snapshot({ isCompacting: true }));

		expect(host.querySelector(".piem-chat__compacting")).toBeNull();
	});

	it("does not name the model, which the composer's switcher owns", async () => {
		// The line lived here and could only be read: the control that changes the
		// model was two tabs deep in settings. It is now the switcher's label, so a
		// header that printed it again would be stating a value beside a copy of
		// itself — and spending a row above the transcript to do it.
		const host = await renderHeader(snapshot({ showAgentDetails: true }));

		expect(host.querySelector(".piem-chat__model")).toBeNull();
		expect(host.textContent).not.toContain("deepseek-v4-pro");
	});

	it("is a single labelled row, not a stacked chrome block", async () => {
		const host = await renderHeader(snapshot());

		const header = host.querySelector("header.piem-chat__header");
		expect(header?.getAttribute("aria-label")).toBe("Current chat");
		expect(host.querySelector(".piem-chat__chrome")).toBeNull();
	});
});

describe("ChatHeader action row", () => {
	beforeEach(() => {
		createRootSync = createRootImpl;
		document.body.replaceChildren();
	});

	afterEach(() => {
		document.body.replaceChildren();
	});

	it("keeps every action button mounted so their positions never shift", async () => {
		const host = await renderHeader(snapshot());

		const labels = Array.from(host.querySelectorAll(".piem-chat__header-actions button"), (button) => button.getAttribute("aria-label"));
		expect(labels).toEqual(["View chat history", "New chat", "More chat actions"]);
	});
});

/*
 * A phone squeezes the transcript between the header above and the keyboard
 * below, so the header's wrap — a full second row of 48px buttons on a narrow
 * leaf — is height the conversation cannot afford. The row goes back to one
 * line by retiring the history button; its picker stays one menu item away in
 * the overflow menu, gated by the same availability the button had.
 */
describe("ChatHeader on a phone", () => {
	beforeEach(() => {
		createRootSync = createRootImpl;
		resetMenus();
		platformMock.isMobile = true;
		document.body.replaceChildren();
	});

	afterEach(() => {
		platformMock.isMobile = false;
		document.body.replaceChildren();
	});

	it("drops the history button from the row, keeping new chat and the menu", async () => {
		const host = await renderHeader(snapshot(), { sessions: [sessionInfo("a"), sessionInfo("b")] });

		const labels = Array.from(host.querySelectorAll(".piem-chat__header-actions button"), (button) => button.getAttribute("aria-label"));
		expect(labels).toEqual(["New chat", "More chat actions"]);
	});

	it("offers history at the head of the overflow menu in its place", async () => {
		const host = await renderHeader(snapshot({ session: sessionInfo() }), {
			onOpenSettings: () => undefined,
			sessions: [sessionInfo("a"), sessionInfo("b")],
		});

		expect((await openOverflow(host)).titles()).toEqual(["View chat history", "Rename chat", "Open settings", "Delete chat"]);
	});

	it("keeps history in the menu mid-turn — the picker never touches the run in flight", async () => {
		// Issue #252: openSession and the picker leave a running request alone, and
		// the picker's rows already mark which sessions are mid-run. The old rule
		// ("history out of the menu mid-turn") is retired with it.
		const host = await renderHeader(snapshot({ session: sessionInfo(), isStreaming: true }), {
			onOpenSettings: () => undefined,
			sessions: [sessionInfo("a"), sessionInfo("b")],
		});

		expect((await openOverflow(host)).titles()).toEqual(["View chat history", "Rename chat", "Open settings", "Delete chat"]);
	});
});

/**
 * The overflow menu is the panel's only always-reachable door to settings.
 *
 * Every other route is conditional on a failure: the banner offers a button when
 * a request already errored, the empty state offers one when no key is
 * configured. A user who simply wants to change model has to leave the panel and
 * find **Settings → Piem** by hand. So the assertions here are mostly about the
 * states where the *session* actions are unavailable — before the first message,
 * and mid-turn — because those are exactly the states the button used to be
 * greyed out in, and a wrong model mid-turn is when a user reaches for it.
 */
describe("ChatHeader overflow menu", () => {
	beforeEach(() => {
		createRootSync = createRootImpl;
		resetMenus();
		document.body.replaceChildren();
	});

	afterEach(() => {
		document.body.replaceChildren();
	});

	it("offers settings between the session actions, with the destructive one last", async () => {
		const host = await renderHeader(snapshot({ session: sessionInfo() }), { onOpenSettings: () => undefined });

		expect((await openOverflow(host)).titles()).toEqual(["Rename chat", "Open settings", "Delete chat"]);
	});

	it("stays open on settings alone before the first message", async () => {
		const host = await renderHeader(snapshot({ session: undefined }), { onOpenSettings: () => undefined });

		const button = host.querySelector<HTMLButtonElement>('.piem-chat__header-actions button[aria-label="More chat actions"]');
		expect(button?.disabled).toBe(false);
		expect((await openOverflow(host)).titles()).toEqual(["Open settings"]);
	});

	it("stays open on settings alone mid-turn, when the model is what the user wants to change", async () => {
		// Mid-turn with no session, only settings has anything to say — the empty
		// state, not the disabled one. Rename and delete follow the session; a
		// mid-turn *existing* chat keeps them (issue #252).
		const host = await renderHeader(snapshot({ session: undefined, isStreaming: true }), { onOpenSettings: () => undefined });

		expect((await openOverflow(host)).titles()).toEqual(["Open settings"]);
	});

	it("offers rename, export and delete mid-turn, which the service handles safely", async () => {
		// Issue #252: rename and export write outside the agent's transcript and
		// delete aborts first, so a mid-turn menu is the full one.
		const host = await renderHeader(snapshot({ session: sessionInfo(), isStreaming: true, messages: [assistantMessage()] }), {
			onExportSession: () => undefined,
			onOpenSettings: () => undefined,
		});

		expect((await openOverflow(host)).titles()).toEqual(["Rename chat", "Save as note", "Open settings", "Delete chat"]);
	});

	it("routes the settings item to the host callback", async () => {
		let opened = 0;
		const host = await renderHeader(snapshot({ session: undefined }), { onOpenSettings: () => (opened += 1) });

		(await openOverflow(host)).click("Open settings");

		expect(opened).toBe(1);
	});

	/*
	 * A menu whose every block is absent would open as an empty popover — the one
	 * outcome worse than a greyed-out button, since it looks like a bug rather
	 * than a state.
	 */
	it("disables the button when the host cannot reach settings and there is no session", async () => {
		const host = await renderHeader(snapshot({ session: undefined }));

		const button = host.querySelector<HTMLButtonElement>('.piem-chat__header-actions button[aria-label="More chat actions"]');
		expect(button?.disabled).toBe(true);
	});

	it("emits no separator when only one block survives", async () => {
		const host = await renderHeader(snapshot({ session: undefined }), { onOpenSettings: () => undefined });

		expect((await openOverflow(host)).items.some((item) => item.separator)).toBe(false);
	});

	it("keeps the session actions when the host cannot reach settings", async () => {
		const host = await renderHeader(snapshot({ session: sessionInfo() }));

		expect((await openOverflow(host)).titles()).toEqual(["Rename chat", "Delete chat"]);
	});

	it("keeps the slash-command catalogue out of the menu, however many the vault has", async () => {
		// A mirror of the composer's `/` list lived here, one row per invocation.
		// It is gone: a catalogue that grows with the vault does not belong among
		// four verbs about this chat, and past a handful of skills it pushed Delete
		// off the bottom of a phone screen. The menu is session actions only.
		const host = await renderHeader(
			snapshot({
				session: sessionInfo(),
				availableCommands: [
					{ name: "Summarize", description: "", kind: "template", invocation: "summarize" },
					{ name: "Tagger", description: "", kind: "skill", invocation: "skill:tagger" },
				],
			}),
		);

		const menu = await openOverflow(host);
		expect(menu.titles()).toEqual(["Rename chat", "Delete chat"]);
	});

	it("greys the overflow button when only commands would have filled it", async () => {
		// The command block used to be a fourth door keeping this button alive. With
		// no session and no settings, a vault full of skills now leaves the menu
		// genuinely empty — so the button must say so rather than open onto nothing.
		const host = await renderHeader(
			snapshot({
				session: undefined,
				availableCommands: [{ name: "Summarize", description: "", kind: "template", invocation: "summarize" }],
			}),
		);

		const button = host.querySelector<HTMLButtonElement>('.piem-chat__header-actions button[aria-label="More chat actions"]');
		expect(button?.disabled).toBe(true);
	});
});

function snapshot(overrides: Partial<ChatSnapshot> = {}): ChatSnapshot {
	return {
		messages: [],
		isStreaming: false,
		pendingToolCalls: [],
		provider: "deepseek",
		modelId: "deepseek-v4-pro",
		runningModelId: "deepseek-v4-pro",
		thinkingLevel: "high",
		thinkingLevels: ["off", "low", "high"],
		modelChoices: [],
		sessionRevision: 0,
		sessionRunStates: [],
		usage: usageTotals(),
		contextFill: fill(),
		isCompacting: false,
		compactionEvent: null,
		compactionRetained: 0,
		isRewinding: false,
		// The metrics these tests assert on live behind the agent-details tier.
		showAgentDetails: true,
		traceExpand: "collapsed",
		mobileComposerCollapsed: false,
		language: "en",
		sendShortcut: "enter",
		contextRefs: [],
		isFollowingActiveNote: true,
		availableCommands: [],
		queuedPrompts: [],
		...overrides,
	};
}

function fill(overrides: Partial<ContextFill> = {}): ContextFill {
	return {
		tokens: 12_400,
		contextWindow: 1_000_000,
		ratio: 0.0124,
		compactionRatio: (1_000_000 - 16_384) / 1_000_000,
		heuristicOnly: true,
		...overrides,
	};
}

/**
 * A stored session, as the header reads one. Only the fields the header and its
 * dialogs touch are populated; the type is structural on purpose so this does
 * not have to track unrelated additions to `ActiveSessionInfo`.
 */
function sessionInfo(id = "session-1"): ActiveSessionInfo {
	return {
		id,
		path: `/tmp/${id}.jsonl`,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		messageCount: 2,
		firstMessage: "Hello there",
	};
}

function usageTotals(): UsageTotals {
	return { tokens: 0, cost: 0, requests: 0 };
}

/**
 * One completed reply, as export's `messages.length > 0` gate reads it. Only the
 * fields the type demands are populated; the header never inspects the content.
 */
function assistantMessage(): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Here is the answer." }],
		api: "anthropic-messages",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	} as AgentMessage;
}

const roots = new WeakMap<HTMLElement, import("react-dom/client").Root>();
