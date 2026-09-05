import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { App, Component } from "obsidian";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { PendingToolCall } from "../agent/ObsidianAgentService";
import type { createRoot } from "react-dom/client";
import { flushRender, installDom } from "../testUtils/dom";
import { installObsidianStub, markdownRenderMock, setTooltipMock } from "../testUtils/obsidianStub";

installObsidianStub();
const document = installDom();

// Dynamic imports so the mocked `obsidian` module wins over any cached real one.
const { MessageList } = await import("./MessageList");
const { createRoot: createRootImpl } = await import("react-dom/client");

let createRootSync: typeof createRoot;

const app = {} as App;
const component = {} as Component;

function renderMessages(
	messages: Parameters<typeof MessageList>[0]["messages"],
	overrides: Partial<Parameters<typeof MessageList>[0]> = {},
): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = roots.get(host) ?? createRootSync(host);
	roots.set(host, root);
	root.render(
		<MessageList
			messages={messages}
			isStreaming={false}
			pendingToolCalls={[]}
			app={app}
			component={component}
			sourcePath=""
			{...overrides}
		/>,
	);
	return host;
}

beforeEach(() => {
	callIds.clear();
	resultIds.clear();
	createRootSync = createRootImpl;
	markdownRenderMock.mockReset();
	markdownRenderMock.mockImplementation(async ({ el }: { el: HTMLElement }) => {
		const rendered = document.createElement("p");
		rendered.className = "stub-rendered";
		el.appendChild(rendered);
	});
});

afterEach(() => {
	document.body.replaceChildren();
});

describe("MessageList tidying seam", () => {
	it("draws the settled tidy as a seam row, not as a message bubble", async () => {
		const host = renderMessages([compactionSummary("Summary of everything earlier")]);
		await flushRender();

		const seam = host.querySelector("details.piem-chat__trace--seam");
		expect(seam).not.toBeNull();
		expect(seam?.querySelector(".piem-chat__trace-name")?.textContent).toBe("Thoughts tidied");
		expect(seam?.textContent).toContain("Summary of everything earlier");
		// Not modelled as a normal message card.
		expect(host.querySelector("article.piem-chat__message--compactionSummary")).toBeNull();
	});

	it("keeps the summary text verbatim instead of running it through Markdown", async () => {
		renderMessages([compactionSummary("**not** markdown #heading")]);
		await flushRender();

		expect(markdownRenderMock).toHaveBeenCalledTimes(0);
		const text = document.querySelector(".piem-chat__trace--seam .piem-chat__text");
		expect(text?.textContent).toBe("**not** markdown #heading");
	});

	// It rode on `harness` to stay verbatim, and inherited that kind's monospace with
	// it: sentences set in the font reserved for bash output.
	it("sets the summary in the prose face, not the monospace one harness output gets", async () => {
		renderMessages([compactionSummary("Summary of everything earlier")]);
		await flushRender();

		const text = document.querySelector(".piem-chat__trace--seam .piem-chat__text");
		expect(text?.classList.contains("piem-chat__text--prose")).toBe(true);
		expect(text?.classList.contains("piem-chat__text--machine")).toBe(false);
	});

	it("draws a tidy in flight at the tail, where the reader is watching", async () => {
		// The wait used to be reported in the status bar above the composer while its
		// outcome appeared as a divider further up the transcript. One row now, at the
		// position the next state change will keep.
		const host = renderMessages([userMessage("Audit my reading list")], {
			compactionEvent: { state: "running", anchor: 1 },
		});
		await flushRender();

		const rows = Array.from(host.querySelectorAll(".piem-chat__message, .piem-chat__trace"));
		const seam = host.querySelector(".piem-chat__trace--seam");
		expect(seam).not.toBeNull();
		expect(rows.at(-1)).toBe(seam ?? undefined);
		expect(seam?.querySelector(".piem-chat__trace-name")?.textContent).toBe("Tidying thoughts…");
		// Nothing to reveal yet, so no disclosure affordance pointing at nothing.
		expect(seam?.tagName.toLowerCase()).toBe("div");
		expect(seam?.className).toContain("piem-chat__trace--live");
	});

	it("reports a failed tidy on the row the attempt already occupied", async () => {
		const host = renderMessages([userMessage("Audit my reading list")], {
			compactionEvent: { state: "failed", anchor: 1, error: "429 slow down" },
		});
		await flushRender();

		const seam = host.querySelector("details.piem-chat__trace--seam");
		expect(seam?.className).toContain("piem-chat__trace--seam-failed");
		expect(seam?.querySelector(".piem-chat__trace-name")?.textContent).toBe("Could not tidy thoughts");
		expect(seam?.querySelector(".piem-chat__cutoff-raw")?.textContent).toBe("429 slow down");
	});

	it("draws the settled seam after the tail it kept, not at the head pi files it under", async () => {
		// pi puts the summary at index 0 because that is what replaces the history in
		// the request; the tidy itself ran once those retained turns had happened.
		const host = renderMessages(
			[compactionSummary("Earlier turns"), userMessage("kept question"), assistantMessage("kept reply"), userMessage("asked afterwards")],
			{ compactionRetained: 2 },
		);
		await flushRender();

		const rows = Array.from(host.querySelectorAll(".piem-chat__message, .piem-chat__trace"));
		const seam = host.querySelector(".piem-chat__trace--seam");
		expect(rows).toHaveLength(4);
		// Two retained turns above it, the question that arrived afterwards below.
		expect(rows.indexOf(seam as Element)).toBe(2);
		expect(rows.at(-1)?.className).toContain("piem-chat__message--user");
	});

	it("announces running tools as a status region, in the reader's vocabulary", async () => {
		const host = renderMessages([]);
		await flushRender();
		// Re-render with pending tools through the same host.
		const root = roots.get(host)!;
		root.render(
			<MessageList messages={[]} isStreaming={false} pendingToolCalls={[pendingCall("read"), pendingCall("grep")]} app={app} component={component} sourcePath="" />,
		);
		await flushRender();

		const status = host.querySelector(".piem-chat__tool-status");
		expect(status?.getAttribute("role")).toBe("status");
		expect(status?.textContent).toContain("Working: Read a note, Searched the vault");
	});

	it("keeps raw tool ids in the running-tools status when agent details are shown", async () => {
		const host = renderMessages([]);
		await flushRender();
		const root = roots.get(host)!;
		root.render(
			<MessageList
				messages={[]}
				isStreaming={false}
				pendingToolCalls={[pendingCall("read"), pendingCall("grep")]}
				showAgentDetails
				app={app}
				component={component}
				sourcePath=""
			/>,
		);
		await flushRender();

		expect(host.querySelector(".piem-chat__tool-status")?.textContent).toContain("Working: read, grep");
	});
});

describe("MessageList announcements", () => {
	it("keeps the transcript out of the live region, so a streaming turn is not re-read per token", async () => {
		const host = renderMessages([assistantMessage("partial")], { isStreaming: true });
		await flushRender();

		const log = host.querySelector(".piem-chat__messages");
		expect(log?.getAttribute("role")).toBe("log");
		expect(log?.hasAttribute("aria-live")).toBe(false);
		expect(log?.hasAttribute("aria-relevant")).toBe(false);
	});

	it("stays silent while the turn is still streaming", async () => {
		const host = renderMessages([assistantMessage("half a th")], { isStreaming: true });
		await flushRender();

		expect(host.querySelector(".piem-chat__visually-hidden")?.textContent).toBe("");
	});

	it("announces the settled reply once, without its thinking or tool traffic", async () => {
		const host = renderMessages([
			{ ...assistantMessage("Here is the answer."), content: [{ type: "thinking", thinking: "weighing" }, { type: "text", text: "Here is the answer." }] },
		]);
		await flushRender();

		const announcer = host.querySelector(".piem-chat__visually-hidden");
		expect(announcer?.getAttribute("aria-live")).toBe("polite");
		expect(announcer?.textContent).toBe("Here is the answer.");
	});

	it("says the reply was stopped, so silence is not read as completion", async () => {
		const host = renderMessages([assistantMessage("half a th", { stopReason: "aborted" })]);
		await flushRender();

		expect(host.querySelector(".piem-chat__visually-hidden")?.textContent).toContain("you stopped this reply");
	});
});

describe("MessageList empty state", () => {
	it("offers a settings action rather than printing the path, when the host can open it", async () => {
		const host = renderMessages([], { isConfigured: false, onOpenSettings: () => undefined });
		await flushRender();

		expect(host.querySelector(".piem-chat__empty-action")?.textContent).toBe("Add an API key");
	});

	it("falls back to naming the settings path when the host cannot open it", async () => {
		const host = renderMessages([], { isConfigured: false });
		await flushRender();

		expect(host.querySelector(".piem-chat__empty-action")).toBeNull();
		expect(host.querySelector(".piem-chat__empty")?.textContent).toContain("Settings → Piem");
	});

	it("names what the agent can do instead of only inviting a conversation", async () => {
		const host = renderMessages([]);
		await flushRender();

		const empty = host.querySelector(".piem-chat__empty")?.textContent ?? "";
		expect(empty).toContain("read, search, and edit notes");
		expect(empty).toContain("Ask about selection");
	});

	it("shows a skeleton while opening, not a spinner parked in the content area", async () => {
		const host = renderMessages([], { isInitializing: true });
		await flushRender();

		const skeleton = host.querySelector(".piem-chat__skeleton");
		expect(skeleton?.getAttribute("role")).toBe("status");
		expect(skeleton?.getAttribute("aria-label")).toBe("Opening chat");
		expect(skeleton?.querySelectorAll(".piem-chat__skeleton-line").length).toBeGreaterThan(0);
	});
});

