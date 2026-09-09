import { describe, expect, it, mock } from "bun:test";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { installObsidianStub } from "../testUtils/obsidianStub";

installObsidianStub();

const { USER_SKILLS_DIRS, loadUserSkills, loadUserSkillsFromEnv, userSkillsSupported } = await import("./userSkills");
const { createUserSkillsEnv } = await import("./nodeSkillsHost");

/** Minimal ExecutionEnv over a fixed path→content map; paths are literal, so tests use the raw `~` form. */
function fakeHomeEnv(files: Record<string, string>): ExecutionEnv {
	const folders = new Set<string>();
	for (const path of Object.keys(files)) {
		// Paths here are literal (`~/.pi/...`), so folders accumulate from the
		// first segment without dropping the `~` root.
		const segments = path.split("/");
		const current: string[] = [];
		for (const segment of segments.slice(0, -1)) {
			current.push(segment);
			folders.add(current.join("/"));
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
		cwd: "/home/tester",
		fileInfo: async (p: string) => info(p),
		absolutePath: async (p: string) => info(p),
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
		// Present because the real env has it and the loader probes it. Its
		// absence here is what caught the loader assuming every env implements
		// the full interface, which no interface guarantees.
		exists: async (p: string) => ({ ok: true as const, value: files[p] !== undefined || folders.has(p) }),
	} as unknown as ExecutionEnv;
}

/** An env whose `exists` fails the way a phone's does: not an absence, an inability to look. */
function blindHomeEnv(files: Record<string, string>): ExecutionEnv {
	const env = fakeHomeEnv(files);
	return {
		...env,
		exists: async (path: string) => ({ ok: false as const, error: { code: "not_supported" as const, message: "no filesystem", path } }),
	} as unknown as ExecutionEnv;
}

describe("loadUserSkills", () => {
	it("targets the directories pi itself reads, pi precedence first", () => {
		expect(USER_SKILLS_DIRS).toEqual(["~/.pi/agent/skills", "~/.agents/skills"]);
	});

	it("loads skills with their source directory attached", async () => {
		const env = fakeHomeEnv({
			"~/.pi/agent/skills/summarize/SKILL.md": "---\nname: summarize\ndescription: Home skill\n---\nBody",
		});

		const { skills, diagnostics } = await loadUserSkillsFromEnv(env);

		expect(diagnostics).toEqual([]);
		expect(skills.map((skill) => skill.name)).toEqual(["summarize"]);
		expect(skills[0]?.sourceDir).toBe("~/.pi/agent/skills");
		expect(skills[0]?.content).toContain("Body");
	});

	it("keeps the first directory's copy when both locations define a name", async () => {
		// Same tie-break pi uses across its directory list: the .pi copy wins,
		// and the loser never reaches the prompt as a second command.
		const env = fakeHomeEnv({
			"~/.pi/agent/skills/summarize/SKILL.md": "---\nname: summarize\ndescription: Pi copy\n---\nBody",
			"~/.agents/skills/summarize/SKILL.md": "---\nname: summarize\ndescription: Agents copy\n---\nBody",
			"~/.agents/skills/portable/SKILL.md": "---\nname: portable\ndescription: Only here\n---\nBody",
		});

		const { skills } = await loadUserSkillsFromEnv(env);

		expect(skills.map((skill) => skill.name)).toEqual(["summarize", "portable"]);
		expect(skills[0]?.description).toBe("Pi copy");
		expect(skills[0]?.sourceDir).toBe("~/.pi/agent/skills");
	});

	it("treats both directories as missing without complaint", async () => {
		const { skills, diagnostics } = await loadUserSkillsFromEnv(fakeHomeEnv({}));

		expect(skills).toEqual([]);
		expect(diagnostics).toEqual([]);
	});
});

describe("loadUserSkills where node is unavailable", () => {
	// The mobile shape: pi's loader reports any non-`not_found` failure as a
	// diagnostic, so letting the load run there would raise a "node filesystem
	// is unavailable" notice on every agent start — blaming the user's files
	// for a capability the device never had. The skip is the fix; these pin it.
	it("skips the load entirely instead of collecting diagnostics", async () => {
		const options = { createEnv: () => createUserSkillsEnv(null) };
		const { skills, diagnostics } = await loadUserSkills(undefined, options);

		expect(skills).toEqual([]);
		expect(diagnostics).toEqual([]);
	});

	it("names the built-in pair as unconsulted, not absent", async () => {
		const options = { createEnv: () => createUserSkillsEnv(null) };
		const { searched } = await loadUserSkills(undefined, options);

		expect(searched).toEqual(
			USER_SKILLS_DIRS.map((dir) => ({ dir, found: undefined, loaded: 0 })),
		);
	});

	it("leaves the configured extra folder out of the report, since nothing probed it", async () => {
		const options = { createEnv: () => createUserSkillsEnv(null) };
		const { searched } = await loadUserSkills("~/Sync/skills", options);

		expect(searched.map((entry) => entry.dir)).toEqual(USER_SKILLS_DIRS);
	});
});

describe("userSkillsSupported", () => {
	it("follows the env's probe rather than a platform guess", async () => {
		// The test runner has a real `require`, so the honest answer here is
		// yes; the no-node side is covered by nodeSkillsHost's unavailable
		// cases above, which this flag reads.
		expect(userSkillsSupported()).toBe(true);
	});
});

describe("user-skills environment ownership and failures", () => {
	it("cleans up an environment created for the load", async () => {
		const env = fakeHomeEnv({});
		env.cleanup = mock(async () => undefined);
		await loadUserSkills(undefined, { createEnv: async () => env });
		expect(env.cleanup).toHaveBeenCalledTimes(1);
	});

	it("leaves an injected environment under its caller's ownership", async () => {
		const env = fakeHomeEnv({});
		env.cleanup = mock(async () => undefined);
		await loadUserSkills(undefined, { env });
		expect(env.cleanup).not.toHaveBeenCalled();
	});

	it("reports bridge failure with unknown paths, including the custom folder", async () => {
		const result = await loadUserSkills("~/Sync/skills", {
			createEnv: async () => { throw new Error("Node bridge failed"); },
		});
		expect(result.skills).toEqual([]);
		expect(result.diagnostics).toEqual([expect.objectContaining({ message: "Could not load user skills: Node bridge failed" })]);
		expect(result.searched).toEqual(["~/Sync/skills", ...USER_SKILLS_DIRS].map((dir) => ({ dir, found: undefined, loaded: 0 })));
	});

	it("cleans up after a throwing filesystem without rejecting the whole skill load", async () => {
		const env = fakeHomeEnv({});
		env.fileInfo = async () => { throw new Error("scan failed"); };
		env.cleanup = mock(async () => undefined);
		const result = await loadUserSkills(undefined, { createEnv: async () => env });
		expect(result.diagnostics[0]?.message).toContain("scan failed");
		expect(result.searched.every((entry) => entry.found === undefined)).toBe(true);
		expect(env.cleanup).toHaveBeenCalledTimes(1);
	});

	it("keeps loaded skills when cleanup fails and reports that failure", async () => {
		const env = fakeHomeEnv({ "~/.pi/agent/skills/keep/SKILL.md": "---\nname: keep\ndescription: d\n---\nBody" });
		env.cleanup = mock(async () => { throw new Error("cleanup failed"); });
		const result = await loadUserSkills(undefined, { createEnv: async () => env });
		expect(result.skills.map((s) => s.name)).toEqual(["keep"]);
		expect(result.diagnostics[0]?.message).toBe("Could not clean up user skills: cleanup failed");
		expect(result.searched[0]?.loaded).toBe(1);
	});
});

describe("loadUserSkills with a directory the user named", () => {
	it("outranks the built-in pair, since the user chose it and the defaults are only conventions", async () => {
		// The whole reason the setting exists is a machine whose skills live
		// elsewhere. A folder the user pointed at, losing to one they never
		// configured, would make the setting look broken while working exactly as
		// written — so it goes first, where the dedupe below keeps it.
		const env = fakeHomeEnv({
			"~/Sync/skills/summarize/SKILL.md": "---\nname: summarize\ndescription: Chosen copy\n---\nBody",
			"~/.pi/agent/skills/summarize/SKILL.md": "---\nname: summarize\ndescription: Pi copy\n---\nBody",
		});

		const { skills } = await loadUserSkillsFromEnv(env, "~/Sync/skills");

		expect(skills.map((skill) => skill.name)).toEqual(["summarize"]);
		expect(skills[0]?.description).toBe("Chosen copy");
		expect(skills[0]?.sourceDir).toBe("~/Sync/skills");
	});

	it("loads it alongside the built-in pair rather than instead of them", async () => {
		const env = fakeHomeEnv({
			"~/Sync/skills/chosen/SKILL.md": "---\nname: chosen\ndescription: d\n---\nBody",
			"~/.agents/skills/portable/SKILL.md": "---\nname: portable\ndescription: d\n---\nBody",
		});

		const { skills } = await loadUserSkillsFromEnv(env, "~/Sync/skills");

		expect(skills.map((skill) => skill.name).sort()).toEqual(["chosen", "portable"]);
	});

	it("re-validates rather than trusting the caller, so a half-typed path never resolves silently", async () => {
		// The settings panel reaches this with whatever is in the field. A bare
		// `skills` would otherwise resolve against the env's cwd — the home
		// directory — and load from a folder the user never named.
		const env = fakeHomeEnv({ "~/.pi/agent/skills/a/SKILL.md": "---\nname: a\ndescription: d\n---\nBody" });

		const { searched } = await loadUserSkillsFromEnv(env, "skills");

		expect(searched.map((entry) => entry.dir)).toEqual(USER_SKILLS_DIRS);
	});

	it("treats an empty or whitespace-only setting as no extra folder", async () => {
		const env = fakeHomeEnv({});

		for (const value of ["", "   ", undefined]) {
			const { searched } = await loadUserSkillsFromEnv(env, value);

			expect(searched.map((entry) => entry.dir)).toEqual(USER_SKILLS_DIRS);
		}
	});

	it("does not search one folder twice when the setting repeats a built-in", async () => {
		// Duplicated inputs would report the same folder on two rows and dedupe
		// its own skills against itself, reading as a shadowing conflict.
		const env = fakeHomeEnv({ "~/.agents/skills/a/SKILL.md": "---\nname: a\ndescription: d\n---\nBody" });

		const { searched, skills } = await loadUserSkillsFromEnv(env, "~/.agents/skills");

		expect(searched.map((entry) => entry.dir)).toEqual(USER_SKILLS_DIRS);
		expect(skills.map((skill) => skill.name)).toEqual(["a"]);
	});
});

describe("loadUserSkills search report", () => {
	it("names every folder it looked in, so a misresolved path is visible at all", async () => {
		// This report is the entire remedy for the silence: pi's loader skips a
		// missing directory without a diagnostic, so before this there was nothing
		// anywhere to distinguish "no skills" from "looked in the wrong place".
		const { searched } = await loadUserSkillsFromEnv(fakeHomeEnv({}));

		expect(searched.map((entry) => entry.dir)).toEqual(USER_SKILLS_DIRS);
		expect(searched.every((entry) => entry.found === false)).toBe(true);
	});

	it("counts what each folder actually contributed, not what it holds", async () => {
		// A shadowed skill never reaches the agent, so counting it would tell the
		// user a folder is working when its contents are being ignored.
		const env = fakeHomeEnv({
			"~/.pi/agent/skills/summarize/SKILL.md": "---\nname: summarize\ndescription: d\n---\nBody",
			"~/.agents/skills/summarize/SKILL.md": "---\nname: summarize\ndescription: d\n---\nBody",
		});

		const { searched } = await loadUserSkillsFromEnv(env);
		const byDir = new Map(searched.map((entry) => [entry.dir, entry]));

		expect(byDir.get("~/.pi/agent/skills")?.loaded).toBe(1);
		expect(byDir.get("~/.agents/skills")?.loaded).toBe(0);
		expect(byDir.get("~/.agents/skills")?.found).toBe(true);
	});

	it("separates a folder that is there and empty from one that is absent", async () => {
		const env = fakeHomeEnv({ "~/.pi/agent/skills/keep/SKILL.md": "---\nname: keep\ndescription: d\n---\nBody" });

		const { searched } = await loadUserSkillsFromEnv(env);
		const byDir = new Map(searched.map((entry) => [entry.dir, entry]));

		expect(byDir.get("~/.pi/agent/skills")).toEqual({ dir: "~/.pi/agent/skills", found: true, loaded: 1 });
		expect(byDir.get("~/.agents/skills")).toEqual({ dir: "~/.agents/skills", found: false, loaded: 0 });
	});

	it("says it could not tell rather than claiming absence, when the env cannot look", async () => {
		// A phone answers `not_supported`, and an unreadable folder answers
		// `permission_denied`. Reporting either as "no folder here" would assert
		// something false about a folder the user may well have created.
		const { searched } = await loadUserSkillsFromEnv(blindHomeEnv({}));

		expect(searched.every((entry) => entry.found === undefined)).toBe(true);
	});

	it("puts the user's folder first in the report, matching the order it was read", async () => {
		const { searched } = await loadUserSkillsFromEnv(fakeHomeEnv({}), "~/Sync/skills");

		expect(searched.map((entry) => entry.dir)).toEqual(["~/Sync/skills", ...USER_SKILLS_DIRS]);
	});
});
