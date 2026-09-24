import { describe, expect, it } from "bun:test";
import {
	runWorkflow,
	workflowConcurrency,
	type WorkflowHost,
	type WorkflowSpawnRequest,
	type WorkflowSpawnResult,
} from "./runtime";
import type { WorkflowJournalEntry } from "./journal";

/**
 * bun implements the Web Worker API (blob-URL workers, self/postMessage), the
 * same surface the WebView gives — so these run the REAL worker source and the
 * REAL runtime, only the child spawns are stubbed. That is the whole engine
 * under test end to end, not a mock of it.
 */

const HEAD = 'export const meta = { name: "t", description: "d" };\n';

interface Stub {
	host: WorkflowHost;
	calls: WorkflowSpawnRequest[];
	aborted: string[];
}

function stubHost(reply?: (r: WorkflowSpawnRequest) => WorkflowSpawnResult | Promise<WorkflowSpawnResult>): Stub {
	const calls: WorkflowSpawnRequest[] = [];
	const aborted: string[] = [];
	return {
		calls,
		aborted,
		host: {
			async spawnAgent(request) {
				calls.push(request);
				return reply ? await reply(request) : { ok: true, text: `ok:${request.prompt}`, outputTokens: 10 };
			},
			abortAgent(id) {
				aborted.push(id);
			},
		},
	};
}

describe("workflowConcurrency", () => {
	it("never returns zero, even on a one-core device", () => {
		expect(workflowConcurrency(1)).toBe(1);
		expect(workflowConcurrency(2)).toBe(1);
		expect(workflowConcurrency(8)).toBe(6);
		expect(workflowConcurrency(64)).toBe(16);
	});
});

describe("runWorkflow — real worker, stubbed spawns", () => {
	it("runs a linear script and returns its value", async () => {
		const stub = stubHost();
		const result = await runWorkflow({
			script: `${HEAD}const a = await agent("one"); return { a };`,
			host: stub.host,
		});
		expect(result.status).toBe("completed");
		expect(result.value).toEqual({ a: "ok:one" });
		expect(stub.calls).toHaveLength(1);
	});

	it("fans out with parallel and keeps order", async () => {
		const stub = stubHost();
		const result = await runWorkflow({
			script: `${HEAD}return await parallel([() => agent("a"), () => agent("b"), () => agent("c")]);`,
			host: stub.host,
		});
		expect(result.value).toEqual(["ok:a", "ok:b", "ok:c"]);
		expect(result.agentCount).toBe(3);
	});

	it("pipelines each item through stages", async () => {
		const stub = stubHost((r) => ({ ok: true, text: `${r.prompt}!` }));
		const result = await runWorkflow({
			script: `${HEAD}return await pipeline([1, 2], (n) => agent("s1:" + n), (prev) => agent("s2:" + prev));`,
			host: stub.host,
		});
		expect(result.value).toEqual(["s2:s1:1!!", "s2:s1:2!!"]);
	});

	it("returns null to the script for a failed agent, not a throw", async () => {
		const stub = stubHost((r) => (r.prompt === "bad" ? { ok: false, error: "boom" } : { ok: true, text: "fine" }));
		const result = await runWorkflow({
			script: `${HEAD}const bad = await agent("bad"); const ok = await agent("ok"); return { badIsNull: bad === null, ok };`,
			host: stub.host,
		});
		expect(result.value).toEqual({ badIsNull: true, ok: "fine" });
	});

	it("validates a schema'd answer and rejects a mismatch", async () => {
		const schema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };
		const good = stubHost(() => ({ ok: true, text: JSON.stringify({ n: 42 }) }));
		const goodRun = await runWorkflow({
			script: `${HEAD}const r = await agent("x", { schema: ${JSON.stringify(schema)} }); return r;`,
			host: good.host,
		});
		expect(goodRun.value).toEqual({ n: 42 });

		const bad = stubHost(() => ({ ok: true, text: JSON.stringify({ n: "not a number" }) }));
		const badRun = await runWorkflow({
			script: `${HEAD}const r = await agent("x", { schema: ${JSON.stringify(schema)} }); return { isNull: r === null };`,
			host: bad.host,
		});
		expect(badRun.value).toEqual({ isNull: true });
	});

	it("blocks the clock so replay stays deterministic", async () => {
		const result = await runWorkflow({
			script: `${HEAD}let threw = false; try { Date.now(); } catch { threw = true; } return { threw };`,
			host: stubHost().host,
		});
		expect(result.value).toEqual({ threw: true });
	});

	it("rejects an unsupported agent option (isolation) at the call", async () => {
		const result = await runWorkflow({
			script: `${HEAD}return await agent("x", { isolation: "worktree" });`,
			host: stubHost().host,
		});
		// The worker throws inside the script; the run fails rather than returning.
		expect(result.status).toBe("failed");
		expect(result.error).toContain("isolation");
	});

	it("replays the unchanged prefix from a journal and runs only the new tail", async () => {
		const entries: WorkflowJournalEntry[] = [];
		const first = stubHost();
		const firstRun = await runWorkflow({
			script: `${HEAD}const a = await agent("one"); const b = await agent("two"); return { a, b };`,
			host: first.host,
			journal: { append: (e) => entries.push(e) },
		});
		expect(firstRun.value).toEqual({ a: "ok:one", b: "ok:two" });
		expect(first.calls).toHaveLength(2);

		// Re-run with a third agent appended; the first two replay, only "three" spawns.
		const second = stubHost();
		const secondRun = await runWorkflow({
			script: `${HEAD}const a = await agent("one"); const b = await agent("two"); const c = await agent("three"); return { a, b, c };`,
			host: second.host,
			journal: { entries, append: () => {} },
		});
		expect(secondRun.value).toEqual({ a: "ok:one", b: "ok:two", c: "ok:three" });
		expect(secondRun.replayedCount).toBe(2);
		expect(second.calls).toHaveLength(1);
		expect(second.calls[0]?.prompt).toBe("three");
	});

	it("enforces the agent cap fatally", async () => {
		const result = await runWorkflow({
			script: `${HEAD}await agent("a"); await agent("b"); await agent("c"); return "done";`,
			host: stubHost().host,
			agentCap: 2,
		});
		expect(result.status).toBe("failed");
		expect(result.error).toContain("cap of 2");
	});

	it("mirrors output tokens into budget.spent()", async () => {
		const result = await runWorkflow({
			script: `${HEAD}await agent("a"); await agent("b"); return budget.spent();`,
			host: stubHost().host,
		});
		expect(result.value).toBe(20);
	});

	it("fails a script that drops an unawaited launch", async () => {
		// A launch is only "unawaited" if it is still open when the script returns.
		// An instant stub resolves it first, so this needs a slow child.
		const slow = stubHost(() => new Promise<WorkflowSpawnResult>(() => {}));
		const result = await runWorkflow({
			script: `${HEAD}agent("dropped"); return "done";`,
			host: slow.host,
		});
		expect(result.status).toBe("failed");
		expect(result.error).toContain("unawaited");
	});

	it("aborts in-flight children when the run signal fires", async () => {
		const stub = stubHost(
			() => new Promise<WorkflowSpawnResult>(() => {}), // never resolves
		);
		const controller = new AbortController();
		const runPromise = runWorkflow({
			script: `${HEAD}return await parallel([() => agent("a"), () => agent("b")]);`,
			host: stub.host,
			signal: controller.signal,
		});
		await new Promise((r) => setTimeout(r, 100));
		controller.abort();
		const result = await runPromise;
		expect(result.status).toBe("killed");
		expect(stub.aborted.length).toBeGreaterThan(0);
	});
});
