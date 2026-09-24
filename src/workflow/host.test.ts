import { describe, expect, it } from "bun:test";
import { createWorkflowHost, type WorkflowChildOutcome, type WorkflowChildRunner } from "./host";
import type { WorkflowSpawnRequest } from "./runtime";

const request = (over: Partial<WorkflowSpawnRequest> = {}): WorkflowSpawnRequest => ({
	agentId: "wf-agent-0",
	index: 0,
	prompt: "do it",
	label: "do it",
	agentType: "general",
	...over,
});

describe("createWorkflowHost", () => {
	it("maps a successful outcome and reports the effective model", async () => {
		const runner: WorkflowChildRunner = {
			spawn: async () => ({
				ok: true,
				text: "answer",
				recordId: "rec-1",
				modelName: "haiku 4.5",
				modelId: "anthropic/claude-haiku-4-5",
				thinking: "medium",
				outputTokens: 33,
				tokens: 120,
			}),
		};
		const host = createWorkflowHost(runner);
		const resolved: unknown[] = [];
		const result = await host.spawnAgent(request({ onResolved: (info) => resolved.push(info) }));
		expect(result).toEqual({ ok: true, text: "answer", outputTokens: 33, tokens: 120 });
		expect(resolved[0]).toMatchObject({ recordId: "rec-1", modelName: "haiku 4.5", thinking: "medium" });
	});

	it("maps a failure to ok:false", async () => {
		const host = createWorkflowHost({ spawn: async () => ({ ok: false, error: "nope" }) });
		expect(await host.spawnAgent(request())).toEqual({ ok: false, error: "nope" });
	});

	it("catches a thrown runner and does not reject", async () => {
		const host = createWorkflowHost({
			spawn: async () => {
				throw new Error("kaboom");
			},
		});
		expect(await host.spawnAgent(request())).toEqual({ ok: false, error: "kaboom" });
	});

	it("routes abortAgent to the running child's signal", async () => {
		let seenAborted = false;
		const runner: WorkflowChildRunner = {
			spawn: (_req, signal) =>
				new Promise<WorkflowChildOutcome>((resolve) => {
					signal.addEventListener("abort", () => {
						seenAborted = true;
						resolve({ ok: false, error: "aborted" });
					});
				}),
		};
		const host = createWorkflowHost(runner);
		const pending = host.spawnAgent(request({ agentId: "wf-agent-7" }));
		await new Promise((r) => setTimeout(r, 10));
		host.abortAgent("wf-agent-7");
		await pending;
		expect(seenAborted).toBe(true);
	});

	it("exposes resumeAgent only when the runner can resume, and maps agentId→recordId", async () => {
		const resumed: string[] = [];
		const runner: WorkflowChildRunner = {
			spawn: async () => ({ ok: true, text: "first", recordId: "rec-9" }),
			resume: async (recordId, prompt) => {
				resumed.push(`${recordId}:${prompt}`);
				return { ok: true, text: "second", recordId: "rec-9" };
			},
		};
		const host = createWorkflowHost(runner);
		expect(typeof host.resumeAgent).toBe("function");
		await host.spawnAgent(request({ agentId: "wf-agent-3" }));
		const result = await host.resumeAgent?.("wf-agent-3", "again");
		expect(result).toMatchObject({ ok: true, text: "second" });
		expect(resumed).toEqual(["rec-9:again"]);
	});

	it("omits resumeAgent when the runner cannot resume", () => {
		const host = createWorkflowHost({ spawn: async () => ({ ok: true, text: "x" }) });
		expect(host.resumeAgent).toBeUndefined();
	});
});
