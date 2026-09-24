import { describe, expect, it } from "bun:test";
import { createWorkflowTool, createMemoryJournalStore } from "./workflowTool";
import type { WorkflowHost } from "./runtime";

const HEAD = 'export const meta = { name: "t", description: "d" };\n';

/** A host that echoes prompts, so a run produces a checkable result and journal. */
const echoHost: WorkflowHost = {
	async spawnAgent(request) {
		return { ok: true, text: `ok:${request.prompt}`, outputTokens: 5 };
	},
	abortAgent() {},
};

async function runScript(script: string, over: { resumeFromRunId?: string; store?: ReturnType<typeof createMemoryJournalStore>; ids?: string[] } = {}) {
	const ids = over.ids ?? ["run-1", "run-2", "run-3"];
	let n = 0;
	const tool = createWorkflowTool({
		host: echoHost,
		store: over.store ?? createMemoryJournalStore(),
		newRunId: () => ids[n++] ?? `run-${n}`,
	});
	const params: Record<string, unknown> = { script };
	if (over.resumeFromRunId !== undefined) params.resumeFromRunId = over.resumeFromRunId;
	const result = await tool.execute?.("call-id", params, new AbortController().signal);
	return result;
}

describe("run_workflow tool", () => {
	it("runs a script and returns a summary plus structured details", async () => {
		const result = await runScript(`${HEAD}const a = await agent("one"); return { a };`);
		expect(result?.details?.status).toBe("completed");
		expect(result?.details?.runId).toBe("run-1");
		expect(result?.details?.value).toEqual({ a: "ok:one" });
		const text = result?.content?.[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain('Workflow "t" completed');
		expect(text).toContain("run-1");
	});

	it("keeps a journal per run id so a later call can resume it", async () => {
		const store = createMemoryJournalStore();
		await runScript(`${HEAD}const a = await agent("one"); return { a };`, { store, ids: ["r1"] });
		// r1's journal now holds agent 0. A resume that re-runs the same prefix
		// and appends one more should replay the first and only spawn the second.
		const second = await runScript(
			`${HEAD}const a = await agent("one"); const b = await agent("two"); return { a, b };`,
			{ store, resumeFromRunId: "r1", ids: ["r2"] },
		);
		expect(second?.details?.value).toEqual({ a: "ok:one", b: "ok:two" });
		expect(second?.details?.replayedCount).toBe(1);
	});

	it("reports a clear message when the resume id is unknown", async () => {
		const result = await runScript(`${HEAD}return "x";`, { resumeFromRunId: "nope", ids: ["r1"] });
		expect(result?.details?.resumed).toBe(false);
		const text = result?.content?.[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("No workflow journal");
	});
});
