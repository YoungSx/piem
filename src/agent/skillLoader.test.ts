import { describe, expect, it } from "bun:test";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { installObsidianStub } from "../testUtils/obsidianStub";

installObsidianStub();

const { composeSystemPrompt, DEFAULT_SKILLS_DIR, emptySkillLoadReport, expandSkill, findSkill, loadVaultSkills, mergeSkills, mergeSkillsWithSource } =
	await import("./skillLoader");

/** Minimal ExecutionEnv over a fixed path→content map, matching pi's skill walk. */
function fakeEnv(files: Record<string, string>): ExecutionEnv {
	const folders = new Set<string>();
	for (const path of Object.keys(files)) {
		const segments = path.split("/").slice(1, -1);
		let current = "";
		for (const segment of segments) {
			current = `${current}/${segment}`;
			folders.add(current);
		}
	}
	const info = (path: string) => {
		if (files[path] !== undefined) {
			return { ok: true as const, value: { name: path.split("/").pop() ?? "", path, kind: "file" as const, size: 0, mtimeMs: 0 } };
		}
		if (folders.has(path) || path === "/") {
			return { ok: true as const, value: { name: path.split("/").pop() ?? "", path, kind: "directory" as const, size: 0, mtimeMs: 0 } };
		}
		return { ok: false as const, error: { code: "not_found" as const, message: `missing: ${path}`, path } };
	};
	return {
		cwd: "/",
		fileInfo: async (p: string) => info(p),
		absolutePath: async (p: string) => info(p),
		// pi passes env-absolute dirs into `joinPath`, so parts already carry the
		// leading `/`; collapsing doubled slashes mirrors the real adapter, which
		// is pure concatenation and never consults the filesystem.
		joinPath: async (parts: string[]) => ({ ok: true as const, value: parts.filter(Boolean).join("/").replace(/\/{2,}/g, "/") }),
		readTextFile: async (p: string) =>
			files[p] !== undefined ? { ok: true as const, value: files[p] } : { ok: false as const, error: { code: "not_found" as const, message: "missing", path: p } },
		listDir: async (p: string) => {
			const prefix = p === "/" ? "/" : `${p}/`;
			const entries = [
				...Object.keys(files)
					.filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes("/"))
					.map((f) => ({ name: f.split("/").pop() ?? "", path: f, kind: "file" as const })),
				...[...folders]
					.filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes("/"))
					.map((f) => ({ name: f.split("/").pop() ?? "", path: f, kind: "directory" as const })),
			];
			return { ok: true as const, value: entries };
		},
		canonicalPath: async (p: string) => info(p),
	} as unknown as ExecutionEnv;
}

const BASE = "You are Piem inside Obsidian.";

describe("loadVaultSkills", () => {
	it("exposes the vault-visible default folder", () => {
		// A dot-directory would be unreadable through the vault API and invisible
		// to the user; the loader's whole point is skills the user authors.
		expect(DEFAULT_SKILLS_DIR.startsWith(".")).toBe(false);
	});

	it("loads SKILL.md files under the skills folder", async () => {
		const env = fakeEnv({
			"/Piem/skills/summarize/SKILL.md": "---\nname: summarize\ndescription: Summarize a note\n---\nDo the summary.",
		});

		const { skills } = await loadVaultSkills(env);

		expect(skills.map((skill) => skill.name)).toEqual(["summarize"]);
		expect(skills[0]?.description).toBe("Summarize a note");
		expect(skills[0]?.content).toContain("Do the summary.");
	});

	it("treats a missing skills folder as empty rather than a failure", async () => {
		const { skills, diagnostics } = await loadVaultSkills(fakeEnv({}));

		expect(skills).toEqual([]);
		expect(diagnostics).toEqual([]);
	});

	it("surfaces malformed skills as warnings while loading the valid ones", async () => {
		// pi validates names only to warn: a skill whose frontmatter name breaks
		// the rules still loads (here under the frontmatter value), so the test
		// asserts the warning points at the file while both skills stay usable.
		const env = fakeEnv({
			"/Piem/skills/good/SKILL.md": "---\nname: good\ndescription: A good one\n---\nBody",
			"/Piem/skills/bad/SKILL.md": "---\nname: Not_A_Name\ndescription: A bad one\n---\nBody",
		});

		const { skills, diagnostics } = await loadVaultSkills(env);

		expect(skills.map((skill) => skill.name).sort()).toEqual(["Not_A_Name", "good"]);
		expect(diagnostics.length).toBeGreaterThan(0);
		expect(diagnostics.every((diagnostic) => diagnostic.type === "warning")).toBe(true);
		expect(diagnostics.every((diagnostic) => diagnostic.path.endsWith("bad/SKILL.md"))).toBe(true);
	});
});

