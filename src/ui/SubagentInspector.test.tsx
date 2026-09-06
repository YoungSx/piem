import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { JSX } from "react";
import type { App, Component } from "obsidian";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Language } from "../i18n";
import type { SubagentSnapshot } from "../subagent/inspectorModel";
import { flushRender, installDom } from "../testUtils/dom";
import { installObsidianStub } from "../testUtils/obsidianStub";

installObsidianStub();
const document = installDom();

// Dynamic imports so the mocked `obsidian` module wins over any cached real one.
const { SubagentInspector, SubagentInspectorApp } = await import("./SubagentInspector");
const { TranslatorProvider } = await import("./TranslatorContext");
const { createRoot } = await import("react-dom/client");

/**
 * The subagent monitor's markup contract.
 *
 * Three of these assertions are the feature's design commitments rather than its
 * behaviour — stop without steering, no reply channel, nothing persisted — and
 * they are here because each names a boundary. A boundary is exactly what a
 * later well-meaning edit crosses ("the panel should also let you redirect a
 * child"), and nothing else in the codebase would object. Stop exists since the
 * monitor got a circuit breaker; a reply box did not and must not.
 *
 * Every mount is unmounted rather than detached. Detaching leaves the React root
 * alive with its document-level listeners still registered, which is how
 * `ContextGauge.test.tsx` ended up with a dismissal test that passes alone and
 * fails in file order.
 */

const app = {} as App;
const component = {} as Component;
const mounted: Array<() => void> = [];

async function render(node: JSX.Element, language: Language = "en"): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.push(() => {
		root.unmount();
		host.remove();
	});
	root.render(<TranslatorProvider language={language}>{node}</TranslatorProvider>);
	await flushRender();
	return host;
}

async function renderInspector(
	overrides: Partial<Parameters<typeof SubagentInspector>[0]> = {},
	language: Language = "en",
): Promise<HTMLElement> {
	return render(
		<SubagentInspector
			snapshots={[]}
			// The fixture's own conversation, so the default scope — this chat only —
			// shows the snapshots a test hands it rather than filtering them all out.
			focusedOwnerId="chat-a"
			describeOwner={(ownerId) => `chat named ${ownerId}`}
			showAllChats={false}
			onShowAllChats={() => undefined}
			showAgentDetails={false}
			selectedId={null}
			onSelect={() => undefined}
			onStop={() => undefined}
			onStopChat={() => undefined}
			onStopEverything={() => undefined}
			onArchiveFinished={() => undefined}
			app={app}
			component={component}
			{...overrides}
		/>,
		language,
	);
}

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
	return {
		id: "subagent-1",
		role: "scout",
		task: "Sweep Projects/ for stale notes",
		depth: 1,
		ownerId: "chat-a",
		modelId: "deepseek-v4-pro",
		thinkingLevel: "off",
		status: "done",
		spawnedAt: 1_000,
		settledAt: 4_000,
		durationMs: 3_000,
		report: "Three notes are stale.",
		turns: 2,
		usage: { tokens: 12_400, cost: 0.42, requests: 3 },
		messages: [],
		...overrides,
	};
}

function text(host: HTMLElement): string {
	return host.textContent ?? "";
}

/** Row titles in the live list — the child combinator excludes the archived section's own list. */
function currentTasks(host: HTMLElement): string[] {
	return Array.from(
		host.querySelectorAll(".piem-subagents > .piem-subagents__list .piem-subagents__row-task"),
		(node) => node.textContent ?? "",
	);
}

/** Row titles inside the archived disclosure. */
function archivedTasks(host: HTMLElement): string[] {
	return Array.from(
		host.querySelectorAll(".piem-subagents__archived .piem-subagents__row-task"),
		(node) => node.textContent ?? "",
	);
}

