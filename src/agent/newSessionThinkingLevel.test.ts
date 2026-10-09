import { afterAll, describe, expect, it } from "bun:test";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { MemoryAdapter } from "../testUtils/memoryAdapter";
import { installObsidianStub } from "../testUtils/obsidianStub";
import { stubWindowTimers } from "../testUtils/windowStub";

installObsidianStub();
const restoreTimers = stubWindowTimers();
afterAll(restoreTimers);

const { harness } = await import("../testUtils/nativeExtensionServiceHarness");
const { ObsidianSessionManager } = await import("../session/ObsidianSessionManager");

describe("new session thinking level", () => {
	it.each([
		["high", true, "high"],
		["off", true, "off"],
		["max", true, "high"],
		["high", false, "off"],
	] satisfies [ThinkingLevel, boolean, ThinkingLevel][])("seeds startup from saved %s with reasoning %j as %s", async (saved, reasoning, expected) => {
		const { service, sessions, adapter, settings } = harness(() => {}, { reasoning });
		const stored = new ObsidianSessionManager(adapter, "Piem/sessions", "obsidian-vault:Bridge test");
		const previous = await stored.createSession({ provider: settings.providers[0]!.id, modelId: "previous-model", thinkingLevel: saved });
		const before = await adapter.read(previous.path);
		try {
			await service.initialize();
			expect(service.getActiveSessionPath()).not.toBe(previous.path);
			expect(service.getSnapshot().thinkingLevel).toBe(expected);
			expect((await sessions.buildSessionContext()).thinkingLevel).toBe(expected);
			expect(await adapter.read(previous.path)).toBe(before);
			expect(await adapter.exists(service.getActiveSessionPath()!)).toBe(false);
		} finally { service.dispose(); }
	});

	it("uses this device's last opened conversation on startup instead of a newer file", async () => {
		let lastOpened: string | null = null;
		const { service, sessions, adapter, settings } = harness(() => {}, { reasoning: true,
			lastOpened: { read: () => lastOpened, write: path => { lastOpened = path; } },
		});
		const stored = new ObsidianSessionManager(adapter, "Piem/sessions", "obsidian-vault:Bridge test");
		const first = await stored.createSession({ provider: settings.providers[0]!.id, modelId: "test-model", thinkingLevel: "high" });
		const second = await stored.createSession({ provider: settings.providers[0]!.id, modelId: "test-model", thinkingLevel: "off" });
		(adapter as unknown as MemoryAdapter).setMtime(second.path, Date.parse("2099-01-01"));
		lastOpened = first.path;
		try {
			await service.initialize();
			expect(service.getSnapshot().thinkingLevel).toBe("high");
			expect((await sessions.buildSessionContext()).thinkingLevel).toBe("high");
			expect(lastOpened).toBe(first.path);
		} finally { service.dispose(); }
	});

	it("inherits the level of the conversation just reopened, even when another was saved later", async () => {
		const { service, sessions, adapter } = harness(() => {}, { reasoning: true });
		try {
			await service.sendPrompt("First conversation");
			await service.setThinkingLevel("high");
			const first = service.getActiveSessionPath()!;
			await service.newSession();
			await service.setThinkingLevel("off");
			await service.sendPrompt("Later conversation");
			(adapter as unknown as MemoryAdapter).setMtime(service.getActiveSessionPath()!, Date.parse("2099-01-01"));
			await service.openSession(first);
			expect(service.getSnapshot().thinkingLevel).toBe("high");

			await service.newSession();
			expect(service.getSnapshot().thinkingLevel).toBe("high");
			expect((await sessions.buildSessionContext()).thinkingLevel).toBe("high");
		} finally { service.dispose(); }
	});

	it("retains the selected level when replacing an unsent sheet", async () => {
		const { service, sessions } = harness(() => {}, { reasoning: true });
		try {
			await service.initialize();
			await service.setThinkingLevel("medium");
			await service.newSession({ force: true });
			expect(service.getSnapshot().thinkingLevel).toBe("medium");
			expect((await sessions.buildSessionContext()).thinkingLevel).toBe("medium");
		} finally { service.dispose(); }
	});

	it.each(["initialize", "newSession"] as const)("defaults to off without a previous conversation through %s", async entry => {
		const { service } = harness(() => {}, { reasoning: true });
		try {
			await service[entry]();
			expect(service.getSnapshot().thinkingLevel).toBe("off");
		} finally { service.dispose(); }
	});

	it("clamps to the new model while the previous conversation still runs on its old model", async () => {
		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>(resolve => { entered = resolve; });
		const waiting = new Promise<void>(resolve => { release = resolve; });
		const { service, sessions, settings } = harness(pi => {
			pi.on("message_start", async () => { entered(); await waiting; });
		}, { reasoning: true });
		settings.models.push({ ...settings.models[0]!, id: "plain", modelApiId: "plain", reasoning: false });
		try {
			await service.initialize();
			await service.setThinkingLevel("high");
			const run = service.sendPrompt("Continue in the background");
			await started;
			const previous = service.getActiveSessionPath()!;
			await service.setActiveModel("plain");
			expect(service.getSnapshot().thinkingLevel).toBe("high");
			await service.newSession();
			expect(service.getSnapshot().thinkingLevel).toBe("off");
			expect((await sessions.buildSessionContext()).model?.modelId).toBe("plain");
			expect((await sessions.buildSessionContext()).thinkingLevel).toBe("off");
			expect((await sessions.buildSessionContextFor(previous)).thinkingLevel).toBe("high");
			release();
			await run;
		} finally { release(); service.dispose(); }
	});

	it("gracefully falls back to off when candidate session file cannot be opened", async () => {
		const { service, adapter } = harness(() => {}, { reasoning: true });
		try {
			await adapter.write("Piem/sessions/--obsidian-vault-Bridge test--/corrupted.jsonl", "NOT_JSON_GARBAGE\n");
			await service.initialize();
			expect(service.getSnapshot().thinkingLevel).toBe("off");
		} finally {
			service.dispose();
		}
	});

	it("inherits thinking level from active lane when previous session was on non-main lane", async () => {
		const { service, sessions } = harness(() => {}, { reasoning: true });
		try {
			await service.initialize();
			await service.sendPrompt("Hello");
			const path = service.getActiveSessionPath()!;
			const runtime = (service as unknown as { current: () => { activeLane: string } }).current();
			runtime.activeLane = "alt-lane";
			await sessions.appendThinkingLevelChangeFor(path, "high", "alt-lane");
			await service.newSession();
			expect(service.getSnapshot().thinkingLevel).toBe("high");
		} finally {
			service.dispose();
		}
	});
});
