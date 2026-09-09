import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildBuiltinSkills } from "./builtin-skills.mjs";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const skill = (name: string) => `---\nname: ${name}\ndescription: Use when checking a note.\n---\nRead the current note.`;
function fixture(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "piem-skills-build-"));
	dirs.push(dir);
	writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: "2.0.0" }));
	for (const [file, text] of Object.entries(files)) {
		const target = join(dir, "skills", file);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, text);
	}
	return dir;
}

describe("standard skill resource build", () => {
	it("discovers new directories without a registration array and watches additions", async () => {
		const dir = fixture({ "first/SKILL.md": skill("first") });
		const first = await buildBuiltinSkills(dir);
		mkdirSync(join(dir, "skills/second"));
		writeFileSync(join(dir, "skills/second/SKILL.md"), skill("second"));
		const next = await buildBuiltinSkills(dir);
		expect(next.asset.names).toEqual(["first", "second"]);
		expect(next.asset.sha256).not.toBe(first.asset.sha256);
		expect(next.watchDirs).toContain(join(dir, "skills"));
		expect((await buildBuiltinSkills(dir)).content).toBe(next.content);
	});

	it("requires explicit metadata even when Pi could infer the name", async () => {
		for (const text of ["Body only", "---\ndescription: Do a thing\n---\nBody", "---\nname: first\n---\nBody", skill("mismatch")]) {
			await expect(buildBuiltinSkills(fixture({ "first/SKILL.md": text }))).rejects.toThrow();
		}
	});

	it("preserves references and refuses missing or escaping resources", async () => {
		const content = `${skill("first")}\nSee [detail](references/detail.md).`;
		const valid = await buildBuiltinSkills(fixture({ "first/SKILL.md": content, "first/references/detail.md": "# Details" }));
		expect(JSON.parse(valid.content).files).toContainEqual({ path: "first/references/detail.md", content: "# Details" });
		await expect(buildBuiltinSkills(fixture({ "first/SKILL.md": content }))).rejects.toThrow("Broken skill reference");
		await expect(buildBuiltinSkills(fixture({ "first/SKILL.md": `${skill("first")}\n[escape](../../outside.md)` }))).rejects.toThrow("Broken skill reference");
	});

	it("refuses scripts and symlinks before packaging", async () => {
		await expect(buildBuiltinSkills(fixture({ "first/SKILL.md": skill("first"), "first/scripts/run.js": "alert(1)" }))).rejects.toThrow("Markdown");
		const dir = fixture({ "first/SKILL.md": skill("first") });
		symlinkSync(join(dir, "manifest.json"), join(dir, "skills/first/extra.md"));
		await expect(buildBuiltinSkills(dir)).rejects.toThrow("symlink");
	});

	it("rejects oversized resources", async () => {
		await expect(buildBuiltinSkills(fixture({ "first/SKILL.md": skill("first"), "first/large.md": "x".repeat(256 * 1024 + 1) }))).rejects.toThrow("too large");
	});
});
