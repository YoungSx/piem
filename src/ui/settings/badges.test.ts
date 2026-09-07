import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { getT } from "../../i18n";
import type { McpServerState } from "../../mcp/mcpManager";
import type { SkillRow } from "../../skills/skillManager";
import { installDom } from "../../testUtils/dom";
import { appendBadge, describeMcpBadge, externalFileBadge, mcpPendingBadge, problemCountBadge, setBadge, skillProvenanceBadge } from "./badges";

const server: McpServerState = { id: "one", name: "One", url: "https://example.com/mcp", enabled: true, status: "ok", toolCount: 1 };
const skill: SkillRow = { name: "notes", description: "A description", path: "Piem/skills/notes/SKILL.md", dirName: "notes" };

describe("extension badge facts", () => {
	for (const language of ["en", "zh-cn"] as const) {
		const t = getT(language);
		it(`${language}: keeps connection states and singular counts distinct`, () => {
			expect(describeMcpBadge(server, t)).toEqual({ label: t.t("badges.mcpOkOne"), tone: "ok" });
			for (const count of [0, 2, 120]) {
				expect(describeMcpBadge({ ...server, toolCount: count }, t).label).toContain(String(count));
			}
			const failed = { ...server, status: "error" as const, error: "401" };
			expect(describeMcpBadge(failed, t).tone).toBe("error");
			expect(describeMcpBadge({ ...failed, enabled: false }, t).tone).toBe("disabled");
			expect(describeMcpBadge({ ...server, status: "untested" }, t).tone).toBe("untested");
			expect(mcpPendingBadge(t).tone).toBe("connecting");
		});

		it(`${language}: derives skill identity from provenance and path`, () => {
			expect(skillProvenanceBadge(skill, t).label).toBe(t.t("badges.handAuthored"));
			expect(skillProvenanceBadge({ ...skill, dirName: "" }, t).label).toBe(t.t("badges.rootFile"));
			expect(skillProvenanceBadge({ ...skill, provenance: { url: "https://example.com/skill.md", kind: "raw", importedAt: "", files: {} } }, t).label).toBe(t.t("badges.imported"));
			expect(externalFileBadge(t).label).toBe(t.t("badges.external"));
			expect(problemCountBadge(0, t)).toBeUndefined();
			expect(problemCountBadge(1, t)?.label).toBe(t.t("badges.problemOne"));
			expect(problemCountBadge(2, t)?.label).toBe(t.t("badges.problemMany", { count: 2 }));
		});
	}
});

it("reuses the badge, preserves the name and never interprets data as HTML", () => {
	const document = installDom();
	const name = document.createElement("div");
	name.textContent = "<script>name</script>";
	const badge = appendBadge(name, mcpPendingBadge(getT("en")));
	badge.setAttribute("role", "status");
	const again = appendBadge(name, describeMcpBadge(server, getT("en")));
	expect(again).toBe(badge);
	expect(name.querySelectorAll(".piem-badge")).toHaveLength(1);
	expect(name.firstElementChild?.textContent).toBe("<script>name</script>");
	expect(name.querySelector("script")).toBeNull();
	expect(badge.classList.contains("piem-badge--connecting")).toBe(false);
	setBadge(badge, { label: "<b>failure</b>", tone: "error" });
	expect(badge.children).toHaveLength(0);
	expect(badge.textContent).toBe("<b>failure</b>");
	expect(badge.getAttribute("role")).toBe("status");
});

it("stops connecting motion when reduced motion is requested", () => {
	const css = readFileSync(new URL("../../../styles.css", import.meta.url), "utf8");
	expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.piem-badge--connecting::before\s*\{\s*animation:\s*none/);
});