describe("one-way glass with a pressure valve", () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(async () => {
		while (mounted.length > 0) {
			mounted.pop()?.();
		}
		await flushRender();
	});

	it("stops a running child from its detail page, without confirmation", async () => {
		/*
		 * Rule 1 as it now stands: the user's circuit breaker, not the parent's
		 * monopoly. No confirmation because the partial report survives as
		 * incomplete — that is the undo — and the detail page is where the reader
		 * who has watched a run go sideways already is.
		 */
		const stops: string[] = [];
		const host = await renderInspector({
			snapshots: [snapshot({ status: "running", report: undefined })],
			selectedId: "subagent-1",
			onStop: (id) => stops.push(id),
		});
		const stop = host.querySelector<HTMLButtonElement>(".piem-subagents__detail-stop button");

		expect(stop).not.toBeNull();
		expect(stop!.getAttribute("aria-label")).toBe("Stop this run");
		stop!.click();
		expect(stops).toEqual(["subagent-1"]);
	});

	it("offers no stop on a settled detail page — the run is over, there is nothing to stop", async () => {
		const host = await renderInspector({ snapshots: [snapshot()], selectedId: "subagent-1" });

		expect(host.querySelector(".piem-subagents__detail-stop")).toBeNull();
	});

	it("stops everything running from the list, and only then", async () => {
		// One control for the whole fan-out, next to the sentence that says stopping
		// is possible — and absent against a finished history, where it could only
		// ever do nothing.
		let stopAllCalls = 0;
		const running = await renderInspector({ snapshots: [snapshot({ status: "running", report: undefined }), snapshot({ id: "b" })], onStopChat: () => (stopAllCalls += 1) });
		const stopAll = running.querySelector<HTMLButtonElement>(".piem-subagents__stop-all");

		expect(stopAll).not.toBeNull();
		stopAll!.click();
		expect(stopAllCalls).toBe(1);

		const settled = await renderInspector({ snapshots: [snapshot()] });
		expect(settled.querySelector(".piem-subagents__stop-all")).toBeNull();
	});

	it("offers no way to talk to a child", async () => {
		/*
		 * Rule 2: watch, do not talk. A subagent's isolation is what makes its
		 * report trustworthy — it cannot see this conversation, so its answer is a
		 * function of its task alone. A reply box would break that quietly.
		 */
		const host = await renderInspector({ snapshots: [snapshot()], selectedId: "subagent-1" });

		expect(host.querySelector("textarea")).toBeNull();
		expect(host.querySelector("input")).toBeNull();
		expect(host.querySelector("form")).toBeNull();
	});

	it("says what the panel does and does not do, since a missing control is otherwise ambiguous", async () => {
		// Both halves matter: "you can stop" invites the reader who wants the
		// circuit breaker, "not talk" preempts the one hunting for a reply box.
		const host = await renderInspector({ snapshots: [snapshot()] });

		expect(text(host)).toContain("You can stop a run from here");
		expect(text(host)).toContain("not talk to it");
	});
});

describe("the list is a record, read forward", () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(async () => {
		while (mounted.length > 0) {
			mounted.pop()?.();
		}
		await flushRender();
	});

	it("explains itself when empty rather than looking broken", async () => {
		// A monitor for a feature the user may never have knowingly triggered has
		// to say what would put something here.
		const host = await renderInspector();

		expect(text(host)).toContain("No subagents yet");
		expect(text(host)).toContain("hands a task to a subagent");
	});

	it("keeps spawn order rather than floating the newest to the top", async () => {
		// The third subagent's task usually only makes sense after the first one's
		// report, so the record reads forward.
		const host = await renderInspector({
			snapshots: [snapshot({ id: "a", task: "First task" }), snapshot({ id: "b", task: "Second task" })],
		});
		const tasks = Array.from(host.querySelectorAll(".piem-subagents__row-task"), (node) => node.textContent);

		expect(tasks).toEqual(["First task", "Second task"]);
	});

	it("titles a row with its task, which is what the reader remembers", async () => {
		// "scout" describes three of them and `subagent-2` describes none.
		const host = await renderInspector({ snapshots: [snapshot()] });

		expect(host.querySelector(".piem-subagents__row-task")?.textContent).toBe("Sweep Projects/ for stale notes");
	});

	it("carries the status in words, not only in the dot's colour", async () => {
		// WCAG 1.4.1: a colour-blind reader has to be able to tell a failure from a
		// finish, and an 8px dot alone cannot do that.
		const host = await renderInspector({ snapshots: [snapshot({ status: "failed" })] });

		expect(host.querySelector(".piem-subagents__row-status")?.textContent).toBe("failed");
		expect(host.querySelector(".piem-subagents__dot--failed")).not.toBeNull();
	});

	it("hides the dot from assistive tech, since the word beside it already said it", async () => {
		const host = await renderInspector({ snapshots: [snapshot()] });

		expect(host.querySelector(".piem-subagents__dot")?.getAttribute("aria-hidden")).toBe("true");
	});

	it("names a row for a screen reader by its task, since the role can be a paragraph of identical ones", async () => {
		const host = await renderInspector({ snapshots: [snapshot({ status: "running" })] });

		expect(host.querySelector(".piem-subagents__row")?.getAttribute("aria-label")).toBe("Sweep Projects/ for stale notes — open run");
	});
});

