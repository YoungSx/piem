import { expect, test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry, MemoryStorage, SystemEntry, CompactionEntry, ResetEntry, UserEntry, type ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { nativeChatProjection } from "./nativeChatProjection";

async function fixture() {
	const models = createModels();
	const provider = fauxProvider({ tokensPerSecond: Infinity });
	models.setProvider(provider.provider);
	const model = provider.getModel();
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
	const conversation = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
	return { harness, conversation, provider };
}

test("projects official submitted messages without copying them to storage", async () => {
	const f = await fixture();
	try {
		f.provider.setResponses([fauxAssistantMessage("Answer")]);
		await (await f.conversation.submit({ type: "input", content: "Question" }, context)).wait(context);
		const view = await f.conversation.viewState(context);
		try {
			const result = nativeChatProjection(view.value);
			expect(result.messages.map(message => message.role)).toEqual(["user", "assistant"]);
			expect(result.busy).toBe(false);
			expect(result.pendingToolCalls).toEqual([]);
			expect(result.messages[0]).toBe(view.value.entries.find(entry => entry.kind === "pi.user")?.model?.[0]);
		} finally { view.dispose(); }
	} finally { await f.harness.close(context); }
});

test("committed progress replaces older output and done tools disappear", async () => {
	const f = await fixture();
	try {
		const view = await f.conversation.viewState(context);
		try {
			const withLive = (content: string): ConversationView => ({ ...view.value, docs: { ...view.value.docs, "pi.live": {
				run: { taskId: 1, inputs: [] }, generation: { attempt: 2, retry: { at: 100, error: "retry" } },
				tools: [{ name: "write", callId: "one", status: "running", output: "old output", details: { piemProgress: { content: [{ type: "text", text: content }] } } },
					{ name: "read", callId: "two", status: "done" }],
			} } });
			expect(nativeChatProjection(withLive("Longer")).pendingToolCalls[0]?.progress).toBe("Longer");
			const next = nativeChatProjection(withLive("A"));
			expect(next.pendingToolCalls).toEqual([{ id: "one", name: "write", progress: "A" }]);
			expect(next.busy).toBe(true);
			expect(next.retry?.error).toBe("retry");
			expect(nativeChatProjection(withLive("")).pendingToolCalls[0]?.progress).toBe("");
		} finally { view.dispose(); }
	} finally { await f.harness.close(context); }
});


test("official system declarations, summaries and reset handoffs never become visible user messages", async () => {
	const f = await fixture();
	try {
		await f.conversation.commit(async tx => {
			const first = await tx.appendEntry(UserEntry, f.conversation.id, { model: [{ role: "user", content: "Actual question", timestamp: 1 }] });
			await tx.appendEntry(SystemEntry, f.conversation.id, { model: [{ role: "system", content: "Internal instructions", timestamp: 1 }] });
			await tx.appendEntry(CompactionEntry, f.conversation.id, { head: first.id, data: { reason: "manual" }, model: [{ role: "user", content: "Internal summary", timestamp: 2 }] });
		}, context);
		const view = await f.conversation.viewState(context);
		try {
			expect(view.value.entries.some(entry => SystemEntry.is(entry))).toBe(true);
			expect(view.value.entries.some(entry => CompactionEntry.is(entry))).toBe(true);
			expect(nativeChatProjection(view.value).messages).toEqual([{ role: "user", content: "Actual question", timestamp: 1 }]);
			await f.conversation.commit(async tx => {
				await tx.appendEntry(ResetEntry, f.conversation.id, { head: "self", model: [{ role: "user", content: "Internal handoff", timestamp: 3 }] });
			}, context);
			expect(nativeChatProjection(view.value).messages).toEqual([]);
		} finally { view.dispose(); }
	} finally { await f.harness.close(context); }
});
