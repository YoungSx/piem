import { afterAll, expect, test } from "bun:test";
import { installObsidianStub } from "../testUtils/obsidianStub";
import { stubWindowTimers } from "../testUtils/windowStub";

installObsidianStub();
afterAll(stubWindowTimers());
const { harness } = await import("../testUtils/nativeExtensionServiceHarness");
const { ObsidianSessionManager } = await import("../session/ObsidianSessionManager");
const { BACKGROUND_CONTEXT } = await import("@earendil-works/pi-agent-core");

test("boundary continuation reaches the provider once and survives stored-session replay", async () => {
	let calls = 0;
	const f = harness(pi => {
		pi.on("turn_end", event => {
			calls++;
			expect(event.messageEntryId).not.toBe("");
			if (calls !== 1) return;
			return { entries: [{ type: "custom_message", customType: "boundary-hint", content: "Continue with the next step", display: false }], continue: true };
		});
	});
	try {
		expect(await f.service.sendPrompt("Start")).toBe(true);
		expect(f.requests).toHaveLength(2);
		expect(calls).toBe(2);
		expect(JSON.stringify(f.requests[1]?.messages)).toContain("Continue with the next step");
		const path = f.sessions.getActiveSessionPath()!;
		const replay = await f.sessions.buildSessionContextFor(path);
		expect(replay.messages.filter(message => message.role === "custom" && message.customType === "boundary-hint")).toHaveLength(1);
		const reopened = new ObsidianSessionManager(f.adapter, "Piem/sessions", "obsidian-vault:Bridge test");
		await reopened.loadSession(path);
		try {
			const coldReplay = await reopened.buildSessionContext();
			expect(coldReplay.messages.filter(message => message.role === "custom" && message.customType === "boundary-hint")).toHaveLength(1);
		} finally { await reopened.getSession().close(BACKGROUND_CONTEXT); }
		expect(f.service.getSnapshot().errorMessage).toBeUndefined();
	} finally { f.service.dispose(); }
});

test("boundary compaction and its continuation retain one copy of the kept message", async () => {
	let calls = 0;
	const f = harness(pi => {
		pi.on("turn_end", event => {
			if (++calls !== 1) return;
			const user = event.context.contextEntries.find(entry => entry.sourceEntry.type === "message" && entry.sourceEntry.message.role === "user");
			if (!user) throw new Error("Missing persisted user prompt");
			return { entries: [
				{ type: "compaction", summary: "Boundary summary", firstKeptEntryId: user.sourceEntry.id },
				{ type: "custom_message", customType: "after-summary", content: "Continue after summary", display: false },
			], continue: true };
		});
	});
	try {
		expect(await f.service.sendPrompt("Keep this prompt")).toBe(true);
		expect(f.requests).toHaveLength(2);
		expect(JSON.stringify(f.requests[1]?.messages)).toContain("Boundary summary");
		const replay = await f.sessions.buildSessionContext();
		expect(replay.messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes("Keep this prompt"))).toHaveLength(1);
		expect(f.service.getSnapshot().errorMessage).toBeUndefined();
	} finally { f.service.dispose(); }
});

test("before-settle continuation starts a tracked run and then settles once", async () => {
	let boundaries = 0, settled = 0;
	const f = harness(pi => {
		pi.on("agent_before_settle", () => {
			if (++boundaries !== 1) return;
			return { entries: [{ type: "custom_message", customType: "settle-hint", content: "Finish the next step", display: false }], continue: true };
		});
		pi.on("agent_settled", () => { settled++; });
	});
	try {
		await f.service.sendPrompt("Start");
		for (let i = 0; i < 100 && !settled; i++) await new Promise(resolve => setTimeout(resolve, 10));
		expect(f.requests).toHaveLength(2);
		expect(boundaries).toBe(2);
		expect(settled).toBe(1);
		expect(JSON.stringify(f.requests[1]?.messages)).toContain("Finish the next step");
		expect(f.service.getSnapshot().isStreaming).toBe(false);
		expect(f.service.getSnapshot().errorMessage).toBeUndefined();
	} finally { f.service.dispose(); }
});

test("unsupported context edit rejects the entire draft batch before any custom entry is saved", async () => {
	const f = harness(pi => {
		pi.on("turn_end", event => ({ entries: [
			{ type: "custom", customType: "must-not-save", data: { value: 1 } },
			{ type: "context_edit", targetId: event.messageEntryId, replacement: null },
		] }));
	});
	try {
		await f.service.sendPrompt("Start");
		const entries = await f.sessions.getSession().view("main").findEntriesOnBranch({ order: "oldestFirst" });
		expect(entries.some(entry => entry.type === "custom" && entry.customType === "must-not-save")).toBe(false);
		expect(JSON.stringify(f.service.getSnapshot())).toContain("context_edit is unavailable");
		expect(f.requests).toHaveLength(1);
	} finally { f.service.dispose(); }
});

test("a failed atomic boundary write persists neither custom state nor its message", async () => {
	let failed = false;
	const f = harness(pi => {
		pi.on("turn_end", () => ({ entries: [
			{ type: "custom", customType: "atomic-state", data: { value: 1 } },
			{ type: "custom_message", customType: "atomic-message", content: "must not appear", display: false },
		], continue: true }));
	});
	const append = f.adapter.append.bind(f.adapter);
	f.adapter.append = async (path, data, options) => {
		if (data.includes("atomic-state")) { failed = true; throw new Error("Disk unavailable"); }
		await append(path, data, options);
	};
	try {
		await f.service.sendPrompt("Start");
		expect(failed).toBe(true);
		const replay = await f.sessions.buildSessionContext();
		expect(JSON.stringify(replay)).not.toContain("must not appear");
		const entries = await f.sessions.getSession().view("main").findEntriesOnBranch({ order: "oldestFirst" });
		expect(JSON.stringify(entries)).not.toContain("atomic-state");
		expect(f.requests).toHaveLength(1);
	} finally { f.service.dispose(); }
});

test("stopping an awaited boundary handler prevents its later draft from being committed", async () => {
	let enter!: () => void, release!: () => void;
	const entered = new Promise<void>(resolve => { enter = resolve; });
	const gate = new Promise<void>(resolve => { release = resolve; });
	const f = harness(pi => {
		pi.on("turn_end", async () => {
			enter(); await gate;
			return { entries: [{ type: "custom_message", customType: "too-late", content: "cancelled draft", display: false }], continue: true };
		});
	});
	try {
		const run = f.service.sendPrompt("Start");
		await entered;
		f.service.abort();
		release();
		await run;
		const replay = await f.sessions.buildSessionContext();
		expect(JSON.stringify(replay)).not.toContain("cancelled draft");
		expect(f.requests).toHaveLength(1);
	} finally { release(); f.service.dispose(); }
});
