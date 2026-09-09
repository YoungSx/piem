import { describe, expect, it } from "bun:test";
import { convertToLlm, formatSkillInvocation, type AgentMessage, type CompactResult } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Models, Usage } from "@earendil-works/pi-ai";
import { compactIfNeeded, toCompactedMessages } from "./compaction";
import { createReadSkillTool } from "../tools/skillTools";
import { ObsidianSessionManager } from "../session/ObsidianSessionManager";
import { MemoryAdapter } from "../testUtils/memoryAdapter";
import { stubWindowTimers } from "../testUtils/windowStub";
import type { DataAdapter } from "obsidian";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("compactIfNeeded", () => {
	it("skips compaction while the context still fits", async () => {
		const outcome = await compactIfNeeded({
			messages: [userMessage("short")],
			model: createModel({ contextWindow: 1_000_000 }),
			models: createModels(),
			thinkingLevel: "off",
		});

		expect(outcome.status).toBe("skipped");
	});

	it("summarizes history once the context exceeds the reserve", async () => {
		const outcome = await compactIfNeeded({
			messages: buildOverflowingHistory(),
			model: createModel({ contextWindow: 2_000 }),
			models: createModels("SUMMARY OF EARLIER TURNS"),
			thinkingLevel: "off",
		});

		expect(outcome.status).toBe("compacted");
		if (outcome.status !== "compacted") {
			return;
		}
		expect(outcome.result.summary).toContain("SUMMARY OF EARLIER TURNS");
		expect(outcome.messages[0]?.role).toBe("compactionSummary");
		// pi keeps `keepRecentTokens` worth of recent turns, so the win is that history
		// is now fronted by a summary rather than that the list is shorter.
		expect(outcome.result.tokensBefore).toBeGreaterThan(0);
	});

	it("compacts a fitting context when forced, for the manual command", async () => {
		const outcome = await compactIfNeeded({
			messages: [userMessage("short"), assistantMessage("short answer", EMPTY_USAGE)],
			model: createModel({ contextWindow: 1_000_000 }),
			models: createModels("MANUAL SUMMARY"),
			thinkingLevel: "off",
			force: true,
		});

		expect(outcome.status).toBe("compacted");
		if (outcome.status !== "compacted") {
			return;
		}
		expect(outcome.result.summary).toContain("MANUAL SUMMARY");
	});

	it("still skips when not forced and the context fits", async () => {
		const outcome = await compactIfNeeded({
			messages: [userMessage("short"), assistantMessage("short answer", EMPTY_USAGE)],
			model: createModel({ contextWindow: 1_000_000 }),
			models: createModels(),
			thinkingLevel: "off",
		});

		expect(outcome.status).toBe("skipped");
	});

	it("reports provider failures instead of throwing", async () => {
		const outcome = await compactIfNeeded({
			messages: buildOverflowingHistory(),
			model: createModel({ contextWindow: 2_000 }),
			models: createFailingModels("provider exploded"),
			thinkingLevel: "off",
		});

		expect(outcome.status).toBe("failed");
		if (outcome.status === "failed") {
			expect(outcome.message).toContain("provider exploded");
		}
	});

	it("retries a transient summarization failure and still compacts", async () => {
		const models = createFlakyModels();

		const outcome = await compactIfNeeded({
			messages: buildOverflowingHistory(),
			model: createModel({ contextWindow: 2_000 }),
			models,
			thinkingLevel: "off",
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
		});

		expect(outcome.status).toBe("compacted");
	});

	it("compacts through a transient failure on the default policy", async () => {
		// The regression here is the wiring, not pi's retry loop: `compactIfNeeded`
		// used to pass `undefined` for the retry budget, so the default policy
		// never applied and one 503 failed the whole pre-prompt compaction.
		const outcome = await compactIfNeeded({
			messages: buildOverflowingHistory(),
			model: createModel({ contextWindow: 2_000 }),
			models: createFlakyModels(),
			thinkingLevel: "off",
		});

		expect(outcome.status).toBe("compacted");
	});

	/**
	 * A second compaction used to see the previous one's retained tail twice: the
	 * tail was passed in as part of the `compaction` entry *and* re-listed as
	 * message entries, because a compacted transcript already is
	 * `[summary, ...retainedTail]`. Both copies reached the new
	 * `retainedTail` — and from there the JSONL line written for it.
	 */
	it("does not re-list a tail the previous compaction already carries", async () => {
		const keptQuestion = userMessage("KEPT QUESTION");
		const keptAnswer = assistantMessage("KEPT ANSWER", { ...EMPTY_USAGE, input: 4_000, totalTokens: 4_000 });
		const previous = createCompactResult("EARLIER HISTORY", [keptQuestion, keptAnswer]);
		// Something has to follow the tail, or there is genuinely nothing left to
		// compact and pi reports "skipped" before the duplication could show.
		const messages = [...toCompactedMessages(previous), userMessage("NEXT QUESTION")];

		const outcome = await compactIfNeeded({
			messages,
			model: createModel({ contextWindow: 2_000 }),
			models: createModels("SECOND SUMMARY"),
			thinkingLevel: "off",
			previous,
			force: true,
		});

		expect(outcome.status).toBe("compacted");
		if (outcome.status !== "compacted") {
			return;
		}
		// By reference: the duplicate was the same object twice, so comparing
		// content would not tell the two copies apart.
		expect(outcome.result.retainedTail.filter((message) => message === keptQuestion)).toHaveLength(1);
		expect(outcome.result.retainedTail.filter((message) => message === keptAnswer)).toHaveLength(1);
	});

	it("fails without retrying when the policy is disabled", async () => {
		const outcome = await compactIfNeeded({
			messages: buildOverflowingHistory(),
			model: createModel({ contextWindow: 2_000 }),
			models: createFlakyModels(),
			thinkingLevel: "off",
			retry: { enabled: false, maxRetries: 2, baseDelayMs: 1 },
		});

		expect(outcome.status).toBe("failed");
		if (outcome.status === "failed") {
			expect(outcome.message).toContain("503");
		}
	});
});

