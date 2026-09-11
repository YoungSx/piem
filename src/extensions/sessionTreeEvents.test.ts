import { afterAll, describe, expect, it } from "bun:test";
import type { DataAdapter } from "obsidian";
import type { SessionTreeEvent } from "@earendil-works/pi-coding-agent";
import { ObsidianSessionManager } from "../session/ObsidianSessionManager";
import { navigateExtensionSummary } from "../session/extensionNavigation";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { stubWindowTimers } from "../testUtils/windowStub";
import { ContextSession } from "./contextSession";
import { createExtensionHost } from "./extensionHost";

afterAll(stubWindowTimers());

async function fixture(options: { failWrite?: boolean; failObserver?: boolean } = {}) {
	const manager = new ObsidianSessionManager(new MemoryAdapter() as unknown as DataAdapter, "Piem/chats", "piem");
	await manager.createSession({ provider: "test", modelId: "test", thinkingLevel: "off" });
	const session = manager.getSession();
	const first = await manager.appendMessage({ role: "user", content: "First", timestamp: Date.now() });
	const tip = await manager.appendMessage({ role: "user", content: "Next", timestamp: Date.now() });
	const context = new ContextSession({
		load: async () => session, assertAvailable: () => {},
		navigate: async request => {
			if (options.failWrite) throw new Error("Disk full");
			await navigateExtensionSummary(session, request, () => {});
		},
	});
	const seen: Array<{ event: SessionTreeEvent; leafId: string | null; savedLeaf: string | null }> = [];
	let summaryId = "";
	const host = await createExtensionHost([{ id: "tree-test", factory: pi => {
		pi.on("session_tree", async (event, ctx) => {
			const leafId = ctx.sessionManager.getLeafId();
			seen.push({ event, leafId, savedLeaf: await session.view("main").getLeafId() });
			if (options.failObserver) throw new Error("Observer failed");
		});
		pi.registerCommand("branch", { handler: async (_args, ctx) => {
			summaryId = context.branchWithSummary(first, "Handoff summary");
			await ctx.navigateTree(summaryId, { summarize: false });
		} });
	} }], {
		session: context, getEntries: () => context.getEntries(), getBranch: () => context.getBranch(),
		refreshSession: () => context.refresh(), notify: () => {},
	});
	return { host, context, session, tip, seen, summaryId: () => summaryId };
}

describe("session_tree after extension navigation", () => {
	it("announces the saved old/new leaf and real summary after the navigation queue releases", async () => {
		const f = await fixture();
		try {
			await f.host.run("branch");
			expect(f.seen).toHaveLength(1);
			expect(f.seen[0]).toMatchObject({
				leafId: f.summaryId(), savedLeaf: f.summaryId(),
				event: { type: "session_tree", oldLeafId: f.tip, newLeafId: f.summaryId(), fromExtension: true,
					summaryEntry: { type: "branch_summary", id: f.summaryId(), summary: "Handoff summary", fromId: f.tip } },
			});
			expect(Number.isNaN(Date.parse(f.seen[0]!.event.summaryEntry!.timestamp))).toBe(false);
		} finally { f.host.dispose(); f.context.dispose(); }
	});

	it("emits nothing when saving the new branch fails", async () => {
		const f = await fixture({ failWrite: true });
		try {
			await expect(f.host.run("branch")).rejects.toThrow("Disk full");
			expect(f.seen).toHaveLength(0);
			expect(await f.session.view("main").getLeafId()).toBe(f.tip);
		} finally { f.host.dispose(); f.context.dispose(); }
	});

	it("does not roll back a saved branch when an observer fails", async () => {
		const f = await fixture({ failObserver: true });
		try {
			await expect(f.host.run("branch")).rejects.toThrow("Observer failed");
			expect(f.seen).toHaveLength(1);
			expect(await f.session.view("main").getLeafId()).toBe(f.summaryId());
		} finally { f.host.dispose(); f.context.dispose(); }
	});
});
