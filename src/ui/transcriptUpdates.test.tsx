import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
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

function reply(text: string): AssistantMessage {
	return {
		role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: "anthropic", model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: 1,
	};
}

function render(messages: AgentMessage[], props: Partial<Parameters<typeof MessageList>[0]> = {}, language: "en" | "zh-cn" = "en"): void {
	root.render(
		<TranslatorProvider language={language}>
			<MessageList messages={messages} isStreaming={false} pendingToolCalls={[]} unpersistedMessages={[]}
				app={app} component={component} sourcePath="Notes/first.md" {...props} />
		</TranslatorProvider>,
	);
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

describe("transcript updates", () => {
	it("does not traverse settled history again when only the active note changes", async () => {
		let reads = 0;
		const messages = Array.from({ length: 40 }, (_, index) => {
			const message = reply(`Historical reply ${index}`);
			const content = message.content;
			Object.defineProperty(message, "content", { get: () => { reads += 1; return content; } });
			return message;
		});
		const actions: string[] = [];
		render(messages, { onRetry: () => actions.push("old handler") });
		await flushRender();
		expect(reads).toBeGreaterThan(0);
		expect(host.querySelectorAll("article")).toHaveLength(40);
		reads = 0;

		// Service snapshots recreate these empty arrays, and ChatApp provides
		// fresh closures. Neither changes a word of the historical transcript.
		render(messages, { sourcePath: "Notes/second.md", pendingToolCalls: [], unpersistedMessages: [], onRetry: () => actions.push("new handler") });
		await flushRender();

		expect(reads).toBe(0);
		expect(markdownRenderMock).toHaveBeenCalledTimes(40);
		expect(host.querySelectorAll("article")).toHaveLength(40);
		host.querySelector<HTMLButtonElement>('button[aria-label="Regenerate reply"]')!.click();
		expect(actions).toEqual(["new handler"]);
	});

	it("updates a streaming message whose object and array are reused", async () => {
		const message = reply("First token");
		const messages = [message];
		render(messages, { isStreaming: true });
		await flushRender();
		expect(host.textContent).toContain("First token");

		message.content = [{ type: "text", text: "First token and the next one" }];
		render(messages, { isStreaming: true, sourcePath: "Notes/second.md" });
		await flushRender();
		expect(host.textContent).toContain("First token and the next one");
		expect(markdownRenderMock).toHaveBeenCalledTimes(0);

		render(messages, { isStreaming: false, sourcePath: "Notes/second.md" });
		await flushRender();
		expect(markdownRenderMock).toHaveBeenCalledTimes(1);
		expect(markdownRenderMock.mock.calls[0]?.[0].sourcePath).toBe("Notes/second.md");
	});

	it("draws a fast completed turn appended to the same array between renders", async () => {
		const messages = [reply("Earlier reply")];
		render(messages);
		await flushRender();

		// Pi appends in place. A short reply may settle before React commits a
		// streaming frame, so both observed renders can be idle.
		messages.push(reply("Already completed"));
		render(messages);
		await flushRender();

		expect(host.querySelectorAll("article")).toHaveLength(2);
		expect(host.textContent).toContain("Already completed");
	});

	it("uses the new note base when content changes after a note-only update", async () => {
		const messages = [reply("Earlier reply")];
		render(messages);
		await flushRender();
		render(messages, { sourcePath: "Other/second.md" });
		await flushRender();
		expect(markdownRenderMock).toHaveBeenCalledTimes(1);

		render([...messages, reply("A new [[relative link]]")], { sourcePath: "Other/second.md" });
		await flushRender();
		expect(markdownRenderMock).toHaveBeenCalledTimes(2);
		expect(markdownRenderMock.mock.calls[1]?.[0].sourcePath).toBe("Other/second.md");
	});

	it("refreshes language, trace preferences and action availability with stable messages", async () => {
		const message = reply("Answer");
		message.content.unshift({ type: "thinking", thinking: "Considered carefully" });
		const messages = [message];
		render(messages, { traceExpand: "collapsed", onRetry: () => undefined });
		await flushRender();
		expect(host.querySelector<HTMLDetailsElement>(".piem-chat__trace--thinking")?.open).toBe(false);
		expect(host.querySelector('button[aria-label="Regenerate reply"]')).not.toBeNull();

		render(messages, { traceExpand: "expanded" }, "zh-cn");
		await flushRender();
		expect(host.querySelector<HTMLDetailsElement>(".piem-chat__trace--thinking")?.open).toBe(true);
		expect(host.querySelector("article")?.getAttribute("aria-label")).toBe("Piem");
		expect(host.querySelector('button[aria-label="复制回复"]')).not.toBeNull();
		expect(host.querySelector('button[aria-label="Regenerate reply"]')).toBeNull();
	});

	it("moves running markers when pending tool ids change without a message update", async () => {
		const message = reply("");
		message.content = [
			{ type: "toolCall", id: "first", name: "read", arguments: { path: "first.md" } },
			{ type: "toolCall", id: "second", name: "read", arguments: { path: "second.md" } },
		];
		const messages = [message];
		render(messages, { traceExpand: "expanded", pendingToolCalls: [{ id: "first", name: "read" }] });
		await flushRender();
		expect(host.querySelector(".piem-chat__trace--running")?.textContent).toContain("first.md");

		render(messages, { traceExpand: "expanded", pendingToolCalls: [{ id: "second", name: "read" }] });
		await flushRender();
		expect(host.querySelectorAll(".piem-chat__trace--running")).toHaveLength(1);
		expect(host.querySelector(".piem-chat__trace--running")?.textContent).toContain("second.md");
	});

	it("adds and clears an unsaved warning when only persistence state changes", async () => {
		const message = reply("Keep this reply");
		const messages = [message];
		render(messages);
		await flushRender();
		expect(host.querySelector(".piem-chat__interrupted--unsaved")).toBeNull();

		render(messages, { unpersistedMessages: [message] });
		await flushRender();
		expect(host.querySelector(".piem-chat__interrupted--unsaved")?.textContent).toContain("Not saved to the vault");

		render(messages, { unpersistedMessages: [] });
		await flushRender();
		expect(host.querySelector(".piem-chat__interrupted--unsaved")).toBeNull();
	});
});
