import { describe, expect, it } from "bun:test";
import { DEFAULT_MAX_BYTES, type AgentTool } from "@earendil-works/pi-agent-core";
import { createReadSkillTool } from "./skillTools";

describe("read_skill", () => {
	const skill = {
		name: "summarize",
		description: "Summarize a note",
		content: "Read the active note, then summarize it.",
		filePath: "/Piem/builtin-skills/summarize/SKILL.md",
	};

	it("returns the complete loaded content from the loaded file snapshot", async () => {
		const result = await createReadSkillTool(() => [skill]).execute("call-1", { name: "summarize" });

		const content = result.content[0];
		expect(content?.type).toBe("text");
		expect(content?.type === "text" ? content.text : undefined).toBe(skill.content);
		expect(result.details).toMatchObject({ name: "summarize", filePath: skill.filePath, offset: 0, endOffset: new TextEncoder().encode(skill.content).byteLength });
	});

	it("rejects a name that is not in the current loaded set", async () => {
		expect(createReadSkillTool(() => [skill]).execute("call-1", { name: "missing" })).rejects.toThrow("Unknown skill: missing");
	});

	it("can read a long single-line Unicode skill to the end without losing characters", async () => {
		const content = `${"老奶奶🦑".repeat(8_000)}END_OF_SKILL`;
		const tool: AgentTool = createReadSkillTool(() => [{ ...skill, content }]);
		let offset = 0;
		let snapshot: unknown;
		let rebuilt = "";
		for (let page = 0; page < 10; page++) {
			const result = await tool.execute("page", { name: skill.name, offset, snapshot });
			const details = result.details as { offset: number; endOffset: number; nextOffset?: number; snapshot: string };
			expect(details.offset).toBe(offset);
			expect(details.endOffset).toBeGreaterThan(offset);
			const text = result.content[0];
			expect(text?.type).toBe("text");
			if (text?.type !== "text") throw new Error("Expected text page");
			const data = new TextEncoder().encode(text.text).slice(0, details.endOffset - offset);
			expect(data.byteLength).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
			rebuilt += new TextDecoder("utf-8", { fatal: true }).decode(data);
			if (details.nextOffset === undefined) break;
			expect(text.text).toContain(`offset=${details.nextOffset}`);
			snapshot = details.snapshot;
			offset = details.nextOffset;
		}
		expect(rebuilt).toBe(content);
	});

	it("refuses to combine pages from different skill snapshots", async () => {
		let current = { ...skill, content: "A".repeat(DEFAULT_MAX_BYTES + 100) };
		const tool: AgentTool = createReadSkillTool(() => [current]);
		const first = await tool.execute("first", { name: skill.name });
		const details = first.details as { nextOffset: number; snapshot: string };
		current = { ...current, content: "B".repeat(DEFAULT_MAX_BYTES + 100) };
		await expect(tool.execute("second", { name: skill.name, offset: details.nextOffset, snapshot: details.snapshot })).rejects.toThrow("changed");
	});
});