describe("putting finished runs away", () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(async () => {
		while (mounted.length > 0) {
			mounted.pop()?.();
		}
		await flushRender();
	});

	it("offers the archive control only while a finished run could move", async () => {
		// The mirror of stop-all: a control that could only ever do nothing is not
		// worth the reader's attention. Here that is a list with nothing finished in
		// it, and a list whose finished runs are already away.
		let archived = 0;
		const withFinished = await renderInspector({
			snapshots: [snapshot({ status: "running", report: undefined }), snapshot({ id: "b" })],
			onArchiveFinished: () => (archived += 1),
		});
		const archive = withFinished.querySelector<HTMLButtonElement>(".piem-subagents__archive");

		expect(archive).not.toBeNull();
		expect(archive!.getAttribute("aria-label")).toBe("Archive every run that has finished");
		archive!.click();
		expect(archived).toBe(1);

		const onlyRunning = await renderInspector({ snapshots: [snapshot({ status: "running", report: undefined })] });
		expect(onlyRunning.querySelector(".piem-subagents__archive")).toBeNull();

		const alreadyAway = await renderInspector({ snapshots: [snapshot({ archived: true })] });
		expect(alreadyAway.querySelector(".piem-subagents__archive")).toBeNull();
	});

	it("moves an archived run into a closed section instead of dropping it", async () => {
		/*
		 * Archiving is not deleting, and this is the assertion that says so. The
		 * panel is the only window onto a record that dies with the session, and the
		 * parent may still be about to collect a report the reader has read and put
		 * away — so the run has to stay reachable, and the section it moves to has
		 * to start closed or the tidying bought nothing.
		 */
		const host = await renderInspector({
			snapshots: [snapshot({ id: "a", task: "Still open" }), snapshot({ id: "b", task: "Put away", archived: true })],
		});
		const details = host.querySelector<HTMLDetailsElement>(".piem-subagents__archived");

		expect(currentTasks(host)).toEqual(["Still open"]);
		expect(archivedTasks(host)).toEqual(["Put away"]);
		expect(details).not.toBeNull();
		expect(details!.open).toBe(false);
		expect(text(host)).toContain("1 run(s)");
	});

	it("opens an archived run's detail from inside the section", async () => {
		const opened: Array<string | null> = [];
		const host = await renderInspector({
			snapshots: [snapshot({ id: "b", task: "Put away", archived: true })],
			onSelect: (id) => opened.push(id),
		});
		host.querySelector<HTMLButtonElement>(".piem-subagents__archived .piem-subagents__row")!.click();

		expect(opened).toEqual(["b"]);
	});

	it("says where the runs went rather than claiming there are none", async () => {
		// "No subagents yet" would be a lie told to the one reader who knows
		// better, having just archived them — and a closed section reads as an
		// absence unless something points at it.
		const host = await renderInspector({ snapshots: [snapshot({ archived: true })] });

		expect(text(host)).not.toContain("No subagents yet");
		expect(text(host)).toContain("Every run is archived");
		expect(host.querySelector(".piem-subagents__archived")).not.toBeNull();
	});

	it("still says nothing ever happened when nothing ever did", async () => {
		const host = await renderInspector();

		expect(text(host)).toContain("No subagents yet");
		expect(host.querySelector(".piem-subagents__archived")).toBeNull();
	});
});