describe("MessageList message chrome", () => {
	beforeEach(() => {
		createRootSync = createRootImpl;
		markdownRenderMock.mockReset();
		markdownRenderMock.mockImplementation(async ({ el }: { el: HTMLElement }) => {
			const rendered = document.createElement("p");
			rendered.className = "stub-rendered";
			el.appendChild(rendered);
		});
	});

	afterEach(() => {
		document.body.replaceChildren();
	});

	it("names the speaker on the card itself rather than printing a role banner", async () => {
		const host = renderMessages([userMessage("hi"), assistantMessage("hello")]);
		await flushRender();

		// The avatar glyph and the word "You" spent a line per turn restating what
		// side and fill already say. The role moved onto the accessible name, so a
		// screen reader still gets it while the transcript stops paying for it.
		expect(host.querySelector(".piem-chat__message-role")).toBeNull();
		const names = Array.from(host.querySelectorAll("article.piem-chat__message"), (el) => el.getAttribute("aria-label"));
		expect(names).toEqual(["You", "Piem"]);
	});

	it("gives card chrome to conversation only, so a tool result never nests inside one", async () => {
		const host = renderMessages([userMessage("hi"), toolResult({})]);
		await flushRender();

		expect(host.querySelectorAll("article.piem-chat__message")).toHaveLength(1);
		expect(host.querySelector("article.piem-chat__message--user")).not.toBeNull();
		expect(host.querySelector("details.piem-chat__trace--result")).not.toBeNull();
		// A trace must never live inside a message card; that was the nested-card bug.
		expect(host.querySelector("article.piem-chat__message .piem-chat__trace")).toBeNull();
	});

	it("marks an aborted assistant turn so half-written text is not read as complete", async () => {
		const host = renderMessages([assistantMessage("half a th", { stopReason: "aborted" })]);
		await flushRender();

		expect(host.querySelector(".piem-chat__interrupted")?.textContent).toContain("You stopped this reply.");
	});

	it("leaves a settled assistant turn unmarked", async () => {
		const host = renderMessages([assistantMessage("all done")]);
		await flushRender();

		expect(host.querySelector(".piem-chat__interrupted")).toBeNull();
	});

	it("attributes unknown harness roles to the system, never to the model", async () => {
		const host = renderMessages([harnessMessage("injected by the harness")]);
		await flushRender();

		const trace = host.querySelector("details.piem-chat__trace--harness");
		expect(trace?.querySelector(".piem-chat__trace-name")?.textContent).toBe("System");
		expect(trace?.textContent).not.toContain("Piem");
	});
});

/**
 * Image content in the live transcript (issue #253).
 *
 * The persisted log swaps image blocks for placeholder text, but the agent's
 * in-memory state keeps the bytes, so a sent picture can be drawn as itself
 * for the rest of the session. A reloaded session has only the placeholder —
 * and no image block at all — so the fallback there costs nothing here.
 */
describe("MessageList image content", () => {
	beforeEach(() => {
		createRootSync = createRootImpl;
	});

	afterEach(() => {
		document.body.replaceChildren();
	});

	it("draws a sent image as the picture, not a mime-type note", async () => {
		const image = userMessage("look at this");
		image.content = [
			{ type: "text", text: "look at this" },
			{ type: "image", mimeType: "image/png", data: "aGVsbG8=" },
		];
		const host = renderMessages([image]);
		await flushRender();

		const img = host.querySelector<HTMLImageElement>(".piem-chat__image");
		expect(img?.src).toBe("data:image/png;base64,aGVsbG8=");
		expect(img?.alt).toContain("image/png");
		expect(host.textContent).not.toContain("[image: image/png]");
	});

	it("keeps the placeholder when a block has no bytes to draw", async () => {
		const image = userMessage("look");
		image.content = [{ type: "image", mimeType: "image/png", data: "" }];
		const host = renderMessages([image]);
		await flushRender();

		expect(host.querySelector(".piem-chat__image")).toBeNull();
		expect(host.textContent).toContain("[image: image/png]");
	});
});

/**
 * The gap between sending and the first token.
 *
 * Reported as "it ignored me": the prompt lands, the transcript ends on the
 * user's own message, and the only sign anything happened is a control at the
 * other end of the panel. The wait is first-token latency the plugin does not
 * control, so it is filled with a placeholder in the assistant's own position.
 */
describe("MessageList pending reply", () => {
	beforeEach(() => {
		createRootSync = createRootImpl;
	});

	afterEach(() => {
		document.body.replaceChildren();
	});

	it("holds the assistant's place while the turn has produced nothing yet", async () => {
		const host = renderMessages([userMessage("summarize my note")], { isStreaming: true });
		await flushRender();

		const pending = host.querySelector(".piem-chat__message--pending");
		// The reply is signalled as a typing indicator — three dots — rather than
		// a "Piem is replying" line, so the visible text is empty. The assistant's
		// own chrome, so it sits where the answer will appear.
		expect(pending?.querySelectorAll(".piem-chat__typing-dot").length).toBe(3);
		expect(pending?.className).toContain("piem-chat__message--assistant");
	});

	it("names the placeholder for assistive tech without announcing it", async () => {
		const host = renderMessages([userMessage("hi")], { isStreaming: true });
		await flushRender();

		const pending = host.querySelector(".piem-chat__message--pending");
		expect(pending?.getAttribute("aria-label")).toBe("Piem is replying");
		// Announcing the start as well as the finish would interrupt the user to
		// say that nothing had happened yet; `TurnAnnouncer` speaks the result.
		expect(pending?.getAttribute("aria-live")).toBeNull();
		expect(pending?.getAttribute("role")).toBeNull();
	});

	it("gives way to the first token, so it never stacks with the reply", async () => {
		const host = renderMessages([userMessage("hi"), assistantMessage("Here")], { isStreaming: true });
		await flushRender();

		expect(host.querySelector(".piem-chat__message--pending")).toBeNull();
	});

	it("gives way to a thought, which is already visible progress", async () => {
		const host = renderMessages([userMessage("hi"), assistantThinking("weighing it up")], { isStreaming: true });
		await flushRender();

		expect(host.querySelector(".piem-chat__message--pending")).toBeNull();
	});

	it("treats an assistant turn with only empty text as still pending", async () => {
		// The streaming message is appended before its first delta arrives, so the
		// empty shell must not count as something to look at.
		const host = renderMessages([userMessage("hi"), assistantMessage("")], { isStreaming: true });
		await flushRender();

		expect(host.querySelector(".piem-chat__message--pending")).not.toBeNull();
	});

	it("stands down while a tool runs, since the line above already reports it", async () => {
		const host = renderMessages([userMessage("hi")], { isStreaming: true, pendingToolCalls: [pendingCall("read")] });
		await flushRender();

		expect(host.querySelector(".piem-chat__tool-status")).not.toBeNull();
		expect(host.querySelector(".piem-chat__message--pending")).toBeNull();
	});

	it("shows nothing once the turn has settled", async () => {
		const host = renderMessages([userMessage("hi"), assistantMessage("done")], { isStreaming: false });
		await flushRender();

		expect(host.querySelector(".piem-chat__message--pending")).toBeNull();
	});
});

