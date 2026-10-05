import { expect, test } from "bun:test";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage, StorageRejected, type StorageWrite, type Seq } from "@earendil-works/pi-durable";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { PiemSession } from "../session/PiemSession";
import { snapshotSession } from "../session/sessionSnapshot";
import { DurableAgent } from "./DurableAgent";

const metadata = { id: "execution", createdAt: 1, storageVersion: 1 };
const model = {
	id: "test", name: "Test", api: "openai-completions", provider: "test", baseUrl: "https://example.invalid",
	reasoning: false, contextWindow: 100_000, maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<"openai-completions">;

class RecordedStorage extends MemoryStorage {
	readonly commits: Array<{ writes: StorageWrite[]; seq: Seq }> = [];
	override async commit(writes: readonly StorageWrite[], context: Context) {
		const seq = await super.commit(writes, context);
		this.commits.push({ writes: structuredClone([...writes]), seq });
		return seq;
	}
	crashCopy(): MemoryStorage {
		const copy = new MemoryStorage();
		for (const { writes, seq } of this.commits) copy.prepareCommit(structuredClone(writes), seq).apply();
		return copy;
	}
}

function answer(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant", content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: 1,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

function stream(message: AssistantMessage) {
	const result = createAssistantMessageEventStream();
	result.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
	result.end(message);
	return result;
}

async function makeAgent(session: PiemSession, streamFn: StreamFn, tools: AgentTool[] = []) {
	const messages = (await session.view().findEntries()).flatMap(entry => entry.type === "message" ? [entry.message] : []);
	const agent = new DurableAgent({ initialState: { model, tools, messages }, streamFn }, { open: () => session.execution() });
	agent.subscribe(async event => {
		if (event.type === "message_end") await agent.persistMessage(event.message, event.message);
	});
	return agent;
}

test("admits the prompt with its task and commits each answer with its checkpoint", async () => {
	const storage = new RecordedStorage();
	const session = await PiemSession.open(storage, metadata);
	try {
		const agent = await makeAgent(session, async () => {
			const tasks = (await storage.scanTasks({}, 10, undefined, BACKGROUND_CONTEXT)).items;
			expect(tasks).toHaveLength(1);
			expect(tasks[0]?.state.status).toBe("running");
			expect((await session.findEntries({ type: "message" })).length).toBe(1);
			return stream(answer([{ type: "text", text: "Done" }]));
		});
		await agent.prompt("Question");
		const entries = await session.findEntries({ type: "message" });
		expect(entries).toHaveLength(2);
		for (const commit of storage.commits.filter(commit => commit.writes.some(write => write.type === "entry"))) {
			expect(commit.writes.some(write => write.type === "task")).toBe(true);
		}
		expect((await storage.scanTasks({}, 10, undefined, BACKGROUND_CONTEXT)).items[0]?.state).toMatchObject({ status: "terminal", outcome: { status: "completed" } });
	} finally { await session.close(); }
});

test("reopens a tool checkpoint without repeating a write whose result was lost", async () => {
	const storage = new RecordedStorage();
	const session = await PiemSession.open(storage, metadata);
	let writes = 0;
	let started!: () => void;
	const toolStarted = new Promise<void>(resolve => { started = resolve; });
	const tool: AgentTool = {
		name: "write", label: "Write", description: "Write", parameters: Type.Object({}),
		executionMode: "sequential",
		execute: async (_id, _args, signal) => {
			writes++;
			started();
			await new Promise<void>((_resolve, reject) => {
				if (signal?.aborted) reject(signal.reason);
				else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
			return { content: [], details: {} };
		},
	};
	let reads = 0;
	const read: AgentTool = { name: "read", label: "Read", description: "Read", parameters: Type.Object({}), execute: async () => {
		reads++;
		return { content: [{ type: "text", text: "Existing note" }], details: {} };
	} };
	const agent = await makeAgent(session, () => stream(answer([
		{ type: "toolCall", id: "read-1", name: "read", arguments: {} },
		{ type: "toolCall", id: "write-1", name: "write", arguments: {} },
	], "toolUse")), [read, tool]);
	const running = agent.prompt("Write once").catch(() => undefined);
	await toolStarted;
	const copy = storage.crashCopy();
	await session.close();
	await running;
	const reopened = await PiemSession.open(copy, metadata);
	try {
		expect(await (await reopened.execution()).hasPending()).toBe(true);
		const resumed = await makeAgent(reopened, (_model, context) => {
			const results = context.messages.filter(message => message.role === "toolResult");
			expect(results).toHaveLength(2);
			expect(results[0]).toMatchObject({ toolCallId: "read-1", isError: false });
			expect(results[1]).toMatchObject({ toolCallId: "write-1", isError: true });
			return stream(answer([{ type: "text", text: "I will inspect the saved note" }]));
		}, [tool]);
		await resumed.continue();
		expect(writes).toBe(1);
		expect(reads).toBe(1);
		expect((await reopened.findEntries({ type: "message" })).filter(entry => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
		expect(await (await reopened.execution()).hasPending()).toBe(false);
	} finally { await reopened.close(); }
});

test("portable repair restores a matching checkpoint, but rejects a changed transcript", async () => {
	const session = await PiemSession.open(new MemoryStorage(), metadata);
	let ready!: () => void;
	const reached = new Promise<void>(resolve => { ready = resolve; });
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const agent = await makeAgent(session, async () => { ready(); await gate; return stream(answer([])); });
	const running = agent.prompt("Recover this question");
	await reached;
	const snapshot = await snapshotSession(session);
	release();
	await running;
	await session.close();
	for (const changed of [false, true]) {
		const restored = await PiemSession.open(new MemoryStorage(), metadata);
		try {
			await restored.restoreLog(snapshot.log, snapshot.lanes, snapshot.legacyValues);
			if (changed) await restored.appendMessage("A newer request");
			await restored.restoreExecutions(snapshot.executions!);
			expect(await (await restored.execution()).hasPending()).toBe(!changed);
			if (!changed) {
				let requests = 0;
				const resumed = await makeAgent(restored, () => { requests++; return stream(answer([{ type: "text", text: "Recovered" }])); });
				await resumed.continue();
				expect(requests).toBe(1);
				expect(await (await restored.execution()).hasPending()).toBe(false);
			}
		} finally { await restored.close(); }
	}
});

test("a reader does not recover or rewrite another host's running task", async () => {
	const storage = new RecordedStorage();
	const session = await PiemSession.open(storage, metadata);
	let started!: () => void;
	const reached = new Promise<void>(resolve => { started = resolve; });
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const agent = await makeAgent(session, async () => {
		started();
		await gate;
		return stream(answer([{ type: "text", text: "Done" }]));
	});
	const running = agent.prompt("Question");
	try {
		await reached;
		const before = storage.commits.length;
		const readerStorage = storage.crashCopy();
		const reader = await PiemSession.open(readerStorage, metadata, BACKGROUND_CONTEXT, { readOnly: true });
		try {
			expect((await reader.findEntries({ type: "message" })).length).toBe(1);
			expect(storage.commits.length).toBe(before);
			expect((await readerStorage.scanTasks({}, 10, undefined, BACKGROUND_CONTEXT)).items[0]?.state.status).toBe("running");
			await expect(reader.execution()).rejects.toThrow("reader cannot execute");
		} finally { await reader.close(); }
	} finally { release(); await running; await session.close(); }
});

test("failed prompt admission makes no provider request", async () => {
	const storage = new RecordedStorage();
	const session = await PiemSession.open(storage, metadata);
	let requests = 0;
	const agent = await makeAgent(session, () => { requests++; return stream(answer([])); });
	storage.commit = async () => { throw new StorageRejected("Disk full"); };
	try {
		await expect(agent.prompt("Question")).rejects.toThrow("Disk full");
		expect(requests).toBe(0);
		expect(await session.findEntries({ type: "message" })).toEqual([]);
	} finally { await session.close(); }
});

test("an explicit stop settles its task instead of leaving a resumable run", async () => {
	const storage = new RecordedStorage();
	const session = await PiemSession.open(storage, metadata);
	let ready!: () => void;
	const reached = new Promise<void>(resolve => { ready = resolve; });
	const agent = await makeAgent(session, async (_model, _context, options) => {
		ready();
		await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
		return stream(answer([]));
	});
	const running = agent.prompt("Question");
	try {
		await reached;
		agent.abort();
		await running;
		await agent.waitForIdle();
		expect(await (await session.execution()).hasPending()).toBe(false);
		expect((await storage.scanTasks({}, 10, undefined, BACKGROUND_CONTEXT)).items[0]?.state).toMatchObject({ status: "terminal", outcome: { status: "aborted" } });
	} finally { await session.close(); }
});

test("unloading the host preserves its run for recovery", async () => {
	const storage = new RecordedStorage();
	const session = await PiemSession.open(storage, metadata);
	let ready!: () => void;
	const reached = new Promise<void>(resolve => { ready = resolve; });
	const agent = await makeAgent(session, async (_model, _context, options) => {
		ready();
		await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
		return stream(answer([]));
	});
	const running = agent.prompt("Question").catch(() => undefined);
	await reached;
	await agent.suspend();
	await running;
	const reopened = await PiemSession.open(storage.crashCopy(), metadata);
	try { expect(await (await reopened.execution()).hasPending()).toBe(true); }
	finally { await reopened.close(); }
});

test("Stop after admission preserves the accepted prompt in memory and the next request", async () => {
	const storage = new RecordedStorage();
	const session = await PiemSession.open(storage, metadata);
	let requests = 0;
	let accepted = 0;
	const agent = new DurableAgent({ initialState: { model }, streamFn: (_model, context) => {
		requests++;
		expect(context.messages.filter(message => message.role === "user")).toHaveLength(2);
		return stream(answer([]));
	} }, { open: () => session.execution(), admitted: () => { accepted++; } });
	agent.subscribe(async event => { if (event.type === "message_end") await agent.persistMessage(event.message, event.message); });
	const commit = storage.commit.bind(storage);
	let stopFirst = true;
	storage.commit = async (writes, context) => {
		const seq = await commit(writes, context);
		if (stopFirst && writes.some(write => write.type === "task" && write.value.state.status === "pending")) {
			stopFirst = false;
			agent.abort();
		}
		return seq;
	};
	try {
		await agent.prompt("Accepted, then stopped");
		expect(requests).toBe(0);
		expect(accepted).toBe(1);
		expect(agent.state.messages.filter(message => message.role === "user")).toHaveLength(1);
		expect(await (await session.execution()).hasPending()).toBe(false);
		await agent.prompt("Next request");
		expect(requests).toBe(1);
		expect(accepted).toBe(2);
		expect((await session.findEntries({ type: "message" })).filter(entry => entry.type === "message" && entry.message.role === "user")).toHaveLength(2);
	} finally { await session.close(); }
});