describe("the detail page answers in the order a reader asks", () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(async () => {
		while (mounted.length > 0) {
			mounted.pop()?.();
		}
		await flushRender();
	});

	it("replaces the list rather than sitting beside it", async () => {
		// Two panes in a ~300px sidebar would each land near 150px, where a task
		// sentence wraps every three words.
		const host = await renderInspector({ snapshots: [snapshot()], selectedId: "subagent-1" });

		expect(host.querySelector(".piem-subagents__list")).toBeNull();
		expect(host.querySelector(".piem-subagents__detail")).not.toBeNull();
	});

	it("puts the caveat above the report, not under it", async () => {
		// A caveat under 400 words of findings arrives after the reader has already
		// believed them.
		const host = await renderInspector({
			snapshots: [snapshot({ status: "incomplete", incomplete: true })],
			selectedId: "subagent-1",
		});
		const caveat = host.querySelector(".piem-subagents__caveat");
		const report = host.querySelector(".piem-subagents__section:last-of-type");

		expect(caveat).not.toBeNull();
		expect(caveat!.compareDocumentPosition(report!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
	});

	it("shows the failure message where a failed run has no report to show", async () => {
		const host = await renderInspector({
			snapshots: [snapshot({ status: "failed", report: undefined, errorMessage: "vault exploded", turns: undefined, usage: undefined })],
			selectedId: "subagent-1",
		});

		expect(host.querySelector(".piem-subagents__error")?.textContent).toBe("vault exploded");
		expect(text(host)).toContain("failed before writing a report");
	});

	it("keeps the process record closed, since it is the longest and least-asked part", async () => {
		const messages = [{ role: "user", content: "Sweep", timestamp: 1 }] as AgentMessage[];
		const host = await renderInspector({ snapshots: [snapshot({ messages })], selectedId: "subagent-1" });
		const details = host.querySelector<HTMLDetailsElement>(".piem-subagents__process");

		expect(details).not.toBeNull();
		expect(details!.open).toBe(false);
		expect(text(host)).toContain("1 step(s)");
	});

	it("words a failed run's empty transcript as nothing recorded, not as a clean process", async () => {
		// The failure path throws, so the registry keeps the error but not the
		// messages. Pretending otherwise would be the one dishonest reading.
		const host = await renderInspector({
			snapshots: [snapshot({ status: "failed", messages: [], report: undefined, errorMessage: "boom" })],
			selectedId: "subagent-1",
		});

		expect(text(host)).toContain("Nothing recorded");
	});

	it("promises the transcript to a still-running child rather than calling it missing", async () => {
		const host = await renderInspector({
			snapshots: [snapshot({ status: "running", messages: [], report: undefined, turns: undefined, usage: undefined })],
			selectedId: "subagent-1",
		});

		expect(text(host)).toContain("kept when the run ends");
	});

	it("hands focus to the back control, which is what replaced the row that was pressed", async () => {
		// Arriving here unmounted the list, which drops focus to `<body>` and costs
		// a keyboard reader their place.
		const host = await renderInspector({ snapshots: [snapshot()], selectedId: "subagent-1" });

		expect(document.activeElement).toBe(host.querySelector(".piem-subagents__detail-bar button"));
	});

	it("falls back to the list when the selected run is gone", async () => {
		// A rebuilt service means a rebuilt registry, and there is no honest detail
		// page for a run that no longer exists.
		const host = await renderInspector({ snapshots: [snapshot({ id: "other" })], selectedId: "subagent-1" });

		expect(host.querySelector(".piem-subagents__list")).not.toBeNull();
	});

	it("omits the standing-instructions block when the spawn passed none", async () => {
		const host = await renderInspector({ snapshots: [snapshot()], selectedId: "subagent-1" });

		expect(text(host)).not.toContain("Standing instructions");
	});

	it("shows standing instructions when there were some", async () => {
		const host = await renderInspector({
			snapshots: [snapshot({ instructions: "Answer in one paragraph." })],
			selectedId: "subagent-1",
		});

		expect(host.querySelector(".piem-subagents__instructions")?.textContent).toBe("Answer in one paragraph.");
	});

	it("shows the later errands under the first, in the order they were given", async () => {
		/*
		 * A re-tasked child has a history, and the reader needs to know Piem asked
		 * again — the panel forbids *them* talking to a child, so an extra
		 * instruction can only have come from the chat, and a report that answers
		 * something the task never asked would otherwise read as a wandering child.
		 * The row's title and the task paragraph stay the spawn task: that is what
		 * the reader remembers asking for.
		 */
		const host = await renderInspector({
			snapshots: [snapshot({ followUps: ["Which are in Archive/?", "Now check Inbox/."] })],
			selectedId: "subagent-1",
		});
		const later = Array.from(host.querySelectorAll(".piem-subagents__followups li"), (node) => node.textContent);

		expect(host.querySelector(".piem-subagents__task")?.textContent).toBe("Sweep Projects/ for stale notes");
		expect(text(host)).toContain("Then Piem asked for:");
		expect(later).toEqual(["Which are in Archive/?", "Now check Inbox/."]);
	});

	it("says nothing about later errands when there were none", async () => {
		const host = await renderInspector({ snapshots: [snapshot()], selectedId: "subagent-1" });

		expect(text(host)).not.toContain("Then Piem asked for");
		expect(host.querySelector(".piem-subagents__followups")).toBeNull();
	});

	it("keeps spend behind the agent-details tier", async () => {
		const withoutTier = await renderInspector({ snapshots: [snapshot()], selectedId: "subagent-1", showAgentDetails: false });
		const withTier = await renderInspector({ snapshots: [snapshot()], selectedId: "subagent-1", showAgentDetails: true });

		expect(text(withoutTier)).not.toContain("$0.42");
		expect(text(withTier)).toContain("$0.42");
	});
});

describe("selection requests from outside the tree", () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(async () => {
		while (mounted.length > 0) {
			mounted.pop()?.();
		}
		await flushRender();
	});

	it("opens the run the entry icon named", async () => {
		const host = await render(
			<SubagentInspectorApp
				snapshots={[snapshot({ id: "a", task: "First" }), snapshot({ id: "b", task: "Second" })]}
				showAgentDetails={false}
				selectionRequest={{ id: "b", token: 1 }}
				focusedOwnerId="chat-a"
				describeOwner={(ownerId) => `chat named ${ownerId}`}
				onStop={() => undefined}
				onStopChat={() => undefined}
				onStopEverything={() => undefined}
				onArchiveFinished={() => undefined}
				app={app}
				component={component}
			/>,
		);

		expect(host.querySelector(".piem-subagents__detail")).not.toBeNull();
		expect(text(host)).toContain("Second");
	});

	it("starts on the list when nothing asked for a run", async () => {
		const host = await render(
			<SubagentInspectorApp
				snapshots={[snapshot()]}
				showAgentDetails={false}
				selectionRequest={null}
				focusedOwnerId="chat-a"
				describeOwner={(ownerId) => `chat named ${ownerId}`}
				onStop={() => undefined}
				onStopChat={() => undefined}
				onStopEverything={() => undefined}
				onArchiveFinished={() => undefined}
				app={app}
				component={component}
			/>,
		);

		expect(host.querySelector(".piem-subagents__list")).not.toBeNull();
	});
});