describe("MessageList reply actions", () => {
	it("offers the note-facing actions on a settled reply, so an answer can reach a note", async () => {
		const host = renderMessages([assistantMessage("the answer")], { onRetry: () => undefined });
		await flushRender();

		const group = host.querySelector(".piem-chat__message-actions");
		expect(group?.getAttribute("role")).toBe("group");
		const labels = Array.from(group?.querySelectorAll("button") ?? [], (button) => button.getAttribute("aria-label"));
		expect(labels).toEqual(["Copy reply", "Insert at cursor", "Append to note", "Regenerate reply"]);
	});

	it("hides regenerate while a turn is in flight, rather than queueing a second run", async () => {
		const host = renderMessages([assistantMessage("the answer")]);
		await flushRender();

		const labels = Array.from(host.querySelectorAll(".piem-chat__message-actions button"), (button) => button.getAttribute("aria-label"));
		expect(labels).not.toContain("Regenerate reply");
	});

	it("shows no actions while the reply is still streaming", async () => {
		const host = renderMessages([assistantMessage("half a th")], { isStreaming: true, onRetry: () => undefined });
		await flushRender();

		expect(host.querySelector(".piem-chat__message-actions")).toBeNull();
	});

	it("shows no actions on a turn that only called tools, since there is nothing to copy", async () => {
		const host = renderMessages([assistantToolCall("read", { path: "Note.md" })], { onRetry: () => undefined });
		await flushRender();

		expect(host.querySelector(".piem-chat__message-actions")).toBeNull();
	});

	/*
	 * A tool-using turn leaves several assistant entries — one per model call. The
	 * actions row is a turn-level affordance: copy/insert under a mid-turn "let me
	 * look" would offer half a process sentence, so only the reply that closes its
	 * turn earns the row.
	 */
	it("gives the actions row to only the reply that closes its turn, not every model call inside it", async () => {
		const host = renderMessages(
			[
				userMessage("q1"),
				assistantMessage("let me look"),
				toolResultFor("read"),
				assistantMessage("the answer"),
				userMessage("q2"),
				assistantMessage("the second answer"),
			],
			{ onRetry: () => undefined },
		);
		await flushRender();

		const replies = host.querySelectorAll(".piem-chat__message--assistant");
		expect(replies).toHaveLength(3);
		// The turn-tail rows are the two answers; the process sentence above them has none.
		expect(replies[0]?.querySelector(":scope > .piem-chat__message-actions")).toBeNull();
		expect(replies[1]?.querySelector(":scope > .piem-chat__message-actions")).not.toBeNull();
		expect(replies[2]?.querySelector(":scope > .piem-chat__message-actions")).not.toBeNull();
	});

	/*
	 * The blank-row defect (#239): a provider failure before the first token leaves
	 * an assistant message with no prose, and the guard here used to be `if (!text)
	 * return null` — so the transcript grew an empty row and the retry that would
	 * fix it did not exist, on the one turn where retrying is the whole point.
	 */
	it("keeps the retry on a failed turn that produced no words", async () => {
		const host = renderMessages([assistantMessage("", { stopReason: "error", errorMessage: "504 Gateway Time-out" })], {
			onRetry: () => undefined,
		});
		await flushRender();

		const labels = Array.from(host.querySelectorAll(".piem-chat__message-actions button"), (button) =>
			button.getAttribute("aria-label"),
		);
		// Only the retry: the three note-facing actions have nothing to act on.
		expect(labels).toEqual(["Regenerate reply"]);
	});

	it("gives the user's own turn no reply actions", async () => {
		const host = renderMessages([userMessage("a question")], { onRetry: () => undefined });
		await flushRender();

		expect(host.querySelector(".piem-chat__message-actions")).toBeNull();
	});

	/*
	 * Issue #273: the fork used to ride the user's question, which read as
	 * "branch from here" about a question the reader was satisfied with. It
	 * answers "carry this exchange onward" about the reply it grows from — the
	 * same row regenerate lives on — so the question's row keeps only its edit.
	 */
	it("mounts the fork action on the reply's row, never on the question's", async () => {
		const host = renderMessages([userMessage("the question"), assistantMessage("the answer")], {
			onRetry: () => undefined,
			onFork: () => undefined,
			onEditMessage: () => undefined,
		});
		await flushRender();

		const question = host.querySelector(".piem-chat__message--user");
		const reply = host.querySelector(".piem-chat__message--assistant");
		expect(question?.querySelector('[aria-label="Fork a new chat from here"]')).toBeNull();
		expect(question?.querySelectorAll(".piem-chat__message-actions button")).toHaveLength(1);
		expect(reply?.querySelector('[aria-label="Fork a new chat from here"]')).not.toBeNull();
	});

	it("reports the message index so the regeneration re-asks the right question", async () => {
		const retried: number[] = [];
		const host = renderMessages([userMessage("q"), assistantMessage("a")], { onRetry: (index) => retried.push(index) });
		await flushRender();

		host.querySelector<HTMLButtonElement>('[aria-label="Regenerate reply"]')?.click();
		await flushRender();
		expect(retried).toEqual([1]);
	});

	it("offers regenerate on the newest reply only, since rewinding an older one discards the turns after it", async () => {
		const host = renderMessages(
			[userMessage("q1"), assistantMessage("a1"), userMessage("q2"), assistantMessage("a2")],
			{ onRetry: () => undefined },
		);
		await flushRender();

		// One button, and it is the one attached to the last reply — not merely
		// inert on the earlier one. An older reply that only ignored the click
		// would still invite it.
		const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('[aria-label="Regenerate reply"]'));
		expect(buttons).toHaveLength(1);
		const replies = Array.from(host.querySelectorAll(".piem-chat__message--assistant"));
		expect(replies).toHaveLength(2);
		expect(replies[1]?.contains(buttons[0] ?? null)).toBe(true);
	});

	it("keeps regenerate on a reply that trailing tool output follows, which is the turn worth retrying", async () => {
		// A failed tool call settles the turn with its result last. Anchoring on
		// the final entry would hide the action exactly when the reply is broken.
		const host = renderMessages([userMessage("q"), assistantMessage("a"), toolResult({ ok: false })], {
			onRetry: () => undefined,
		});
		await flushRender();

		expect(host.querySelectorAll('[aria-label="Regenerate reply"]')).toHaveLength(1);
	});

	it("withdraws regenerate once a newer question is unanswered, which rewinding would discard", async () => {
		const host = renderMessages([userMessage("q1"), assistantMessage("a1"), userMessage("q2")], {
			onRetry: () => undefined,
		});
		await flushRender();

		expect(host.querySelectorAll('[aria-label="Regenerate reply"]')).toHaveLength(0);
	});
});

describe("MessageList reply duration stamp", () => {
	it("stamps a slow reply with its duration at the actions row's right end", async () => {
		// A settled reply that took 84 seconds. The stamp text is the only
		// user-facing claim here; the tooltip is asserted separately below.
		const host = renderMessages([
			userMessage("q"),
			assistantMessage("the answer", { timestamp: 1_000, durationMs: 84_000 } as Partial<AssistantMessage>),
		]);
		await flushRender();

		const stamp = host.querySelector(".piem-chat__reply-duration");
		expect(stamp?.textContent).toBe("1:24");
	});

	it("keeps the stamp off fast replies, which answer before the reader wonders", async () => {
		const host = renderMessages([
			userMessage("q"),
			assistantMessage("the answer", { timestamp: 1_000, durationMs: 4_999 } as Partial<AssistantMessage>),
		]);
		await flushRender();

		expect(host.querySelector(".piem-chat__reply-duration")).toBeNull();
	});

	it("keeps the stamp off replies with no recorded duration, so old sessions render unchanged", async () => {
		const host = renderMessages([userMessage("q"), assistantMessage("the answer")]);
		await flushRender();

		expect(host.querySelector(".piem-chat__reply-duration")).toBeNull();
	});

	it("keeps the stamp off mid-run calls, which the trace rows already narrate", async () => {
		// The first call ended in a tool execution; the tool result follows it in
		// the transcript, and only the reply that actually answers gets a stamp.
		const host = renderMessages([
			userMessage("q"),
			assistantMessage("", { timestamp: 1_000, durationMs: 30_000 } as Partial<AssistantMessage>),
			toolResult({ ok: true }),
			assistantMessage("the answer", { timestamp: 40_000, durationMs: 30_000 } as Partial<AssistantMessage>),
		]);
		await flushRender();

		const stamps = Array.from(host.querySelectorAll(".piem-chat__reply-duration"));
		expect(stamps).toHaveLength(1);
		expect(stamps[0]?.textContent).toBe("30s");
	});

	it("states the exact instants on hover through Obsidian's tooltip", async () => {
		// Built with the local `Date` constructor so the expected instants are
		// the wall clock on any test machine, UTC offset irrelevant.
		const startedAt = new Date(2026, 8, 3, 6, 32, 8).getTime();
		// Earlier tests in this file mounted icon buttons, whose tooltips are
		// still on the mock; this test only claims the stamp's own call.
		setTooltipMock.mockClear();
		const host = renderMessages([userMessage("q"), assistantMessage("the answer", { timestamp: startedAt, durationMs: 84_000 } as Partial<AssistantMessage>)]);
		await flushRender();

		// The stub records `setTooltip` calls; the start is derived from the
		// message's own timestamp and the end from start plus duration, so the
		// instants the reader hovers for are the real ones, not reformatted
		// duration text.
		const calls = setTooltipMock.mock.calls as unknown as [element: HTMLElement, tooltip: string][];
		const stampTooltip = calls.filter(([element]) => element?.className === "piem-chat__reply-duration");
		expect(stampTooltip).toHaveLength(1);
		expect(stampTooltip[0]?.[1]).toBe("Started 06:32:08 · Ended 06:33:32");
	});
});

