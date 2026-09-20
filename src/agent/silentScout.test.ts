import { describe, expect, it } from "bun:test";
import { SilentScout, hashContent, type ScoutInsight } from "./silentScout";
import type { ScoutPerceptionRequest } from "./scoutPerception";
import type { App, TFile } from "obsidian";
import { stubWindowTimers } from "../testUtils/windowStub";

stubWindowTimers();

const FILE = { path: "Projects/AI.md", basename: "AI" } as TFile;
const CONTENT = "# AI Roadmap\n\n待验证：本地小模型在移动端的量化损失，需要设计针对性评测集。\n";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const mockApp = {
	metadataCache: { unresolvedLinks: {} },
	vault: { getMarkdownFiles: () => [] },
} as unknown as App;

/** Timing that reaches the model within one tick and lets a cooldown expire inside a test. */
const FAST = { debounceMs: 5, cooldownMs: 25 };

function finding(label: string): { label: string; prompt: string } {
	return { label, prompt: `处理：${label}` };
}

describe("SilentScout", () => {
	it("inspectNoteLocal collects promises and broken links", () => {
		const scout = new SilentScout(mockApp);
		const insight = scout.inspectNoteLocal(FILE, CONTENT, ["ai"]);

		expect(insight.notePath).toBe("Projects/AI.md");
		expect(insight.unresolvedPromises).toEqual(["本地小模型在移动端的量化损失，需要设计针对性评测集。"]);
		expect(insight.contentHash).toBe(hashContent(CONTENT));
		expect(insight.findings).toEqual([]);
		expect(scout.getInsight("Projects/AI.md")).toBe(insight);
	});

	it("observe stages a perception and surfaces its findings", async () => {
		const requests: ScoutPerceptionRequest[] = [];
		const scout = new SilentScout(mockApp, async (request) => {
			requests.push(request);
			return [finding("2 处矛盾"), finding("缺 Frontmatter")];
		});

		let staged: ScoutInsight | undefined;
		const changed = scout.observe(FILE, CONTENT, ["ai"], (insight) => {
			staged = insight;
		}, FAST);

		expect(changed).toBe(true);
		await sleep(30);

		expect(requests).toHaveLength(1);
		// The local audit rides along: the model is not asked to rediscover promises.
		expect(requests[0]?.unresolvedPromises).toEqual(["本地小模型在移动端的量化损失，需要设计针对性评测集。"]);
		expect(requests[0]?.tags).toEqual(["ai"]);
		expect(staged?.findings.map((entry) => entry.label)).toEqual(["2 处矛盾", "缺 Frontmatter"]);
	});

	it("does not perceive text the last perception already saw", async () => {
		let calls = 0;
		const scout = new SilentScout(mockApp, async () => {
			calls += 1;
			return [finding("重复")];
		});

		scout.observe(FILE, CONTENT, [], undefined, FAST);
		await sleep(30);
		expect(calls).toBe(1);

		// Re-focusing the same note is the common case for `active-leaf-change`.
		const changed = scout.observe(FILE, CONTENT, [], undefined, FAST);
		expect(changed).toBe(false);
		await sleep(30);
		expect(calls).toBe(1);
	});

	it("holds a rewritten note until the cooldown has passed", async () => {
		let calls = 0;
		const scout = new SilentScout(mockApp, async () => {
			calls += 1;
			return [finding("改写后")];
		});
		// Long enough that the middle assertion is still inside the window, short
		// enough that the last one is past it.
		const timing = { debounceMs: 5, cooldownMs: 200 };

		scout.observe(FILE, CONTENT, [], undefined, timing);
		await sleep(40);
		expect(calls).toBe(1);

		// The text moved, so the facts refresh — but the rate limit holds the spend.
		const changed = scout.observe(FILE, `${CONTENT}\n第二段。`, [], undefined, timing);
		expect(changed).toBe(true);
		await sleep(40);
		expect(calls).toBe(1);

		await sleep(200);
		scout.observe(FILE, `${CONTENT}\n第二段。`, [], undefined, timing);
		await sleep(40);
		expect(calls).toBe(2);
	});

	it("retries after a failed perception, because a failure pins nothing", async () => {
		let calls = 0;
		const scout = new SilentScout(mockApp, async () => {
			calls += 1;
			return calls === 1 ? null : [finding("第二次才成功")];
		});

		scout.observe(FILE, CONTENT, [], undefined, FAST);
		await sleep(30);
		expect(calls).toBe(1);
		expect(scout.getInsight(FILE.path)?.findings).toEqual([]);

		await sleep(30);
		scout.observe(FILE, CONTENT, [], undefined, FAST);
		await sleep(30);
		expect(calls).toBe(2);
		expect(scout.getInsight(FILE.path)?.findings.map((entry) => entry.label)).toEqual(["第二次才成功"]);
	});

	it("drops a perception whose note changed while the model was thinking", async () => {
		let release: (value: { label: string; prompt: string }[]) => void = () => {};
		const pending = new Promise<{ label: string; prompt: string }[]>((resolve) => {
			release = resolve;
		});
		const scout = new SilentScout(mockApp, () => pending);

		scout.observe(FILE, CONTENT, [], undefined, { debounceMs: 5, cooldownMs: 60_000 });
		await sleep(20);

		// The user keeps writing while the request is in flight, then it answers.
		scout.observe(FILE, `${CONTENT}\n改过了。`, [], undefined, { debounceMs: 60_000, cooldownMs: 60_000 });
		release([finding("过时的发现")]);
		await sleep(30);

		expect(scout.getInsight(FILE.path)?.findings).toEqual([]);
		expect(scout.getInsight(FILE.path)?.contentHash).toBe(hashContent(`${CONTENT}\n改过了。`));
	});

	it("keeps the perception out of the note when no model is configured", async () => {
		const scout = new SilentScout(mockApp);
		const changed = scout.observe(FILE, CONTENT, [], undefined, FAST);

		expect(changed).toBe(true);
		await sleep(30);
		expect(scout.getInsight(FILE.path)?.findings).toEqual([]);
	});

	it("dispose aborts the pending run and forgets the notes", async () => {
		let aborted = false;
		const scout = new SilentScout(mockApp, async (_request, signal) => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			aborted = signal.aborted;
			return [finding("不该落地")];
		});

		scout.observe(FILE, CONTENT, [], undefined, FAST);
		await sleep(10);
		scout.dispose();
		await sleep(30);

		expect(aborted).toBe(true);
		expect(scout.getInsight(FILE.path)).toBeUndefined();
	});
});