import { describe, expect, it } from "bun:test";
import {
	collectEntriesForBranchSummary,
	generateBranchSummary,
	MemorySessionRepo,
	type AgentMessage,
	type Session,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Models, Usage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("generateBranchSummary", () => {
	it("returns a structured summary carrying the file operations it extracted", async () => {
		const { session, ids } = await buildSession([
			userMessage("refactor parseNode"),
			assistantMessage("renamed it across three files", { ...EMPTY_USAGE }),
			userMessage("ship it"),
		]);
		// The whole branch is the dead fork: old leaf is the last entry, the fork
		// point is the root, so every entry between them is what gets summarized.
		const branch = (await session.branch("main", BACKGROUND_CONTEXT))!;
		const { entries } = await collectEntriesForBranchSummary(branch, session, ids[ids.length - 1]!, ids[0]!, BACKGROUND_CONTEXT);

		const result = await generateBranchSummary(entries, {
			models: createModels("## Goal\nRefactor parseNode"),
			model: createModel(),
		}, BACKGROUND_CONTEXT);

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		// pi wraps the model's output in a preamble telling the model that what
		// follows describes a branch the conversation has since left.
		expect(result.value.summary).toContain("Refactor parseNode");
		expect(result.value.summary).toContain("explored a different conversation branch");
		expect(result.value.readFiles).toEqual([]);
		expect(result.value.modifiedFiles).toEqual([]);
	});

	it("reports an abort as a typed error instead of throwing", async () => {
		const { session, ids } = await buildSession([userMessage("q"), assistantMessage("a", EMPTY_USAGE)]);
		const branch = (await session.branch("main", BACKGROUND_CONTEXT))!;
		const { entries } = await collectEntriesForBranchSummary(branch, session, ids[1]!, ids[0]!, BACKGROUND_CONTEXT);

		const controller = new AbortController();
		controller.abort();
		const result = await generateBranchSummary(entries, {
			models: createAbortedModels(),
			model: createModel(),
		}, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error.code).toBe("aborted");
	});

	it("reports a summarization failure as a typed error instead of throwing", async () => {
		const { session, ids } = await buildSession([userMessage("q"), assistantMessage("a", EMPTY_USAGE)]);
		const branch = (await session.branch("main", BACKGROUND_CONTEXT))!;
		const { entries } = await collectEntriesForBranchSummary(branch, session, ids[1]!, ids[0]!, BACKGROUND_CONTEXT);

		const result = await generateBranchSummary(entries, {
			models: createErrorModels("provider exploded"),
			model: createModel(),
		}, BACKGROUND_CONTEXT);

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error.code).toBe("summarization_failed");
		expect(result.error.message).toContain("provider exploded");
	});

	it("retries a transient failure and still summarizes", async () => {
		const { session, ids } = await buildSession([userMessage("q"), assistantMessage("a", EMPTY_USAGE), userMessage("q2")]);
		const branch = (await session.branch("main", BACKGROUND_CONTEXT))!;
		const { entries } = await collectEntriesForBranchSummary(branch, session, ids[2]!, ids[0]!, BACKGROUND_CONTEXT);

		const result = await generateBranchSummary(entries, {
			models: createFlakyModels("## Goal\nRecovered"),
			model: createModel(),
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
		}, BACKGROUND_CONTEXT);

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.summary).toContain("Recovered");
	});
});