describe("the panel spans every chat and says which one it is showing", () => {
	it("shows only the focused chat by default, and offers the rest", async () => {
		const host = await renderInspector({
			snapshots: [snapshot({ id: "mine", task: "Sweep mine" }), snapshot({ id: "theirs", task: "Sweep theirs", ownerId: "chat-b" })],
		});

		expect(text(host)).toContain("Sweep mine");
		expect(text(host)).not.toContain("Sweep theirs");
		// The toggle is the only thing that says the other run exists at all, so it
		// has to be present the moment one does.
		expect(host.querySelector(".piem-subagents__scope")).not.toBeNull();
	});

	it("keeps the toggle away when every run belongs to the focused chat", async () => {
		const host = await renderInspector({ snapshots: [snapshot({ id: "a" }), snapshot({ id: "b" })] });

		// Nothing to switch to: a control whose two states render the same list is
		// a question the reader cannot answer wrongly, and should not be asked.
		expect(host.querySelector(".piem-subagents__scope")).toBeNull();
	});

	it("names the other chats' runs in the empty state rather than reading as quiet", async () => {
		const host = await renderInspector({ snapshots: [snapshot({ ownerId: "chat-b", status: "running" })] });

		// The failure this replaces: an empty panel while a background chat's
		// subagent is working, which reads as "nothing is running".
		expect(text(host)).toContain("Nothing was handed off in this chat");
		expect(text(host)).toContain("1");
		expect(host.querySelector(".piem-subagents__scope")).not.toBeNull();
	});

	it("groups by chat with the focused one first, and names each group", async () => {
		const host = await renderInspector({
			showAllChats: true,
			snapshots: [
				snapshot({ id: "theirs", task: "Sweep theirs", ownerId: "chat-b" }),
				snapshot({ id: "mine", task: "Sweep mine" }),
			],
		});

		const names = Array.from(host.querySelectorAll(".piem-subagents__group-name")).map((node) => node.textContent);
		// Focused first even though its run was spawned second: a reader who opened
		// the panel from a chat is almost always asking about that chat.
		expect(names).toEqual(["This chat", "chat named chat-b"]);
		expect(text(host)).toContain("Sweep mine");
		expect(text(host)).toContain("Sweep theirs");
	});

	it("gives each group a stop that can only reach its own chat", async () => {
		const stopped: string[] = [];
		const host = await renderInspector({
			showAllChats: true,
			onStopChat: (ownerId) => stopped.push(ownerId),
			snapshots: [
				snapshot({ id: "mine", status: "running", report: undefined }),
				snapshot({ id: "theirs", status: "running", report: undefined, ownerId: "chat-b" }),
			],
		});

		const groupStops = Array.from(host.querySelectorAll<HTMLButtonElement>(".piem-subagents__group-head .piem-subagents__stop-all"));
		expect(groupStops).toHaveLength(2);
		groupStops[1]!.click();
		// The second group's button reached the second group's chat, and nothing else.
		expect(stopped).toEqual(["chat-b"]);
	});

	it("states the reach of the unscoped stop instead of calling it 'all'", async () => {
		let everything = 0;
		const host = await renderInspector({
			showAllChats: true,
			onStopEverything: () => (everything += 1),
			snapshots: [
				snapshot({ id: "mine", status: "running", report: undefined }),
				snapshot({ id: "theirs", status: "running", report: undefined, ownerId: "chat-b" }),
			],
		});

		const noticeStop = host.querySelector<HTMLButtonElement>(".piem-subagents__notice .piem-subagents__stop-all");
		// "Stop all" beside three chats' rows is the label that ends work the reader
		// never thought about; the count and the chat count are the fence.
		expect(noticeStop?.textContent).toBe("Stop all 2 (2 chats)");
		noticeStop!.click();
		expect(everything).toBe(1);
	});

	it("attributes a detail page only when the run belongs to another chat", async () => {
		const mine = await renderInspector({ snapshots: [snapshot()], selectedId: "subagent-1" });
		expect(text(mine)).not.toContain("Ordered by");

		const theirs = await renderInspector({
			snapshots: [snapshot({ ownerId: "chat-b" })],
			showAllChats: true,
			selectedId: "subagent-1",
		});
		// Without this line, a run reached from the All chats list is
		// indistinguishable from the reader's own — and the stop button in the bar
		// above it would be pressed against a chat they were not thinking about.
		expect(text(theirs)).toContain("Ordered by chat named chat-b");
	});

	it("switches scope from the toggle, and starts scoped on every open", async () => {
		const host = await render(
			<SubagentInspectorApp
				snapshots={[snapshot({ id: "theirs", task: "Sweep theirs", ownerId: "chat-b" })]}
				focusedOwnerId="chat-a"
				describeOwner={(ownerId) => `chat named ${ownerId}`}
				showAgentDetails={false}
				selectionRequest={null}
				onStop={() => undefined}
				onStopChat={() => undefined}
				onStopEverything={() => undefined}
				onArchiveFinished={() => undefined}
				app={app}
				component={component}
			/>,
		);

		// Opens on the focused chat, which has delegated nothing.
		expect(text(host)).not.toContain("Sweep theirs");

		const allChatsOption = (): HTMLButtonElement =>
			Array.from(host.querySelectorAll<HTMLButtonElement>(".piem-subagents__scope-option"))[1]!;
		const pressed = allChatsOption();
		pressed.click();
		await flushRender();

		expect(text(host)).toContain("Sweep theirs");
		expect(allChatsOption().getAttribute("aria-pressed")).toBe("true");
		// The toggle survives its own press rather than being rebuilt by it, which is
		// what keeps a keyboard reader on the control they just used.
		expect(allChatsOption()).toBe(pressed);
	});
});