describe("toCompactedMessages", () => {
	it("puts the summary ahead of the retained tail", () => {
		const retained = userMessage("most recent question");
		const messages = toCompactedMessages(createCompactResult("earlier history", [retained]));

		expect(messages).toHaveLength(2);
		expect(messages[0]?.role).toBe("compactionSummary");
		expect(messages[1]).toBe(retained);
	});

	/**
	 * The agent's default converter keeps only user/assistant/toolResult, so a
	 * compaction summary would be dropped from the request with no error at all.
	 * `ObsidianAgentService` passes pi's converter to prevent that; this test
	 * fails if the summary ever stops surviving conversion.
	 */
	it("produces a summary that survives conversion to provider messages", () => {
		const messages = toCompactedMessages(createCompactResult("EARLIER HISTORY", []));

		expect(JSON.stringify(convertToLlm(messages))).toContain("EARLIER HISTORY");
	});
});

describe("skill instructions across compaction", () => {
	const skill = { name: "example", description: "Test", filePath: "/Piem/skills/example/SKILL.md", content: `START_SKILL\n${"Keep this rule.\n".repeat(200)}END_SKILL` };
	const settings = { enabled: true, reserveTokens: 1024, keepRecentTokens: 1024 };
	const recent = () => [userMessage(`Continue\n${"recent work\n".repeat(800)}`), assistantMessage("Recent answer", EMPTY_USAGE)];
	const run = (messages: AgentMessage[], previous?: CompactResult) => compactIfNeeded({
		messages, previous, model: createModel({ contextWindow: 32_768 }), models: createModels("Earlier work summarized"), thinkingLevel: "off", settings, force: true,
	});

	it("keeps the exact loaded body after repeated compaction and serialization", async () => {
		const toolResult = await createReadSkillTool(() => [skill]).execute("skill-call", { name: skill.name });
		const call: AgentMessage = { ...assistantMessage("", EMPTY_USAGE), stopReason: "toolUse", content: [{ type: "toolCall", id: "skill-call", name: "read_skill", arguments: { name: skill.name } }] };
		const history: AgentMessage[] = [userMessage("Use the skill"), call, { ...toolResult, role: "toolResult", toolName: "read_skill", toolCallId: "skill-call", isError: false, timestamp: 1 }, ...recent()];
		const first = await run(history);
		expect(first.status).toBe("compacted");
		if (first.status !== "compacted") throw new Error("Expected compaction");
		expect(JSON.stringify(convertToLlm(first.messages))).toContain("END_SKILL");
		const stored = JSON.parse(JSON.stringify(first.result)) as CompactResult;
		const second = await run([...toCompactedMessages(stored), ...recent()], stored);
		expect(second.status).toBe("compacted");
		if (second.status !== "compacted") throw new Error("Expected compaction");
		const texts = convertToLlm(second.messages).flatMap((message) => typeof message.content === "string" ? [message.content] : message.content.filter((part) => part.type === "text").map((part) => part.text));
		expect(texts.filter((text) => text.includes("END_SKILL"))).toHaveLength(1);
		expect(texts.some((text) => text.includes(skill.content))).toBe(true);
	});

	it("preserves explicit slash instructions while summarizing the surrounding request", async () => {
		const outcome = await run([userMessage(formatSkillInvocation(skill, "Focus on yesterday")), assistantMessage("Done", EMPTY_USAGE), ...recent()]);
		expect(outcome.status).toBe("compacted");
		if (outcome.status !== "compacted") throw new Error("Expected compaction");
		expect(JSON.stringify(convertToLlm(outcome.messages))).toContain("END_SKILL");
	});

	it("does not preserve failed skill calls as standing instructions", async () => {
		const result = await createReadSkillTool(() => [skill]).execute("skill-call", { name: skill.name });
		const outcome = await run([userMessage("Use a skill"), { ...result, role: "toolResult", toolName: "read_skill", toolCallId: "skill-call", isError: true, timestamp: 1 }, ...recent()]);
		expect(outcome.status).toBe("compacted");
		if (outcome.status !== "compacted") throw new Error("Expected compaction");
		expect(JSON.stringify(outcome.messages)).not.toContain("END_SKILL");
	});

	it("persists retained instructions through the real session codec and reload", async () => {
		const restore = stubWindowTimers();
		try {
			const outcome = await run([userMessage(formatSkillInvocation(skill)), assistantMessage("Done", EMPTY_USAGE), ...recent()]);
			if (outcome.status !== "compacted") throw new Error("Expected compaction");
			const adapter = new MemoryAdapter() as unknown as DataAdapter;
			const manager = new ObsidianSessionManager(adapter, "Piem/chats", "skill-test");
			const session = await manager.createSession({ provider: "test", modelId: "test", thinkingLevel: "off" });
			await manager.appendMessage(userMessage("Initial request"));
			await manager.appendCompactionFor(session.path, outcome.result);
			const reopened = new ObsidianSessionManager(adapter, "Piem/chats", "skill-test");
			await reopened.loadSession(session.path);
			const context = await reopened.buildSessionContextFor(session.path, "main");
			expect(JSON.stringify(convertToLlm(context.messages)).includes("END_SKILL")).toBe(true);
			const previous = await reopened.getLastCompactionFor(session.path);
			const again = await run([...context.messages, ...recent()], previous);
			if (again.status !== "compacted") throw new Error("Expected compaction");
			expect(again.messages.filter((message) => message.role === "custom" && message.customType === "piem-skill-context")).toHaveLength(1);
		} finally {
			restore();
		}
	});
});

