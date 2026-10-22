import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Tests for the version-drift gate.
 *
 * A gate that passes proves nothing on its own. The rule this one enforces was
 * already implicit — `manifest.json` owns the version — and it passed every day
 * for two releases while `mcpManager.ts` reported a stale `1.0.0` to every MCP
 * server and both READMEs described a shipped 1.0.x plugin as early alpha.
 *
 * So what gets pinned here is the other direction: that a hand-written version
 * really does fail the gate, and — just as important — that the version-shaped
 * strings which are *supposed* to be there stay unflagged. A gate that fires on
 * `minAppVersion` or on a test's stub is a gate someone deletes from the CI
 * file, and then the rule is implicit again.
 *
 * Each case writes a scratch tree and runs the real script over it as a
 * subprocess, so what is under test is the shipped file rather than a
 * re-implementation of its logic. The scratch dir supplies its own
 * `manifest.json`, because the gate reads the current version from the file that
 * owns it and the assertions should not move on every release.
 */

const SCRIPT = join(import.meta.dir, "check-version.mjs");
const SCRATCH_VERSION = "3.4.5";

interface GateResult {
	exitCode: number;
	output: string;
}

/**
 * Runs the gate over a synthetic tree.
 *
 * `sources` are written under `src/`; `docs` keys are paths relative to the
 * scratch root, so `"docs/tools.md"` lands in a subdirectory the gate has to
 * discover rather than one it was handed.
 * The subprocess's cwd is the scratch dir so `manifest.json` and the README
 * paths resolve there, while `node_modules` still resolves up to the repo for
 * the TypeScript parser.
 */
async function runGate(files: {
	sources?: Record<string, string>;
	docs?: Record<string, string>;
	version?: string;
}): Promise<GateResult> {
	const dir = mkdtempSync(join(tmpdir(), "check-version-"));
	try {
		const version = files.version ?? SCRATCH_VERSION;
		writeFileSync(
			join(dir, "manifest.json"),
			JSON.stringify({ id: "piem", version, minAppVersion: "1.5.7" }, null, "\t"),
		);
		const sourceRoot = join(dir, "src");
		mkdirSync(sourceRoot, { recursive: true });
		for (const [name, contents] of Object.entries(files.sources ?? {})) {
			const target = join(sourceRoot, name);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, contents);
		}
		for (const [name, contents] of Object.entries(files.docs ?? {})) {
			const target = join(dir, name);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, contents);
		}

		const proc = Bun.spawn(["node", SCRIPT, sourceRoot], {
			cwd: dir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { exitCode, output: stdout + stderr };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("check-version", () => {
	it("fails on the shape the MCP handshake defect was written in", async () => {
		// The original: a module constant, correct on the day it was typed, never
		// touched again, and read by nothing that could notice it had gone stale.
		const result = await runGate({
			sources: {
				"mcpManager.ts": `const clientInfo = { name: "piem", version: "${SCRATCH_VERSION}" } as const;\nexport { clientInfo };\n`,
			},
		});
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("mcpManager.ts:1");
		expect(result.output).toContain(SCRATCH_VERSION);
	});

	it("names the variable a hand-written version was assigned to", async () => {
		const result = await runGate({
			sources: { "constants.ts": `export const PLUGIN_VERSION = "${SCRATCH_VERSION}";\n` },
		});
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain(`PLUGIN_VERSION = "${SCRATCH_VERSION}"`);
	});

	it("catches a version in a template literal, not just a quoted string", async () => {
		const result = await runGate({
			sources: { "banner.ts": `export const tag = \`${SCRATCH_VERSION}\`;\n` },
		});
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("banner.ts:1");
	});

	it("fails on docs prose that states the current version", async () => {
		// Both READMEs claimed "early alpha (0.1.0-alpha.x)" for the whole 1.0.x
		// line. Prose goes stale with nothing to catch it.
		const result = await runGate({
			docs: { "README.md": `# Piem\n\nPiem is at ${SCRATCH_VERSION} right now.\n` },
		});
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("README.md:3");
	});

	it("finds a doc the gate was never told about", async () => {
		// The README's reference material moved into docs/ in the same change
		// that made this scan enumerate roots instead of files. Under the old
		// hardcoded pair, a version literal here was invisible by construction —
		// which is the failure mode that killed stamp-version.mjs.
		const result = await runGate({
			docs: { "docs/tools.md": `# Tools\n\nAs of ${SCRATCH_VERSION}, the agent has these.\n` },
		});
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("docs/tools.md:3");
	});

	it("passes a clean tree and says where the version is allowed to live", async () => {
		const result = await runGate({
			sources: { "main.ts": `export const version = () => plugin.manifest.version;\n` },
			docs: { "README.md": "# Piem\n\nSee `manifest.json` for the version.\n" },
		});
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("manifest.json");
	});

	describe("what must stay unflagged", () => {
		it("ignores other software's versions", async () => {
			// minAppVersion, a dependency pin, and MCP's protocol revision all name
			// something that is not us and have no reason to move when we release.
			const result = await runGate({
				sources: {
					"deps.ts": `export const pins = { obsidian: "1.5.7", esbuild: "0.25.5", protocol: "2025-06-18" };\n`,
				},
			});
			expect(result.exitCode).toBe(0);
		});

		it("ignores an older version of our own, cited as history", async () => {
			const result = await runGate({
				sources: { "notes.ts": `export const previous = "1.0.0";\n` },
			});
			expect(result.exitCode).toBe(0);
		});

		it("exempts test files, where a version literal is a fixture", async () => {
			const result = await runGate({
				sources: { "thing.test.ts": `const stub = "${SCRATCH_VERSION}";\nexport { stub };\n` },
			});
			expect(result.exitCode).toBe(0);
		});

		it("exempts test utilities under testUtils, where a version literal is a stub", async () => {
			const result = await runGate({
				sources: { "testUtils/stub.ts": `export const STUB_VERSION = "${SCRATCH_VERSION}";\n` },
			});
			expect(result.exitCode).toBe(0);
		});

		it("does not flag a version mentioned in a comment", async () => {
			// This gate's own header cites the stale 1.0.0 that motivated it, and
			// AGENTS.md cites old tags deliberately. Parsing rather than grepping is
			// what makes that possible.
			const result = await runGate({
				sources: { "history.ts": `// Shipped ${SCRATCH_VERSION} with the drift still in place.\nexport const x = 1;\n` },
			});
			expect(result.exitCode).toBe(0);
		});

		it("does not flag a version assembled at runtime", async () => {
			// It cannot know what a computed value holds, and saying so is honest
			// about the gate's limit rather than pretending to a proof.
			const result = await runGate({
				sources: { "compose.ts": `export const v = (minor: string) => "3." + minor + ".5";\n` },
			});
			expect(result.exitCode).toBe(0);
		});

		it("leaves the worklogs archive alone", async () => {
			// A worklog describes what a release looked like on the day it was
			// written. Rewriting it on the next release would destroy the record,
			// so the root scan is non-recursive and the folder stays out.
			const result = await runGate({
				docs: { "worklogs/2026-01-shipping.md": `Shipped ${SCRATCH_VERSION} today.\n` },
			});
			expect(result.exitCode).toBe(0);
		});

		it("does not flag prose citing an older version as history", async () => {
			const result = await runGate({
				docs: { "README.md": "# Piem\n\n0.1.0-alpha.9 was the last alpha.\n" },
			});
			expect(result.exitCode).toBe(0);
		});
	});
});
