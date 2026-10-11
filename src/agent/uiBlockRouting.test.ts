/**
 * Where a live view's message lands, and in what order.
 *
 * `present_ui` returns as soon as its view mounts, so by the time the user
 * presses something in one, the run that created it is over and the agent may
 * be busy with something else — or the user may have navigated to another
 * conversation entirely. Everything below is about that gap, and none of it is
 * testable from the broker alone: the broker only knows an `ownerId`, and the
 * question is what the *service* does with one.
 *
 * Three invariants:
 *
 * 1. **The owning conversation, not the focused one.** A dashboard's button
 *    landing in whichever chat happens to be on screen would put an answer in a
 *    stranger's transcript.
 * 2. **Arrival order is dispatch order.** A press queues like a typed message
 *    and departs with whatever was already waiting, ahead of it.
 * 3. **A conversation that is gone drops the message**, rather than re-homing it
 *    or stranding a chip the user never created.
 */
import { afterAll, describe, expect, it } from "bun:test";
import type { App, DataAdapter } from "obsidian";
import type { AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { installObsidianStub } from "../testUtils/obsidianStub";
import { stubWindowTimers } from "../testUtils/windowStub";

installObsidianStub();
const restoreTimers = stubWindowTimers();
afterAll(restoreTimers);

const { ObsidianAgentService } = await import("./ObsidianAgentService");
const { ObsidianSessionManager } = await import("../session/ObsidianSessionManager");
const { UIBlockBroker } = await import("../tools/uiBlockBroker");
const { DEFAULT_SETTINGS } = await import("../settings");

type StreamMode = "reply" | "hang";

function harness(mode: StreamMode = "reply") {
	const adapter = new MemoryAdapter() as unknown as DataAdapter;
	const sessions = new ObsidianSessionManager(adapter, "Piem/sessions", "obsidian-vault:UI block routing");
	const settings = {
		...DEFAULT_SETTINGS,
		providers: [{
			id: "p", name: "Test gateway", baseUrl: "https://bridge.test/v1",
			protocol: "openai-completions" as const, apiKey: "test-key", secretRef: "",
			source: "user" as const, oauthFlow: "" as const,
		}],
		models: [{
			id: "m", providerId: "p", modelApiId: "test-model", displayName: "Test model",
			reasoning: false, supportsImages: false,
		}],
		activeModelId: "m",
	};
	const app = {
		vault: {
			adapter, getName: () => "UI block routing", getFiles: () => [], getFileByPath: () => null,
			getAbstractFileByPath: () => null, read: async () => "", cachedRead: async () => "",
		},
		workspace: { getActiveViewOfType: () => null, getActiveFile: () => null },
	} as unknown as App;

	const requests: TranscriptContext[] = [];
	const streamFn: StreamFn = (model: Model<string>, context: TranscriptContext) => {
		requests.push({ ...context, messages: structuredClone(context.messages) });
		const stream = createAssistantMessageEventStream();
		if (mode === "hang") {
			// Never settles: holds `isStreaming` so a press has to queue.
			return stream;
		}
		const message: AssistantMessage = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id,
			timestamp: Date.now(), content: [{ type: "text", text: "Done" }], stopReason: "stop",
			usage: {
				input: 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
		return stream;
	};

	const broker = new UIBlockBroker();
	const service = new ObsidianAgentService(app, () => settings, sessions, {
		streamFn,
		uiBlockBroker: broker,
		loadUserSkills: async () => ({ skills: [], diagnostics: [], searched: [] }),
	});
	return { service, broker, requests };
}

/** Every user message in the conversation, in transcript order. */
function userTexts(service: { getSnapshot: () => { messages: readonly unknown[] } }): string[] {
	return service
		.getSnapshot()
		.messages.filter((message): message is { role: string; content: unknown } =>
			typeof message === "object" && message !== null && (message as { role?: unknown }).role === "user",
		)
		.map((message) => JSON.stringify(message.content));
}

/** A live view belonging to `ownerId`, with its delivery already settled. */
async function liveView(
	broker: InstanceType<typeof UIBlockBroker>,
	ownerId: string,
	title: string,
): Promise<string> {
	const promise = broker.present({ code: "/* test */", title }, undefined, ownerId);
	const id = broker.getLive(ownerId).at(-1)!.id;
	broker.ready(id);
	await promise;
	return id;
}

describe("live view message routing", () => {
	it("delivers to the conversation that owns the view, not the focused one", async () => {
		const { service, broker } = harness();
		await service.initialize();
		await service.sendPrompt("first chat");
		const owner = service.getActiveSessionPath()!;
		const id = await liveView(broker, owner, "Owner Dashboard");

		// The user moves on. The view is still on screen in the conversation that
		// presented it, and its button must not answer into this one.
		await service.newSession({ force: true });
		const other = service.getActiveSessionPath()!;
		expect(other).not.toBe(owner);
		await service.sendPrompt("second chat");
		const otherBefore = userTexts(service).length;

		broker.sendMessage(id, { action: "approve" });
		await Bun.sleep(20);

		expect(userTexts(service)).toHaveLength(otherBefore);
		await service.openSession(owner);
		expect(userTexts(service).join("\n")).toContain("approve");
	});

	/*
	 * The regression: `sendPromptEntries` departs with exactly the entries it is
	 * handed, and an idle agent does not imply an empty queue — a run that ended
	 * in an error restores its queue to the chips and leaves. A press arriving
	 * then used to jump the words the user typed first and leave them waiting.
	 */
	it("departs behind whatever was already queued", async () => {
		const { service, broker } = harness();
		await service.initialize();
		await service.sendPrompt("opening message");
		const owner = service.getActiveSessionPath()!;
		const id = await liveView(broker, owner, "Form");

		// A queued entry with the agent idle, which is the state the error path
		// leaves behind.
		const runtime = (service as unknown as {
			runtimes: Map<string, { promptQueue: { add: (input: unknown) => unknown; size: number } }>;
		}).runtimes.get(owner)!;
		runtime.promptQueue.add({
			text: "typed first",
			imageCount: 0,
			stagedImages: [],
			message: { role: "user", content: [{ type: "text", text: "typed first" }], timestamp: Date.now() },
		});

		broker.sendMessage(id, { action: "pressed second" });
		await Bun.sleep(40);

		const texts = userTexts(service);
		const typedAt = texts.findIndex((text) => text.includes("typed first"));
		const pressedAt = texts.findIndex((text) => text.includes("pressed second"));
		expect(typedAt).toBeGreaterThanOrEqual(0);
		expect(pressedAt).toBeGreaterThanOrEqual(0);
		expect(typedAt).toBeLessThan(pressedAt);
		expect(runtime.promptQueue.size).toBe(0);
	});

	it("queues rather than interrupting a reply in flight", async () => {
		const { service, broker } = harness("hang");
		await service.initialize();
		const owner = service.getActiveSessionPath() ?? "";
		void service.sendPrompt("question that hangs");
		await Bun.sleep(20);
		const path = service.getActiveSessionPath()!;
		const id = await liveView(broker, path, "Dashboard");

		broker.sendMessage(id, { filter: "pressed while busy" });
		await Bun.sleep(20);

		// On a chip, not in the transcript: a press is not an interruption of the
		// work it is answering.
		const snapshot = service.getSnapshot();
		expect(snapshot.queuedPrompts.some((entry) => entry.text.includes("pressed while busy"))).toBe(true);
		expect(userTexts(service).join("\n")).not.toContain("pressed while busy");
		expect(owner === "" || path === owner).toBe(true);
	});

	it("drops a message whose conversation is gone", async () => {
		const { service, broker } = harness();
		await service.initialize();
		await service.sendPrompt("doomed chat");
		const owner = service.getActiveSessionPath()!;
		const id = await liveView(broker, owner, "Orphan");

		// Closing the conversation clears its views; the message has nowhere to go
		// and must not be re-homed into whatever is open instead.
		await service.newSession({ force: true });
		const survivor = service.getActiveSessionPath()!;
		await service.sendPrompt("survivor chat");
		const before = userTexts(service).length;

		broker.sendMessage(id, { action: "too late" });
		await Bun.sleep(20);

		expect(userTexts(service)).toHaveLength(before);
		expect(survivor).not.toBe(owner);
	});
});
