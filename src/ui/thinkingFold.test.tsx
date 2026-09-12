import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ThinkingContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { App, Component } from "obsidian";
import type { Root } from "react-dom/client";
import { installDom, flushRender } from "../testUtils/dom";
import { installObsidianStub, markdownRenderMock } from "../testUtils/obsidianStub";

installObsidianStub();
const document = installDom();
const { MessageList } = await import("./MessageList");
const { TranslatorProvider } = await import("./TranslatorContext");
const { createRoot } = await import("react-dom/client");

let root: Root;
let host: HTMLElement;
const app = {} as App;
const component = {} as Component;

function assistant(...content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: 1,
	};
}

function thought(thinking: string): ThinkingContent {
	return { type: "thinking", thinking };
}

function call(id: string, name = "read"): ToolCall {
	return { type: "toolCall", id, name, arguments: { path: `${id}.md` } };
}

function result(id: string, overrides: Partial<ToolResultMessage> = {}): ToolResultMessage {
	return { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: `result ${id}` }], isError: false, timestamp: 2, ...overrides };
}

async function render(messages: AgentMessage[], props: Partial<Parameters<typeof MessageList>[0]> = {}, language: "en" | "zh-cn" = "en"): Promise<void> {
	root.render(
		<TranslatorProvider language={language}>
			<MessageList messages={messages} isStreaming={false} pendingToolCalls={[]} unpersistedMessages={[]}
				app={app} component={component} sourcePath="Notes/first.md" {...props} />
		</TranslatorProvider>,
	);
	await flushRender();
}

function fold(): HTMLDetailsElement {
	const element = host.querySelector<HTMLDetailsElement>(".piem-chat__trace--fold");
	if (!element) throw new Error("Expected a folded trace");
	return element;
}

function rows(element: Element): Element[] {
	return Array.from(element.querySelectorAll(":scope > .piem-chat__trace-body > .piem-chat__trace"));
}

function label(element: Element): string | null | undefined {
	return element.querySelector(".piem-chat__trace-name")?.textContent;
}

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	markdownRenderMock.mockReset();
	markdownRenderMock.mockImplementation(async ({ el, markdown }) => {
		el.createDiv({ cls: "rendered-prose", text: markdown });
	});
});

afterEach(() => {
	root.unmount();
	host.remove();
});

