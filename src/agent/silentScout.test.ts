import { describe, expect, it } from "bun:test";
import { SilentScout } from "./silentScout";
import type { App, TFile } from "obsidian";
import { stubWindowTimers } from "../testUtils/windowStub";

stubWindowTimers();

describe("SilentScout", () => {
	it("inspectNoteLocal collects promises and broken links", () => {
		const mockFile = { path: "Projects/AI.md", basename: "AI" } as TFile;
		const mockApp = {
			metadataCache: { unresolvedLinks: {} },
			vault: { getMarkdownFiles: () => [] },
		} as unknown as App;

		const scout = new SilentScout(mockApp);
		const content = `# AI Roadmap\n\n待验证：本地小模型在移动端的量化损失。\n`;
		const insight = scout.inspectNoteLocal(mockFile, content, ["ai"]);

		expect(insight.notePath).toBe("Projects/AI.md");
		expect(insight.unresolvedPromises).toEqual(["本地小模型在移动端的量化损失。"]);
		expect(scout.getInsight("Projects/AI.md")).toBe(insight);
	});

	it("scheduleBackgroundPrefetch executes and stores stagedAction", async () => {
		const mockFile = { path: "Projects/AI.md", basename: "AI" } as TFile;
		const mockApp = {
			metadataCache: { unresolvedLinks: {} },
			vault: { getMarkdownFiles: () => [] },
		} as unknown as App;

		const mockRunner = async () =>
			JSON.stringify({
				label: "量化实测",
				prompt: "请评估 Q4_K_M 量化方案在移动设备上的吞吐量与内存占用。",
				summary: "评估模型量化损失",
			});

		const scout = new SilentScout(mockApp, mockRunner);
		const content = `# AI Roadmap\n\n待验证：本地小模型在移动端的量化损失，需要设计针对性评测集。\n`;

		let notified = false;
		scout.scheduleBackgroundPrefetch(
			mockFile,
			content,
			(insight) => {
				notified = true;
				expect(insight.stagedAction?.label).toBe("量化实测");
			},
			10,
		);

		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(notified).toBe(true);

		const insight = scout.getInsight("Projects/AI.md");
		expect(insight?.stagedAction?.label).toBe("量化实测");
		expect(insight?.stagedAction?.prompt).toContain("量化方案");

		scout.dispose();
	});
});