function buildOverflowingHistory(): AgentMessage[] {
	// `estimateContextTokens` trusts the newest assistant usage, so one message
	// reporting a large context is enough to cross the threshold deterministically.
	return [
		userMessage("first question"),
		assistantMessage("first answer", { ...EMPTY_USAGE, input: 4_000, totalTokens: 4_000 }),
		userMessage("second question"),
		assistantMessage("second answer", { ...EMPTY_USAGE, input: 4_000, totalTokens: 4_000 }),
		userMessage("third question"),
	];
}

function createCompactResult(summary: string, retainedTail: AgentMessage[]): CompactResult {
	return { summary, tokensBefore: 4_000, retainedTail };
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

function assistantMessage(text: string, usage: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

function createModel(overrides: { contextWindow: number }): Model<Api> {
	return {
		id: "deepseek-v4-pro",
		name: "DeepSeek v4 Pro",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com",
		reasoning: false,
		contextWindow: overrides.contextWindow,
		maxTokens: 4_096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as unknown as Model<Api>;
}

/** Minimal `Models` stand-in: compaction only ever calls `completeSimple`. */
function createModels(summary = "summary"): Models {
	return {
		completeSimple: async () => assistantMessage(summary, EMPTY_USAGE),
	} as unknown as Models;
}

function createFailingModels(message: string): Models {
	return {
		completeSimple: async () => {
			throw new Error(message);
		},
	} as unknown as Models;
}

/**
 * First call answers with a transient provider error (`503` matches pi's
 * retryable pattern); every later call summarizes normally.
 */
function createFlakyModels(summary = "summary"): Models {
	let calls = 0;
	return {
		completeSimple: async () => {
			calls += 1;
			if (calls === 1) {
				return errorAssistantMessage("HTTP 503: service temporarily unavailable");
			}
			return assistantMessage(summary, EMPTY_USAGE);
		},
	} as unknown as Models;
}

/** The error-shaped `AssistantMessage` pi's `retryAssistantCall` classifies. */
function errorAssistantMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage: EMPTY_USAGE,
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}