describe("thinking and tool activity share a fold", () => {
	it("preserves interleaved rows and paired results, leaving prose and its announcement outside", async () => {
		await render([
			assistant(thought("check the note"), call("read-a"), thought("check its links")),
			result("read-a"),
			assistant(call("search", "grep")),
			result("search", { toolName: "grep" }),
			assistant({ type: "text", text: "Two links found." }),
		]);

		expect(host.querySelectorAll(".piem-chat__trace--fold")).toHaveLength(1);
		expect(fold().open).toBe(false);
		expect(rows(fold()).map(label)).toEqual(["Thought it through", "Read a note", "Thought it through", "Searched the vault"]);
		expect(label(fold())).toBe("Read a note, ran a search and thought it through 2 times");
		expect(fold().textContent?.match(/result read-a/g)).toHaveLength(1);
		expect(fold().textContent?.match(/result search/g)).toHaveLength(1);
		expect(fold().textContent).not.toContain("Two links found.");
		expect(host.querySelectorAll("article.piem-chat__message--assistant")).toHaveLength(2);
		expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe("Two links found.");
	});

	it("leaves one thought alone and folds two across blank text, with live language updates", async () => {
		const messages = [assistant(thought("first"))];
		await render(messages);
		expect(host.querySelector(".piem-chat__trace--fold")).toBeNull();
		expect(host.querySelectorAll(".piem-chat__trace--thinking")).toHaveLength(1);

		messages.push(assistant({ type: "text", text: "  " }, thought("second")));
		await render(messages);
		expect(rows(fold())).toHaveLength(2);
		expect(label(fold())).toBe("Thought it through 2 times");
		expect(host.querySelectorAll("article.piem-chat__message--assistant")).toHaveLength(1);
		await render(messages, {}, "zh-cn");
		expect(label(fold())).toBe("思考了 2 次");
	});

	it.each(["highValue", "expanded"] as const)("unfolds a stable mixed transcript when the preference changes to %s", async (traceExpand) => {
		const messages = [assistant(thought("edit carefully"), call("write-a", "write")), result("write-a", { toolName: "write", details: { diff: "+new line" } })];
		await render(messages);
		expect(fold()).toBeDefined();
		await render(messages, { traceExpand });

		expect(host.querySelector(".piem-chat__trace--fold")).toBeNull();
		expect(host.querySelectorAll(".piem-chat__trace")).toHaveLength(2);
		expect(host.querySelector<HTMLDetailsElement>(".piem-chat__trace--thinking")?.open).toBe(traceExpand === "expanded");
		expect(host.querySelector<HTMLDetailsElement>(".piem-chat__trace--result")?.open).toBe(true);
	});

	it("keeps a late thought streaming inside an earlier fold and preserves the reader's open rows", async () => {
		const growing = thought("Considering");
		const current = assistant(growing);
		const messages = [assistant(call("read-a")), result("read-a"), current];
		await render(messages, { isStreaming: true });
		const group = fold();
		const thinking = group.querySelector<HTMLDetailsElement>(".piem-chat__trace--thinking")!;
		expect(group.getAttribute("aria-busy")).toBe("true");
		expect(label(thinking)).toBe("Thinking…");
		expect(thinking.querySelector("pre")?.textContent).toBe("Considering");
		expect(markdownRenderMock).toHaveBeenCalledTimes(0);
		// Native details owns open state; unrelated stream updates must not reset it.
		group.open = true;
		thinking.open = true;

		growing.thinking = "Considering the next step";
		await render(messages, { isStreaming: true, sourcePath: "Notes/second.md" });
		expect(fold()).toBe(group);
		expect(group.open).toBe(true);
		expect(thinking.open).toBe(true);
		expect(thinking.querySelector("pre")?.textContent).toBe("Considering the next step");
		expect(markdownRenderMock).toHaveBeenCalledTimes(0);

		current.content.push({ type: "text", text: "Here is the answer" });
		await render(messages, { isStreaming: true });
		expect(group.getAttribute("aria-busy")).toBeNull();
		expect(thinking.getAttribute("aria-busy")).toBeNull();
		expect(label(thinking)).toBe("Thought it through");
		expect(thinking.querySelector("pre")).not.toBeNull();
		expect(host.querySelector(".piem-chat__block--live")?.textContent).toBe("Here is the answer");
		expect(group.textContent).not.toContain("Here is the answer");

		await render(messages);
		expect(thinking.querySelector(".rendered-prose")?.textContent).toBe("Considering the next step");
		expect(group.open).toBe(true);
		expect(thinking.open).toBe(true);
	});

	it("keeps a mixed fold busy during argument streaming and pending-only updates", async () => {
		const write = call("write-a", "write");
		const messages = [assistant(thought("write it down"), write)];
		await render(messages, { isStreaming: true, showAgentDetails: true });
		expect(fold().getAttribute("aria-busy")).toBe("true");
		expect(rows(fold()).map((row) => row.getAttribute("aria-busy"))).toEqual([null, "true"]);

		write.arguments.content = "The next chunk";
		await render(messages, { isStreaming: true, showAgentDetails: true });
		expect(fold().textContent).toContain("The next chunk");
		await render(messages, { pendingToolCalls: [{ id: write.id, name: write.name }] });
		expect(fold().getAttribute("aria-busy")).toBe("true");
		await render(messages);
		expect(host.querySelector(".piem-chat__trace--running")).toBeNull();
		expect(rows(fold())[1]?.querySelector('[data-icon="circle-slash"]')).not.toBeNull();
	});

	it.each(["thinking", "tool"] as const)("keeps an open %s and its focused summary when the first mixed fold forms", async (first) => {
		const message = assistant(first === "thinking" ? thought("still reading this") : call("read-a"));
		const messages = [message];
		await render(messages, { isStreaming: true, showAgentDetails: true });
		const original = host.querySelector<HTMLDetailsElement>("details.piem-chat__trace")!;
		const summary = original.querySelector("summary")!;
		original.open = true;
		original.dispatchEvent(new window.Event("toggle"));
		summary.focus();
		await flushRender();

		message.content.push(first === "thinking" ? call("read-a") : thought("now compare"));
		await render(messages, { isStreaming: true, showAgentDetails: true });
		expect(fold()).toBe(original);
		expect(fold().open).toBe(true);
		expect(document.activeElement).toBe(summary);
		expect((rows(fold())[0] as HTMLDetailsElement).open).toBe(true);
		expect(fold().getAttribute("aria-busy")).toBe("true");
	});

	it("brings a newly failed call out of a mixed fold", async () => {
		const messages: AgentMessage[] = [assistant(thought("first"), call("read-a"), thought("try search"), call("search", "grep"))];
		await render(messages, { pendingToolCalls: [{ id: "read-a", name: "read" }, { id: "search", name: "grep" }] });
		expect(rows(fold())).toHaveLength(4);
		messages.push(result("read-a", { isError: true, content: [{ type: "text", text: "File not found." }] }), result("search", { toolName: "grep" }));
		await render(messages);

		const failure = host.querySelector(".piem-chat__trace--error");
		expect(failure?.querySelector(".piem-chat__trace-detail")?.textContent).toBe("File not found.");
		expect(failure?.closest(".piem-chat__trace--fold")).toBeNull();
		expect(rows(fold()).map(label)).toEqual(["Thought it through", "Searched the vault"]);
		expect(host.querySelectorAll(".piem-chat__trace--thinking")).toHaveLength(2);
	});

	it("leaves answered questions and prose between mixed folds visible", async () => {
		await render([
			assistant(thought("look first"), call("read-a")), result("read-a"),
			result("ask", { toolName: "ask_user", details: { dismissed: false, answers: [{ question: "Where?", header: "Folder", selected: ["Inbox"] }] } }),
			assistant({ type: "text", text: "Now checking Inbox." }, thought("look again"), call("read-b")), result("read-b"),
		]);

		expect(host.querySelectorAll(".piem-chat__trace--fold")).toHaveLength(2);
		const receipt = host.querySelector(".piem-ask-card--answered");
		expect(receipt?.textContent).toContain("Inbox");
		expect(receipt?.closest(".piem-chat__trace--fold")).toBeNull();
		for (const group of Array.from(host.querySelectorAll(".piem-chat__trace--fold"))) {
			expect(group.textContent).not.toContain("Now checking Inbox.");
		}
	});

	it("keeps the stopped notice when a thought-only message is absorbed above it", async () => {
		const stopped = assistant(thought("not finished"));
		stopped.stopReason = "aborted";
		await render([assistant(call("read-a")), result("read-a"), stopped]);

		expect(rows(fold())).toHaveLength(2);
		expect(fold().hasAttribute("aria-busy")).toBe(false);
		const notice = host.querySelector(".piem-chat__interrupted--stopped");
		expect(notice?.textContent).toContain("You stopped this reply.");
		expect(notice?.closest(".piem-chat__trace--fold")).toBeNull();
	});

	it("shows and clears an unsaved warning for an absorbed thought without leaving an empty card", async () => {
		const unsaved = assistant(thought("keep this thought"));
		const messages = [assistant(call("read-a")), result("read-a"), unsaved];
		await render(messages);
		expect(host.querySelectorAll("article.piem-chat__message--assistant")).toHaveLength(1);
		await render(messages, { unpersistedMessages: [unsaved] });

		const warning = host.querySelector(".piem-chat__interrupted--unsaved");
		expect(warning?.textContent).toContain("Not saved to the vault");
		expect(warning?.closest(".piem-chat__trace--fold")).toBeNull();
		await render(messages);
		expect(host.querySelector(".piem-chat__interrupted--unsaved")).toBeNull();
		expect(host.querySelectorAll("article.piem-chat__message--assistant")).toHaveLength(1);
	});
});
