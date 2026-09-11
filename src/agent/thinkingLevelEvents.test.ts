import { afterAll, describe, expect, it } from "bun:test";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import type { ObsidianSessionManager } from "../session/ObsidianSessionManager";
import { installObsidianStub } from "../testUtils/obsidianStub";
import { stubWindowTimers } from "../testUtils/windowStub";

installObsidianStub();
const restoreTimers = stubWindowTimers();
afterAll(restoreTimers);

const { harness } = await import("../testUtils/nativeExtensionServiceHarness");
type ThinkingLevelSelectEvent = Extract<ExtensionEvent, { type: "thinking_level_select" }>;

describe("thinking level observations", () => {
	function observe() {
		const events: Array<ThinkingLevelSelectEvent & { path: string; applied: ThinkingLevel }> = [];
		const factory: ExtensionFactory = pi => {
			pi.on("thinking_level_select", (event, ctx) => {
				events.push({ ...event, path: ctx.sessionManager.getSessionFile()!, applied: ctx.thinkingLevel });
			});
		};
		return { events, factory };
	}

	async function levels(sessions: ObsidianSessionManager, path = sessions.getActiveSessionPath()!) {
		return (await sessions.getSessionFor(path).findEntries({ order: "oldestFirst" }))
			.flatMap(entry => entry.type === "thinking_level_change" ? [entry.thinkingLevel] : []);
	}

	function gate() {
		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>(resolve => { entered = resolve; });
		const waiting = new Promise<void>(resolve => { release = resolve; });
		return { started, release, hold: async () => { entered(); await waiting; } };
	}

	it("announces the saved effective level once for an idle selection and model clamp", async () => {
		const { events, factory } = observe();
		const { service, sessions, settings } = harness(factory, { reasoning: true });
		try {
			await service.initialize();
			await service.setThinkingLevel("max");
			await service.setThinkingLevel("high");
			await service.setThinkingLevel("max");
			expect(events.map(({ previousLevel, level, applied }) => [previousLevel, level, applied])).toEqual([["off", "high", "high"]]);
			expect(await levels(sessions)).toEqual(["off", "high"]);
			settings.models[0]!.reasoning = false;
			await service.refreshConfiguration();
			await service.setThinkingLevel("medium");
			expect(events.map(({ previousLevel, level, applied }) => [previousLevel, level, applied])).toEqual([["off", "high", "high"], ["high", "off", "off"]]);
			expect(await levels(sessions)).toEqual(["off", "high", "off"]);
		} finally { service.dispose(); }
	});

	it("keeps rapid idle selections in saved event order while the first write waits", async () => {
		const { events, factory } = observe();
		const { service, sessions } = harness(factory, { reasoning: true });
		const pending = gate();
		try {
			await service.initialize();
			const append = sessions.appendThinkingLevelChangeFor.bind(sessions);
			sessions.appendThinkingLevelChangeFor = async (path, level, lane) => {
				if (level === "medium") await pending.hold();
				return append(path, level, lane);
			};
			const first = service.setThinkingLevel("medium");
			await pending.started;
			const second = service.setThinkingLevel("high");
			pending.release();
			await Promise.all([first, second]);
			expect(events.map(event => [event.previousLevel, event.level, event.applied])).toEqual([["off", "medium", "medium"], ["medium", "high", "high"]]);
			expect(await levels(sessions)).toEqual(["off", "medium", "high"]);
		} finally { pending.release(); service.dispose(); }
	});

	it("does not send a completed write to a retired host", async () => {
		const { events, factory } = observe();
		const { service, sessions } = harness(factory, { reasoning: true });
		const pending = gate();
		try {
			await service.initialize();
			const append = sessions.appendThinkingLevelChangeFor.bind(sessions);
			sessions.appendThinkingLevelChangeFor = async (path, level, lane) => {
				await pending.hold();
				return append(path, level, lane);
			};
			const selection = service.setThinkingLevel("medium");
			await pending.started;
			service.dispose();
			pending.release();
			await selection.catch(() => undefined);
			expect(events).toEqual([]);
		} finally { pending.release(); service.dispose(); }
	});

	it("settles a choice made by a thinking observer without deadlocking its operation", async () => {
		const { events, factory } = observe();
		const { service, sessions } = harness(pi => {
			factory(pi);
			pi.on("thinking_level_select", event => {
				if (event.level === "medium") pi.setThinkingLevel("high");
			});
		}, { reasoning: true });
		try {
			await service.initialize();
			await service.setThinkingLevel("medium");
			expect(events.map(event => [event.previousLevel, event.level])).toEqual([["off", "medium"], ["medium", "high"]]);
			expect(service.getSnapshot().thinkingLevel).toBe("high");
			expect(service.getSnapshot().pendingThinkingLevel).toBeUndefined();
			expect(await levels(sessions)).toEqual(["off", "medium", "high"]);
		} finally { service.dispose(); }
	});

	it.each(["panel", "extension"] as const)("saves and announces a %s choice only after its busy owner settles", async source => {
		const { events, factory } = observe();
		const pending = gate();
		const { service, sessions } = harness(pi => {
			factory(pi);
			if (source === "extension") pi.on("agent_start", () => { pi.setThinkingLevel("medium"); });
			pi.on("message_start", pending.hold);
		}, { reasoning: true });
		try {
			const run = service.sendPrompt("Keep thinking on this request");
			await pending.started;
			if (source === "panel") await service.setThinkingLevel("medium");
			expect(service.getSnapshot().thinkingLevel).toBe("off");
			expect(service.getSnapshot().pendingThinkingLevel).toBe("medium");
			expect(events).toEqual([]);
			expect(await levels(sessions)).toEqual(["off"]);
			pending.release();
			expect(await run).toBe(true);
			expect(events.map(event => [event.previousLevel, event.level, event.applied])).toEqual([["off", "medium", "medium"]]);
			expect(await levels(sessions)).toEqual(["off", "medium"]);
			await service.refreshConfiguration();
			expect(events).toHaveLength(1);
			expect((await sessions.buildSessionContext()).thinkingLevel).toBe("medium");
		} finally { pending.release(); service.dispose(); }
	});

	it("lets a busy selection return to its current level without writing or announcing a change", async () => {
		const { events, factory } = observe();
		const { service, sessions } = harness(pi => {
			factory(pi);
			pi.registerCommand("undo-thinking", { handler: async () => {
				pi.setThinkingLevel("high");
				pi.setThinkingLevel("off");
			} });
		}, { reasoning: true });
		try {
			await service.initialize();
			expect(await service.runExtensionCommand("undo-thinking")).toBe(true);
			expect(service.getSnapshot().thinkingLevel).toBe("off");
			expect(service.getSnapshot().pendingThinkingLevel).toBeUndefined();
			expect(events).toEqual([]);
			expect(await levels(sessions)).toEqual(["off"]);
		} finally { service.dispose(); }
	});

	it("reports a failed deferred write without announcing an applied level", async () => {
		const { events, factory } = observe();
		const { service, sessions } = harness(pi => {
			factory(pi);
			pi.registerCommand("think", { handler: async () => { pi.setThinkingLevel("medium"); } });
		}, { reasoning: true });
		try {
			await service.initialize();
			sessions.appendThinkingLevelChangeFor = async () => { throw new Error("Cannot save deferred level"); };
			await service.runExtensionCommand("think");
			expect(service.getSnapshot().thinkingLevel).toBe("off");
			expect(service.getSnapshot().errorMessage).toContain("Cannot save deferred level");
			expect(events).toEqual([]);
			expect(await levels(sessions)).toEqual(["off"]);
		} finally { service.dispose(); }
	});

	it("announces a deferred choice on its background conversation", async () => {
		const { events, factory } = observe();
		const pending = gate();
		const { service, sessions } = harness(pi => {
			factory(pi);
			pi.on("agent_start", () => { pi.setThinkingLevel("medium"); });
			pi.on("message_start", pending.hold);
		}, { reasoning: true });
		try {
			const run = service.sendPrompt("Background question");
			await pending.started;
			const owner = service.getActiveSessionPath()!;
			await service.newSession();
			const focused = service.getActiveSessionPath()!;
			expect(focused).not.toBe(owner);
			pending.release();
			expect(await run).toBe(true);
			expect(events.map(event => [event.path, event.level, event.applied])).toEqual([[owner, "medium", "medium"]]);
			expect(await levels(sessions, owner)).toEqual(["off", "medium"]);
			expect(await levels(sessions, focused)).toEqual(["off"]);
			expect(service.getSnapshot().thinkingLevel).toBe("off");
		} finally { pending.release(); service.dispose(); }
	});

	it("emits the successful model-switch clamp inside an extension operation without re-entering it", async () => {
		const { events, factory } = observe();
		const { service, sessions, settings } = harness(pi => {
			factory(pi);
			pi.registerCommand("plain-model", { handler: async (_args, ctx) => {
				await pi.setModel(ctx.modelRegistry.getAvailable().find(model => !model.reasoning)!);
			} });
		}, { reasoning: true });
		settings.models.push({ ...settings.models[0]!, id: "plain-model", modelApiId: "plain", reasoning: false });
		try {
			await service.initialize();
			await service.setThinkingLevel("high");
			events.length = 0;
			expect(await service.runExtensionCommand("plain-model")).toBe(true);
			expect(events.map(event => [event.previousLevel, event.level, event.applied])).toEqual([["high", "off", "off"]]);
			expect(await levels(sessions)).toEqual(["off", "high", "off"]);
		} finally { service.dispose(); }
	});

	it("does not announce a model clamp when the model switch rolls back", async () => {
		const { events, factory } = observe();
		const { service, sessions, settings } = harness(pi => {
			factory(pi);
			pi.registerCommand("plain-model", { handler: async (_args, ctx) => {
				await pi.setModel(ctx.modelRegistry.getAvailable().find(model => !model.reasoning)!);
			} });
		}, { reasoning: true });
		settings.models.push({ ...settings.models[0]!, id: "plain-model", modelApiId: "plain", reasoning: false });
		try {
			await service.initialize();
			await service.setThinkingLevel("high");
			events.length = 0;
			const readInfo = sessions.getActiveSessionInfo.bind(sessions);
			let fail = true;
			sessions.getActiveSessionInfo = async () => {
				if (fail) { fail = false; throw new Error("Cannot finish model switch"); }
				return readInfo();
			};
			expect(await service.runExtensionCommand("plain-model")).toBe(false);
			expect(events).toEqual([]);
			expect(service.getSnapshot().thinkingLevel).toBe("high");
			expect((await sessions.buildSessionContext()).thinkingLevel).toBe("high");
		} finally { service.dispose(); }
	});

	it("releases the model settings queue before a thinking observer switches models again", async () => {
		let switchedBack = false;
		const { service, settings } = harness(pi => {
			pi.registerCommand("plain-model", { handler: async (_args, ctx) => {
				await pi.setModel(ctx.modelRegistry.getAvailable().find(model => !model.reasoning)!);
			} });
			pi.on("thinking_level_select", async (event, ctx) => {
				if (event.level === "off") switchedBack = await pi.setModel(ctx.modelRegistry.getAvailable().find(model => model.reasoning)!);
			});
		}, { reasoning: true });
		settings.models.push({ ...settings.models[0]!, id: "plain-model", modelApiId: "plain", reasoning: false });
		try {
			await service.initialize();
			await service.setThinkingLevel("high");
			expect(await service.runExtensionCommand("plain-model")).toBe(true);
			expect(switchedBack).toBe(true);
			expect(service.getSnapshot().runningModelId).toBe("test-model");
		} finally { service.dispose(); }
	});

	it("keeps a saved selection when an observer fails, and rejects an unsaved selection without an event", async () => {
		const { service, sessions } = harness(pi => {
			pi.on("thinking_level_select", () => { throw new Error("Thinking observer failed"); });
		}, { reasoning: true });
		try {
			await service.initialize();
			await service.setThinkingLevel("medium");
			expect(service.getSnapshot().thinkingLevel).toBe("medium");
			expect(await levels(sessions)).toEqual(["off", "medium"]);
			expect(service.getSnapshot().errorMessage).toContain("Thinking observer failed");
			sessions.appendThinkingLevelChangeFor = async () => { throw new Error("Session is read-only"); };
			await expect(service.setThinkingLevel("high")).rejects.toThrow("Session is read-only");
			expect(service.getSnapshot().thinkingLevel).toBe("medium");
			expect(await levels(sessions)).toEqual(["off", "medium"]);
		} finally { service.dispose(); }
	});
});
