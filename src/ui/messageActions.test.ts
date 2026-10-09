import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { App, WorkspaceLeaf } from "obsidian";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { installObsidianStub } from "../testUtils/obsidianStub";

installObsidianStub();

const { appendToActiveNote, assistantText, copyToClipboard, insertAtCursor, precedingUserText } = await import("./messageActions");
const { MarkdownView } = await import("obsidian");

/** Editor stand-in with the four methods the note-writing actions call. */
class FakeEditor {
	value: string;
	inserted: string[] = [];

	constructor(value = "") {
		this.value = value;
	}

	getValue(): string {
		return this.value;
	}

	replaceSelection(text: string): void {
		this.inserted.push(text);
		this.value += text;
	}

	replaceRange(text: string): void {
		this.inserted.push(text);
		this.value += text;
	}

	lastLine(): number {
		return Math.max(this.value.split("\n").length - 1, 0);
	}

	getLine(line: number): string {
		return this.value.split("\n")[line] ?? "";
	}
}

function appWithEditor(
	editor: FakeEditor | null,
	options: { chatFocused?: boolean; chatInMainArea?: boolean; extension?: string } = {},
): App {
	const file = editor ? { path: `Notes/open.${options.extension ?? "md"}`, extension: options.extension ?? "md" } : null;
	const view = editor ? Object.assign(new MarkdownView({} as WorkspaceLeaf), { editor, file }) : null;
	const leaf = view ? ({ view } as unknown as WorkspaceLeaf) : null;
	const chatLeaf = { view: {} } as unknown as WorkspaceLeaf;

	return {
		workspace: {
			getActiveFile: () => file,
			activeEditor: options.chatFocused || !view ? null : view,
			getMostRecentLeaf: () => (options.chatInMainArea ? chatLeaf : options.chatFocused ? leaf : null),
			getLeavesOfType: (type: string) => (type === "markdown" && leaf ? [leaf] : []),
		},
	} as unknown as App;
}

describe("assistantText", () => {
	it("returns the prose only, so thinking and tool calls never reach a note", () => {
		const message = {
			...assistantBase(),
			content: [
				{ type: "thinking", thinking: "internal reasoning" },
				{ type: "text", text: "The answer." },
				{ type: "toolCall", id: "c1", name: "read", arguments: {} },
			],
		} as AssistantMessage;

		expect(assistantText(message)).toBe("The answer.");
	});

	it("is empty for a turn that only called tools", () => {
		const message = { ...assistantBase(), content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }] } as AssistantMessage;
		expect(assistantText(message)).toBe("");
	});
});

describe("precedingUserText", () => {
	it("finds the question behind a reply, skipping the tool traffic between them", () => {
		const messages = [
			userMessage("summarize my note"),
			{ ...assistantBase(), content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }] } as AgentMessage,
			toolResult(),
			{ ...assistantBase(), content: [{ type: "text", text: "Here it is." }] } as AgentMessage,
		];

		expect(precedingUserText(messages, 3)).toBe("summarize my note");
	});

	it("reads a structured user turn's text parts", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "look at this" }, { type: "image", mimeType: "image/png", data: "" }], timestamp: 0 } as AgentMessage,
			{ ...assistantBase(), content: [{ type: "text", text: "ok" }] } as AgentMessage,
		];

		expect(precedingUserText(messages, 1)).toBe("look at this");
	});

	it("is empty when nothing precedes the reply", () => {
		expect(precedingUserText([{ ...assistantBase(), content: [{ type: "text", text: "hi" }] } as AgentMessage], 0)).toBe("");
	});
});

describe("insertAtCursor", () => {
	it("writes at the caret of the open note", () => {
		const editor = new FakeEditor("existing");
		expect(insertAtCursor(appWithEditor(editor), "inserted")).toBe(true);
		expect(editor.inserted).toEqual(["inserted"]);
	});

	it("keeps writing after the chat sidebar takes focus", () => {
		const editor = new FakeEditor("existing");

		expect(insertAtCursor(appWithEditor(editor, { chatFocused: true }), "inserted")).toBe(true);
		expect(editor.inserted).toEqual(["inserted"]);
	});

	it("finds the open note when the chat occupies the main area on mobile", () => {
		const editor = new FakeEditor("existing");

		expect(insertAtCursor(appWithEditor(editor, { chatFocused: true, chatInMainArea: true }), "inserted")).toBe(true);
		expect(editor.inserted).toEqual(["inserted"]);
	});

	it("reports failure when no note is open, so the caller can say why", () => {
		expect(insertAtCursor(appWithEditor(null), "inserted")).toBe(false);
	});

	it("reports failure when the most recent file is not Markdown", () => {
		expect(insertAtCursor(appWithEditor(new FakeEditor(), { chatFocused: true, extension: "pdf" }), "inserted")).toBe(false);
	});
});

describe("appendToActiveNote", () => {
	it("separates the appended reply from existing content with a blank line", () => {
		const editor = new FakeEditor("first line");
		expect(appendToActiveNote(appWithEditor(editor), "appended")).toBe(true);
		expect(editor.inserted).toEqual(["\n\nappended"]);
	});

	it("adds no separator to an empty note", () => {
		const editor = new FakeEditor("   ");
		appendToActiveNote(appWithEditor(editor), "appended");
		expect(editor.inserted).toEqual(["appended"]);
	});

	it("keeps appending after the chat sidebar takes focus", () => {
		const editor = new FakeEditor("first line");

		expect(appendToActiveNote(appWithEditor(editor, { chatFocused: true }), "appended")).toBe(true);
		expect(editor.inserted).toEqual(["\n\nappended"]);
	});

	it("reports failure when no note is open", () => {
		expect(appendToActiveNote(appWithEditor(null), "appended")).toBe(false);
	});
});

describe("copyToClipboard", () => {
	const originalNavigator = (globalThis as { navigator?: unknown }).navigator;
	afterAll(() => {
		if (originalNavigator !== undefined) {
			(globalThis as { navigator?: unknown }).navigator = originalNavigator;
		} else {
			delete (globalThis as { navigator?: unknown }).navigator;
		}
	});

	beforeEach(() => {
		delete (globalThis as { navigator?: unknown }).navigator;
	});

	it("reports success when the clipboard accepts the write", async () => {
		let written = "";
		(globalThis as { navigator?: unknown }).navigator = { clipboard: { writeText: async (text: string) => void (written = text) } };

		expect(await copyToClipboard("copied")).toBe(true);
		expect(written).toBe("copied");
	});

	it("reports failure instead of throwing when the clipboard rejects", async () => {
		(globalThis as { navigator?: unknown }).navigator = {
			clipboard: {
				writeText: async () => {
					throw new Error("denied");
				},
			},
		};

		expect(await copyToClipboard("copied")).toBe(false);
	});

	it("reports failure when there is no clipboard at all", async () => {
		expect(await copyToClipboard("copied")).toBe(false);
	});
});

function assistantBase(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

function toolResult(): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "c1",
		toolName: "read",
		content: [{ type: "text", text: "note body" }],
		isError: false,
		timestamp: Date.now(),
	} as AgentMessage;
}