describe("MessageList edit action", () => {
	it("offers edit on the question the newest reply answers, and reports its index", async () => {
		const edited: number[] = [];
		const host = renderMessages([userMessage("q1"), assistantMessage("a1"), userMessage("q2"), assistantMessage("a2")], {
			onEditMessage: (index) => edited.push(index),
		});
		await flushRender();

		const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('[aria-label="Edit and resend"]'));
		expect(buttons).toHaveLength(1);
		buttons[0]?.click();
		await flushRender();
		expect(edited).toEqual([2]);
	});

	it("keeps the edit off the older questions, which a resend would discard the turns after", async () => {
		const host = renderMessages([userMessage("q1"), assistantMessage("a1"), userMessage("q2"), assistantMessage("a2")], {
			onEditMessage: () => undefined,
		});
		await flushRender();

		const questions = Array.from(host.querySelectorAll(".piem-chat__message--user"));
		expect(questions).toHaveLength(2);
		expect(questions[0]?.querySelector('[aria-label="Edit and resend"]')).toBeNull();
		expect(questions[1]?.querySelector('[aria-label="Edit and resend"]')).not.toBeNull();
	});

	it("places the edit under the bubble, not inside it, like the reply's own actions row", async () => {
		// The bubble is the card; the actions row is the row's second child. Painted
		// inside the card, the control reads as part of the message rather than as
		// a control for it — which is what Issue #169 asked to have moved.
		const host = renderMessages([userMessage("q1"), assistantMessage("a1"), userMessage("q2"), assistantMessage("a2")], {
			onEditMessage: () => undefined,
		});
		await flushRender();

		const question = host.querySelectorAll(".piem-chat__message--user")[1];
		const bubble = question?.querySelector(":scope > .piem-chat__bubble");
		expect(bubble).not.toBeNull();
		const actions = question?.querySelector(":scope > .piem-chat__message-actions");
		expect(actions).not.toBeNull();
		expect(actions?.querySelector('[aria-label="Edit and resend"]')).not.toBeNull();
	});

	it("withdraws the edit once a newer question is unanswered, which a resend would take down with it", async () => {
		const host = renderMessages([userMessage("q1"), assistantMessage("a1"), userMessage("q2")], {
			onEditMessage: () => undefined,
		});
		await flushRender();

		expect(host.querySelectorAll('[aria-label="Edit and resend"]')).toHaveLength(0);
	});

	it("renders no edit on a question that has no reply behind it to replace", async () => {
		const host = renderMessages([userMessage("a question")], { onEditMessage: () => undefined });
		await flushRender();

		expect(host.querySelector(".piem-chat__message-actions")).toBeNull();
	});

	it("gives the user turn no edit without the handler, same as the reply keeps none without onRetry", async () => {
		const host = renderMessages([userMessage("q"), assistantMessage("a")]);
		await flushRender();

		expect(host.querySelectorAll('[aria-label="Edit and resend"]')).toHaveLength(0);
	});

	it("keeps the edit out of a streaming turn, whose transcript the send would tear mid-run", async () => {
		const host = renderMessages([userMessage("q"), assistantMessage("half a th")], {
			isStreaming: true,
			onEditMessage: () => undefined,
		});
		await flushRender();

		expect(host.querySelectorAll('[aria-label="Edit and resend"]')).toHaveLength(0);
	});
});

describe("MessageList trace collapsing", () => {
	it("renders a tool call as a plain row in the default tier, since the payload is hidden", async () => {
		const host = renderMessages([assistantToolCall("read", { path: "Daily/2026-08-27.md", offset: 0 })]);
		await flushRender();

		const trace = host.querySelector(".piem-chat__trace--flat");
		expect(trace).not.toBeNull();
		// An empty disclosure would offer to open onto nothing.
		expect(host.querySelector("details.piem-chat__trace")).toBeNull();
		const name = trace?.querySelector(".piem-chat__trace-name");
		expect(name?.textContent).toBe("Read a note");
		// A translated sentence, so it is set in the interface font. The row used to
		// infer this from its variant and put every tool name in monospace.
		expect(name?.classList.contains("piem-chat__trace-name--label")).toBe(true);
		expect(trace?.querySelector(".piem-chat__trace-detail")?.textContent).toBe("Daily/2026-08-27.md");
	});

	it("collapses the raw payload behind the row once agent details are on", async () => {
		const host = renderMessages([assistantToolCall("read", { path: "Daily/2026-08-27.md", offset: 0 })], { showAgentDetails: true });
		await flushRender();

		const trace = host.querySelector("details.piem-chat__trace");
		expect(trace?.hasAttribute("open")).toBe(false);
		const name = trace?.querySelector(".piem-chat__trace-name");
		expect(name?.textContent).toBe("read");
		// A raw id here, matched character-for-character against the payload below it.
		expect(name?.classList.contains("piem-chat__trace-name--identifier")).toBe(true);
		expect(trace?.querySelector(".piem-chat__trace-body")?.textContent).toContain('"path": "Daily/2026-08-27.md"');
	});

	it("collapses thinking behind the same trace vocabulary as tool traffic", async () => {
		const host = renderMessages([assistantThinking("weighing options")]);
		await flushRender();

		const trace = host.querySelector("details.piem-chat__trace--thinking");
		expect(trace).not.toBeNull();
		expect(trace?.hasAttribute("open")).toBe(false);
	});

	it("labels thinking as in progress while the turn is still streaming", async () => {
		const host = renderMessages([assistantThinking("weighing options")], { isStreaming: true });
		await flushRender();

		const trace = host.querySelector("details.piem-chat__trace--thinking");
		// The live row carries the running marker and the present-tense label;
		// a settled "Thought it through" on a turn still going would read as done.
		expect(trace?.classList.contains("piem-chat__trace--live")).toBe(true);
		expect(trace?.querySelector(".piem-chat__trace-name")?.textContent).toBe("Thinking…");
	});

	it("opens thinking and tool rows when the expand mode is all-open", async () => {
		const host = renderMessages(
			[assistantThinking("weighing options"), assistantToolCall("read", { path: "Note.md" })],
			{ traceExpand: "expanded" },
		);
		await flushRender();

		expect(host.querySelector("details.piem-chat__trace--thinking")?.hasAttribute("open")).toBe(true);
		expect(host.querySelector("details.piem-chat__trace:not(.piem-chat__trace--result)")?.hasAttribute("open")).toBe(true);
	});

	it("keeps thinking closed but opens the diff result in the high-value mode", async () => {
		const message = assistantBase();
		const host = renderMessages(
			[
				message,
				{ ...toolResult({ diff: "+1 line" }) },
			].map((entry) => (entry === message ? assistantThinking("weighing options") : entry)),
			{ traceExpand: "highValue" },
		);
		await flushRender();

		expect(host.querySelector("details.piem-chat__trace--thinking")?.hasAttribute("open")).toBe(false);
		expect(host.querySelector("details.piem-chat__trace--result")?.hasAttribute("open")).toBe(true);
	});

	it("settles the thinking row once prose starts behind it", async () => {
		// The provider appends blocks in order, so thinking followed by text is
		// finished thinking even though the turn is still streaming — the live
		// marker belongs to the last block alone.
		const host = renderMessages([{ ...assistantBase(), content: [{ type: "thinking", thinking: "done thinking" }, { type: "text", text: "partial prose" }] }], { isStreaming: true });
		await flushRender();

		const trace = host.querySelector("details.piem-chat__trace--thinking");
		expect(trace?.classList.contains("piem-chat__trace--live")).toBe(false);
		expect(trace?.querySelector(".piem-chat__trace-name")?.textContent).toBe("Thought it through");
	});

	it("flags a failed tool result on the collapsed row", async () => {
		const host = renderMessages([{ ...toolResult({}), isError: true, content: [{ type: "text", text: "File not found." }] } as ToolResultMessage]);
		await flushRender();

		const trace = host.querySelector("details.piem-chat__trace--error");
		expect(trace).not.toBeNull();
		expect(trace?.querySelector(".piem-chat__trace-detail")?.textContent).toBe("File not found.");
		const name = trace?.querySelector(".piem-chat__trace-name");
		expect(name?.textContent).toBe("Edited a note");
		// A result row draws its own name, so it has to reach the same verdict as a
		// call row rather than deciding the typeface for itself.
		expect(name?.classList.contains("piem-chat__trace-name--label")).toBe(true);
	});
});