describe("emptySkillLoadReport", () => {
	it("reports no problems in either layer", () => {
		const report = emptySkillLoadReport();

		expect(report.vault).toEqual([]);
		expect(report.user.diagnostics).toEqual([]);
		expect(report.user.skills).toEqual([]);
	});

	it("lists no searched folders, rather than the built-in pair", () => {
		// Nothing has been consulted before the first load, and a report naming
		// folders would claim a look that never happened — the distinction
		// `UserSkillsSearchEntry.found` exists to preserve. The settings panel
		// renders this shape on a tab opened before any skill load, so an
		// invented row would appear on screen.
		expect(emptySkillLoadReport().user.searched).toEqual([]);
	});

	it("hands back a fresh object each call, so one holder cannot mutate another's", () => {
		const first = emptySkillLoadReport();
		first.vault.push({ type: "warning", code: "parse_failed", message: "mine", path: "/a" });

		expect(emptySkillLoadReport().vault).toEqual([]);
	});
});

describe("skill lookup and invocation", () => {
	const builtin = { name: "summarize", description: "Builtin", content: "Builtin body", filePath: "/builtin/SKILL.md" };
	const vault = { name: "summarize", description: "Vault", content: "Vault body", filePath: "/Piem/skills/summarize/SKILL.md" };
	const extra = { name: "custom", description: "Custom", content: "Custom body", filePath: "/Piem/skills/custom/SKILL.md" };

	it("lets a vault skill replace a builtin with the same name", () => {
		const merged = mergeSkills([builtin], [vault, extra]);

		expect(merged).toEqual([vault, extra]);
		expect(findSkill(merged, "summarize")).toBe(vault);
	});

	it("resolves three layers with later layers outranking earlier ones", () => {
		// User-level sits between builtins and vault: it shadows a builtin yet
		// still loses to a vault skill that claims the same command.
		const user = { name: "summarize", description: "User", content: "User body", filePath: "~/.pi/agent/skills/summarize/SKILL.md" };
		const userOnly = { name: "portable", description: "User-only", content: "Portable body", filePath: "~/.pi/agent/skills/portable/SKILL.md" };

		const merged = mergeSkills([builtin], [user, userOnly], [vault, extra]);

		expect(merged.map((skill) => skill.name)).toEqual(["portable", "summarize", "custom"]);
		expect(findSkill(merged, "summarize")).toBe(vault);
	});

	it("uses pi's complete skill block and appends extra instructions verbatim", () => {
		const invocation = expandSkill(vault, 'Focus on decisions "since Monday".');

		expect(invocation).toContain('<skill name="summarize" location="/Piem/skills/summarize/SKILL.md">');
		expect(invocation).toContain("Vault body");
		expect(invocation.endsWith('Focus on decisions "since Monday".')).toBe(true);
	});

	it("labels each merged skill with the layer it survived from", () => {
		// The settings panel splits its rows by provenance, so the label has to
		// track the winning layer — a shadowed builtin must not carry a builtin
		// tag just because it entered the merge.
		const user = { name: "portable", description: "User", content: "Portable body", filePath: "~/.pi/agent/skills/portable/SKILL.md" };

		const merged = mergeSkillsWithSource([builtin], [user], [vault, extra]);

		expect(
			merged.map((entry) => [entry.skill.name, entry.source] as const),
		).toEqual([
			["portable", "user"],
			["summarize", "vault"],
			["custom", "vault"],
		]);
	});
});

describe("composeSystemPrompt", () => {
	it("passes the base prompt through untouched when there are no skills", () => {
		// `formatSkillsForSystemPrompt` renders an empty set as "", so the guard
		// here is what keeps a skill-less vault byte-identical to before.
		expect(composeSystemPrompt(BASE, [])).toBe(BASE);
	});

	it("appends the skill listing after the base prompt", () => {
		const composed = composeSystemPrompt(BASE, [
			{ name: "summarize", description: "Summarize a note", content: "Body", filePath: "/Piem/skills/summarize/SKILL.md" },
		]);

		expect(composed.startsWith(BASE)).toBe(true);
		expect(composed).toContain("<available_skills>");
		expect(composed).toContain("summarize");
		expect(composed).toContain("/Piem/skills/summarize/SKILL.md");
		expect(composed).toContain("use the read_skill tool");
	});
});
