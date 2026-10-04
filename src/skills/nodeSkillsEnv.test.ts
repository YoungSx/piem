import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadSkills } from "./piResources";
import { type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createNodeSkillsEnv } from "./nodeSkillsEnv";

const homes: string[] = [];
const environments: ExecutionEnv[] = [];

function fixture(): { home: string; env: ExecutionEnv } {
	const home = mkdtempSync(join(tmpdir(), "piem-node-skills-"));
	homes.push(home);
	const env = createNodeSkillsEnv(home);
	environments.push(env);
	return { home, env };
}

function skill(home: string, path: string, name: string, metadata = ""): string {
	const file = join(home, path);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, `---\nname: ${name}\ndescription: ${name} description\n${metadata}---\n${name} body\n`);
	return file;
}

afterEach(async () => {
	for (const env of environments.splice(0)) await env.cleanup(BACKGROUND_CONTEXT);
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("Pi's filesystem behind the user-skills bridge", () => {
	it("uses the public NodeExecutionEnv directly", () => {
		const { env } = fixture();
		expect(env).toBeInstanceOf(NodeExecutionEnv);
		// A replacement should inherit Pi's operations, not copy or forward them.
		for (const name of ["readTextFile", "fileInfo", "listDir", "canonicalPath", "absolutePath", "joinPath"] as const) {
			expect(env[name]).toBe(NodeExecutionEnv.prototype[name]);
		}
	});

	it("loads root markdown, nested skills and symlinks while respecting ignore files", async () => {
		const { home, env } = fixture();
		const root = skill(home, "skills/root.md", "root");
		const nested = skill(home, "skills/deep/nested/SKILL.md", "nested", "disable-model-invocation: true\n");
		const linked = skill(home, "elsewhere/linked/SKILL.md", "linked");
		skill(home, "skills/ignored/SKILL.md", "ignored");
		writeFileSync(join(home, "skills/.gitignore"), "ignored/\n");
		symlinkSync(join(home, "elsewhere/linked"), join(home, "skills/linked"));
		symlinkSync(join(home, "missing"), join(home, "skills/dangling"));
		const result = await loadSkills(env, "skills", BACKGROUND_CONTEXT);
		// Root markdown is a declared skill only when it has a description.
		expect(result.diagnostics).toEqual([]);
		expect(result.skills.map((s) => s.name).sort()).toEqual(["linked", "nested", "root"]);
		for (const [name, path] of [["root", root], ["nested", nested], ["linked", join(home, "skills/linked/SKILL.md")]]) {
			const loaded = result.skills.find((s) => s.name === name);
			expect(loaded?.filePath).toBe(path);
			expect(loaded?.content).toContain(`${name} body`);
		}
		expect(await env.canonicalPath(join(home, "skills/linked/SKILL.md"), BACKGROUND_CONTEXT)).toEqual({ ok: true, value: linked });
		expect(result.skills.find((s) => s.name === "nested")?.disableModelInvocation).toBe(true);
	});

	it("keeps Pi's join semantics and resolves paths only when asked", async () => {
		const { home, env } = fixture();
		expect(await env.joinPath(["skills", "a.md"], BACKGROUND_CONTEXT)).toEqual({ ok: true, value: join("skills", "a.md") });
		expect(await env.absolutePath("skills/a.md", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: join(home, "skills/a.md") });
	});

	it("returns missing files as Results and missing roots as an empty load", async () => {
		const { env } = fixture();
		const missing = await env.readTextFile("missing.md", BACKGROUND_CONTEXT);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error.code).toBe("not_found");
		expect(await loadSkills(env, "missing", BACKGROUND_CONTEXT)).toEqual({ skills: [], diagnostics: [] });
	});

	it("reports an unreadable skill instead of claiming a clean empty folder", async () => {
		const { home, env } = fixture();
		const file = skill(home, "skills/blocked/SKILL.md", "blocked");
		chmodSync(file, 0);
		try {
			const result = await loadSkills(env, "skills", BACKGROUND_CONTEXT);
			expect(result.skills).toEqual([]);
			expect(result.diagnostics).toEqual([expect.objectContaining({ code: "read_failed", path: file })]);
		} finally {
			chmodSync(file, 0o600);
		}
	});

	it("refuses shell and temporary files without side effects", async () => {
		const { home, env } = fixture();
		const marker = join(home, "shell-ran");
		const shell = await env.exec(`touch '${marker}'`, undefined, BACKGROUND_CONTEXT);
		expect(shell.ok).toBe(false);
		if (!shell.ok) expect(shell.error.code).toBe("shell_unavailable");
		expect(existsSync(marker)).toBe(false);
		for (const result of [await env.createTempDir(undefined, BACKGROUND_CONTEXT), await env.createTempFile(undefined, BACKGROUND_CONTEXT)]) {
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("not_supported");
		}
		await env.cleanup(BACKGROUND_CONTEXT);
		await env.cleanup(BACKGROUND_CONTEXT);
	});
});