describe("MessageList streaming marks", () => {
	it("leaves the user's own prompt out of the in-flight state", async () => {
		// isStreaming leads the streaming message by one beat: the transcript still
		// ends on the prompt before the first token lands. Marking the user's words
		// aria-busy made them re-render as plain text and reflow when the answer
		// arrived; the typing indicator fills that gap instead.
		const host = renderMessages([userMessage("summarize my note")], { isStreaming: true });
		await flushRender();

		const user = host.querySelector("article.piem-chat__message--user");
		expect(user?.getAttribute("aria-busy")).not.toBe("true");
		// The gap still belongs to the typing indicator, not to silence.
		expect(host.querySelector(".piem-chat__message--pending")).not.toBeNull();
	});

	it("marks the prose block being written with the live caret", async () => {
		const host = renderMessages([userMessage("hi"), assistantMessage("half a th")], { isStreaming: true });
		await flushRender();

		const live = host.querySelector("article.piem-chat__message--assistant .piem-chat__block--live");
		expect(live).not.toBeNull();
	});

	it("drops the caret once the reply has settled", async () => {
		const host = renderMessages([userMessage("hi"), assistantMessage("done")], { isStreaming: false });
		await flushRender();

		expect(host.querySelector(".piem-chat__block--live")).toBeNull();
	});

	it("marks the tool row pi still has out, and leaves it the tool's own glyph", async () => {
		// Running is read off the pending set by call id now, not inferred from the
		// row's position in the streaming message. The glyph stays the tool's: a
		// spinner answered "is something happening", which the breath says anyway,
		// and spent the one slot that could have said what the wait is for. An
		// hourglass on a `wait_subagent` row is that answer.
		const host = renderMessages([userMessage("hi"), assistantToolCall("wait_subagent", { subagentId: "sub-1" })], {
			isStreaming: true,
			pendingToolCalls: [pendingCall("wait_subagent")],
		});
		await flushRender();

		const trace = host.querySelector(".piem-chat__trace");
		// Without agent details on, the call row has nothing to open and renders
		// flat — the running class must reach it either way.
		expect(trace?.classList.contains("piem-chat__trace--flat")).toBe(true);
		expect(trace?.classList.contains("piem-chat__trace--running")).toBe(true);
		expect(trace?.getAttribute("aria-busy")).toBe("true");
		expect(iconNames(trace)).toEqual(["hourglass"]);
	});

	it("settles the tool row once pi has the result, whatever the turn is doing", async () => {
		// Streaming still, and the call is the last block — the two facts the old
		// rule read as "running". Only the pending set decides now, and it is empty.
		const host = renderMessages([userMessage("hi"), assistantToolCall("read", { path: "Note.md" }), toolResultFor("read")], {
			isStreaming: true,
		});
		await flushRender();

		expect(host.querySelector(".piem-chat__trace--running")).toBeNull();
		expect(host.querySelector(".piem-chat__trace[aria-busy]")).toBeNull();
	});

	it("breathes the fold holding a running call, and every running row inside it", async () => {
		// Two defects in one shape. A fold handed every row it drew `live={false}`,
		// so opening one showed calls marked cut off while they were out; and running
		// was the streaming message's last block, so only the third of three
		// concurrent calls counted at all. One breath for the run — no count on the
		// summary, which already says how many calls it swallowed.
		const host = renderMessages([userMessage("hi"), assistantToolCalls("spawn_subagent", "spawn_subagent", "wait_subagent")], {
			isStreaming: true,
			pendingToolCalls: [pendingCall("spawn_subagent", 0), pendingCall("spawn_subagent", 1), pendingCall("wait_subagent")],
		});
		await flushRender();

		const fold = host.querySelector(".piem-chat__trace--fold");
		expect(fold?.classList.contains("piem-chat__trace--running")).toBe(true);
		expect(fold?.getAttribute("aria-busy")).toBe("true");
		expect(fold?.querySelectorAll(".piem-chat__trace--running")).toHaveLength(3);
	});

	it("leaves the tail placeholder saying only that something is out", async () => {
		// It used to name the running tools under a spinner turning at the rows' own
		// rate, from the same table the rows read — the transcript reading itself
		// back. The names stay in the announcement, where three dots cannot go.
		const host = renderMessages([userMessage("hi")], { isStreaming: true, pendingToolCalls: [pendingCall("read")] });
		await flushRender();

		const status = host.querySelector(".piem-chat__tool-status");
		expect(status?.querySelector(".piem-chat__typing")).not.toBeNull();
		expect(status?.querySelector("[data-icon]")).toBeNull();
		expect(status?.querySelector(".piem-chat__visually-hidden")?.textContent).toBe("Working: Read a note");
	});

	it("lets the running-tools row speak its own content", async () => {
		// The aria-label used to replace the row's text as the accessible name,
		// so a screen reader heard "Tools running" and never the tool names the
		// sighted reader sees right there.
		const host = renderMessages([userMessage("hi")], { isStreaming: true, pendingToolCalls: [pendingCall("read")] });
		await flushRender();

		const status = host.querySelector(".piem-chat__tool-status");
		expect(status?.hasAttribute("aria-label")).toBe(false);
		expect(status?.textContent).toContain("Read a note");
	});
});

describe("MessageList consecutive-tool folding", () => {
	it("folds a run of calls and results into one row, holding the rows it replaced", async () => {
		const host = renderMessages([
			userMessage("what links here?"),
			assistantToolCalls("read", "grep"),
			toolResultFor("read"),
			toolResultFor("grep"),
			assistantMessage("Two notes link here."),
		]);
		await flushRender();

		const fold = host.querySelector("details.piem-chat__trace--fold");
		expect(fold).not.toBeNull();
		expect(foldSummaries(host)).toEqual(["Read a note and ran a search"]);
		// Closed, like every other trace row in the mode that folds at all.
		expect(fold?.hasAttribute("open")).toBe(false);
		// A sentence, so it is set in the interface font rather than the id face.
		const name = fold?.querySelector(".piem-chat__trace-name");
		expect(name?.classList.contains("piem-chat__trace-name--label")).toBe(true);
		// Two rows inside for two invocations — the call and result of each are one
		// row now (see `toolPair.ts`) — and none was left behind in the transcript.
		expect(fold?.querySelectorAll(".piem-chat__trace-body > .piem-chat__trace")).toHaveLength(2);
		const stranded = Array.from(host.querySelectorAll(".piem-chat__trace")).filter(
			(row) => !row.classList.contains("piem-chat__trace--fold") && row.closest(".piem-chat__trace--fold") === null,
		);
		expect(stranded).toHaveLength(0);
	});

	/*
	 * One invocation, one row. The transcript used to draw two — a wrench row and a
	 * tick row, both naming the tool from the same table — so a reader scanning for
	 * what the agent did counted every action twice, and the two things they wanted
	 * (which note, and did it work) sat in different rows with a truncation each.
	 */
	it("draws a call and its result as one row, with the outcome on the glyph", async () => {
		const host = renderMessages([assistantToolCall("write", { path: "Clippings/Note.md" }), toolResultFor("write")]);
		await flushRender();

		expect(host.querySelectorAll(".piem-chat__trace")).toHaveLength(1);
		const row = host.querySelector(".piem-chat__trace");
		expect(row?.querySelector(".piem-chat__trace-name")?.textContent).toBe("Wrote a note");
		// A row that worked spends its glyph on the tool, because "it worked" is
		// what the sentence beside it already says — a tick there was the same fact
		// twice, and left reading a note and trashing one looking identical.
		expect(iconNames(row)).toEqual(["file-plus"]);
		// And the argument survives absorbing the result, because "which note" is the
		// question a collapsed tool row exists to answer.
		expect(row?.querySelector(".piem-chat__trace-detail")?.textContent).toBe("Clippings/Note.md");
	});

	/*
	 * Asked, never answered — a turn interrupted between the call and its result.
	 * It outranks the tool's own glyph because the reader has to act on it, and it
	 * borrows the glyph the transcript already uses for a reply they stopped.
	 */
	it("marks a call whose result never came as cut off", async () => {
		const host = renderMessages([assistantToolCall("write", { path: "Clippings/Note.md" })]);
		await flushRender();

		expect(iconNames(host.querySelector(".piem-chat__trace"))).toEqual(["circle-slash"]);
	});

	/*
	 * A write's diff counts are the one thing the result knew that the call could
	 * not, they are four characters, and they are worthless clipped — so they lead,
	 * and the path gives up its tail to the panel's width instead.
	 */
	it("puts a write's diff counts in front of the path", async () => {
		const host = renderMessages([
			assistantToolCall("edit", { path: "Clippings/Note.md" }),
			{ ...toolResultFor("edit"), details: { diff: "@@ -1 +1 @@\n+added\n-removed" } } as ToolResultMessage,
		]);
		await flushRender();

		expect(host.querySelector(".piem-chat__trace-detail")?.textContent).toBe("+1 -1 · Clippings/Note.md");
	});

	/*
	 * "Why not" outranks "which note" the moment there is a why-not: the glyph says
	 * something went wrong, and the detail is the only place the row can say what.
	 */
	it("gives a failed row's line to the failure message", async () => {
		const host = renderMessages([assistantToolCall("read", { path: "Missing.md" }), errorResultFor("read")]);
		await flushRender();

		const row = host.querySelector(".piem-chat__trace--error");
		expect(row).not.toBeNull();
		expect(iconNames(row)).toEqual(["alert-triangle"]);
		expect(row?.querySelector(".piem-chat__trace-detail")?.textContent).toBe("File not found.");
	});

	/*
	 * Nothing in the transcript asked for it — compaction ate the turn that did, or
	 * the session file predates ids — so no row will draw it but its own.
	 */
	it("still draws a result no call claimed", async () => {
		const host = renderMessages([orphanResult()]);
		await flushRender();

		expect(host.querySelectorAll("details.piem-chat__trace--result")).toHaveLength(1);
	});

	it("leaves a lone call unfolded, since its own row names the note it touched", async () => {
		// "Read a note — Daily/2026-08-27.md" says more than "read a note" behind a click.
		const host = renderMessages([assistantToolCall("read", { path: "Daily/2026-08-27.md" }), toolResultFor("read")]);
		await flushRender();

		expect(host.querySelector(".piem-chat__trace--fold")).toBeNull();
		expect(host.querySelector(".piem-chat__trace-detail")?.textContent).toBe("Daily/2026-08-27.md");
	});

	it("stops a fold at the sentence between two runs, so prose is never inside one", async () => {
		const host = renderMessages([
			assistantToolCalls("read", "read"),
			toolResultFor("read"),
			toolResultFor("read"),
			assistantMessage("Now the links."),
			assistantToolCalls("grep", "grep"),
			toolResultFor("grep"),
			toolResultFor("grep"),
		]);
		await flushRender();

		expect(foldSummaries(host)).toEqual(["Read 2 notes", "Ran 2 searches"]);
		// The transcript row itself is what a fold must never contain: nothing the
		// model said can end up behind a disclosure it did not have before.
		expect(host.querySelector(".piem-chat__trace--fold article")).toBeNull();
	});

	it("draws no empty card for a turn whose every call went into a fold anchored above it", async () => {
		const host = renderMessages([
			assistantToolCall("read", { path: "A.md" }),
			toolResultFor("read"),
			assistantToolCall("grep", { pattern: "linked" }),
			toolResultFor("grep"),
		]);
		await flushRender();

		// The summary stands where the run began — inside the turn that opened it —
		// and the second turn, left with nothing to draw, draws nothing.
		expect(host.querySelectorAll("article.piem-chat__message--assistant")).toHaveLength(1);
		expect(host.querySelector("article.piem-chat__message--assistant > .piem-chat__bubble .piem-chat__trace--fold")).not.toBeNull();
	});

	it("draws the summary in a result's own slot when the run begins with one", async () => {
		/*
		 * A result whose call is nowhere in the transcript — compaction ate the turn
		 * that made it, or the session file predates ids being recorded. It is the one
		 * kind of result that is still a row of its own, so it is the one kind that can
		 * open a run: a paired result is drawn by its call and is not a row here at all.
		 */
		const host = renderMessages([orphanResult(), assistantToolCalls("read", "read"), toolResultFor("read"), toolResultFor("read")]);
		await flushRender();

		// Two calls in the run, and the orphan is not one of them: the summary counts
		// what the agent did, and nothing in the transcript says this result was asked
		// for by anything above it.
		expect(foldSummaries(host)).toEqual(["Read 2 notes"]);
		const fold = host.querySelector("details.piem-chat__trace--fold");
		// Its first member is the stray result, drawn in the slot the summary took over.
		expect(fold?.querySelector(".piem-chat__trace-body > .piem-chat__trace")?.classList.contains("piem-chat__trace--result")).toBe(true);
	});

	it("keeps a failure in the transcript rather than inside a fold", async () => {
		const host = renderMessages([
			assistantToolCalls("read", "grep"),
			errorResultFor("read"),
			toolResultFor("grep"),
			assistantToolCalls("read", "read"),
			toolResultFor("read"),
		]);
		await flushRender();

		const failure = host.querySelector(".piem-chat__trace--error");
		expect(failure?.querySelector(".piem-chat__trace-detail")?.textContent).toBe("File not found.");
		expect(failure?.closest(".piem-chat__trace--fold")).toBeNull();
	});

	it("keeps the answered question in the stream instead of inside the fold", async () => {
		const host = renderMessages([
			assistantToolCalls("read", "read"),
			toolResultFor("read"),
			askResult({ dismissed: false, answers: [{ question: "Where?", header: "Where to file", selected: ["Inbox"] }] }),
			toolResultFor("read"),
		]);
		await flushRender();

		const receipt = host.querySelector(".piem-ask-card--answered");
		expect(receipt).not.toBeNull();
		expect(receipt?.closest(".piem-chat__trace--fold")).toBeNull();
	});

	it("swallows the call still running and breathes instead of exempting it", async () => {
		// The exemption it replaces kept the running call out of the fold, because a
		// settled count where a spinner had been would report the run as finished.
		// It was addressed at one row, so it never covered a turn that issued
		// several; the fold carries the state itself now.
		const host = renderMessages(
			[
				assistantToolCalls("read", "grep"),
				toolResultFor("read"),
				toolResultFor("grep"),
				assistantToolCall("write", { path: "Note.md" }),
			],
			{ isStreaming: true, pendingToolCalls: [pendingCall("write")] },
		);
		await flushRender();

		const fold = host.querySelector(".piem-chat__trace--fold");
		expect(fold?.classList.contains("piem-chat__trace--running")).toBe(true);
		expect(host.querySelectorAll(".piem-chat__trace--fold")).toHaveLength(1);
		// The write is inside it, still marked running, rather than standing alone.
		const running = fold?.querySelector(".piem-chat__trace--running");
		expect(running?.querySelector(".piem-chat__trace-name")?.textContent).toBe("Wrote a note");
	});

	it("keeps the summary in the reader's words while the rows inside it keep the raw ids", async () => {
		const host = renderMessages([assistantToolCalls("read", "grep"), toolResultFor("read"), toolResultFor("grep")], {
			showAgentDetails: true,
		});
		await flushRender();

		expect(foldSummaries(host)).toEqual(["Read a note and ran a search"]);
		const inner = Array.from(host.querySelectorAll(".piem-chat__trace-body > .piem-chat__trace .piem-chat__trace-name"));
		expect(inner.map((node) => node.textContent)).toEqual(["read", "grep"]);
	});

	it("folds nothing in the two modes chosen to open machine traffic", async () => {
		for (const traceExpand of ["highValue", "expanded"] as const) {
			const host = renderMessages([assistantToolCalls("read", "grep"), toolResultFor("read"), toolResultFor("grep")], { traceExpand });
			await flushRender();

			expect(host.querySelector(".piem-chat__trace--fold")).toBeNull();
			// Two invocations, two rows — unfolded, but still one row apiece.
			expect(host.querySelectorAll(".piem-chat__trace")).toHaveLength(2);
			host.remove();
		}
	});
});

