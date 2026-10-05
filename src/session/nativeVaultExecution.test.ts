import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, type StorageWrite } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { DurableVaultStorage } from "./DurableVaultStorage";
import { SESSION_FORMAT } from "./sessionMetadata";

const path = "Piem/chats/native.jsonl";

class ObservedAdapter extends MemoryAdapter {
	onCommit?: (writes: StorageWrite[]) => void;
	override async append(file: string, content: string) {
		await super.append(file, content);
		if (file === path) this.onCommit?.((JSON.parse(content) as { writes: StorageWrite[] }).writes);
	}
}

async function fixture() {
	const adapter = new ObservedAdapter();
	await adapter.write(path, `${JSON.stringify({ kind: "header", v: SESSION_FORMAT, id: "native" })}\n`);
	const storage = await DurableVaultStorage.open(adapter, path);
	const faux = fauxProvider({ tokensPerSecond: Infinity });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let writes = 0;
	const tool = defineTool({
		name: "write_note", description: "Write a note", parameters: Type.Object({}), replay: "unsafe",
		execute: async (_args, _api, ctx) => {
			writes++;
			await adapter.write("note.md", "Written once");
			started.resolve();
			const abort = () => release.resolve();
			ctx.abortSignal?.addEventListener("abort", abort, { once: true });
			try { await release.promise; }
			finally { ctx.abortSignal?.removeEventListener("abort", abort); }
			return { content: [{ type: "text" as const, text: "Saved" }] };
		},
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "vault-contract", tools: [tool] }));
	const options = { models, registry };
	const harness = await Harness.open(storage, options, context);
	const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
	faux.setResponses([fauxAssistantMessage(fauxToolCall("write_note", {}), { stopReason: "toolUse" })]);
	return { adapter, storage, faux, options, harness, root, started, release, writes: () => writes };
}

async function openCopy(content: string, options: Parameters<typeof Harness.open>[1]) {
	const adapter = new MemoryAdapter();
	await adapter.write(path, content);
	const storage = await DurableVaultStorage.open(adapter, path);
	const harness = await Harness.open(storage, options, context);
	return { storage, harness };
}

// Native engine contract only; production Piem still has its separate execution bridge.
test("Vault commits restore native generation/tool ownership, interrupted unsafe writes and queued request IDs", async () => {
	const f = await fixture();
	let copy: Awaited<ReturnType<typeof openCopy>> | undefined;
	try {
		const input = { type: "input", content: "Write the note", requestId: "first" } as const;
		const first = await f.root.submit(input, context);
		await f.started.promise;
		const queuedInput = { type: "input", content: "Follow up", requestId: "queued", whenBusy: "followUp" } as const;
		const queued = await f.root.submit(queuedInput, context);
		const tasks = (await f.storage.scanTasks({}, 20, undefined, context)).items;
		const generation = tasks.find(task => task.kind === "pi.generation");
		const tool = tasks.find(task => task.kind === "pi.tool");
		expect(generation).toBeDefined();
		expect(tool?.owner).toBe(generation?.id);
		expect(tool?.state.status).toBe("running");
		const before = (await f.storage.scanEntries({ conversationId: f.root.id }, 50, undefined, context)).items;
		expect(before.some(entry => entry.kind === "pi.tool-result")).toBe(false);
		expect(await f.adapter.read("note.md")).toBe("Written once");
		const saved = await f.adapter.read(path); // Cut after the real side effect, before its tool result.
		await f.harness.close(context);
		f.faux.setResponses([fauxAssistantMessage("Interrupted write acknowledged"), fauxAssistantMessage("Follow-up answered")]);
		copy = await openCopy(saved, f.options);
		const root = await copy.harness.root(context);
		const recovered = await root.submit(input, context);
		const recoveredQueue = await root.submit(queuedInput, context);
		expect(recovered.id).toBe(first.id);
		expect(recoveredQueue.id).toBe(queued.id);
		expect((await recovered.wait(context)).status).toBe("done");
		expect((await recoveredQueue.wait(context)).status).toBe("done");
		expect(f.writes()).toBe(1);
		const entries = (await copy.storage.scanEntries({ conversationId: root.id }, 50, undefined, context)).items;
		expect(entries.filter(entry => entry.kind === "pi.user")).toHaveLength(2);
		expect(f.faux.state.callCount).toBe(3); // Initial tool call, recovered answer, queued answer.
		const results = entries.flatMap(entry => entry.model ?? []).filter(message => message.role === "toolResult");
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ isError: true });
		expect(JSON.stringify(results[0])).toContain("interrupted");
		expect((await copy.storage.task(tool!.id, context))?.state.status).toBe("terminal");
	} finally {
		f.release.resolve();
		await f.harness.close(context);
		await copy?.harness.close(context);
	}
});

test("Vault commits preserve Stop before tool drain and withdraw queued input after reopen", async () => {
	const f = await fixture();
	let copy: Awaited<ReturnType<typeof openCopy>> | undefined;
	try {
		const first = await f.root.submit({ type: "input", content: "Write", requestId: "stop-first" }, context);
		await f.started.promise;
		const queued = await f.root.submit({ type: "input", content: "Do not send", requestId: "stop-queued", whenBusy: "followUp" }, context);
		const marked = Promise.withResolvers<string>();
		f.adapter.onCommit = writes => {
			if (writes.some(write => write.type === "task" && write.value.abortRequested)) {
				// MemoryAdapter.read resolves immediately; capture the committed cancellation frame.
				void f.adapter.read(path).then(marked.resolve);
			}
		};
		const stopping = f.root.abort(context);
		const saved = await marked.promise;
		const snapshotAdapter = new MemoryAdapter();
		await snapshotAdapter.write(path, saved);
		const snapshotStorage = await DurableVaultStorage.open(snapshotAdapter, path);
		try {
			const tasks = (await snapshotStorage.scanTasks({}, 20, undefined, context)).items;
			expect(tasks.find(task => task.kind === "pi.tool")).toMatchObject({
				abortRequested: true, state: { status: "running" },
			});
		} finally { await snapshotStorage.close(); }
		f.adapter.onCommit = undefined;
		await stopping;
		await f.harness.close(context);
		const requests = f.faux.state.callCount;
		copy = await openCopy(saved, f.options);
		copy.harness.resume();
		await copy.harness.waitForIdle(context);
		expect(f.faux.state.callCount).toBe(requests);
		expect(f.writes()).toBe(1);
		const recovered = await copy.harness.submission(first.id, context);
		const recoveredQueue = await copy.harness.submission(queued.id, context);
		expect(await recovered?.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		expect(await recoveredQueue?.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
	} finally {
		f.adapter.onCommit = undefined;
		f.release.resolve();
		await f.harness.close(context);
		await copy?.harness.close(context);
	}
});
