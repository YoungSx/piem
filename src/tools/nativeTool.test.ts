import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import type { AgentTool, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness, MemoryStorage, createRegistry, defineExtension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { nativeTool } from "./nativeTool";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const parameters = Type.Object({ count: Type.Number() });
function tool(execute: AgentTool<typeof parameters, number>["execute"]): AgentTool<typeof parameters, number> {
	return { name: "count", label: "Count", description: "Count", parameters, execute };
}

test("native Harness validates repaired arguments, runs bridge and stores final error/content/details", async () => {
	const storage = new MemoryStorage();
	const models = createModels();
	const faux = fauxProvider({ tokensPerSecond: Infinity });
	models.setProvider(faux.provider);
	const model = faux.getModel();
	let called = false;
	let late: AgentToolUpdateCallback<number> | undefined;
	const old = tool(async (callId, args, signal, update) => {
		called = true;
		expect(callId).toBeTruthy();
		expect(signal?.aborted).toBe(false);
		expect(args).toEqual({ count: 2 });
		update?.({ content: [{ type: "text", text: "prefix" }], details: 1 });
		update?.({ content: [{ type: "text", text: "replacement" }], details: 2 });
		late = update;
		return { content: [{ type: "text", text: "final" }], details: 3, isError: true, usage };
	});
	old.prepareArguments = args => ({ count: Number((args as { count: unknown }).count) });
	old.executionMode = "sequential";
	const bridged = nativeTool(old);
	expect(bridged.replay).toBe("unsafe");
	expect(bridged.executionMode).toBe("sequential");
	const registry = createRegistry();
	registry.install(defineExtension({ name: "bridge", tools: [bridged] }));
	const harness = await Harness.open(storage, { models, registry }, context);
	try {
		const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("count", { count: "2" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		]);
		const submission = await root.submit({ type: "input", content: "Count", requestId: "bridge" }, context);
		expect((await submission.wait(context)).status).toBe("done");
		expect(called).toBe(true);
		late?.({ content: [{ type: "text", text: "late" }], details: 99 });
		const entries = (await storage.scanEntries({ conversationId: root.id }, 50, undefined, context)).items;
		const result = entries.flatMap(entry => entry.model ?? []).find(message => message.role === "toolResult");
		expect(result).toMatchObject({ content: [{ type: "text", text: "final" }], details: 3, isError: true, usage });
	} finally { await harness.close(context); }
});

function api(details: ToolExecutionApi["details"]): ToolExecutionApi {
	return { callId: "call", details, output: () => { throw new Error("Replacement content must not be appended"); } } as unknown as ToolExecutionApi;
}

test("progress writes are serialized; failures drain before execution returns", async () => {
	const writes: unknown[] = [];
	const failure = new Error("storage unavailable");
	const bridged = nativeTool(tool(async (_id, _args, _signal, update) => {
		update?.({ content: [], details: 1 });
		update?.({ content: [], details: 2 });
		return { content: [], details: 3 };
	}));
	await expect(bridged.execute({ count: 1 }, api(async value => {
		writes.push(value);
		throw failure;
	}), context)).rejects.toBe(failure);
	expect(writes).toEqual([{ piemProgress: { content: [], details: 1 } }]);
});

test("cancellation suppresses queued and late updates", async () => {
	const controller = new AbortController();
	const writes: unknown[] = [];
	const bridged = nativeTool(tool(async (_id, _args, _signal, update) => {
		update?.({ content: [], details: 1 });
		controller.abort();
		update?.({ content: [], details: 2 });
		return { content: [], details: 3 };
	}));
	await expect(bridged.execute({ count: 1 }, api(async value => { writes.push(value); }), withAbortSignal(controller.signal, context))).rejects.toBeDefined();
	expect(writes).toEqual([{ piemProgress: { content: [], details: 1 } }]);
});

test("safe is explicit; outputSchema and non-equivalent return contracts fail clearly", async () => {
	const old = tool(async () => ({ content: [], details: 1 }));
	old.replay = "safe";
	expect(nativeTool(old).replay).toBe("safe");
	old.replay = "never";
	expect(nativeTool(old).replay).toBe("unsafe");
	old.outputSchema = Type.Object({});
	expect(() => nativeTool(old)).toThrow("outputSchema");
	for (const extra of [{ structuredContent: {} }, { terminate: true }]) {
		const bridged = nativeTool(tool(async () => ({ content: [], details: 1, ...extra })));
		const result = await bridged.execute({ count: 1 }, api(async () => {}), context);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("already executed");
		expect(JSON.stringify(result.content)).toContain("Do not retry");
	}
});


test("replacement progress preserves AB then A, final C clears envelope, late writes are ignored", async () => {
	const writes: unknown[] = [];
	let late: AgentToolUpdateCallback<undefined> | undefined;
	const bridged = nativeTool({
		name: "progress", label: "Progress", description: "Progress", parameters,
		execute: async (_id, _args, _signal, update: AgentToolUpdateCallback<undefined> | undefined) => {
			late = update;
			update?.({ content: [{ type: "text", text: "AB" }], details: undefined });
			update?.({ content: [{ type: "text", text: "A" }], details: undefined });
			return { content: [{ type: "text" as const, text: "C" }], details: undefined };
		},
	});
	const result = await bridged.execute({ count: 1 }, api(async value => { writes.push(value); }), context);
	late?.({ content: [], details: undefined });
	expect(writes).toEqual([
		{ piemProgress: { content: [{ type: "text", text: "AB" }], details: null } },
		{ piemProgress: { content: [{ type: "text", text: "A" }], details: null } },
	]);
	expect(result).toMatchObject({ content: [{ type: "text", text: "C" }], details: null });
});


test("storage failure aborts an executing tool and preserves the storage error", async () => {
	const failure = new Error("disk full");
	let observedAbort = false;
	const bridged = nativeTool(tool(async (_id, _args, signal, update) => {
		const stopped = new Promise<void>(resolve => signal!.addEventListener("abort", () => { observedAbort = true; resolve(); }, { once: true }));
		update?.({ content: [], details: 1 });
		await stopped;
		throw new Error("tool cancellation");
	}));
	await expect(bridged.execute({ count: 1 }, api(async () => { throw failure; }), context)).rejects.toBe(failure);
	expect(observedAbort).toBe(true);
});

test("progress is copied at emission and slow storage coalesces pending snapshots", async () => {
	const gate = Promise.withResolvers<void>();
	const writes: unknown[] = [];
	const bridged = nativeTool({
		name: "progress", label: "Progress", description: "Progress", parameters,
		execute: async (_id, _args, _signal, update) => {
			const details = { count: 1 };
			update?.({ content: [], details });
			details.count = 2;
			update?.({ content: [], details });
			details.count = 3;
			update?.({ content: [], details });
			details.count = 99;
			gate.resolve();
			return { content: [], details };
		},
	});
	await bridged.execute({ count: 1 }, api(async value => { await gate.promise; writes.push(value); }), context);
	expect(writes).toEqual([
		{ piemProgress: { content: [], details: { count: 1 } } },
		{ piemProgress: { content: [], details: { count: 3 } } },
	]);
});