describe("MessageList tool-result diff", () => {
	it("collapses a diff-bearing result under the default mode, which is the issue's all-collapsed transcript", async () => {
		const host = renderMessages([toolResult({ diff: " 1 unchanged\n+2 added\n-3 removed" })]);
		await flushRender();

		const trace = host.querySelector("details.piem-chat__trace--result");
		expect(trace).not.toBeNull();
		expect(trace?.hasAttribute("open")).toBe(false);
		// The counts stay on the row either way, so what changed is still readable closed.
		expect(trace?.querySelector(".piem-chat__trace-detail")?.textContent).toBe("+1 -1");
	});

	it("opens a diff-bearing result in the high-value mode, so the write is visible without a second interaction", async () => {
		// The previewable half of the undo story: a collapsed diff hid the one
		// thing the reader most needs to check — what actually landed in the note.
		const host = renderMessages([toolResult({ diff: " 1 unchanged\n+2 added\n-3 removed" })], { traceExpand: "highValue" });
		await flushRender();

		const trace = host.querySelector("details.piem-chat__trace--result");
		expect(trace).not.toBeNull();
		expect(trace?.hasAttribute("open")).toBe(true);
		expect(trace?.querySelector(".piem-chat__trace-detail")?.textContent).toBe("+1 -1");
		// The old shape nested a `<details>` inside an always-expanded result block.
		expect(trace?.querySelector("details")).toBeNull();
	});

	it("keeps a result without a diff collapsed, since there is nothing to preview", async () => {
		const host = renderMessages([toolResult({ path: "Note.md", editCount: 2 })]);
		await flushRender();

		expect(host.querySelector("details.piem-chat__trace--result")?.hasAttribute("open")).toBe(false);
	});

	it("sends the diff through the Markdown renderer as a diff fence", async () => {
		renderMessages([toolResult({ diff: "+added line" })]);
		await flushRender();

		const diffCall = markdownRenderMock.mock.calls.find((call) => (call[0] as { markdown: string }).markdown.startsWith("```diff"));
		expect((diffCall?.[0] as { markdown: string }).markdown).toBe("```diff\n+added line\n```");
	});

	it("falls back to the result's own first line when no diff is attached", async () => {
		const host = renderMessages([toolResult({ path: "Note.md", editCount: 2 })]);
		await flushRender();

		expect(host.querySelector(".piem-chat__trace-detail")?.textContent).toBe("Applied 1 edit to Note.md.");
		const diffCalls = markdownRenderMock.mock.calls.filter((call) => (call[0] as { markdown: string }).markdown.startsWith("```diff"));
		expect(diffCalls).toHaveLength(0);
	});

	it("ignores non-string and empty diff values", async () => {
		renderMessages([toolResult({ diff: 42 }), toolResult({ diff: "" })]);
		await flushRender();

		const diffCalls = markdownRenderMock.mock.calls.filter((call) => (call[0] as { markdown: string }).markdown.startsWith("```diff"));
		expect(diffCalls).toHaveLength(0);
	});
});

