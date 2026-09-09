import { describe, expect, it } from "bun:test";
import { DEFAULT_MAX_BYTES, formatSkillInvocation, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createReadSkillTool } from "../tools/skillTools";
import { retainSkillContext } from "./skillContext";

const skill = { name: "example", description: "Test", filePath: "/Piem/skills/example/SKILL.md", content: "rule" };

async function pages(content: string): Promise<AgentMessage[]> {
	const tool = createReadSkillTool(() => [{ ...skill, content }]);
	const messages: AgentMessage[] = [];
	let offset = 0;
	let snapshot: string | undefined;
	for (;;) {
		const result = await tool.execute(`page-${offset}`, { name: skill.name, offset, snapshot });
		messages.push({ ...result, role: "toolResult", toolName: "read_skill", toolCallId: `page-${offset}`, isError: false, timestamp: 1 });
		if (result.details.nextOffset === undefined) return messages;
		offset = result.details.nextOffset;
		snapshot = result.details.snapshot;
	}
}

describe("retained skill context", () => {
	it("retains every loaded page once across repeated reads and compactions", async () => {
		const history = await pages(`${"x".repeat(DEFAULT_MAX_BYTES + 40)}PAGE_END`);
		const retained = retainSkillContext([...history, ...history], []);
		expect(retained).toHaveLength(history.length);
		expect(JSON.stringify(retained).includes("PAGE_END")).toBe(true);
		const again = retainSkillContext(retained, retained);
		expect(again).toEqual(retained);
	});

	it("does not duplicate pages still present in the recent tail", async () => {
		const history = await pages("rule");
		expect(retainSkillContext(history, history)).toEqual(history);
	});

	it("replaces old pages when a new version of the same skill was loaded", async () => {
		const old = await pages(`${"o".repeat(DEFAULT_MAX_BYTES + 40)}OLD_END`);
		const newer = await pages("NEW_RULE");
		const kept = retainSkillContext([...retainSkillContext(old, []), ...newer], []);
		expect(kept).toHaveLength(1);
		expect(JSON.stringify(kept)).toContain("NEW_RULE");
		expect(JSON.stringify(kept)).not.toContain("OLD_END");
	});

	it("keeps text resources separate from instructions without promoting failed reads", async () => {
		const [body] = await pages("BODY");
		if (!body || body.role !== "toolResult") throw new Error("Missing fixture");
		const resource: AgentMessage = { ...body, details: { ...(body.details as object), resource: "references/detail.md", filePath: "/Piem/skills/example/references/detail.md" }, content: [{ type: "text", text: "REFERENCE" }] };
		const failed: AgentMessage = { ...resource, isError: true, content: [{ type: "text", text: "BAD_RULE" }] };
		const kept = retainSkillContext([body, resource, failed], []);
		expect(kept).toHaveLength(2);
		expect(JSON.stringify(kept)).toContain("REFERENCE");
		expect(JSON.stringify(kept)).not.toContain("BAD_RULE");
	});

	it("retains slash body exactly and leaves additional user instructions to the summary", () => {
		const body = "  First rule.\n\nLast rule.  ";
		const invocation: AgentMessage = { role: "user", content: formatSkillInvocation({ ...skill, content: body }, "ONLY_THIS_REQUEST"), timestamp: 1 };
		const kept = retainSkillContext([invocation], []);
		expect(kept).toHaveLength(1);
		const text = kept[0] && "content" in kept[0] ? kept[0].content : "";
		expect(text).toContain(body);
		expect(text).not.toContain("ONLY_THIS_REQUEST");
	});
});
