import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { convertToLlm } from "@earendil-works/pi-agent-core";
import { createReferenceMessage, messageReferences, parseContextReferences, type ContextReference } from "./contextReference";
import { installObsidianStub, requestUrlMock } from "../testUtils/obsidianStub";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { stubWindowTimers } from "../testUtils/windowStub";

installObsidianStub();
const restore = stubWindowTimers();
afterAll(restore);
const { harness } = await import("../testUtils/nativeExtensionServiceHarness");
const { DraftStore } = await import("../session/DraftStore");
const { renderTranscriptMarkdown } = await import("./exportNote");

const references: ContextReference[] = [
	{ kind: "file", path: "Notes/A.md" }, { kind: "folder", path: "Projects" },
	{ kind: "url", url: "https://example.org/a" },
	{ kind: "selection", path: "Notes/B.md", text: "the selected passage", startLine: 3, endLine: 4 },
];

describe("native context references", () => {
	it("uses Pi's native custom message and sends content without renderer metadata", () => {
		const message = createReferenceMessage(references, 123);
		expect(messageReferences(message)).toEqual(references);
		const wire = convertToLlm([message]);
		expect(wire[0]?.role).toBe("user");
		expect(JSON.stringify(wire)).toContain("the selected passage");
		expect(JSON.stringify(wire)).not.toContain("customType");
		expect(JSON.stringify(wire)).not.toContain("details");
	});

	it("does not disguise model text using different renderer metadata", () => {
		const message = createReferenceMessage(references);
		message.content = "Different material";
		expect(messageReferences(message)).toBeNull();
	});

	it("preserves reference material in Markdown export", () => {
		const text = renderTranscriptMarkdown([createReferenceMessage(references)], {
			title: "Conversation", exportedAt: new Date(0), model: "test", roles: { user: "User", assistant: "Agent", tool: "Tool" },
		});
		expect(text).toContain("Notes/A.md");
		expect(text).toContain("the selected passage");
	});

	it.each([[{ kind: "file", path: "../outside.md" }], [{ kind: "url", url: "javascript:alert(1)" }],
		[{ kind: "selection", path: "A.md", text: "long".repeat(600) }]])("rejects unsafe or over-budget serialized references", input => {
		expect(parseContextReferences(input)).toBeNull();
	});

	it("persists cards with their question and restores them from a native session", async () => {
		const h = harness(() => undefined);
		try {
			expect(await h.service.sendPrompt("Review my references", [], references)).toBe(true);
			const messages = h.service.getSnapshot().messages;
			expect(messages[0]?.role).toBe("user");
			expect(messageReferences(messages[1])).toEqual(references);
			const session = h.service.getActiveSessionPath()!;
			const restored = await h.sessions.buildSessionContextFor(session);
			expect(messageReferences(restored.messages.find(message => message.role === "custom"))).toEqual(references);
			const wire = JSON.stringify(h.requests[0]);
			expect(wire).toContain("Notes/A.md");
			expect(wire).toContain("https://example.org/a");
			expect(wire).not.toContain("piem-context-references");
		} finally { h.service.dispose(); }
	});

	it("refuses duplicate preparation through a new caller before Pi accepts the question", async () => {
		let entered!: () => void;
		let release!: () => void;
		const ready = new Promise<void>(resolve => { entered = resolve; });
		const gate = new Promise<void>(resolve => { release = resolve; });
		const h = harness(() => undefined);
		await h.service.initialize();
		const refreshConfiguration = h.service.refreshConfiguration.bind(h.service);
		const refresh = spyOn(h.service, "refreshConfiguration").mockImplementationOnce(async () => {
			entered(); await gate; await refreshConfiguration();
		});
		const first = h.service.sendPrompt("Question", [], references);
		try {
			await ready;
			const duplicate = await h.service.sendPrompt("Question", [], references);
			release();
			expect(duplicate).toBe(false);
			expect(await first).toBe(true);
			expect(h.service.getSnapshot().messages.filter(message => message.role === "user")).toHaveLength(1);
		} finally { release(); await first; refresh.mockRestore(); h.service.dispose(); }
	});

	it("retains references when retrying a reply and replaces them when editing the question", async () => {
		const h = harness(() => undefined);
		h.settings.networkTransport = "requestUrl";
		requestUrlMock.mockImplementation(async () => ({ status: 200, headers: { "content-type": "text/event-stream" },
			text: 'data: {"id":"summary","choices":[{"index":0,"delta":{"content":"Summary"},"finish_reason":null}]}\n\ndata: {"id":"summary","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
		}));
		try {
			await h.service.sendPrompt("Original question", [], references);
			expect(await h.service.retryFrom(h.service.getSnapshot().messages.length - 1)).toBe(true);
			let messages = h.service.getSnapshot().messages;
			let index = messages.findLastIndex(message => message.role === "user");
			expect(messageReferences(messages[index + 1])).toEqual(references);
			expect(await h.service.editAndResend(index, "New question", [], [references[0]!])).toBe(true);
			messages = h.service.getSnapshot().messages;
			index = messages.findLastIndex(message => message.role === "user");
			expect(messageReferences(messages[index + 1])).toEqual([references[0]!]);
		} finally { h.service.dispose(); requestUrlMock.mockReset(); }
	});

	it("restores reference-only drafts after reload and clears text and cards together", async () => {
		const h = harness(() => undefined);
		(h.adapter as unknown as MemoryAdapter).allowReplaceRemoval = true;
		const store = new DraftStore(h.adapter, "Drafts");
		const reopened = new DraftStore(h.adapter, "Drafts");
		try {
			await store.set("a", "", references);
			await store.flush();
			expect(await reopened.getDraft("a")).toEqual({ text: "", references });
			await reopened.set("a", "Question");
			expect((await reopened.getDraft("a")).references).toEqual(references);
			await reopened.clear("a");
			await reopened.flush();
			expect(await h.adapter.exists("Drafts/drafts/a.json")).toBe(false);
		} finally { store.dispose(); reopened.dispose(); h.service.dispose(); }
	});
});
