import { afterAll, describe, expect, it } from "bun:test";
import type { Api, AssistantMessage, Context, Model, Models, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	Agent,
	convertToLlm,
	type AgentMessage,
	type AgentTool,
	type Skill,
	type StreamFn,
} from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { clampWait, clampWaitTimeoutMs, WAIT_DEFAULT_MS, WAIT_MIN_MS, type WaitPacing } from "./waitTool";
import { resumableTranscript, runSubagent, SUBAGENT_MAX_COMPACTIONS } from "./runner";
import { statusOf } from "./registry";
import { SUBAGENT_CONCURRENCY_LIMIT } from "./spawnTool";
import { createSubagentExtension, type SubagentHost } from "./extension";
import { anyRunning, snapshotSubagents } from "./inspectorModel";
import {
	DEFAULT_SUBAGENT_ROLE_NAME,
	SUBAGENT_ROLES,
	composeSubagentPrompt,
	findSubagentRole,
} from "./roles";
import { stubWindowTimers } from "../testUtils/windowStub";

/*
 * `wait_subagent` arms its timer through `window.setTimeout` — the popout-window
 * spelling `obsidianmd/prefer-window-timers` pins — so every test that reaches a
 * wait needs a `window` to arm it on. Installed at file scope rather than inside
 * one `describe`: the waits are spread across `spawn/wait extension` and
 * `inspector data`, and a per-block stub would leave whichever block ran without
 * one failing on `window is not defined`. Without this the file passed only
 * under a full `bun test`, riding on a `window` some UI test installed first.
 */
const restoreWindowTimers = stubWindowTimers();

afterAll(() => {
	restoreWindowTimers();
});

const MODEL: Model<Api> = {
	id: "test-model",
	api: "openai-completions",
	provider: "test",
	contextWindow: 128_000,
	maxTokens: 4_096,
} as unknown as Model<Api>;

const SKILL: Skill = {
	name: "grooming",
	description: "How to groom the vault",
	content: "Brush daily.",
	filePath: "/vault/Piem/skills/grooming/SKILL.md",
};

/** Millisecond-scale wait pacing so tests never idle on Codex's 10s floor. */
const TEST_PACING: WaitPacing = { defaultMs: 200, minMs: 10 };

/**
 * Builds a streamFn whose nth request replays the nth script entry.
 *
 * Each entry is either a tool call (the loop then executes the tool and asks
 * again) or a final text. This is the smallest harness that exercises a real
 * multi-turn agent run without a provider.
 */
