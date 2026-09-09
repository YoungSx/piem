import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AgentTool, ExecutionEnv } from "@earendil-works/pi-agent-core";
import { createReadSkillTool } from "../tools/skillTools";
import { loadUserSkills } from "./userSkills";
import { installObsidianStub } from "../testUtils/obsidianStub";
import { createSkillVault } from "../testUtils/skillVault";

installObsidianStub();
const { TFile, TFolder } = await import("obsidian");
const { VaultExecutionEnv } = await import("../vault/VaultExecutionEnv");
const { loadVaultSkills } = await import("../agent/skillLoader");
const directories: string[] = [];
afterEach(async () => {
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("skill resources", () => {
	it("reads a Vault reference only when selected, from the same skill instance", async () => {
		const { vault } = createSkillVault({ TFile, TFolder } as unknown as Parameters<typeof createSkillVault>[0]);
		await vault.create("Piem/skills/example/SKILL.md", "---\nname: example\ndescription: Test\n---\nRead references/detail.md");
		await vault.create("Piem/skills/example/references/detail.md", "Only loaded when requested");
		const reads: string[] = [];
		const originalRead = vault.read;
		vault.read = async (file) => { reads.push(file.path); return originalRead(file); };
		const env = new VaultExecutionEnv({ vault } as unknown as ConstructorParameters<typeof VaultExecutionEnv>[0]);
		const { skills, diagnostics } = await loadVaultSkills(env);
		expect(diagnostics).toEqual([]);
		expect(reads).toEqual(["Piem/skills/example/SKILL.md"]);
		const tool: AgentTool = createReadSkillTool(() => skills);
		const result = await tool.execute("resource", { name: "example", path: "references/detail.md" });
		expect(result.content).toEqual([{ type: "text", text: "Only loaded when requested" }]);
		expect(result.details).toMatchObject({ resource: "references/detail.md", name: "example" });
		await env.cleanup();
	});

	it("reads user-skill resources after discovery releases its env and closes each new env", async () => {
		const { home, skillDir } = await fixture();
		await writeFile(join(skillDir, "references/detail.md"), "USER_REFERENCE");
		let created = 0;
		let cleaned = 0;
		const createEnv = async (): Promise<ExecutionEnv> => {
			created++;
			const env = new NodeExecutionEnv({ cwd: home });
			const cleanup = env.cleanup.bind(env);
			env.cleanup = async () => { cleaned++; await cleanup(); };
			return env;
		};
		const loaded = await loadUserSkills(join(home, "skills"), { createEnv });
		expect(loaded.diagnostics).toEqual([]);
		expect(created).toBe(1);
		expect(cleaned).toBe(1);
		const tool: AgentTool = createReadSkillTool(() => loaded.skills);
		const result = await tool.execute("read", { name: "example", path: "references/detail.md" });
		expect(result.content).toEqual([{ type: "text", text: "USER_REFERENCE" }]);
		expect(created).toBe(2);
		expect(cleaned).toBe(2);
		await expect(tool.execute("missing", { name: "example", path: "missing.md" })).rejects.toThrow();
		expect(created).toBe(3);
		expect(cleaned).toBe(3);
	});

	it("rejects escaping paths and symlinks while allowing links inside the skill", async () => {
		const { home, skillDir } = await fixture();
		await writeFile(join(home, "private.md"), "PRIVATE");
		await writeFile(join(skillDir, "references/detail.md"), "SAFE");
		await symlink(join(home, "private.md"), join(skillDir, "outside.md"));
		await symlink(join(skillDir, "references/detail.md"), join(skillDir, "inside.md"));
		const { skills } = await loadUserSkills(join(home, "skills"), { createEnv: async () => new NodeExecutionEnv({ cwd: home }) });
		const tool: AgentTool = createReadSkillTool(() => skills);
		for (const path of ["../private.md", join(home, "private.md"), "references/../../private.md", "outside.md", "C:\\private.md", ".secret.md"]) {
			await expect(tool.execute("escape", { name: "example", path })).rejects.toThrow();
		}
		expect((await tool.execute("inside", { name: "example", path: "inside.md" })).content).toEqual([{ type: "text", text: "SAFE" }]);
	});

	it("rejects binary, oversized, changed and cancelled reads", async () => {
		const { home, skillDir } = await fixture();
		await writeFile(join(skillDir, "binary.bin"), new Uint8Array([0, 255, 3]));
		await writeFile(join(skillDir, "large.md"), "x".repeat(1024 * 1024 + 1));
		await writeFile(join(skillDir, "paged.md"), "a".repeat(60_000));
		const { skills } = await loadUserSkills(join(home, "skills"), { createEnv: async () => new NodeExecutionEnv({ cwd: home }) });
		const tool: AgentTool = createReadSkillTool(() => skills);
		await expect(tool.execute("binary", { name: "example", path: "binary.bin" })).rejects.toThrow("UTF-8 text");
		await expect(tool.execute("large", { name: "example", path: "large.md" })).rejects.toThrow("1 MiB");
		const first = await tool.execute("page", { name: "example", path: "paged.md" });
		const details = first.details as { nextOffset: number; snapshot: string };
		await writeFile(join(skillDir, "paged.md"), "b".repeat(60_000));
		await expect(tool.execute("changed", { name: "example", path: "paged.md", offset: details.nextOffset, snapshot: details.snapshot })).rejects.toThrow("changed");
		const controller = new AbortController();
		controller.abort();
		await expect(tool.execute("cancelled", { name: "example", path: "paged.md" }, controller.signal)).rejects.toThrow("aborted");
	});

	it("rejects a skill root replaced with a symlink after discovery", async () => {
		const { home, skillDir } = await fixture();
		const { skills } = await loadUserSkills(join(home, "skills"), { createEnv: async () => new NodeExecutionEnv({ cwd: home }) });
		await rename(skillDir, `${skillDir}-original`);
		await mkdir(join(home, "private"));
		await writeFile(join(home, "private/secret.md"), "SECRET");
		await symlink(join(home, "private"), skillDir);
		const tool: AgentTool = createReadSkillTool(() => skills);
		await expect(tool.execute("retargeted", { name: "example", path: "secret.md" })).rejects.toThrow("directory changed");
	});
});

async function fixture(): Promise<{ home: string; skillDir: string }> {
	const home = await mkdtemp(join(tmpdir(), "piem-skill-resources-"));
	directories.push(home);
	const skillDir = join(home, "skills/example");
	await mkdir(join(skillDir, "references"), { recursive: true });
	await writeFile(join(skillDir, "SKILL.md"), "---\nname: example\ndescription: Test resource access\n---\nRead references/detail.md");
	return { home, skillDir };
}
