import { afterAll, afterEach, describe, expect, it } from "bun:test";
import type { SessionTreeEvent } from "@earendil-works/pi-coding-agent";
import { installObsidianStub, requestUrlMock } from "../testUtils/obsidianStub";
import { stubWindowTimers } from "../testUtils/windowStub";

installObsidianStub();
afterAll(stubWindowTimers());
afterEach(() => requestUrlMock.mockReset());
const { harness } = await import("../testUtils/nativeExtensionServiceHarness");

describe("session_tree from retry and edit-resend", () => {
	it.each(["retry", "edit"] as const)("emits saved leaf IDs before the %s replacement runs", async action => {
		const events: Array<{ event: SessionTreeEvent; leaf: string | null; requests: number }> = [];
		const f = harness(pi => { pi.on("session_tree", (event, ctx) => {
			events.push({ event, leaf: ctx.sessionManager.getLeafId(), requests: f.requests.length });
		}); });
		try {
			await f.service.sendPrompt("Original");
			const session = f.sessions.getSession();
			const oldLeafId = await session.view("main").getLeafId();
			const prompt = (await session.findEntries({ order: "oldestFirst" })).find(entry => entry.type === "message" && entry.message.role === "user")!;
			requestUrlMock.mockResolvedValue({ status: 400, headers: {}, arrayBuffer: new ArrayBuffer(0) });
			expect(await (action === "retry" ? f.service.retryFrom(1) : f.service.editAndResend(0, "Edited"))).toBe(true);
			expect(events).toEqual([{ event: { type: "session_tree", oldLeafId, newLeafId: prompt.parentId, fromExtension: false }, leaf: prompt.parentId, requests: 1 }]);
			expect(f.requests).toHaveLength(2);
		} finally { f.service.dispose(); }
	});

	it.each(["stop", "switch"] as const)("does not send a replacement after %s overtakes a waiting observer", async action => {
		const entered = Promise.withResolvers<void>();
		const held = Promise.withResolvers<void>();
		const f = harness(pi => { pi.on("session_tree", async () => { entered.resolve(); await held.promise; }); });
		try {
			await f.service.sendPrompt("Original");
			let other: string | undefined;
			if (action === "switch") {
				const original = f.service.getActiveSessionPath()!;
				await f.service.newSession();
				await f.service.sendPrompt("Other conversation");
				other = f.service.getActiveSessionPath()!;
				await f.service.openSession(original);
			}
			const count = f.requests.length;
			requestUrlMock.mockResolvedValue({ status: 400, headers: {}, arrayBuffer: new ArrayBuffer(0) });
			const retry = f.service.retryFrom(1);
			await entered.promise;
			if (action === "stop") await f.service.abortSession(f.service.getActiveSessionPath()!);
			else await f.service.openSession(other!);
			held.resolve();
			expect(await retry).toBe(false);
			expect(f.requests).toHaveLength(count);
		} finally { held.resolve(); f.service.dispose(); }
	});
});
