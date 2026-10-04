import { expect, it } from "bun:test";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { PiemSession } from "./PiemSession";
import { AgentDoc, UserEntry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

it("retains all branches, labels and UUID identities through a durable import", async () => {
	const metadata = { id: "chat", createdAt: 1, storageVersion: 1 };
	const session = await PiemSession.open(new MemoryStorage(), metadata);
	const first = await session.appendMessage("First");
	const old = await session.appendMessage("Old answer");
	await session.setLabel(old, "bookmark");
	await session.createLane("alternative", first);
	const alternative = await session.appendMessage("Alternative", "alternative");
	await session.setName("A chat");
	const restored = await PiemSession.open(new MemoryStorage(), metadata);
	await restored.restoreLog(await session.getLog(), await session.getLanes());
	expect((await restored.view().findEntries()).map(entry => entry.id)).toEqual([first, old]);
	expect((await restored.view("alternative").findEntries()).map(entry => entry.id)).toEqual([first, alternative]);
	expect(await restored.getLabel(old)).toBe("bookmark");
	expect(await restored.getName()).toBe("A chat");
	await session.close();
	await restored.close();
});

it("uses native fork ancestry and inherits configuration at the selected entry", async () => {
	const storage = new MemoryStorage();
	const session = await PiemSession.open(storage, { id: "native", createdAt: 1, storageVersion: 1 });
	try {
		await session.appendEntry({ type: "model_change", provider: "test", modelId: "first" });
		await session.appendEntry({ type: "thinking_level_change", thinkingLevel: "high" });
		const forkPoint = await session.appendMessage("Shared message");
		await session.appendEntry({ type: "model_change", provider: "test", modelId: "second" });
		await session.appendMessage("Main only");
		await session.createLane("alternative", forkPoint);
		await session.appendMessage("Alternative only", "alternative");
		expect((await session.getConfiguration("main"))?.model.modelId).toBe("second");
		expect(await session.getConfiguration("alternative")).toMatchObject({ model: { modelId: "first" }, thinkingLevel: "high" });
		await session.appendEntry({ type: "thinking_level_change", thinkingLevel: "off" }, "alternative");
		expect((await session.getConfiguration("alternative"))?.thinkingLevel).toBe("off");
		expect((await session.getConfiguration("main"))?.thinkingLevel).toBe("high");
		const conversations = (await storage.scanConversations({}, 10, undefined, BACKGROUND_CONTEXT)).items;
		const fork = conversations.find(item => item.parent)!;
		expect(fork.parent).toBeDefined();
		const entries = (await storage.scanEntries({ conversationId: fork.id }, 10, undefined, BACKGROUND_CONTEXT)).items;
		const texts = entries.filter(UserEntry.is).map(entry => entry.model?.[0]);
		expect(texts).toMatchObject([{ content: "Alternative only" }, { content: "Shared message" }]);
		expect(entries.filter(entry => entry.kind === UserEntry.kind).every(entry => !("message" in (entry.data as object)))).toBe(true);
		const config = await storage.findDocument({ kind: AgentDoc.definition.kind, scope: { kind: "conversation", conversationId: fork.id } }, "current", BACKGROUND_CONTEXT);
		expect(config).toBeDefined();
	} finally { await session.close(); }
});

it("migrates distinct legacy lane configurations without inheriting the main lane's choices", async () => {
	const session = await PiemSession.open(new MemoryStorage(), { id: "legacy", createdAt: 1, storageVersion: 1 });
	try {
		await session.restoreLog([{ kind: "entry", seq: 1, entry: { type: "message", id: "shared", parentId: null, seq: 1, timestamp: 1, message: { role: "user", content: "Shared", timestamp: 1 } } }],
			[{ lane: "main", leafId: "shared" }, { lane: "alternative", leafId: "shared" }], {
				"pi.lane.config/main": { model: { provider: "test", modelId: "A" }, thinkingLevel: "off", activeToolNames: ["read"] },
				"pi.lane.config/alternative": { model: { provider: "test", modelId: "B" }, thinkingLevel: "high", activeToolNames: ["write"] },
			});
		expect(await session.getConfiguration("alternative")).toEqual({ model: { provider: "test", modelId: "B" }, thinkingLevel: "high", activeToolNames: ["write"] });
		expect(await session.getConfiguration("main")).toEqual({ model: { provider: "test", modelId: "A" }, thinkingLevel: "off", activeToolNames: ["read"] });
	} finally { await session.close(); }
});

it("asks Pi for one entry when reading a branch tip", async () => {
	const storage = new MemoryStorage();
	const session = await PiemSession.open(storage, { id: "tip", createdAt: 1, storageVersion: 1 });
	try {
		await session.appendMessage("First");
		const last = await session.appendMessage("Last");
		const limits: number[] = [];
		const scan = storage.scanEntries.bind(storage);
		storage.scanEntries = (...args) => { limits.push(args[1]); return scan(...args); };
		expect(await session.getLeafId()).toBe(last);
		expect(limits).toEqual([1]);
	} finally { await session.close(); }
});
