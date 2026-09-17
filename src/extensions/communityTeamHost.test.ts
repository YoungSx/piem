import { afterEach, describe, expect, it } from "bun:test";
import { webcrypto } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import { Logger } from "../logging/Logger";
import { stubWindowMembers } from "../testUtils/windowStub";
import { createExtensionConfigStore } from "./extensionConfigStore";
import { CommunityHost } from "./communityHost";
import type { MemberSessionHandle, MemberSessionSpec } from "./team/memberTypes";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const model: Model<string> = {
	provider: "fixture", id: "fixture-model", name: "Fixture", api: "openai-completions", baseUrl: "https://model.invalid",
	reasoning: false, input: ["text"], contextWindow: 8000, maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/**
 * A scripted member session host: records every spec the bridge forwards, and
 * answers turns with the package's own coordination tools so the run stays
 * bounded — each member ends its first turn with `team_finish`, the reporter
 * hands back its report through `getLastAssistantText` (decision 5B's payload
 * channel), and the run settles instead of looping.
 */
function memberHost() {
	const specs: MemberSessionSpec[] = [];
	const handles: MemberSessionHandle[] = [];
	return {
		specs, handles,
		createMemberSession: (spec: MemberSessionSpec): Promise<MemberSessionHandle> => {
			specs.push(spec);
			const recorded: string[] = [];
			const tools = new Map<string, (args: Record<string, unknown>) => unknown>(
				(spec.customTools as Array<{ name: string; execute: (id: string, args: Record<string, unknown>) => unknown }>)
					.map(tool => [tool.name, (args: Record<string, unknown>) => tool.execute(`call-${tool.name}`, args)]),
			);
			const handle: MemberSessionHandle = {
				sessionId: `member-${specs.length}`,
				sessionFile: `Piem/member-${specs.length}.jsonl`,
				prompt: async (text: string) => {
					recorded.push(text);
					// One finish turn per member: the coordination tool rides the
					// session the way the package registered it, and the queued
					// command is what turns the member in.
					tools.get("team_finish")!({ summary: "scripted member is done" });
				},
				abort: async () => {},
				dispose: async () => {},
				getLastAssistantText: () => "REPORT BODY FROM SCRIPTED MEMBER",
			};
			handles.push(handle);
			return Promise.resolve(handle);
		},
		last: (index: number) => handles[index]!,
	};
}

async function teamHost() {
	// Real timers, but the upstream pre-warm's handle is dropped: the overlay
	// graph loads on the first refresh either way, and a live 2s timer would
	// outlive the test (same shape as the todo host probe).
	const restore = stubWindowMembers({
		crypto: webcrypto,
		setTimeout: (callback: () => void, delay?: number) => globalThis.setTimeout(callback, delay),
		clearTimeout: (id?: number) => { if (id !== undefined) globalThis.clearTimeout(id); },
	});
	cleanups.push(async () => restore());
	const members = memberHost();
	const conversation = await CommunityHost.create({
		getEntries: () => [], getBranch: () => [], getSessionId: () => "session-1", getSessionFile: () => "Piem/session-1.jsonl",
		getModel: () => model, getModels: () => [model], getThinkingLevel: () => "high", isIdle: () => true,
		notify: () => {}, prepare: async () => {}, deliver: () => {},
		logger: new Logger({ level: () => "debug", sinks: [] }),
		otelEnvironment: () => ({}),
		platform: {
			fetch: async () => { throw new Error("Unexpected foreground request"); },
			backgroundFetch: async () => new Response("{}"),
			config: createExtensionConfigStore({ getData: () => undefined, setData: () => {}, persist: async () => {}, queue: work => work() }),
			onError: () => {},
			// The conversation host's own answer to the bridge: what piem really
			// builds for a member is the subject of the service test; here it is
			// the scripted seam the team runtime drives.
			createMemberSession: members.createMemberSession,
		},
	});
	cleanups.push(async () => { conversation.dispose(); await conversation.closed().catch(() => {}); });
	await conversation.start();
	return { host: conversation, members };
}

describe("agent team through the community host", () => {
	it("starts a team of scripted members and settles with the reporter's final report", async () => {
		const { host, members } = await teamHost();
		const start = host.tools.find(tool => tool.name === "team_start");
		expect(start).toBeDefined();

		const result = await start!.execute("team-1", {
			objective: "each member finishes at once",
			members: [{ id: "m1", name: "Alice" }, { id: "m2", name: "Bob" }],
			reporterId: "m1",
			initialMessage: "begin",
		} as never);
		const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
		expect(text).toContain("FINAL REPORT");
		expect(text).toContain("REPORT BODY FROM SCRIPTED MEMBER");
		// One spec per member, forwarded through the bridge in member order.
		expect(members.specs).toHaveLength(2);
		expect(members.specs.map(spec => spec.cwd)).toEqual(["/vault", "/vault"]);
		// Each member received the package's doctrine prompt as its system prompt.
		const prompts = members.handles.map(handle => handle.sessionId);
		expect(prompts).toEqual(["member-1", "member-2"]);
		// The retained run stays answerable to cancel and shutdown handlers.
		const cancel = host.tools.find(tool => tool.name === "team_cancel");
		expect(cancel).toBeDefined();
	});
});