describe("collectEntriesForBranchSummary", () => {
	it("collects the dead branch from the old leaf down to the common ancestor", async () => {
		// A linear chain: m1 → m2 → m3 → m4. The user rewinds from m4 back to m2,
		// so the abandoned branch is [m3, m4] and m2 is the common ancestor.
		const { session, ids } = await buildSession([
			userMessage("first"),
			assistantMessage("second", EMPTY_USAGE),
			userMessage("third"),
			assistantMessage("fourth", EMPTY_USAGE),
		]);
		const [, fork, dead, leaf] = [ids[0]!, ids[1]!, ids[2]!, ids[3]!];

		const branch = (await session.branch("main", BACKGROUND_CONTEXT))!;
		const { entries, commonAncestorId } = await collectEntriesForBranchSummary(branch, session, leaf, fork, BACKGROUND_CONTEXT);

		expect(entries.map((entry) => entry.id)).toEqual([dead, leaf]);
		expect(commonAncestorId).toBe(fork);
	});

	it("collects nothing when the old leaf is already the fork point", async () => {
		const { session, ids } = await buildSession([userMessage("only"), assistantMessage("a", EMPTY_USAGE)]);
		const leaf = ids[1]!;

		// Rewinding to the entry we are already on: both paths start at the same
		// id, so the fork point is that id and nothing sits between them.
		const branch = (await session.branch("main", BACKGROUND_CONTEXT))!;
		const { entries, commonAncestorId } = await collectEntriesForBranchSummary(branch, session, leaf, leaf, BACKGROUND_CONTEXT);

		expect(entries).toEqual([]);
		expect(commonAncestorId).toBe(leaf);
	});

	it("collects nothing without an old leaf", async () => {
		const { session, ids } = await buildSession([userMessage("only")]);

		const branch = (await session.branch("main", BACKGROUND_CONTEXT))!;
		const { entries, commonAncestorId } = await collectEntriesForBranchSummary(branch, session, null, ids[0]!, BACKGROUND_CONTEXT);

		expect(entries).toEqual([]);
		expect(commonAncestorId).toBeNull();
	});
});

/** Creates a native in-memory pi session and returns its root-to-leaf ids. */
async function buildSession(messages: AgentMessage[]): Promise<{ session: Session; ids: string[] }> {
	const repo = new MemorySessionRepo();
	const session = await repo.create({ id: "branch-summary-test" }, BACKGROUND_CONTEXT);
	const branch = (await session.branch("main", BACKGROUND_CONTEXT)) ?? (await session.createBranch("main", null, BACKGROUND_CONTEXT));
	const ids: string[] = [];
	for (let index = 0; index < messages.length; index += 1) {
		const id = await branch.appendMessage(messages[index]!, BACKGROUND_CONTEXT);
		ids.push(id);
	}
	return { session, ids };
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 } as AgentMessage;
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
		timestamp: 1,
	} as unknown as AssistantMessage;
}

function createModel(): Model<Api> {
	return {
		id: "deepseek-v4-pro",
		name: "DeepSeek v4 Pro",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com",
		reasoning: false,
		contextWindow: 1_000_000,
		maxTokens: 4_096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as unknown as Model<Api>;
}

/** Minimal `Models` stand-in: branch summarization only ever calls `completeSimple`. */
function createModels(summary: string): Models {
	return {
		completeSimple: async () => assistantMessage(summary, EMPTY_USAGE),
	} as unknown as Models;
}

/** Returns an aborted assistant message, the shape `retryAssistantCall` passes through. */
function createAbortedModels(): Models {
	return {
		completeSimple: async () => abortedAssistantMessage(),
	} as unknown as Models;
}

/** Returns a non-retryable error response, so the failure is terminal and deterministic. */
function createErrorModels(message: string): Models {
	return {
		completeSimple: async () => errorAssistantMessage(message),
	} as unknown as Models;
}

/**
 * First call answers with a transient, retryable 503; every later call summarizes.
 * Matches the `completeSimple` contract `completeSimpleWithRetries` relies on.
 */
function createFlakyModels(summary: string): Models {
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

function abortedAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage: EMPTY_USAGE,
		stopReason: "aborted",
		timestamp: 1,
	} as unknown as AssistantMessage;
}

function errorAssistantMessage(message: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage: EMPTY_USAGE,
		stopReason: "error",
		errorMessage: message,
		timestamp: 1,
	} as unknown as AssistantMessage;
}