describe("MessageList quick actions", () => {
	it("renders the model's follow-ups under a settled reply and sends the tapped prompt", async () => {
		const selected: string[] = [];
		const host = renderMessages([userMessage("What is this?"), assistantMessage("An answer.")], {
			onQuickAction: (prompt) => selected.push(prompt),
			suggestedActions: [
				{ id: "suggested-0", label: "Go deeper", prompt: "Expand on the points above." },
				{ id: "suggested-1", label: "Key points", prompt: "Summarize the reply as bullets." },
			],
		});
		await flushRender();

		const row = host.querySelector(".piem-chat__quick-actions");
		expect(row?.getAttribute("aria-label")).toBe("Suggested prompts");
		const chips = Array.from(row?.querySelectorAll<HTMLButtonElement>(".piem-chat__quick-action") ?? []);
		expect(chips.length).toBe(2);
		chips[1]?.click();
		await flushRender();
		// The tap sends the full prompt, not the chip label.
		expect(selected[0]).toContain("Summarize the reply as bullets.");
	});

	it("shows no follow-ups on a settled reply when the model suggested nothing", async () => {
		// The post-reply row is model-generated with no built-in stand-ins: a
		// failed or empty suggestion request leaves the row out entirely.
		const host = renderMessages([userMessage("q"), assistantMessage("An answer.")], {
			onQuickAction: () => undefined,
		});
		await flushRender();

		expect(host.querySelector(".piem-chat__quick-actions")).toBeNull();
	});

	it("hides the follow-ups while the turn is still streaming", async () => {
		const host = renderMessages([userMessage("q"), assistantMessage("partial")], {
			isStreaming: true,
			onQuickAction: () => undefined,
		});
		await flushRender();

		expect(host.querySelector(".piem-chat__quick-actions")).toBeNull();
	});

	it("hides the follow-ups while tools run or compaction is in flight", async () => {
		const running = renderMessages([userMessage("q"), assistantMessage("done")], {
			pendingToolCalls: [{ name: "read" } as never],
			onQuickAction: () => undefined,
		});
		await flushRender();
		expect(running.querySelector(".piem-chat__quick-actions")).toBeNull();

		const compacting = renderMessages([userMessage("q"), assistantMessage("done")], {
			isCompacting: true,
			onQuickAction: () => undefined,
		});
		await flushRender();
		expect(compacting.querySelector(".piem-chat__quick-actions")).toBeNull();
	});

	it("renders exactly the suggested row under a truncated reply, with no continue chip of its own", async () => {
		// Truncation used to mint a rule-based "Continue" chip; the row is
		// model-generated now, and the model's chips are the whole row.
		const host = renderMessages([userMessage("q"), assistantMessage("half a", { stopReason: "length" })], {
			onQuickAction: () => undefined,
			suggestedActions: [{ id: "suggested-0", label: "Finish it", prompt: "Finish your reply." }],
		});
		await flushRender();

		const chips = Array.from(host.querySelectorAll<HTMLButtonElement>(".piem-chat__quick-action"));
		expect(chips.map((chip) => chip.textContent)).toEqual(["Finish it"]);
	});

	it("offers no follow-ups without a sender wired", async () => {
		const host = renderMessages([userMessage("q"), assistantMessage("answer")]);
		await flushRender();

		expect(host.querySelector(".piem-chat__quick-actions")).toBeNull();
	});

	it("suggests first prompts on the ready empty screen", async () => {
		const selected: string[] = [];
		const host = renderMessages([], { onQuickAction: (prompt) => selected.push(prompt) });
		await flushRender();

		const chips = Array.from(host.querySelectorAll<HTMLButtonElement>(".piem-chat__empty .piem-chat__quick-action"));
		expect(chips.length).toBe(3);
		chips[0]?.click();
		await flushRender();
		expect(selected[0]).toContain("note");
	});

	it("shapes the empty-screen prompts around the open note", async () => {
		const withNote = renderMessages([], { hasActiveNote: true, onQuickAction: () => undefined });
		await flushRender();
		expect(withNote.querySelector(".piem-chat__empty")?.textContent).toContain("Summarize this note");

		const withoutNote = renderMessages([], { onQuickAction: () => undefined });
		await flushRender();
		expect(withoutNote.querySelector(".piem-chat__empty")?.textContent).toContain("Draft a new note");
	});

	it("offers no suggestions on the unconfigured or still-opening empty screen", async () => {
		const unconfigured = renderMessages([], { isConfigured: false, onOpenSettings: () => undefined, onQuickAction: () => undefined });
		await flushRender();
		expect(unconfigured.querySelector(".piem-chat__quick-actions")).toBeNull();

		const initializing = renderMessages([], { isInitializing: true, onQuickAction: () => undefined });
		await flushRender();
		expect(initializing.querySelector(".piem-chat__quick-actions")).toBeNull();
	});
});

/**
 * The transcript's side of issue #237: an `ask_user` exchange is not machine traffic.
 * It renders as a card while it is open and as a record once it is not, and the trace
 * rows that would otherwise say the same thing twice are suppressed.
 */
describe("MessageList ask_user", () => {
	it("draws no trace row for the call, so the question is not in the transcript twice", async () => {
		const host = renderMessages([assistantToolCall("ask_user", { questions: [] })]);
		await flushRender();

		expect(host.querySelector(".piem-chat__trace")).toBeNull();
		// And no empty bubble where the turn was: an assistant message whose only
		// content was that call has nothing left to draw, and rendering it anyway left
		// a copy/insert actions row offering to copy no text at all.
		expect(host.querySelector(".piem-chat__message--assistant")).toBeNull();
	});

	it("keeps the raw call visible under agent details, which exist to show payloads", async () => {
		const host = renderMessages([assistantToolCall("ask_user", { questions: [] })], { showAgentDetails: true });
		await flushRender();

		expect(host.querySelector(".piem-chat__trace")).not.toBeNull();
	});

	it("renders the answer as a record rather than a collapsed row", async () => {
		const host = renderMessages([askResult({ dismissed: false, answers: [{ question: "Where?", header: "Where to file", selected: ["Inbox"] }] })]);
		await flushRender();

		expect(host.querySelector(".piem-ask-card--answered")).not.toBeNull();
		expect(host.querySelector(".piem-ask-card__picked")?.textContent).toBe("Inbox");
		// Not behind a disclosure: everything else mechanical folds away, and a decision
		// the reader made is the least mechanical thing in the transcript.
		expect(host.querySelector("details")).toBeNull();
	});

	it("records a handed-back decision as its own outcome", async () => {
		const host = renderMessages([askResult({ dismissed: true })]);
		await flushRender();

		expect(host.querySelector(".piem-ask-card--dismissed")).not.toBeNull();
	});

	it("falls back to the ordinary row for a payload it cannot read", async () => {
		// An older session file, a hand edit, a sync from another build. An empty receipt
		// would be worse than the collapsed row this has always had.
		const host = renderMessages([askResult({ answers: "Inbox" })]);
		await flushRender();

		expect(host.querySelector(".piem-ask-card")).toBeNull();
		expect(host.querySelector(".piem-chat__trace--result")).not.toBeNull();
	});

	it("renders the pending question at the tail, and only with somewhere to send it", async () => {
		const request = { id: "ask-0", shell: "panel" as const, questions: [{ question: "Where?", header: "Where to file", options: [{ label: "Inbox" }, { label: "Archive" }] }] };

		const unwired = renderMessages([userMessage("Tidy up")], { pendingQuestion: request });
		await flushRender();
		// No answer handler means nothing could receive a click; a card that cannot
		// settle its own question is worse than none.
		expect(unwired.querySelector(".piem-ask-card")).toBeNull();

		const host = renderMessages([userMessage("Tidy up")], {
			pendingQuestion: request,
			onAnswerQuestion: () => undefined,
			onDismissQuestion: () => undefined,
		});
		await flushRender();

		expect(host.querySelector(".piem-ask-card--pending")).not.toBeNull();
	});
});

/** An `ask_user` result carrying `details` as the transcript will read them back. */
function askResult(details: Record<string, unknown>): ToolResultMessage {
	return { ...toolResult(details), toolName: "ask_user", content: [{ type: "text", text: "The user answered:\nWhere to file: Inbox" }] };
}

function toolResult(details: Record<string, unknown>): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "edit",
		content: [{ type: "text", text: "Applied 1 edit to Note.md." }],
		details,
		isError: false,
		timestamp: Date.now(),
	};
}

/** An assistant turn whose whole content is back-to-back tool calls. */
function assistantToolCalls(...names: string[]): AssistantMessage {
	return {
		...assistantBase(),
		content: names.map((name): AssistantMessage["content"][number] => ({
			type: "toolCall",
			id: nextToolCallId(callIds, name),
			name,
			arguments: { path: `${name}.md` },
		})),
	};
}

/** A settled result for `toolName`, on the shape {@link toolResult} already produces. */
function toolResultFor(toolName: string): ToolResultMessage {
	return { ...toolResult({}), toolName, toolCallId: nextToolCallId(resultIds, toolName) };
}

/**
 * A result with no call to pair with, which is what compaction and older session
 * files leave behind. Its `toolCallId` is deliberately one no fixture hands out.
 */
function orphanResult(): ToolResultMessage {
	return { ...toolResult({}), toolName: "read", toolCallId: "no-such-call" };
}

function errorResultFor(toolName: string): ToolResultMessage {
	return { ...toolResultFor(toolName), isError: true, content: [{ type: "text", text: "File not found." }] };
}

/**
 * The icon names a row painted, in order.
 *
 * `setIcon` writes the name as text under `bun test` (see `obsidianStub.ts`), which
 * is what makes a status glyph assertable without shipping an icon registry.
 */
function iconNames(row: Element | null | undefined): string[] {
	return Array.from(row?.querySelectorAll("[data-icon]") ?? []).map((node) => node.getAttribute("data-icon") ?? "");
}

/** The summary line of every folded run, in transcript order. */
function foldSummaries(host: HTMLElement): (string | null)[] {
	return Array.from(host.querySelectorAll(".piem-chat__trace--fold > .piem-chat__trace-summary > .piem-chat__trace-name")).map(
		(node) => node.textContent,
	);
}

function compactionSummary(text: string): AgentMessage {
	return { role: "compactionSummary", summary: text, tokensBefore: 40_000, timestamp: Date.now() } as AgentMessage;
}

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