function scriptedStreamFn(
	script: Array<{ toolCall?: { id: string; name: string; arguments?: Record<string, unknown> }; text?: string }>,
): StreamFn {
	let requests = 0;
	return (model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => {
		const step = script[Math.min(requests, script.length - 1)]!;
		requests += 1;
		const stream = createAssistantMessageEventStream();
		const base = {
			role: "assistant" as const,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1_000,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_010,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		if (step.toolCall) {
			const message: AssistantMessage = {
				...base,
				// A real model often prefixes a tool call with text; keep it so the
				// runner's report-extraction can be tested against a mixed message.
				content: [
					...(step.text ? [{ type: "text" as const, text: step.text }] : []),
					{ type: "toolCall", id: step.toolCall.id, name: step.toolCall.name, arguments: step.toolCall.arguments ?? {} },
				],
				stopReason: "toolUse",
			};
			stream.push({ type: "done", reason: "toolUse", message });
			stream.end(message);
			return stream;
		}
		const message: AssistantMessage = {
			...base,
			content: [{ type: "text", text: step.text ?? "" }],
			stopReason: "stop",
		};
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
		return stream;
	};
}

/**
 * A provider request that never completes on its own and only terminates when
 * the run's signal fires — what a real hung request does, since the agent
 * forwards its signal into stream options.
 */
function hangingStreamFn(): StreamFn {
	return (model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
		const stream = createAssistantMessageEventStream();
		const fire = (): void => {
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
				stopReason: "aborted",
				errorMessage: "aborted",
			};
			// The event protocol terminates aborted runs with `error`, not `done`.
			stream.push({ type: "error", reason: "aborted", error: message });
			stream.end(message);
		};
		if (options?.signal?.aborted) {
			fire();
		} else {
			options?.signal?.addEventListener("abort", fire, { once: true });
		}
		return stream;
	};
}

/**
 * A model with a tiny window, so pi's compaction threshold trips on turn one.
 *
 * The real trigger reads the newest assistant usage against the window, so the
 * pairing with {@link fullContextStreamFn} is what makes compaction fire rather
 * than any test hook.
 */
const SMALL_WINDOW_MODEL: Model<Api> = {
	id: "small-window",
	api: "openai-completions",
	provider: "test",
	contextWindow: 2_000,
	maxTokens: 500,
} as unknown as Model<Api>;

function usageReporting(input: number) {
	return {
		input,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
	};
}

/** Turns that each report a nearly-full context, then one that replies. */
function fullContextStreamFn(toolTurns: number): StreamFn {
	let requests = 0;
	return (model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => {
		requests += 1;
		const stream = createAssistantMessageEventStream();
		const base = {
			role: "assistant" as const,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usageReporting(1_900),
			timestamp: Date.now(),
		};
		const message: AssistantMessage =
			requests <= toolTurns
				? { ...base, content: [{ type: "toolCall", id: `c${requests}`, name: "noop", arguments: {} }], stopReason: "toolUse" }
				: { ...base, content: [{ type: "text", text: "Report." }], stopReason: "stop" };
		stream.push({ type: "done", reason: message.stopReason as never, message });
		stream.end(message);
		return stream;
	};
}

/** A `Models` whose only live method is the one compaction reaches. */
function summarizingModels(onComplete: () => void): Models {
	return {
		completeSimple: async (model: Model<Api>) => {
			onComplete();
			return {
				role: "assistant",
				content: [{ type: "text", text: "Summary of earlier work." }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: usageReporting(50),
				timestamp: Date.now(),
				stopReason: "stop",
			} as AssistantMessage;
		},
		streamSimple: () => {
			throw new Error("test bug: compaction should not stream");
		},
	} as unknown as Models;
}

function noopTool(): AgentTool {
	return {
		name: "noop",
		label: "noop",
		description: "does nothing",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
}

function recordingTool(name: string, calls: string[]): AgentTool {
	return {
		name,
		label: name,
		description: `test tool ${name}`,
		parameters: Type.Object({}),
		execute: async () => {
			calls.push(name);
			return { content: [{ type: "text", text: `${name} ran` }], details: {} };
		},
	};
}

/** A tool that always fails, for exercising the error-feedback path. */
function failingTool(): AgentTool {
	return {
		name: "grep",
		label: "grep",
		description: "fails",
		parameters: Type.Object({}),
		execute: async () => {
			// One real tick per call. The scripted stream resolves synchronously,
			// so a sync-throwing tool turns the whole loop into uninterrupted
			// microtasks — an abort scheduled by the test never gets a slot to
			// land and the test spins forever instead of finishing.
			await new Promise((resolve) => setTimeout(resolve, 0));
			throw new Error("vault exploded");
		},
	};
}

function toolNamed(tools: readonly AgentTool[], name: string): AgentTool {
	const tool = tools.find((candidate) => candidate.name === name);
	if (!tool) {
		throw new Error(`test bug: no tool named ${name}`);
	}
	return tool;
}

/** The text of a tool result's single text block, failing loudly on anything else. */
function textBlock(result: { content: { type: string }[] }): string {
	const block = result.content[0];
	if (block?.type !== "text") {
		throw new Error("Expected a text content block.");
	}
	return (block as { type: "text"; text: string }).text;
}

describe("subagent roles", () => {
	it("composes the base prompt with the role's instructions", () => {
		const role = findSubagentRole("scout")!;
		const prompt = composeSubagentPrompt(role);
		expect(prompt).toContain("subagent");
		expect(prompt).toContain("Research first");
		expect(prompt).toContain("deliverable is a report of findings");
	});

	it("resolves the default role", () => {
		expect(findSubagentRole(DEFAULT_SUBAGENT_ROLE_NAME)?.name).toBe("general");
		expect(findSubagentRole("no-such-role")).toBeUndefined();
	});

	it("every advertised role is reachable through the tool schema's names", () => {
		expect(SUBAGENT_ROLES.map((role) => role.name)).toEqual(["general", "scout", "reviewer"]);
	});
});

describe("runSubagent", () => {
	const role = findSubagentRole("general")!;

	it("runs a tool loop on an isolated transcript and returns the final report", async () => {
		const calls: string[] = [];
		const tools = [recordingTool("grep", calls), recordingTool("find", calls)];
		const result = await runSubagent({
			task: "Sweep the vault",
			role,
			tools,
			model: MODEL,
			streamFn: scriptedStreamFn([
				{ toolCall: { id: "call_1", name: "grep" } },
				{ toolCall: { id: "call_2", name: "find" } },
				{ text: "Found 3 notes mentioning the mole." },
			]),
			thinkingLevel: "off" as never,
		});
		expect(result.text).toBe("Found 3 notes mentioning the mole.");
		expect(calls).toEqual(["grep", "find"]);
		expect(result.turns).toBe(3);
		expect(result.usage.requests).toBe(3);
		expect(result.usage.tokens).toBeGreaterThan(0);
	});

	it("reports the system prompt that frames the child run", async () => {
		let seenSystemPrompt: string | undefined;
		const streamFn: StreamFn = (model, context, _options) => {
			seenSystemPrompt = context.systemPrompt;
			return scriptedStreamFn([{ text: "ok" }])(model, context, _options);
		};
		await runSubagent({
			task: "t",
			role: findSubagentRole("reviewer")!,
			tools: [],
			model: MODEL,
			streamFn,
			thinkingLevel: "off" as never,
		});
		expect(seenSystemPrompt).toContain("Assess, do not fix");
	});

	it("aborts with a named error when the parent signal fires", async () => {
		const controller = new AbortController();
		const run = runSubagent({
			task: "t",
			role,
			tools: [],
			model: MODEL,
			streamFn: hangingStreamFn(),
			thinkingLevel: "off" as never,
			signal: controller.signal,
		});
		controller.abort();
		expect(run).rejects.toThrow("Subagent aborted");
	});

	it("keeps waiting on a silent child rather than inventing a deadline", async () => {
		// The guard against a wall-clock cap creeping back in: a hung child is
		// still running after a window any reaper would have fired inside, and
		// only the explicit abort ends it. A thorough sweep and a wedged one look
		// identical from out here, so a timer could only ever cut off honest work.
		const controller = new AbortController();
		const run = runSubagent({
			task: "t",
			role,
			tools: [],
			model: MODEL,
			streamFn: hangingStreamFn(),
			thinkingLevel: "off" as never,
			signal: controller.signal,
		});
		let settled = false;
		void run.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(settled).toBe(false);

		controller.abort();
		expect(run).rejects.toThrow("Subagent aborted");
	});

	it("refuses to start when the parent signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const run = runSubagent({
			task: "t",
			role,
			tools: [],
			model: MODEL,
			streamFn: scriptedStreamFn([{ text: "never reached" }]),
			thinkingLevel: "off" as never,
			signal: controller.signal,
		});
		expect(run).rejects.toThrow("Subagent aborted");
	});

	it("feeds a tool error back and lets the model recover", async () => {
		// The error is one turn's result, and the next request sees it — a bad
		// call is a recoverable stumble, not a dead run.
		const failing = failingTool();
		const result = await runSubagent({
			task: "t",
			role,
			tools: [failing],
			model: MODEL,
			streamFn: scriptedStreamFn([
				{ toolCall: { id: "call_1", name: "grep" } },
				{ text: "Recovered and found it." },
			]),
			thinkingLevel: "off" as never,
		});
		expect(result.text).toBe("Recovered and found it.");
		expect(result.turns).toBe(2);
	});

	it("does not mistake prefatory text for a report after a recovered tool error", async () => {
		const failing = failingTool();
		const result = await runSubagent({
			task: "t",
			role,
			tools: [failing],
			model: MODEL,
			streamFn: scriptedStreamFn([
				{ toolCall: { id: "call_1", name: "grep" }, text: "Let me search for that." },
				{ text: "Real report." },
			]),
			thinkingLevel: "off" as never,
		});
		expect(result.text).toBe("Real report.");
	});

	it("still refuses an empty success when the model gives up after a tool error", async () => {
		const failing = failingTool();
		expect(
			runSubagent({
				task: "t",
				role,
				tools: [failing],
				model: MODEL,
				streamFn: scriptedStreamFn([
					{ toolCall: { id: "call_1", name: "grep" } },
					{ text: "" },
				]),
				thinkingLevel: "off" as never,
			}),
		).rejects.toThrow("Subagent failed: grep: vault exploded");
	});

	it("stops a model that never recovers from a tool error the moment it is aborted", async () => {
		const failing = failingTool();
		// The script clamps to its last entry, so the model retries the failing
		// call forever. Nothing ends that on a clock — the abort has to reach it
		// between turns, which is what `shouldStopAfterTurn` is there for.
		const controller = new AbortController();
		const run = runSubagent({
			task: "t",
			role,
			tools: [failing],
			model: MODEL,
			streamFn: scriptedStreamFn([{ toolCall: { id: "call_1", name: "grep" } }]),
			thinkingLevel: "off" as never,
			signal: controller.signal,
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort();
		expect(run).rejects.toThrow("Subagent aborted");
	});

	it("lists the given skills in the child system prompt", async () => {
		let seenSystemPrompt: string | undefined;
		const streamFn: StreamFn = (model, context, _options) => {
			seenSystemPrompt = context.systemPrompt;
			return scriptedStreamFn([{ text: "ok" }])(model, context, _options);
		};
		await runSubagent({
			task: "t",
			role,
			tools: [],
			skills: [SKILL],
			model: MODEL,
			streamFn,
			thinkingLevel: "off" as never,
		});
		expect(seenSystemPrompt).toContain("grooming");
		expect(seenSystemPrompt).toContain("read_skill");
	});

	it("appends caller instructions after the role appendix", async () => {
		let seen: string | undefined;
		const streamFn: StreamFn = (model, context, options) => {
			seen = context.systemPrompt;
			return scriptedStreamFn([{ text: "ok" }])(model, context, options);
		};
		await runSubagent({
			task: "Summarize the mole notes",
			role: findSubagentRole("scout")!,
			instructions: "Answer in exactly three bullet points.",
			tools: [],
			model: MODEL,
			streamFn,
			thinkingLevel: "off" as never,
		});
		expect(seen).toContain("Research first");
		expect(seen).toContain("three bullet points");
		// Framing lands after the role, so a caller narrows the role rather than
		// replacing it — and never unsays the base framing.
		expect(seen!.indexOf("three bullet points")).toBeGreaterThan(seen!.indexOf("Research first"));
		expect(seen).toContain("never ask questions");
	});

	it("leaves the prompt untouched for blank instructions", () => {
		const role = findSubagentRole("general")!;
		expect(composeSubagentPrompt(role, "   ")).toBe(composeSubagentPrompt(role));
		expect(composeSubagentPrompt(role, undefined)).toBe(composeSubagentPrompt(role));
	});

	it("compacts its own context mid-run when the host supplies a registry", async () => {
		let summaries = 0;
		const result = await runSubagent({
			task: "t",
			role,
			tools: [noopTool()],
			model: SMALL_WINDOW_MODEL,
			streamFn: fullContextStreamFn(2),
			thinkingLevel: "off" as never,
			models: summarizingModels(() => {
				summaries += 1;
			}),
		});
		expect(result.text).toBe("Report.");
		expect(summaries).toBeGreaterThan(0);
		// The summarization request is billed but leaves no message, so it only
		// lands in the totals through the extras channel.
		expect(result.usage.requests).toBe(result.turns + summaries);
	});

	it("runs without compaction when no registry is supplied", async () => {
		// The identical run to the test above, minus `models`. A summarization
		// request would show up as a billed request with no message behind it, so
		// requests matching turns exactly is the assertion that none happened.
		const result = await runSubagent({
			task: "t",
			role,
			tools: [noopTool()],
			model: SMALL_WINDOW_MODEL,
			streamFn: fullContextStreamFn(2),
			thinkingLevel: "off" as never,
		});
		expect(result.text).toBe("Report.");
		expect(result.usage.requests).toBe(result.turns);
	});

	it("spends at most its compaction budget however long the run goes", async () => {
		let summaries = 0;
		// Every turn reports a full context, so the threshold trips at every
		// boundary — the pathological case the budget exists for.
		const result = await runSubagent({
			task: "t",
			role,
			tools: [noopTool()],
			model: SMALL_WINDOW_MODEL,
			streamFn: fullContextStreamFn(SUBAGENT_MAX_COMPACTIONS + 4),
			thinkingLevel: "off" as never,
			models: summarizingModels(() => {
				summaries += 1;
			}),
		});
		expect(result.text).toBe("Report.");
		expect(summaries).toBe(SUBAGENT_MAX_COMPACTIONS);
	});

	it("finishes the run when compaction itself fails", async () => {
		// pi's contract is that this hook must not throw, and a child has no banner
		// to report on — so a failed summary is silent and the run continues.
		const failing = {
			completeSimple: async () => {
				throw new Error("summarizer exploded");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
		} as unknown as Models;
		const result = await runSubagent({
			task: "t",
			role,
			tools: [noopTool()],
			model: SMALL_WINDOW_MODEL,
			streamFn: fullContextStreamFn(2),
			thinkingLevel: "off" as never,
			models: failing,
		});
		expect(result.text).toBe("Report.");
	});

	it("names a context overflow instead of passing the provider's wording through", async () => {
		const overflowing: StreamFn = (model, _context, _options) => {
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: usageReporting(0),
				timestamp: Date.now(),
				stopReason: "error",
				// One of the phrasings pi's detector knows.
				errorMessage: "prompt is too long: 213000 tokens > 200000 maximum",
			};
			stream.push({ type: "error", reason: "error", error: message });
			stream.end(message);
			return stream;
		};
		const run = runSubagent({
			task: "t",
			role,
			tools: [],
			model: SMALL_WINDOW_MODEL,
			streamFn: overflowing,
			thinkingLevel: "off" as never,
		});
		expect(run).rejects.toThrow("ran out of context");
		expect(run).rejects.toThrow("Narrow it, or split it");
	});

	it("hands back a partial report when a kill lands mid-run", async () => {
		const failing = failingTool();
		const controller = new AbortController();
		// The script clamps to its last entry, so after the written turn the model
		// retries the failing call forever until the abort lands. The text from
		// the turn before is the salvage.
		const run = runSubagent({
			task: "t",
			role,
			tools: [failing],
			model: MODEL,
			// Prefatory text on the tool-call message is the only text a run that
			// never finishes ever produces — a plain text turn would end the run
			// before the kill could land. Salvage relaxes the "a tool-call
			// message is not a report" rule for exactly this case.
			streamFn: scriptedStreamFn([{ toolCall: { id: "call_1", name: "grep" }, text: "Partial findings: two matches." }]),
			thinkingLevel: "off" as never,
			signal: controller.signal,
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort();
		const result = await run;
		expect(result.text).toContain("Partial findings");
		expect(result.incomplete).toBe(true);
	});

	it("still throws when an aborted run wrote nothing at all", async () => {
		const controller = new AbortController();
		const run = runSubagent({
			task: "t",
			role,
			tools: [],
			model: MODEL,
			streamFn: hangingStreamFn(),
			thinkingLevel: "off" as never,
			signal: controller.signal,
		});
		controller.abort();
		expect(run).rejects.toThrow("Subagent aborted");
	});

	it("returns an empty report rather than a failure for a clean silent run", async () => {
		// "I swept the vault and found nothing" is an answer. Only a recorded
		// error makes an empty run a failure.
		const result = await runSubagent({
			task: "t",
			role,
			tools: [],
			model: MODEL,
			streamFn: scriptedStreamFn([{ text: "" }]),
			thinkingLevel: "off" as never,
		});
		expect(result.text).toBe("");
		expect(result.incomplete).toBeUndefined();
		expect(result.turns).toBe(1);
	});
});

describe("spawn/wait extension", () => {
	/** What one child request looked like, read from the only observable spot. */
	interface ChildObservation {
		systemPrompt?: string;
		toolNames: string[];
	}

	function makeHost(streamFn: StreamFn): SubagentHost {
		return {
			createVaultTools: () => {
				const calls: string[] = [];
				return ["read", "write", "grep", "read_skill"].map((name) => recordingTool(name, calls));
			},
			getModel: () => MODEL,
			getStreamFn: () => streamFn,
			getThinkingLevel: () => "off" as never,
			getSkills: () => [SKILL],
		};
	}

	/** Wraps a streamFn so every LLM request a child makes is recorded. */
	function observing(streamFn: StreamFn, observations: ChildObservation[]): StreamFn {
		return (model, context, options) => {
			observations.push({
				systemPrompt: context.systemPrompt,
				toolNames: (context.tools ?? []).map((tool) => tool.name),
			});
			return streamFn(model, context, options);
		};
	}

	/** Tools from an extension whose wait window is milliseconds, not Codex seconds. */
	function toolsWithPacing(streamFn: StreamFn): AgentTool[] {
		const extension = createSubagentExtension(makeHost(streamFn), { waitPacing: TEST_PACING });
		return extension.createTools();
	}

	it("the parent set carries vault tools plus the spawn/wait pair", () => {
		const names = toolsWithPacing(scriptedStreamFn([{ text: "ok" }])).map((tool) => tool.name);
		expect(names).toContain("grep");
		expect(names).toContain("read_skill");
		expect(names).toContain("spawn_subagent");
		expect(names).toContain("wait_subagent");
	});

	it("spawn returns immediately with an id while the child runs", async () => {
		const extension = createSubagentExtension(makeHost(hangingStreamFn()));
		const spawn = toolNamed(extension.createTools(), "spawn_subagent");
		const controller = new AbortController();
		try {
			const result = await spawn.execute("call_1", { task: "Sweep" }, controller.signal);
			expect(result.details).toMatchObject({ subagentId: "subagent-1", role: "general", status: "running" });
			expect(controller.signal.aborted).toBe(false);
		} finally {
			// A hung child runs until something kills it; dispose is that teardown.
			extension.disposeAll();
		}
	});

	it("wait collects the report with accounting details", async () => {
		const tools = toolsWithPacing(scriptedStreamFn([{ text: "The vault is clean." }]));
		await toolNamed(tools, "spawn_subagent").execute("call_1", { task: "Sweep" }, undefined);
		const result = await toolNamed(tools, "wait_subagent").execute("call_2", {}, undefined);
		expect(textBlock(result)).toContain("The vault is clean.");
		expect(result.details).toMatchObject({
			status: "settled",
			subagents: [{ subagentId: "subagent-1", role: "general", status: "done", turns: 1, usage: { requests: 1 } }],
		});
	});

	it("an id-less wait covers every child of the run, spawned in parallel", async () => {
		const tools = toolsWithPacing(scriptedStreamFn([{ text: "done" }]));
		await Promise.all([
			toolNamed(tools, "spawn_subagent").execute("c1", { task: "a", role: "scout" }, undefined),
			toolNamed(tools, "spawn_subagent").execute("c2", { task: "b" }, undefined),
		]);
		const result = await toolNamed(tools, "wait_subagent").execute("c3", {}, undefined);
		const subagents = (result.details as { subagents: Array<{ subagentId: string; role: string }> }).subagents;
		expect(subagents.map((s) => s.subagentId)).toEqual(["subagent-1", "subagent-2"]);
		expect(subagents.map((s) => s.role)).toEqual(["scout", "general"]);
	});

	it("a closed window reports progress, and the next wait settles", async () => {
		const controller = new AbortController();
		const extension = createSubagentExtension(makeHost(hangingStreamFn()), { waitPacing: TEST_PACING });
		const tools = extension.createTools();
		await toolNamed(tools, "spawn_subagent").execute("c1", { task: "Sweep" }, controller.signal);
		const running = await toolNamed(tools, "wait_subagent").execute("c2", { timeoutMs: 10 }, controller.signal);
		expect(running.details).toMatchObject({ status: "running", subagentIds: ["subagent-1"] });
		// The child only ends when its signal does; the wait window closing was
		// progress, never a kill. A dead run can't wait (its signal is aborted),
		// so the outcome is read back by id — the way any later call reads it.
		controller.abort();
		const settled = await toolNamed(tools, "wait_subagent").execute("c3", { subagentId: "subagent-1" }, undefined);
		expect(settled.details).toMatchObject({
			status: "settled",
			subagents: [{ subagentId: "subagent-1", status: "failed", error: "Subagent aborted" }],
		});
	});

	it("wait refuses unknown ids and names what was spawned", async () => {
		const tools = toolsWithPacing(scriptedStreamFn([{ text: "done" }]));
		await toolNamed(tools, "spawn_subagent").execute("c1", { task: "a" }, undefined);
		expect(toolNamed(tools, "wait_subagent").execute("c2", { subagentId: "subagent-9" }, undefined)).rejects.toThrow(
			"Unknown subagent id: subagent-9",
		);
		expect(toolNamed(tools, "wait_subagent").execute("c3", { subagentId: "subagent-9" }, undefined)).rejects.toThrow(
			"subagent-1",
		);
	});

	it("wait with nothing spawned errors instead of spinning", async () => {
		const tools = toolsWithPacing(scriptedStreamFn([{ text: "done" }]));
		expect(toolNamed(tools, "wait_subagent").execute("c1", {}, undefined)).rejects.toThrow("No subagents to wait for");
	});

	it("clamps the wait into the Codex window", () => {
		expect(clampWaitTimeoutMs(undefined)).toBe(WAIT_DEFAULT_MS);
		expect(clampWaitTimeoutMs(WAIT_MIN_MS - 1)).toBe(WAIT_MIN_MS);
		// No ceiling: how long to wait is the model's own call, and an hour-long
		// request survives intact rather than being quietly cut to a house number.
		expect(clampWaitTimeoutMs(6 * 3_600_000)).toBe(6 * 3_600_000);
		expect(clampWaitTimeoutMs(45_000)).toBe(45_000);
	});

	it("disposeAll kills live children", async () => {
		const controller = new AbortController();
		const extension = createSubagentExtension(makeHost(hangingStreamFn()));
		const tools = extension.createTools();
		await toolNamed(tools, "spawn_subagent").execute("c1", { task: "Sweep" }, controller.signal);
		extension.disposeAll();
		const settled = await toolNamed(tools, "wait_subagent").execute("c2", { subagentId: "subagent-1" }, undefined);
		expect(settled.details).toMatchObject({
			status: "settled",
			subagents: [{ subagentId: "subagent-1", status: "failed", error: "Subagent aborted" }],
		});
	});

	it("refuses a role the schema should have prevented", async () => {
		const tools = toolsWithPacing(scriptedStreamFn([{ text: "done" }]));
		expect(
			// A hand-rolled payload bypasses schema validation, hence the cast.
			toolNamed(tools, "spawn_subagent").execute("c1", { task: "t", role: "overlord" as never }, undefined),
		).rejects.toThrow("Unknown subagent role");
	});

	it("lets a child spawn once more and caps the tree below that", async () => {
		const observations: ChildObservation[] = [];
		// The parent spawns and waits; the child does the same one level down;
		// the grandchild — whose set has no spawn — just reports.
		const parentScript = [
			{ toolCall: { id: "p1", name: "spawn_subagent", arguments: { task: "Sweep the vault" } } },
			{ toolCall: { id: "p2", name: "wait_subagent", arguments: {} } },
			{ text: "Folded in." },
		];
		const childScript = [
			{ toolCall: { id: "s1", name: "spawn_subagent", arguments: { task: "Narrow sweep" } } },
			{ toolCall: { id: "s2", name: "wait_subagent", arguments: {} } },
			{ text: "Child report: all clear." },
		];
		// One stream closure per level — a fresh closure per request would reset
		// its script counter and replay step one forever.
		const parentStream = scriptedStreamFn(parentScript);
		const childStream = scriptedStreamFn(childScript);
		const grandchildStream = scriptedStreamFn([{ text: "Floor report: all clear." }]);
		const dispatching: StreamFn = (model, context, options) => {
			const isDelegated = context.systemPrompt?.includes("delegated task") ?? false;
			if (!isDelegated) {
				return parentStream(model, context, options);
			}
			const hasSpawn = (context.tools ?? []).some((tool) => tool.name === "spawn_subagent");
			return (hasSpawn ? childStream : grandchildStream)(model, context, options);
		};
		const extension = createSubagentExtension(makeHost(observing(dispatching, observations)), { waitPacing: TEST_PACING });
		const agent = new Agent({
			streamFn: dispatching,
			convertToLlm,
			initialState: {
				systemPrompt: "You are the parent.",
				model: MODEL,
				thinkingLevel: "off" as never,
				tools: extension.createTools(),
				messages: [],
			},
		});
		await agent.prompt("Delegate the sweep.");
		// The child's report reached the parent through the wait tool result.
		const transcript = JSON.stringify(agent.state.messages);
		expect(transcript).toContain("Child report: all clear.");
		expect(transcript).toContain("Folded in.");

		// The grandchild set: no spawn/wait, vault tools only.
		const grandchild = observations.find(
			(o) => o.systemPrompt?.includes("delegated task") && !o.toolNames.includes("spawn_subagent"),
		);
		expect(grandchild).toBeDefined();
		expect(grandchild!.toolNames).toContain("grep");
		expect(grandchild!.toolNames).not.toContain("spawn_subagent");
		expect(grandchild!.toolNames).not.toContain("wait_subagent");
		// Skills ride every level of the tree.
		expect(grandchild!.systemPrompt).toContain("grooming");
		extension.disposeAll();
	});

	it("the parent set carries the delegation five", () => {
		const names = toolsWithPacing(scriptedStreamFn([{ text: "ok" }])).map((tool) => tool.name);
		expect(names).toContain("spawn_subagent");
		expect(names).toContain("wait_subagent");
		expect(names).toContain("list_subagents");
		expect(names).toContain("kill_subagent");
		expect(names).toContain("follow_up_subagent");
	});

	it("the grandchild set carries none of the five", async () => {
		const observations: ChildObservation[] = [];
		const parentStream = scriptedStreamFn([
			{ toolCall: { id: "p1", name: "spawn_subagent", arguments: { task: "Sweep" } } },
			{ toolCall: { id: "p2", name: "wait_subagent", arguments: {} } },
			{ text: "Folded in." },
		]);
		const childStream = scriptedStreamFn([
			{ toolCall: { id: "s1", name: "spawn_subagent", arguments: { task: "Narrow" } } },
			{ toolCall: { id: "s2", name: "wait_subagent", arguments: {} } },
			{ text: "Child report." },
		]);
		const grandchildStream = scriptedStreamFn([{ text: "Floor report." }]);
		const dispatching: StreamFn = (model, context, options) => {
			if (!(context.systemPrompt?.includes("delegated task") ?? false)) {
				return parentStream(model, context, options);
			}
			const hasSpawn = (context.tools ?? []).some((tool) => tool.name === "spawn_subagent");
			return (hasSpawn ? childStream : grandchildStream)(model, context, options);
		};
		const extension = createSubagentExtension(makeHost(observing(dispatching, observations)), { waitPacing: TEST_PACING });
		const agent = new Agent({
			streamFn: dispatching,
			convertToLlm,
			initialState: {
				systemPrompt: "You are the parent.",
				model: MODEL,
				thinkingLevel: "off" as never,
				tools: extension.createTools(),
				messages: [],
			},
		});
		await agent.prompt("Delegate.");
		const grandchild = observations.find(
			(o) => o.systemPrompt?.includes("delegated task") && !o.toolNames.includes("spawn_subagent"),
		);
		expect(grandchild).toBeDefined();
		for (const name of ["spawn_subagent", "wait_subagent", "list_subagents", "kill_subagent", "follow_up_subagent"]) {
			expect(grandchild!.toolNames).not.toContain(name);
		}
		extension.disposeAll();
	});

	it("omits the model parameter and the menu when the host offers no models", () => {
		const spawn = toolNamed(toolsWithPacing(scriptedStreamFn([{ text: "ok" }])), "spawn_subagent");
		const properties = (spawn.parameters as unknown as { properties: Record<string, unknown> }).properties;
		expect(properties.model).toBeUndefined();
		expect(spawn.description).not.toContain("label → id");
		// The level is always offered: the clamp reduces it to what the model
		// supports, so it needs no host list.
		expect(properties.thinkingLevel).toBeDefined();
	});

	it("advertises the host's models and runs the child on the one picked", async () => {
		const cheap: Model<Api> = { ...MODEL, id: "cheap-model" } as Model<Api>;
		const seenModels: string[] = [];
		const streamFn: StreamFn = (model, context, options) => {
			seenModels.push(model.id);
			return scriptedStreamFn([{ text: "done" }])(model, context, options);
		};
		const extension = createSubagentExtension(
			{
				...makeHost(streamFn),
				listModels: () => [
					{ id: "choice-default", label: "Opus 5 (OpenRouter)" },
					{ id: "choice-cheap", label: "Haiku (Anthropic)" },
				],
				resolveModel: (id) => (id === "choice-cheap" ? cheap : MODEL),
			},
			{ waitPacing: TEST_PACING },
		);
		const tools = extension.createTools();
		const spawn = toolNamed(tools, "spawn_subagent");
		expect(spawn.description).toContain("Haiku (Anthropic) → choice-cheap");
		const result = await spawn.execute("c1", { task: "Sweep", model: "choice-cheap" } as never, undefined);
		expect(result.details).toMatchObject({ model: "cheap-model" });
		await toolNamed(tools, "wait_subagent").execute("c2", {}, undefined);
		expect(seenModels).toEqual(["cheap-model"]);
		extension.disposeAll();
	});

	it("names an unresolvable model instead of quietly falling back to the parent's", async () => {
		const extension = createSubagentExtension(
			{
				...makeHost(scriptedStreamFn([{ text: "done" }])),
				listModels: () => [{ id: "choice-gone", label: "Deleted model" }],
				// The user deleted it between agent builds: advertised, unresolvable.
				resolveModel: () => undefined,
			},
			{ waitPacing: TEST_PACING },
		);
		const spawn = toolNamed(extension.createTools(), "spawn_subagent");
		expect(spawn.execute("c1", { task: "t", model: "choice-gone" } as never, undefined)).rejects.toThrow(
			"Unknown model: choice-gone",
		);
		extension.disposeAll();
	});

	it("clamps the child's level to what its own model supports", async () => {
		const seenLevels: unknown[] = [];
		const streamFn: StreamFn = (model, context, options) => {
			seenLevels.push((context as { thinkingLevel?: unknown }).thinkingLevel);
			return scriptedStreamFn([{ text: "done" }])(model, context, options);
		};
		// MODEL has no `reasoning`, so pi's clamp collapses any level to "off" —
		// which is exactly the case a parent must be able to see it got.
		const extension = createSubagentExtension(makeHost(streamFn), { waitPacing: TEST_PACING });
		const tools = extension.createTools();
		const result = await toolNamed(tools, "spawn_subagent").execute(
			"c1",
			{ task: "t", thinkingLevel: "max" } as never,
			undefined,
		);
		expect(result.details).toMatchObject({ thinkingLevel: "off" });
		await toolNamed(tools, "wait_subagent").execute("c2", {}, undefined);
		extension.disposeAll();
	});

	it("list_subagents answers at once, without waiting", async () => {
		const controller = new AbortController();
		const extension = createSubagentExtension(makeHost(hangingStreamFn()), { waitPacing: TEST_PACING });
		const tools = extension.createTools();
		try {
			await toolNamed(tools, "spawn_subagent").execute("c1", { task: "a", role: "scout" }, controller.signal);
			const listed = await toolNamed(tools, "list_subagents").execute("c2", {}, controller.signal);
			expect(textBlock(listed)).toContain("subagent-1");
			expect(listed.details).toMatchObject({ subagents: [{ subagentId: "subagent-1", role: "scout", status: "running" }] });
		} finally {
			extension.disposeAll();
		}
	});

	it("list_subagents names children of earlier turns rather than claiming none exist", async () => {
		const tools = toolsWithPacing(scriptedStreamFn([{ text: "done" }]));
		const earlier = new AbortController();
		await toolNamed(tools, "spawn_subagent").execute("c1", { task: "a" }, earlier.signal);
		const laterTurn = new AbortController();
		const listed = await toolNamed(tools, "list_subagents").execute("c2", {}, laterTurn.signal);
		expect(textBlock(listed)).toContain("Earlier turns spawned: subagent-1");
		expect(listed.details).toMatchObject({ subagents: [], earlierIds: ["subagent-1"] });
	});

	it("kill_subagent stops a live child and its partial work survives", async () => {
		const controller = new AbortController();
		// Prefatory text is the only text a never-finishing child produces, and it
		// is what the kill must leave behind.
		const stream = scriptedStreamFn([{ toolCall: { id: "t1", name: "grep" }, text: "Found two so far." }]);
		const host: SubagentHost = {
			...makeHost(stream),
			// A tool that never resolves keeps the child alive until the kill lands.
			createVaultTools: () => [
				{
					name: "grep",
					label: "grep",
					description: "hangs",
					parameters: Type.Object({}),
					execute: async (_id: string, _p: unknown, signal?: AbortSignal) =>
						new Promise((_resolve, reject) => {
							signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
						}),
				} as AgentTool,
			],
		};
		const extension = createSubagentExtension(host, { waitPacing: TEST_PACING });
		const tools = extension.createTools();
		try {
			await toolNamed(tools, "spawn_subagent").execute("c1", { task: "Sweep" }, controller.signal);
			// Let the first turn land so there is prefatory text to salvage.
			await new Promise((resolve) => setTimeout(resolve, 20));
			const killed = await toolNamed(tools, "kill_subagent").execute("c2", { subagentId: "subagent-1" }, controller.signal);
			expect(killed.details).toMatchObject({ subagentId: "subagent-1", killed: true });
			const collected = await toolNamed(tools, "wait_subagent").execute("c3", { subagentId: "subagent-1" }, controller.signal);
			expect(textBlock(collected)).toContain("Found two so far.");
			expect(textBlock(collected)).toContain("kill_subagent");
			expect(textBlock(collected)).toContain("INCOMPLETE");
			expect(collected.details).toMatchObject({
				status: "settled",
				subagents: [{ subagentId: "subagent-1", status: "incomplete", incomplete: true }],
			});
		} finally {
			extension.disposeAll();
		}
	});

	it("kill_subagent reports rather than throws on a settled child and an unknown id", async () => {
		const tools = toolsWithPacing(scriptedStreamFn([{ text: "done" }]));
		await toolNamed(tools, "spawn_subagent").execute("c1", { task: "a" }, undefined);
		await toolNamed(tools, "wait_subagent").execute("c2", {}, undefined);
		const settled = await toolNamed(tools, "kill_subagent").execute("c3", { subagentId: "subagent-1" }, undefined);
		expect(settled.details).toMatchObject({ killed: false, reason: "already-settled" });
		const missing = await toolNamed(tools, "kill_subagent").execute("c4", { subagentId: "subagent-9" }, undefined);
		expect(missing.details).toMatchObject({ killed: false, reason: "not-found" });
		expect(textBlock(missing)).toContain("subagent-1");
	});

	it("kill_subagent refuses a child of another run", async () => {
		const extension = createSubagentExtension(makeHost(hangingStreamFn()), { waitPacing: TEST_PACING });
		const tools = extension.createTools();
		const mine = new AbortController();
		const theirs = new AbortController();
		try {
			await toolNamed(tools, "spawn_subagent").execute("c1", { task: "a" }, theirs.signal);
			const refused = await toolNamed(tools, "kill_subagent").execute("c2", { subagentId: "subagent-1" }, mine.signal);
			expect(refused.details).toMatchObject({ killed: false, reason: "not-yours" });
		} finally {
			extension.disposeAll();
		}
	});

	it("a user kill from the monitor panel reaches the parent as the user's decision", async () => {
		// The panel kills hostless — no owner signal — and records cause "user".
		// What must survive the trip is attribution: the parent reading a
		// cut-short report has to know the user, not it, ended the run, so it
		// does not retry what the user chose to end.
		const controller = new AbortController();
		// Prefatory text plus a tool that hangs until aborted: same shape as the
		// kill_subagent test, because only a run wedged in a tool leaves the
		// partial-work trail an INCOMPLETE report carries — an aborted stream
		// alone settles as a plain failure.
		const stream = scriptedStreamFn([{ toolCall: { id: "t1", name: "grep" }, text: "Found two so far." }]);
		const host: SubagentHost = {
			...makeHost(stream),
			createVaultTools: () => [
				{
					name: "grep",
					label: "grep",
					description: "hangs",
					parameters: Type.Object({}),
					execute: async (_id: string, _p: unknown, signal?: AbortSignal) =>
						new Promise((_resolve, reject) => {
							signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
						}),
				} as AgentTool,
			],
		};
		const extension = createSubagentExtension(host, { waitPacing: TEST_PACING });
		const tools = extension.createTools();
		try {
			await toolNamed(tools, "spawn_subagent").execute("c1", { task: "Sweep" }, controller.signal);
			// Let the first turn land so there is prefatory text to salvage.
			await new Promise((resolve) => setTimeout(resolve, 20));
			const outcome = extension.registry.kill("subagent-1", undefined, "user");
			expect(outcome).toBe("killed");
			const entry = extension.registry.get("subagent-1")!;
			expect(entry.killedBy).toBe("user");
			// The kill is a synchronous abort; the unwind lands a tick later. Wait
			// for it here so the wait below reads the settled entry instead of
			// entering a wait window for a run that just ended.
			await entry.promise.catch(() => undefined);
			const collected = await toolNamed(tools, "wait_subagent").execute("c2", { subagentId: "subagent-1" }, controller.signal);
			expect(textBlock(collected)).toContain("stopped by the user");
			expect(textBlock(collected)).toContain("Found two so far.");
			expect(textBlock(collected)).toContain("INCOMPLETE");
		} finally {
			extension.disposeAll();
		}
	});

	it("killAllLive stops only the running children and counts them", async () => {
		// The panel's "stop all" is one user action among live runs: settled
		// entries stay exactly as the record keeps them, and the count is what
		// the next snapshot's absence of the button is checked against.
		const extension = createSubagentExtension(makeHost(hangingStreamFn()), { waitPacing: TEST_PACING });
		const tools = extension.createTools();
		const controller = new AbortController();
		try {
			await toolNamed(tools, "spawn_subagent").execute("c1", { task: "one" }, controller.signal);
			await toolNamed(tools, "spawn_subagent").execute("c2", { task: "two" }, controller.signal);
			// Settle the first deterministically with a tool kill, then stop all:
			// only the second is live, so the count is 1 and the settled entry's
			// record is left naming the tool, not overwritten by the sweep.
			extension.registry.kill("subagent-1", controller.signal);
			await toolNamed(tools, "wait_subagent").execute("c3", { subagentId: "subagent-1" }, controller.signal);
			const killed = extension.registry.killAllLive("user");

			expect(killed).toBe(1);
			expect(extension.registry.get("subagent-1")!.killedBy).toBe("tool");
			expect(extension.registry.get("subagent-2")!.killedBy).toBe("user");
		} finally {
			extension.disposeAll();
		}
	});

	it("refuses a spawn past the concurrency limit and says how to recover", async () => {
		const controller = new AbortController();
		const extension = createSubagentExtension(makeHost(hangingStreamFn()), { waitPacing: TEST_PACING });
		const tools = extension.createTools();
		const spawn = toolNamed(tools, "spawn_subagent");
		try {
			for (let i = 0; i < SUBAGENT_CONCURRENCY_LIMIT; i++) {
				await spawn.execute(`c${i}`, { task: `task ${i}` }, controller.signal);
			}
			expect(spawn.execute("over", { task: "one too many" }, controller.signal)).rejects.toThrow(
				`which is the limit (${SUBAGENT_CONCURRENCY_LIMIT})`,
			);
		} finally {
			extension.disposeAll();
		}
	});

	it("a settled child frees its concurrency slot", async () => {
		const tools = toolsWithPacing(scriptedStreamFn([{ text: "done" }]));
		const spawn = toolNamed(tools, "spawn_subagent");
		for (let i = 0; i < SUBAGENT_CONCURRENCY_LIMIT; i++) {
			await spawn.execute(`c${i}`, { task: `task ${i}` }, undefined);
		}
		await toolNamed(tools, "wait_subagent").execute("collect", {}, undefined);
		// Every child settled, so the next spawn is not at the limit.
		const after = await spawn.execute("next", { task: "after collection" }, undefined);
		expect(after.details).toMatchObject({ status: "running" });
	});

	it("a long report is not cut at pi's 2000-line file limit", async () => {
		const long = Array.from({ length: 2_600 }, (_, i) => `line ${i + 1}`).join("\n");
		const tools = toolsWithPacing(scriptedStreamFn([{ text: long }]));
		await toolNamed(tools, "spawn_subagent").execute("c1", { task: "Enumerate" }, undefined);
		const result = await toolNamed(tools, "wait_subagent").execute("c2", { subagentId: "subagent-1" }, undefined);
		expect(textBlock(result)).toContain("line 2600");
		expect(result.details).not.toMatchObject({ truncated: true });
	});

	it("names the next offset when a report is cut, and paging reaches the end", async () => {
		// Wide enough to exceed pi's 50KB byte budget, so the cap really lands.
		const long = Array.from({ length: 900 }, (_, i) => `line ${i + 1}: ${"x".repeat(80)}`).join("\n");
		const tools = toolsWithPacing(scriptedStreamFn([{ text: long }]));
		await toolNamed(tools, "spawn_subagent").execute("c1", { task: "Enumerate" }, undefined);
		const wait = toolNamed(tools, "wait_subagent");
		const first = await wait.execute("c2", { subagentId: "subagent-1" }, undefined);
		expect(first.details).toMatchObject({ truncated: true, totalLines: 900 });
		// Line numbers count the report's own lines, so page one starts at 1 — the
		// header is outside the cap on purpose.
		expect(textBlock(first)).toContain("lines 1-");
		expect(textBlock(first)).toContain("of 900");
		expect(textBlock(first)).toContain("line 1: ");

		// Follow the offset the result names, rather than computing one.
		let next = (first.details as { nextOffset?: number }).nextOffset;
		expect(next).toBeGreaterThan(1);
		let last = first;
		for (let page = 0; page < 6 && next !== undefined; page++) {
			last = await wait.execute(`page${page}`, { subagentId: "subagent-1", offset: next }, undefined);
			next = (last.details as { nextOffset?: number }).nextOffset;
		}
		// Paging terminates, and the final page reaches the report's last line.
		expect(next).toBeUndefined();
		expect(textBlock(last)).toContain("(complete)");
		expect(textBlock(last)).toContain("line 900:");
	});

	it("warns on every page of a salvaged report, not only the last", async () => {
		const controller = new AbortController();
		// A long prefatory text on a hanging tool call: the salvage is big enough
		// to need paging, so page one must carry the warning too.
		const long = Array.from({ length: 900 }, (_, i) => `finding ${i + 1}: ${"z".repeat(80)}`).join("\n");
		const host: SubagentHost = {
			...makeHost(scriptedStreamFn([{ toolCall: { id: "t1", name: "grep" }, text: long }])),
			createVaultTools: () => [
				{
					name: "grep",
					label: "grep",
					description: "hangs",
					parameters: Type.Object({}),
					execute: async (_id: string, _p: unknown, signal?: AbortSignal) =>
						new Promise((_resolve, reject) => {
							signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
						}),
				} as AgentTool,
			],
		};
		const extension = createSubagentExtension(host, { waitPacing: TEST_PACING });
		const tools = extension.createTools();
		try {
			await toolNamed(tools, "spawn_subagent").execute("c1", { task: "Sweep" }, controller.signal);
			await new Promise((resolve) => setTimeout(resolve, 20));
			await toolNamed(tools, "kill_subagent").execute("c2", { subagentId: "subagent-1" }, controller.signal);
			const wait = toolNamed(tools, "wait_subagent");
			const first = await wait.execute("c3", { subagentId: "subagent-1" }, controller.signal);
			expect(textBlock(first)).toContain("INCOMPLETE");
			expect(textBlock(first)).toContain("kill_subagent");
			const next = (first.details as { nextOffset?: number }).nextOffset;
			expect(next).toBeGreaterThan(1);
			const second = await wait.execute("c4", { subagentId: "subagent-1", offset: next }, controller.signal);
			// The warning repeats rather than appearing once at the start.
			expect(textBlock(second)).toContain("INCOMPLETE");
		} finally {
			extension.disposeAll();
		}
	});

	it("reports a clamped wait rather than letting it look like a slow child", async () => {
		const extension = createSubagentExtension(makeHost(hangingStreamFn()), { waitPacing: TEST_PACING });
		const tools = extension.createTools();
		const controller = new AbortController();
		try {
			await toolNamed(tools, "spawn_subagent").execute("c1", { task: "a" }, controller.signal);
			const result = await toolNamed(tools, "wait_subagent").execute("c2", { timeoutMs: 1 }, controller.signal);
			expect(result.details).toMatchObject({
				status: "running",
				requestedTimeoutMs: 1,
				effectiveTimeoutMs: TEST_PACING.minMs,
			});
		} finally {
			extension.disposeAll();
		}
	});

	it("clampWait says whether it moved the dial", () => {
		expect(clampWait(undefined)).toEqual({ value: WAIT_DEFAULT_MS, clamped: false });
		expect(clampWait(45_000)).toEqual({ value: 45_000, clamped: false });
		expect(clampWait(WAIT_MIN_MS - 1)).toEqual({ value: WAIT_MIN_MS, clamped: true });
		expect(clampWait(6 * 3_600_000)).toEqual({ value: 6 * 3_600_000, clamped: false });
		// NaN would slip past a bare comparison and arm a timer that fires at once.
		expect(clampWait(Number.NaN)).toEqual({ value: WAIT_DEFAULT_MS, clamped: true });
	});

	it("an id-less wait in a later turn names the earlier children instead of denying them", async () => {
		const tools = toolsWithPacing(scriptedStreamFn([{ text: "done" }]));
		const earlier = new AbortController();
		await toolNamed(tools, "spawn_subagent").execute("c1", { task: "a" }, earlier.signal);
		const laterTurn = new AbortController();
		expect(toolNamed(tools, "wait_subagent").execute("c2", {}, laterTurn.signal)).rejects.toThrow(
			"Earlier turns spawned: subagent-1",
		);
	});

	it("a failing child never reaches the unhandled-rejection lane", async () => {
		// The bare `.catch` in registry.spawn is what keeps a child nobody has
		// waited for yet from crashing the host. Load-bearing and otherwise
		// untested: this asserts the rejection is absorbed until a wait reads it.
		const rejections: unknown[] = [];
		// `process.on("unhandledRejection")` is not in Bun's process typings, so the
		// listener rides the global event the runtime does emit.
		const onRejection = (event: Event): void => {
			rejections.push(event);
		};
		globalThis.addEventListener("unhandledrejection", onRejection);
		try {
			const extension = createSubagentExtension(
				{
					...makeHost(scriptedStreamFn([{ text: "" }])),
					// A tool set whose only tool always fails, so the child dies with a
					// recorded tool error — the one shape that still rejects.
					createVaultTools: () => [failingTool()],
					getStreamFn: () => scriptedStreamFn([{ toolCall: { id: "t1", name: "grep" } }, { text: "" }]),
				},
				{ waitPacing: TEST_PACING },
			);
			const spawned = extension.createTools();
			await toolNamed(spawned, "spawn_subagent").execute("c1", { task: "a" }, undefined);
			// Long enough for the child to settle and reject with nobody waiting.
			await new Promise((resolve) => setTimeout(resolve, 60));
			expect(rejections).toEqual([]);
			// The failure is still there to be read, as data rather than a crash.
			const collected = await toolNamed(spawned, "wait_subagent").execute("c2", { subagentId: "subagent-1" }, undefined);
			expect(collected.details).toMatchObject({ subagents: [{ status: "failed" }] });
			extension.disposeAll();
		} finally {
			globalThis.removeEventListener("unhandledrejection", onRejection);
		}
	});

	it("words a clean silent child as no report, not as a failure", async () => {
		const tools = toolsWithPacing(scriptedStreamFn([{ text: "" }]));
		await toolNamed(tools, "spawn_subagent").execute("c1", { task: "Find the mole" }, undefined);
		const result = await toolNamed(tools, "wait_subagent").execute("c2", {}, undefined);
		expect(textBlock(result)).toContain("finished with no report");
		expect(textBlock(result)).not.toContain("failed");
		expect(result.details).toMatchObject({ status: "settled", subagents: [{ subagentId: "subagent-1", status: "done" }] });
	});
});

describe("resumableTranscript", () => {
	const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AgentMessage =>
		({
			role: "assistant",
			content,
			api: MODEL.api,
			provider: MODEL.provider,
			model: MODEL.id,
			usage: usageReporting(10),
			stopReason,
			timestamp: 1,
		}) as AgentMessage;
	const toolResult = (id: string): AgentMessage =>
		({ role: "toolResult", toolCallId: id, toolName: "grep", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2 }) as AgentMessage;
	const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 0 }) as AgentMessage;

	it("leaves a transcript whose every tool call was answered exactly as it is", () => {
		const messages = [user("Sweep"), assistant([{ type: "toolCall", id: "t1", name: "grep", arguments: {} }], "toolUse"), toolResult("t1"), assistant([{ type: "text", text: "Done." }])];

		// Identity, not just equality: an untouched transcript must not be rebuilt,
		// because the `produced` split downstream keys on message identity.
		expect(resumableTranscript(messages)).toEqual(messages);
		expect(resumableTranscript(messages)[1]).toBe(messages[1]);
	});

	it("drops a tool call nothing answered but keeps what the turn had already written", () => {
		// The shape a killed or network-broken run leaves. The text is the salvage
		// worth carrying into the next errand; the dangling call is a 400.
		const messages = [
			user("Sweep"),
			assistant([{ type: "text", text: "Found two so far." }, { type: "toolCall", id: "t1", name: "grep", arguments: {} }], "toolUse"),
		];
		const kept = resumableTranscript(messages);

		expect(kept).toHaveLength(2);
		expect(kept[1]).toMatchObject({ content: [{ type: "text", text: "Found two so far." }] });
	});

	it("drops a turn left with nothing at all", () => {
		// An aborted stream reports an assistant message with no blocks. Seeding it
		// back is a message some providers reject and none of them learn from.
		const messages = [user("Sweep"), assistant([], "aborted")];

		expect(resumableTranscript(messages)).toEqual([messages[0]!]);
	});

	it("keeps every answered call in a turn that also lost one", () => {
		const messages = [
			user("Sweep"),
			assistant(
				[
					{ type: "toolCall", id: "t1", name: "grep", arguments: {} },
					{ type: "toolCall", id: "t2", name: "grep", arguments: {} },
				],
				"toolUse",
			),
			toolResult("t1"),
		];
		const kept = resumableTranscript(messages);

		expect(kept).toHaveLength(3);
		expect(kept[1]).toMatchObject({ content: [{ type: "toolCall", id: "t1" }] });
	});
});

describe("follow-up errands", () => {
	function makeHost(streamFn: StreamFn): SubagentHost {
		return {
			createVaultTools: () => [],
			getModel: () => MODEL,
			getStreamFn: () => streamFn,
			getThinkingLevel: () => "off" as never,
			getSkills: () => [],
		};
	}

	/** Records the transcript each child request was made against. */
	function recordingContexts(streamFn: StreamFn, contexts: Context[]): StreamFn {
		return (model, context, options) => {
			contexts.push(context);
			return streamFn(model, context, options);
		};
	}

	/** Answers the first request, then hangs — so a second errand stays in flight. */
	function answerThenHang(text: string): StreamFn {
		const scripted = scriptedStreamFn([{ text }]);
		const hanging = hangingStreamFn();
		let requests = 0;
		return (model, context, options) => {
			requests += 1;
			return requests === 1 ? scripted(model, context, options) : hanging(model, context, options);
		};
	}

	/** The text of every user and assistant block in one recorded request. */
	function said(context: Context): string {
		return context.messages
			.map((message) =>
				typeof message.content === "string"
					? message.content
					: message.content.map((block) => ("text" in block ? block.text : "")).join(" "),
			)
			.join(" | ");
	}

	it("hands a settled child another instruction on the transcript it already has", async () => {
		const contexts: Context[] = [];
		const extension = createSubagentExtension(
			makeHost(recordingContexts(scriptedStreamFn([{ text: "Three notes are stale." }, { text: "Two of them are in Archive/." }]), contexts)),
			{ waitPacing: TEST_PACING },
		);
		const tools = extension.createTools();
		await toolNamed(tools, "spawn_subagent").execute("c1", { task: "Sweep Projects/" }, undefined);
		await toolNamed(tools, "wait_subagent").execute("c2", { subagentId: "subagent-1" }, undefined);

		const followUp = await toolNamed(tools, "follow_up_subagent").execute(
			"c3",
			{ subagentId: "subagent-1", task: "Which of them are in Archive/?" },
			undefined,
		);
		expect(followUp.details).toMatchObject({ subagentId: "subagent-1", resumed: true, status: "running" });
		const collected = await toolNamed(tools, "wait_subagent").execute("c4", { subagentId: "subagent-1" }, undefined);

		// The whole point: the second request carries the first errand and its
		// answer, so the child is not paying to work them out again.
		expect(contexts).toHaveLength(2);
		expect(said(contexts[1]!)).toContain("Sweep Projects/");
		expect(said(contexts[1]!)).toContain("Three notes are stale.");
		expect(said(contexts[1]!)).toContain("Which of them are in Archive/?");
		expect(textBlock(collected)).toContain("Two of them are in Archive/.");
		// One row, one id, and the errand history on the entry.
		expect(extension.registry.all()).toHaveLength(1);
		expect(extension.registry.get("subagent-1")!.followUps).toEqual(["Which of them are in Archive/?"]);
	});

	it("reports this errand's turns to the parent and the child's whole spend to the panel", async () => {
		// The `produced` split: a resumed run's accounting must not re-count the
		// transcript it was seeded with, while the panel's row is the child rather
		// than the run and so has to add the errands up.
		const extension = createSubagentExtension(makeHost(scriptedStreamFn([{ text: "First." }, { text: "Second." }])), {
			waitPacing: TEST_PACING,
		});
		const tools = extension.createTools();
		await toolNamed(tools, "spawn_subagent").execute("c1", { task: "a" }, undefined);
		await toolNamed(tools, "wait_subagent").execute("c2", {}, undefined);
		await toolNamed(tools, "follow_up_subagent").execute("c3", { subagentId: "subagent-1", task: "b" }, undefined);
		const collected = await toolNamed(tools, "wait_subagent").execute("c4", { subagentId: "subagent-1" }, undefined);

		expect(collected.details).toMatchObject({ subagents: [{ subagentId: "subagent-1", turns: 1 }] });
		const snapshot = snapshotSubagents(extension.registry, Date.now())[0]!;
		expect(snapshot.turns).toBe(2);
		expect(snapshot.usage?.requests).toBe(2);
		expect(snapshot.followUps).toEqual(["b"]);
	});

	it("picks a broken run back up rather than starting it over", async () => {
		/*
		 * The case the issue named: a run that died partway — here to a failing tool
		 * rather than a dropped connection, which is the same shape from the child's
		 * side — and is then handed another instruction. What must survive is the
		 * work it had already done, which is the whole saving over a fresh spawn.
		 */
		const contexts: Context[] = [];
		const extension = createSubagentExtension(
			{
				...makeHost(
					recordingContexts(
						scriptedStreamFn([
							{ toolCall: { id: "t1", name: "grep" }, text: "Read 40 notes so far." },
							{ text: "" },
							{ text: "Recovered: 3 stale notes." },
						]),
						contexts,
					),
				),
				createVaultTools: () => [failingTool()],
			},
			{ waitPacing: TEST_PACING },
		);
		const tools = extension.createTools();
		await toolNamed(tools, "spawn_subagent").execute("c1", { task: "Sweep everything" }, undefined);
		await extension.registry.get("subagent-1")!.promise.catch(() => undefined);
		expect(statusOf(extension.registry.get("subagent-1")!)).toBe("failed");

		const resumed = await toolNamed(tools, "follow_up_subagent").execute(
			"c2",
			{ subagentId: "subagent-1", task: "Carry on from where you stopped." },
			undefined,
		);
		expect(resumed.details).toMatchObject({ resumed: true });
		const collected = await toolNamed(tools, "wait_subagent").execute("c3", { subagentId: "subagent-1" }, undefined);

		expect(textBlock(collected)).toContain("Recovered: 3 stale notes.");
		// The dead run's own work came along, and the tool call nothing answered did
		// not — a dangling `tool_use` is what providers reject.
		const resumedRequest = contexts[contexts.length - 1]!;
		expect(said(resumedRequest)).toContain("Read 40 notes so far.");
		expect(said(resumedRequest)).toContain("Carry on from where you stopped.");
	});

	it("refuses a child that is still working, and says what to do first", async () => {
		const extension = createSubagentExtension(makeHost(hangingStreamFn()), { waitPacing: TEST_PACING });
		const tools = extension.createTools();
		try {
			await toolNamed(tools, "spawn_subagent").execute("c1", { task: "a" }, undefined);
			const refused = await toolNamed(tools, "follow_up_subagent").execute("c2", { subagentId: "subagent-1", task: "b" }, undefined);

			expect(refused.details).toMatchObject({ resumed: false, reason: "still-running" });
			expect(textBlock(refused)).toContain("wait_subagent");
			expect(textBlock(refused)).toContain("kill_subagent");
			// Nothing was recorded against the child, so the record still reads as one
			// errand that is still going.
			expect(extension.registry.get("subagent-1")!.followUps).toEqual([]);
		} finally {
			extension.disposeAll();
		}
	});

	it("will not pick up what the user stopped from the panel", async () => {
		/*
		 * The user's kill is the user's circuit breaker (issue #233). A tool that
		 * could undo it would make the breaker advisory — so the parent is told to
		 * spawn something fresh, which leaves the decision where the user put it.
		 */
		const extension = createSubagentExtension(makeHost(hangingStreamFn()), { waitPacing: TEST_PACING });
		const tools = extension.createTools();
		try {
			await toolNamed(tools, "spawn_subagent").execute("c1", { task: "a" }, undefined);
			extension.registry.kill("subagent-1", undefined, "user");
			await extension.registry.get("subagent-1")!.promise.catch(() => undefined);
			const refused = await toolNamed(tools, "follow_up_subagent").execute("c2", { subagentId: "subagent-1", task: "b" }, undefined);

			expect(refused.details).toMatchObject({ resumed: false, reason: "user-stopped" });
			expect(textBlock(refused)).toContain("Spawn a fresh subagent");
			expect(extension.registry.get("subagent-1")!.settled).toBe(true);
		} finally {
			extension.disposeAll();
		}
	});

	it("names every id it knows when the id is wrong, across turns", async () => {
		// Scoped by id rather than by the calling run's signal, so the hint has to
		// be too: a list scoped to this turn would deny children the same call
		// could have re-tasked.
		const extension = createSubagentExtension(makeHost(scriptedStreamFn([{ text: "done" }])), { waitPacing: TEST_PACING });
		const tools = extension.createTools();
		const earlier = new AbortController();
		await toolNamed(tools, "spawn_subagent").execute("c1", { task: "a" }, earlier.signal);
		await extension.registry.get("subagent-1")!.promise;

		const later = new AbortController();
		const missing = await toolNamed(tools, "follow_up_subagent").execute("c2", { subagentId: "subagent-9", task: "b" }, later.signal);

		expect(missing.details).toMatchObject({ resumed: false, reason: "not-found" });
		expect(textBlock(missing)).toContain("subagent-1");
	});

	it("re-tasks a child spawned in an earlier turn, and takes over its wait scope", async () => {
		/*
		 * The ordinary shape of a follow-up is two runs: spawn and collect in one
		 * turn, re-task on what the user said next. Signal scoping — which is how
		 * `kill_subagent` decides ownership — would refuse exactly that, so this is
		 * scoped by id. Ownership moves with the errand: a bare wait in the new turn
		 * covers the work that turn started.
		 */
		const extension = createSubagentExtension(makeHost(scriptedStreamFn([{ text: "First." }, { text: "Second." }])), {
			waitPacing: TEST_PACING,
		});
		const tools = extension.createTools();
		const firstTurn = new AbortController();
		await toolNamed(tools, "spawn_subagent").execute("c1", { task: "a" }, firstTurn.signal);
		await extension.registry.get("subagent-1")!.promise;

		const secondTurn = new AbortController();
		const resumed = await toolNamed(tools, "follow_up_subagent").execute("c2", { subagentId: "subagent-1", task: "b" }, secondTurn.signal);
		expect(resumed.details).toMatchObject({ resumed: true });
		// The bare wait — no id — is the one that reads ownership.
		const collected = await toolNamed(tools, "wait_subagent").execute("c3", {}, secondTurn.signal);

		expect(textBlock(collected)).toContain("Second.");
	});

	it("brings an archived child back into the list when it re-arms it", async () => {
		// Hiding a working child in the panel's closed section is the one thing the
		// panel exists not to do.
		const extension = createSubagentExtension(makeHost(scriptedStreamFn([{ text: "First." }, { text: "Second." }])), {
			waitPacing: TEST_PACING,
		});
		const tools = extension.createTools();
		await toolNamed(tools, "spawn_subagent").execute("c1", { task: "a" }, undefined);
		await extension.registry.get("subagent-1")!.promise;
		expect(extension.registry.archiveSettled()).toBe(1);

		await toolNamed(tools, "follow_up_subagent").execute("c2", { subagentId: "subagent-1", task: "b" }, undefined);

		expect(extension.registry.get("subagent-1")!.archived).toBeUndefined();
		await toolNamed(tools, "wait_subagent").execute("c3", { subagentId: "subagent-1" }, undefined);
	});

	it("times the current errand, not the child's whole life", async () => {
		// A child that answered in three seconds and was re-tasked an hour later did
		// not run for an hour, and the row's one number is what a reader uses to ask
		// "is this stuck?".
		const extension = createSubagentExtension(makeHost(answerThenHang("First.")), { waitPacing: TEST_PACING });
		const tools = extension.createTools();
		try {
			await toolNamed(tools, "spawn_subagent").execute("c1", { task: "a" }, undefined);
			await extension.registry.get("subagent-1")!.promise;
			// Age the child by an hour without ageing the errand it is about to get.
			extension.registry.get("subagent-1")!.spawnedAt -= 3_600_000;

			await toolNamed(tools, "follow_up_subagent").execute("c2", { subagentId: "subagent-1", task: "b" }, undefined);
			const entry = extension.registry.get("subagent-1")!;
			const snapshot = snapshotSubagents(extension.registry, entry.startedAt + 2_000)[0]!;

			expect(entry.startedAt - entry.spawnedAt).toBeGreaterThanOrEqual(3_600_000);
			expect(snapshot.status).toBe("running");
			expect(snapshot.durationMs).toBe(2_000);
		} finally {
			extension.disposeAll();
		}
	});

	it("counts a re-armed child against the width cap like a spawn", async () => {
		// Re-arming makes a child live again, so it has to answer to the same limit
		// — otherwise a parent at the cap could keep going by re-tasking instead of
		// spawning.
		const extension = createSubagentExtension(makeHost(hangingStreamFn()), { waitPacing: TEST_PACING });
		const tools = extension.createTools();
		const spawn = toolNamed(tools, "spawn_subagent");
		try {
			for (let i = 0; i < SUBAGENT_CONCURRENCY_LIMIT; i++) {
				await spawn.execute(`c${i}`, { task: `task ${i}` }, undefined);
			}
			// Settle one and replace it, so the cap is full again while a settled
			// child sits there waiting to be re-tasked.
			extension.registry.kill("subagent-1", undefined);
			await extension.registry.get("subagent-1")!.promise.catch(() => undefined);
			await spawn.execute("replacement", { task: "one more" }, undefined);

			const refused = await toolNamed(tools, "follow_up_subagent").execute("f1", { subagentId: "subagent-1", task: "again" }, undefined);

			expect(refused.details).toMatchObject({ resumed: false, reason: "at-capacity" });
			expect(textBlock(refused)).toContain(`limit (${SUBAGENT_CONCURRENCY_LIMIT})`);
		} finally {
			extension.disposeAll();
		}
	});
});

describe("archiving from the panel", () => {
	function makeHost(streamFn: StreamFn): SubagentHost {
		return {
			createVaultTools: () => [],
			getModel: () => MODEL,
			getStreamFn: () => streamFn,
			getThinkingLevel: () => "off" as never,
			getSkills: () => [],
		};
	}

	it("puts finished runs away, leaves live ones alone, and says how many moved", async () => {
		const extension = createSubagentExtension(makeHost(hangingStreamFn()), { waitPacing: TEST_PACING });
		const tools = extension.createTools();
		const controller = new AbortController();
		const events: string[] = [];
		try {
			await toolNamed(tools, "spawn_subagent").execute("c1", { task: "one" }, controller.signal);
			await toolNamed(tools, "spawn_subagent").execute("c2", { task: "two" }, controller.signal);
			// Settle the first deterministically, then tidy: the second is still
			// hanging, which is the case the sweep must not touch.
			extension.registry.kill("subagent-1", controller.signal);
			await extension.registry.get("subagent-1")!.promise.catch(() => undefined);
			const unsubscribe = extension.registry.subscribe(() => events.push("change"));

			expect(extension.registry.archiveSettled()).toBe(1);
			expect(extension.registry.get("subagent-1")!.archived).toBe(true);
			expect(extension.registry.get("subagent-2")!.archived).toBeUndefined();
			// The panel renders from snapshots and never polls, so a sweep that
			// emitted nothing would leave the list showing what it had just moved.
			expect(events).toEqual(["change"]);
			// Nothing left to move, so pressing it again is not a second change.
			expect(extension.registry.archiveSettled()).toBe(0);
			expect(events).toEqual(["change"]);
			unsubscribe();
		} finally {
			extension.disposeAll();
		}
	});

	it("is invisible to the parent's own tools", async () => {
		// The rule archiving lives by: it is the reader tidying the reader's view.
		// A run the reader has put away is still one the parent can enumerate and
		// collect, because otherwise a panel control could destroy a report nobody
		// had read yet.
		const extension = createSubagentExtension(makeHost(scriptedStreamFn([{ text: "The vault is clean." }])), {
			waitPacing: TEST_PACING,
		});
		const tools = extension.createTools();
		await toolNamed(tools, "spawn_subagent").execute("c1", { task: "Sweep" }, undefined);
		await extension.registry.get("subagent-1")!.promise;

		expect(extension.registry.archiveSettled()).toBe(1);
		const listed = await toolNamed(tools, "list_subagents").execute("c2", {}, undefined);
		const collected = await toolNamed(tools, "wait_subagent").execute("c3", { subagentId: "subagent-1" }, undefined);

		expect(textBlock(listed)).toContain("subagent-1");
		expect(textBlock(collected)).toContain("The vault is clean.");
	});
});

describe("inspector data", () => {
	function makeHost(streamFn: StreamFn): SubagentHost {
		return {
			createVaultTools: () => [],
			getModel: () => MODEL,
			getStreamFn: () => streamFn,
			getThinkingLevel: () => "off" as never,
			getSkills: () => [],
		};
	}

	it("the run result carries the child's transcript for the inspector", async () => {
		const result = await runSubagent({
			task: "Sweep the vault",
			role: findSubagentRole("general")!,
			tools: [recordingTool("grep", [])],
			model: MODEL,
			streamFn: scriptedStreamFn([
				{ toolCall: { id: "call_1", name: "grep" } },
				{ text: "Found it." },
			]),
			thinkingLevel: "off" as never,
		});
		// The process record is the point: user prompt, the tool-call turn, and
		// the report turn, all readable after settlement.
		expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
	});

	it("the registry records spawn metadata and exposes change events", async () => {
		const extension = createSubagentExtension(makeHost(hangingStreamFn()));
		const events: string[] = [];
		const unsubscribe = extension.registry.subscribe(() => events.push("change"));
		const controller = new AbortController();
		try {
			await toolNamed(extension.createTools(), "spawn_subagent").execute(
				"c1",
				{ task: "Sweep", role: "scout", instructions: "Be brief." },
				controller.signal,
			);
			const entry = extension.registry.get("subagent-1");
			// The resolved spec, not its names: this is what a later errand would have
			// to run as, so the record keeps the role and the model themselves.
			expect(entry?.task).toBe("Sweep");
			expect(entry?.instructions).toBe("Be brief.");
			expect(entry?.role.name).toBe("scout");
			expect(entry?.model.id).toBe("test-model");
			expect(entry?.thinkingLevel).toBe("off");
			expect(entry?.depth).toBe(1);
			expect(entry?.followUps).toEqual([]);
			expect(entry?.spent).toEqual({ turns: 0, usage: { tokens: 0, cost: 0, requests: 0 } });
			expect(entry?.spawnedAt).toBeGreaterThan(0);
			expect(entry?.startedAt).toBe(entry!.spawnedAt);
			expect(entry?.settledAt).toBeUndefined();
			// One event so far: the spawn. Nothing settles while the child hangs.
			expect(events).toEqual(["change"]);

			unsubscribe();
			controller.abort();
			await entry?.promise.catch(() => undefined);
			// Unsubscribed, so no further events reach the listener even though
			// the settle fired.
			expect(events).toEqual(["change"]);
			// Not strictly greater: a spawn aborted in the same millisecond settles at
			// its own spawn time, and asserting a gap would fail on a fast machine
			// while testing the clock rather than the bookkeeping.
			expect(entry?.settledAt).toBeGreaterThanOrEqual(entry!.spawnedAt);
		} finally {
			extension.disposeAll();
		}
	});

	it("snapshots copy entries without exposing the live handles", async () => {
		const extension = createSubagentExtension(makeHost(scriptedStreamFn([{ text: "The report." }])));
		try {
			await toolNamed(extension.createTools(), "spawn_subagent").execute("c1", { task: "Sweep" }, undefined);
			await toolNamed(extension.createTools(), "wait_subagent").execute("c2", {}, undefined);
			const now = Date.now();
			const snapshots = snapshotSubagents(extension.registry, now);
			expect(snapshots).toHaveLength(1);
			const snapshot = snapshots[0]!;
			expect(snapshot).toMatchObject({
				id: "subagent-1",
				task: "Sweep",
				depth: 1,
				status: "done",
				report: "The report.",
				turns: 1,
			});
			expect(snapshot.durationMs).toBe((snapshot.settledAt ?? 0) - snapshot.spawnedAt);
			// A settled snapshot carries the transcript; a plain copy, not the entry.
			expect(snapshot.messages.length).toBeGreaterThan(0);
			expect(snapshot).not.toHaveProperty("abort");
			expect(snapshot).not.toHaveProperty("promise");
			expect(snapshot).not.toHaveProperty("start");
		} finally {
			extension.disposeAll();
		}
	});

	it("a running child's duration anchors on the caller's clock", async () => {
		const extension = createSubagentExtension(makeHost(hangingStreamFn()));
		const controller = new AbortController();
		try {
			await toolNamed(extension.createTools(), "spawn_subagent").execute("c1", { task: "Sweep" }, controller.signal);
			const snapshots = snapshotSubagents(extension.registry, Date.now() + 5_000);
			expect(snapshots[0]!.status).toBe("running");
			// `now` is the anchor, not `settledAt`, which is still unset — this is
			// what makes a rendered "elapsed" deterministic in a test.
			expect(snapshots[0]!.durationMs).toBeGreaterThanOrEqual(5_000);
			expect(anyRunning(snapshots)).toBe(true);
		} finally {
			controller.abort();
			extension.disposeAll();
		}
	});

	it("a failed child keeps the transcript it died holding, not only its error", async () => {
		// The whole point of {@link SubagentRunError}: a run that broke partway
		// still learned something, and both readers of the record need it — the
		// panel, which would otherwise word a real run as "nothing recorded", and
		// a follow-up errand, which resumes from exactly this.
		const extension = createSubagentExtension(
			{
				...makeHost(scriptedStreamFn([{ toolCall: { id: "t1", name: "grep" } }, { text: "" }])),
				createVaultTools: () => [failingTool()],
			},
			{ waitPacing: TEST_PACING },
		);
		try {
			await toolNamed(extension.createTools(), "spawn_subagent").execute("c1", { task: "a" }, undefined);
			await new Promise((resolve) => setTimeout(resolve, 60));
			const snapshots = snapshotSubagents(extension.registry, Date.now());
			expect(snapshots[0]!.status).toBe("failed");
			expect(snapshots[0]!.errorMessage).toContain("vault exploded");
			expect(snapshots[0]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
			expect(anyRunning(snapshots)).toBe(false);
		} finally {
			extension.disposeAll();
		}
	});
});

describe("subagent ownership across conversations", () => {
	/**
	 * The same host as the suite above, plus the one getter that names the
	 * conversation acting right now — which the test moves between calls, the way
	 * a user switching chats moves it in the plugin.
	 */
	function makeOwnedHost(streamFn: StreamFn, owner: () => string): SubagentHost {
		return {
			createVaultTools: () => [],
			getModel: () => MODEL,
			getStreamFn: () => streamFn,
			getThinkingLevel: () => "off" as never,
			getSkills: () => [],
			getOwnerId: owner,
		};
	}

	it("hides one conversation's children from another, by listing and by id", async () => {
		let owner = "chat-a";
		const extension = createSubagentExtension(makeOwnedHost(hangingStreamFn(), () => owner), { waitPacing: TEST_PACING });
		const tools = extension.createTools();
		try {
			await toolNamed(tools, "spawn_subagent").execute("call_1", { task: "Sweep A" }, undefined);

			// B's own run: a fresh signal, so the run-scoped lookup finds nothing and
			// the fallback — the thing that used to reach across every chat — decides
			// what B is told.
			owner = "chat-b";
			const bRun = new AbortController().signal;
			const listed = await toolNamed(tools, "list_subagents").execute("call_2", {}, bRun);
			expect(textBlock(listed)).toBe("No subagents have been spawned.");
			expect(textBlock(listed)).not.toContain("subagent-1");

			// Ids are process-wide and sequential, so refusing to name it is only
			// half the fence; the other half is refusing to hand it over on a guess.
			expect(toolNamed(tools, "wait_subagent").execute("call_3", { subagentId: "subagent-1" }, bRun)).rejects.toThrow(
				"Unknown subagent id: subagent-1",
			);

			// Nothing was taken away from the chat that owns it: an earlier turn's
			// child is still nameable and still collectable there.
			owner = "chat-a";
			const aRun = new AbortController().signal;
			const own = await toolNamed(tools, "list_subagents").execute("call_4", {}, aRun);
			expect(textBlock(own)).toContain("subagent-1");
		} finally {
			extension.disposeAll();
		}
	});

	it("files a grandchild under the conversation that started the tree", async () => {
		let owner = "chat-a";
		// One stream closure per level: a fresh one per request would reset its
		// script counter and replay step one forever.
		const parentStream = scriptedStreamFn([{ text: "unused" }]);
		const childStream = scriptedStreamFn([
			{ toolCall: { id: "deep_1", name: "spawn_subagent", arguments: { task: "Deeper" } } },
			{ text: "Child done." },
		]);
		const grandchildStream = scriptedStreamFn([{ text: "Floor done." }]);
		const streamFn: StreamFn = (model, context, options) => {
			const isDelegated = context.systemPrompt?.includes("delegated task") ?? false;
			if (!isDelegated) {
				return parentStream(model, context, options);
			}
			// A level that still has spawn is the child; the one that lost it to the
			// depth cap is the grandchild.
			if ((context.tools ?? []).some((tool) => tool.name === "spawn_subagent")) {
				// The switch lands inside the child's own request, so by the time its
				// spawn executes the host would answer "chat-b" — and nobody may ask it.
				owner = "chat-b";
				return childStream(model, context, options);
			}
			return grandchildStream(model, context, options);
		};
		const extension = createSubagentExtension(makeOwnedHost(streamFn, () => owner), { waitPacing: TEST_PACING });
		try {
			await toolNamed(extension.createTools(), "spawn_subagent").execute("call_1", { task: "Sweep A" }, undefined);
			// The grandchild's spawn is two async hops away (the child's request, then
			// its tool call), so the tree is polled into place — bounded, so a tree
			// that never grows fails the assertion instead of hanging the suite.
			for (let attempt = 0; attempt < 300 && extension.registry.all().length < 2; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 2));
			}

			expect(extension.registry.all()).toHaveLength(2);
			expect(extension.registry.forOwner("chat-a").map((entry) => entry.depth)).toEqual([1, 2]);
			expect(extension.registry.forOwner("chat-b")).toEqual([]);
		} finally {
			extension.disposeAll();
		}
	});
});
