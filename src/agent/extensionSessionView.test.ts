import { afterAll, describe, expect, it } from "bun:test";
import type { DataAdapter } from "obsidian";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { stubWindowTimers } from "../testUtils/windowStub";
import { ObsidianSessionManager } from "../session/ObsidianSessionManager";
import { extensionSessionView } from "./extensionSessionView";

const restore = stubWindowTimers();
afterAll(restore);

describe("extension session read view", () => {
	it("refreshes label facts without a changed leaf and follows the owning lane", async () => {
		const memory = new MemoryAdapter() as unknown as DataAdapter;
		const sessions = new ObsidianSessionManager(memory, "Piem/chats", "test");
		const info = await sessions.createSession({ provider: "test", modelId: "test", thinkingLevel: "off" });
		const session = sessions.getSessionFor(info.path);
		const first = await session.appendMessage({ role: "user", content: "First", timestamp: 0 });
		let lane = "main";
		const view = extensionSessionView({ sessions, path: info.path, lane: () => lane, assertOwner: () => {} });
		await view.refresh();
		expect(view.getBranch().at(-1)?.id).toBe(first);
		const initialEntries = view.getEntries().length;
		await session.setLabel(first, "Saved");
		await view.refresh();
		expect(view.getLabel(first)).toBe("Saved");
		expect(view.getEntries()).toHaveLength(initialEntries);
		await session.createLane("other", first);
		lane = "other";
		const other = await session.view(lane).appendMessage({ role: "user", content: "Other lane", timestamp: 1 });
		await view.refresh();
		expect(view.getBranch().at(-1)?.id).toBe(other);
		lane = "main";
		await view.refresh();
		expect(view.getBranch().at(-1)?.id).toBe(first);
		expect(view.getBranch().some(entry => entry.id === other)).toBe(false);
		expect(view.getEntries()).toHaveLength(initialEntries + 1);
		await view.refresh();
		expect(view.getEntries()).toHaveLength(initialEntries + 1);
	});
});
