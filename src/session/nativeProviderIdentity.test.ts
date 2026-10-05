import { expect, test } from "bun:test";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	Harness, MemoryStorage, ProviderDoc, configure, createRegistry, createSession,
	defineExtension, defineTool, type Conversation, type StorageWrite, type Seq,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";

// Replay committed writes into a fresh backend, as reopening a persisted store would do.
class RecordedStorage extends MemoryStorage {
	readonly commits: Array<{ writes: StorageWrite[]; seq: Seq }> = [];
	override async commit(writes: readonly StorageWrite[], ctx: Context) {
		const seq = await super.commit(writes, ctx);
		this.commits.push({ writes: structuredClone([...writes]), seq });
		return seq;
	}
	reopen() {
		const copy = new MemoryStorage();
		for (const { writes, seq } of this.commits) copy.prepareCommit(structuredClone(writes), seq).apply();
		return copy;
	}
}

// Dependency contract tests: these exercise the native engine, not Piem's current execution bridge.
function fixture() {
	const faux = fauxProvider({ tokensPerSecond: Infinity });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	const agent = { model: { provider: model.provider, modelId: model.id } };
	const options = {
		models, registry: createRegistry(),
		settings: { retry: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 } },
	};
	return { faux, agent, options };
}

async function submit(conversation: Pick<Conversation, "submit">, content: string) {
	const result = await (await conversation.submit({ type: "input", content }, context)).wait(context);
	expect(result.status).toBe("done");
	return result;
}

test("native generation keeps its persisted provider identity across retry and reopen", async () => {
	const { faux, agent, options } = fixture();
	const storage = new RecordedStorage();
	let harness = await Harness.open(storage, options, context);
	const ids: Array<string | undefined> = [];
	try {
		const root = await harness.root(context, { agent });
		const identity = (await harness.snapshot(ProviderDoc, root.id, context))?.sessionId;
		expect(identity).toBeString();
		faux.setResponses([
			(_messages, request) => {
				ids.push(request?.sessionId);
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded" });
			},
			(_messages, request) => {
				ids.push(request?.sessionId);
				return fauxAssistantMessage("Recovered");
			},
		]);
		await submit(root, "Retry once");
		expect(ids).toEqual([identity, identity]);
		await harness.close(context);
		harness = await Harness.open(storage.reopen(), options, context);
		const reopened = await harness.root(context);
		expect(reopened.id).toBe(root.id);
		faux.setResponses([(_messages, request) => {
			ids.push(request?.sessionId);
			return fauxAssistantMessage("Still here");
		}]);
		await submit(reopened, "Next turn");
		expect(ids).toEqual([identity, identity, identity]);
	} finally { await harness.close(context); }
});

test("native forks and task-owned child conversations receive independent provider identities", async () => {
	const { faux, agent, options } = fixture();
	const ids: Array<string | undefined> = [];
	const childTool = defineTool({
		name: "child", description: "Ask a child conversation", parameters: Type.Object({}),
		execute: async (_args, api, ctx) => {
			const childId = await api.commit(async tx => {
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
				await configure(tx, child.id, { tools: [] });
				return child.id;
			}, ctx);
			const child = await api.conversation(childId, ctx);
			if (!child) throw new Error("Child conversation missing");
			await submit(child, "Child question");
			return { content: [{ type: "text" as const, text: "Child answered" }] };
		},
	});
	options.registry.install(defineExtension({ name: "identity-test", tools: [childTool] }));
	const harness = await Harness.open(new MemoryStorage(), options, context);
	try {
		const root = await harness.root(context, { agent });
		faux.setResponses([
			(_messages, request) => { ids.push(request?.sessionId); return fauxAssistantMessage(fauxToolCall("child", {}), { stopReason: "toolUse" }); },
			(_messages, request) => { ids.push(request?.sessionId); return fauxAssistantMessage("Child answer"); },
			(_messages, request) => { ids.push(request?.sessionId); return fauxAssistantMessage("Parent answer"); },
			(_messages, request) => { ids.push(request?.sessionId); return fauxAssistantMessage("Fork answer"); },
		]);
		const settled = await submit(root, "Delegate");
		if (settled.status !== "done" || settled.type !== "input") throw new Error("Missing parent answer");
		const fork = await root.fork(settled.answer, { ownership: { kind: "ownerless" } }, context);
		await submit(fork, "Continue separately");
		expect(ids).toHaveLength(4);
		for (const id of ids) expect(id).toBeString();
		expect(ids[0]).toBe(ids[2]);
		expect(new Set(ids).size).toBe(3);
	} finally { await harness.close(context); }
});

test("native generation persists missing legacy provider identity before dispatch", async () => {
	const { faux, agent, options } = fixture();
	const storage = new RecordedStorage();
	// A plain Session creates pre-Harness data without the new built-in provider document.
	const legacy = createSession(storage);
	const id = await legacy.commit(async tx => {
		const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
		await configure(tx, conversation.id, agent);
		return conversation.id;
	}, context);
	expect(await legacy.snapshot(ProviderDoc, id, context)).toBeUndefined();
	await legacy.close(context);
	const harness = await Harness.open(storage.reopen(), options, context);
	const identities: Array<string | undefined> = [];
	try {
		const conversation = await harness.conversation(id, context);
		if (!conversation) throw new Error("Legacy conversation missing");
		const response = async (_messages: unknown, request: { sessionId?: string } | undefined) => {
			const saved = await harness.snapshot(ProviderDoc, id, context);
			expect(saved?.sessionId).toBeString();
			expect(request?.sessionId).toBe(saved?.sessionId);
			identities.push(request?.sessionId);
			return fauxAssistantMessage("Legacy answer");
		};
		faux.setResponses([response, response]);
		await submit(conversation, "First native turn");
		await submit(conversation, "Second native turn");
		expect(identities).toHaveLength(2);
		expect(identities[0]).toBe(identities[1]);
	} finally { await harness.close(context); }
});