describe("MessageList marks a message the session log did not take", () => {
	/*
	 * The inversion this fixes: every other report in the panel describes something
	 * retryable, and this one describes silent irreversible loss — yet it rode the
	 * dismissible grey notice, ranked below "Nothing to tidy up yet.", and was
	 * cleared unconditionally by the next send. The warning about the reply about to
	 * be lost was destroyed by the act of continuing the conversation.
	 */
	it("warns under the reply it names, with no way to dismiss it", async () => {
		const reply = assistantMessage("the answer");
		const host = renderMessages([reply], { unpersistedMessages: [reply] });
		await flushRender();

		const warning = host.querySelector(".piem-chat__interrupted--unsaved");
		expect(warning?.textContent).toContain("Not saved to the vault");
		// No dismiss control anywhere in the row: this one cannot be acknowledged
		// away, because acknowledging it does not make the reply exist on disk.
		expect(warning?.querySelector(".piem-chat__banner-dismiss")).toBeNull();
	});

	it("puts the rescue one press away, since the reply actions are hover-revealed", async () => {
		const reply = assistantMessage("the answer");
		const host = renderMessages([reply], { unpersistedMessages: [reply] });
		await flushRender();

		const action = host.querySelector(".piem-chat__interrupted--unsaved .piem-chat__interrupted-action");
		expect(action?.textContent).toBe("Copy it out");
	});

	/*
	 * A question that never reached disk is worse than a reply that did not: the
	 * transcript reloads missing the words the reader typed, and nothing else in
	 * the panel would ever mention it.
	 */
	it("marks the user's own turn too", async () => {
		const question = userMessage("a question");
		const host = renderMessages([question], { unpersistedMessages: [question] });
		await flushRender();

		expect(host.querySelector(".piem-chat__interrupted--unsaved")).not.toBeNull();
	});

	it("marks only the message it was given, not the whole transcript", async () => {
		const first = assistantMessage("saved fine");
		const second = assistantMessage("never written");
		const host = renderMessages([first, second], { unpersistedMessages: [second] });
		await flushRender();

		expect(host.querySelectorAll(".piem-chat__interrupted--unsaved")).toHaveLength(1);
	});

	it("says nothing when every message reached the log", async () => {
		const host = renderMessages([assistantMessage("the answer")], { unpersistedMessages: [] });
		await flushRender();

		expect(host.querySelector(".piem-chat__interrupted--unsaved")).toBeNull();
	});
});

describe("MessageList provider failure, reported where it happened", () => {
	/*
	 * #239. The failure used to reach the user only through the top banner, whose
	 * copy pi discards when the next run departs and which cannot say which turn
	 * it belonged to. Here it is anchored, and it reads off `errorMessage` — the
	 * field `appendMessage` writes to the session log — so it survives a reload.
	 */
	it("names the failure in the reader's language, under the turn it ended", async () => {
		const host = renderMessages([assistantMessage("Half a thou", { stopReason: "error", errorMessage: "504 Gateway Time-out" })]);
		await flushRender();

		const pill = host.querySelector(".piem-chat__trace--failed");
		expect(pill?.querySelector(".piem-chat__trace-name")?.textContent).toBe("The provider did not answer in time.");
		// The modifier is what tints the glyph, and only the glyph.
		expect(pill?.className).toContain("piem-chat__trace--failed");
	});

	it("reports a failed turn as one pill, opened onto the provider's own words", async () => {
		const host = renderMessages([
			assistantMessage("", { stopReason: "error", errorMessage: "429 Rate limit reached for gpt-4o" }),
		]);
		await flushRender();

		// One row, not a notice with a stray repeat beneath it. The classified
		// sentence is the summary; the raw text is what opening reveals.
		const pill = host.querySelector("details.piem-chat__trace--failed");
		expect(pill?.querySelector(".piem-chat__trace-name")?.textContent).toBe("The provider is too busy right now. Give it a moment, then try again.");
		expect(pill?.querySelector(".piem-chat__cutoff-raw")?.textContent).toBe("429 Rate limit reached for gpt-4o");
		// Closed until asked for: the sentence itself is the report.
		expect((pill as HTMLDetailsElement | null)?.open ?? false).toBe(false);
	});

	/*
	 * An empty `raw` must not become an empty disclosure: a pill that opens onto
	 * nothing is the one dishonesty this row must not commit, and the `unknown`
	 * sentence already carries the news that there was nothing to show.
	 */
	it("renders a failure the provider said nothing about as a flat row", async () => {
		const host = renderMessages([assistantMessage("", { stopReason: "error" })]);
		await flushRender();

		const pill = host.querySelector(".piem-chat__trace--failed");
		expect(pill?.querySelector(".piem-chat__trace-name")?.textContent).toBe("The provider did not answer, and did not say why.");
		expect(host.querySelector(".piem-chat__cutoff-raw")).toBeNull();
		expect(pill?.matches("details")).toBe(false);
	});

	it("keeps a stopped reply the flat paragraph it always was", async () => {
		// A stop has nothing behind its line, so no disclosure affordance may
		// point at nothing.
		const host = renderMessages([assistantMessage("Half a thou", { stopReason: "aborted" })]);
		await flushRender();

		expect(host.querySelector(".piem-chat__trace--failed")).toBeNull();
		expect(host.querySelector(".piem-chat__interrupted")?.textContent).toContain("You stopped this reply.");
	});

	it("says nothing extra about a reply that ended normally", async () => {
		const host = renderMessages([assistantMessage("the answer")]);
		await flushRender();

		expect(host.querySelector(".piem-chat__interrupted")).toBeNull();
		expect(host.querySelector(".piem-chat__trace--failed")).toBeNull();
	});

	/*
	 * Without this the screen-reader path announced the empty string for a turn
	 * that failed before producing a word — a reader told, literally, that nothing
	 * had happened. `youStoppedSpoken` / `replyTruncatedSpoken` proved the pattern
	 * existed; `error` was the case it had not been extended to.
	 */
	it("announces a failure that produced no words at all", async () => {
		const host = renderMessages([assistantMessage("", { stopReason: "error", errorMessage: "504 Gateway Time-out" })]);
		await flushRender();

		// Standing alone, so `assistantSpeech` publishes the notice rather than the
		// sentence-continuing form — this turn has no sentence to continue.
		const live = Array.from(host.querySelectorAll('[aria-live="polite"]'), (node) => node.textContent ?? "");
		expect(live.some((text) => text.includes("The provider did not answer in time."))).toBe(true);
	});

	it("appends the failure to the words the turn did manage, as a sentence tail", async () => {
		const host = renderMessages([assistantMessage("Half a thou", { stopReason: "error", errorMessage: "504 Gateway Time-out" })]);
		await flushRender();

		const live = Array.from(host.querySelectorAll('[aria-live="polite"]'), (node) => node.textContent ?? "");
		expect(live.some((text) => text.includes("Half a thou — the provider did not answer in time."))).toBe(true);
	});
});

function assistantMessage(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return { ...assistantBase(), content: [{ type: "text", text }], ...overrides };
}

function assistantThinking(thinking: string): AssistantMessage {
	return { ...assistantBase(), content: [{ type: "thinking", thinking }] };
}

function assistantToolCall(name: string, args: Record<string, unknown>): AssistantMessage {
	return { ...assistantBase(), content: [{ type: "toolCall", id: nextToolCallId(callIds, name), name, arguments: args }] };
}

/**
 * Call ids the results can find.
 *
 * A renderer that draws one row per invocation has to know which result answered
 * which call, and `pi` says so with `ToolCall.id` and `ToolResultMessage.toolCallId`.
 * These fixtures predate that being read, so they now generate the correspondence a
 * provider would: the nth call of a tool and the nth result for that tool carry the
 * same id. Which is how the fixtures already read — `assistantToolCalls("read",
 * "grep")` followed by `toolResultFor("read")` and `toolResultFor("grep")` — so no
 * call site changes, and a test that deliberately leaves a call unanswered simply
 * omits the result.
 *
 * Two counters, not one: every fixture creates a call before its result, but a
 * transcript may hold a call whose result never came, and one shared counter would
 * hand the next result the wrong call's id.
 */
const callIds = new Map<string, number>();
const resultIds = new Map<string, number>();

/**
 * The pending-call entry for the nth call of `name`, carrying the id
 * {@link assistantToolCalls} handed that call.
 *
 * Reads the counter rather than advancing it: the fixture that created the call
 * already did, and advancing again would name a call no message contains — which
 * is exactly the state a row must read as "not running".
 */
function pendingCall(name: string, nth = 0): PendingToolCall {
	return { id: `${name}#${nth}`, name };
}

function nextToolCallId(seq: Map<string, number>, name: string): string {
	const nth = seq.get(name) ?? 0;
	seq.set(name, nth + 1);
	return `${name}#${nth}`;
}

function assistantBase(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
}

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	} as AssistantMessage["usage"];
}

/** A role the chat panel does not model as conversation, to pin system attribution. */
function harnessMessage(text: string): AgentMessage {
	return { role: "custom", content: text, timestamp: Date.now() } as AgentMessage;
}

const roots = new WeakMap<HTMLElement, import("react-dom/client").Root>();
