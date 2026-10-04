import { afterAll, expect, test } from "bun:test";
import type { AgentMessage, AgentTurnContext } from "@earendil-works/pi-agent-core";
import type { Entry } from "../session/sessionTypes";
import { getCurrentSystemPrompt, type AssistantMessage } from "@earendil-works/pi-ai";
import { prepareExtensionBoundary, type BoundarySnapshot } from "./extensionBoundary";
import { createExtensionHost } from "./extensionHost";
import { stubWindowTimers } from "../testUtils/windowStub";

afterAll(stubWindowTimers());

function fixture(): BoundarySnapshot {
	const messages: AgentMessage[] = [
		{ role: "system", content: "Keep the vault boundary", timestamp: 0 },
		{ role: "user", content: "Remember this", timestamp: 1 },
		{ role: "user", content: "Keep this", timestamp: 2 },
	];
	return { messages, messageOrigins: ["s", "a", "b"], pendingMessages: [], entries: messages.map((message, index): Entry => ({ type: "message", message, id: ["s", "a", "b"][index]!, parentId: index === 0 ? null : ["s", "a"][index - 1]!, seq: index + 1, timestamp: index })) };
}

test("boundary preview preserves prompt and retained origins, without changing live messages", () => {
	const snapshot = fixture();
	const prepared = prepareExtensionBoundary(snapshot, [
		{ type: "custom", customType: "counter", data: { count: 1 } },
		{ type: "custom_message", customType: "hint", content: "next step", display: false },
		{ type: "compaction", summary: "Earlier work", firstKeptEntryId: "b" },
	], ["c", "d", "e"]);
	expect(snapshot.messages).toHaveLength(3);
	expect(getCurrentSystemPrompt(prepared.context.llmMessages)).toBe("Keep the vault boundary");
	expect(prepared.messages.map(message => message.role)).toEqual(["system", "compactionSummary", "user", "custom"]);
	expect(prepared.messageOrigins).toEqual([null, "e", "b", "d"]);
	expect(prepared.entries.map(entry => entry.type)).toEqual(["custom", "message", "compaction"]);
	expect(prepared.context.canContinue).toBe(true);
	expect(prepared.context.contextEntries.some(entry => entry.sourceEntry.id === "a")).toBe(false);
});

test("invalid targets and unavailable context edits fail before persistence", () => {
	expect(() => prepareExtensionBoundary(fixture(), [{ type: "compaction", summary: "s", firstKeptEntryId: "missing" }], ["c"])).toThrow("active branch");
	expect(() => prepareExtensionBoundary(fixture(), [{ type: "context_edit", targetId: "a", replacement: null }], ["c"])).toThrow("context_edit is unavailable");
});

test("compaction may retain a custom state entry and its following messages", () => {
	const snapshot = fixture();
	const state: Entry = { type: "custom", customType: "state", data: { count: 1 }, id: "state", parentId: "a", seq: 3, timestamp: 2 };
	snapshot.entries.splice(2, 0, state);
	snapshot.entries[3] = { ...snapshot.entries[3]!, parentId: state.id, seq: 4 };
	const prepared = prepareExtensionBoundary(snapshot, [{ type: "compaction", summary: "New summary", firstKeptEntryId: state.id }], ["compact"]);
	expect(prepared.messages.map(message => message.role)).toEqual(["system", "compactionSummary", "user"]);
	expect(prepared.messages[2]).toBe(snapshot.messages[2]);
	expect(prepared.messageOrigins).toEqual([null, "compact", "b"]);
	expect(prepared.context.contextEntries.map(entry => entry.sourceEntry.id)).toEqual(["compact", "state", "b"]);
	expect(prepared.context.contextEntries[1]?.messages).toEqual([]);
});

test("retaining an earlier compaction entry does not replay its summary or retained tail", () => {
	const initial = fixture();
	const first = prepareExtensionBoundary(initial, [{ type: "compaction", summary: "Old summary", firstKeptEntryId: "b" }], ["old"]);
	const snapshot: BoundarySnapshot = { ...initial, entries: [...initial.entries, ...first.entries], messages: first.messages, messageOrigins: first.messageOrigins };
	const prepared = prepareExtensionBoundary(snapshot, [
		{ type: "custom_message", customType: "after", content: "After old summary", display: false },
		{ type: "compaction", summary: "Latest summary", firstKeptEntryId: "old" },
	], ["after", "latest"]);
	expect(prepared.messages.map(message => message.role)).toEqual(["system", "compactionSummary", "custom"]);
	expect(prepared.messageOrigins).toEqual([null, "latest", "after"]);
	expect(JSON.stringify(prepared.context.llmMessages)).not.toContain("Old summary");
	expect(JSON.stringify(prepared.context.llmMessages)).not.toContain("Keep this");
	expect(prepared.context.contextEntries.map(entry => entry.sourceEntry.id)).toEqual(["latest", "old", "after"]);
	expect(prepared.context.contextEntries[1]?.messages).toEqual([]);
});

	test("native boundary handlers chain previews, commit once, and do not run twice on turn_end", async () => {
	let snapshot = fixture();
	const reply: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "Reply" }], timestamp: 2, api: "openai-completions", provider: "test", model: "test", stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	snapshot.messages[2] = reply;
	let calls = 0, commits = 0;
	const host = await createExtensionHost([{ id: "boundary", factory: pi => {
		pi.on("turn_end", event => {
			calls++;
			expect(event.messageEntryId).toBe("b");
			return { entries: [{ type: "custom_message", customType: "hint", content: "continue", display: false }], continue: true };
		});
		pi.on("turn_end", event => {
			expect(event.context.contextMessages.at(-1)?.role).toBe("custom");
			expect(event.continue).toBe(true);
		});
	} }], {
		getEntries: () => [], notify: () => {},
		boundary: {
			getMessageEntryId: message => snapshot.messageOrigins[snapshot.messages.indexOf(message)] ?? undefined,
			buildContext: drafts => prepareExtensionBoundary(snapshot, drafts, ["c"]).context,
			commit: async drafts => {
				commits++;
				const result = prepareExtensionBoundary(snapshot, drafts, ["c"]);
				snapshot = { ...snapshot, messages: result.messages, messageOrigins: result.messageOrigins, entries: [...snapshot.entries, ...result.entries] };
			},
		},
	});
	try {
		const message = reply;
		const turn: AgentTurnContext = { message, toolResults: [], context: { messages: snapshot.messages, tools: [] }, newMessages: [message] };
		expect(await host.finishTurn(turn)).toBe(true);
		await host.emitAgentEvent({ type: "turn_end", message, toolResults: [] });
		expect(calls).toBe(1);
		expect(commits).toBe(1);
	} finally { host.dispose(); }
});
