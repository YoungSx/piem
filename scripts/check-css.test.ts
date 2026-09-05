import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tests for the CSS animation gate.
 *
 * The defect it exists for was invisible to everything else in this repo: a
 * rename left `.piem-chat__subagents-button--running` pointing at keyframes that
 * no longer existed, the icon silently stopped breathing, and every check stayed
 * green. So the true-positive half is the point — but the false-positive half
 * decides whether the gate survives, because a gate that fires on
 * `animation-delay` or on a comment is a gate somebody removes from `verify`.
 *
 * Each case writes one stylesheet to a scratch directory and runs the shipped
 * script over it as a subprocess, so what is under test is the file that ships
 * rather than a second implementation of its parser.
 */

const SCRIPT = join(import.meta.dir, "check-css.mjs");

interface GateResult {
	exitCode: number;
	output: string;
}

async function runGate(css: string): Promise<GateResult> {
	const dir = mkdtempSync(join(tmpdir(), "check-css-"));
	try {
		const file = join(dir, "styles.css");
		writeFileSync(file, css);
		const proc = Bun.spawn(["node", SCRIPT, file], { stdout: "pipe", stderr: "pipe" });
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

/** A paired definition and use, which is what a healthy stylesheet looks like. */
const PAIRED = `@keyframes piem-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.a { animation: piem-breathe 1.8s ease-in-out infinite; }`;

describe("check-css", () => {
	it("passes a stylesheet whose animations all resolve", async () => {
		const result = await runGate(PAIRED);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("1 @keyframes");
	});

	it("fails an animation naming keyframes that do not exist", async () => {
		// The shipped defect: a rename that missed one caller.
		const result = await runGate(`@keyframes piem-breathe { 0% { opacity: 1; } }
.a { animation: piem-subagent-breathe 1.8s ease-in-out infinite; }`);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("piem-subagent-breathe");
		expect(result.output).toContain("no @keyframes block defines");
		// The failure names what *is* defined, because the answer to a missed rename
		// is almost always the new name sitting right there.
		expect(result.output).toContain("Defined here: piem-breathe");
	});

	it("fails keyframes nothing names, which is the same rename half-done", async () => {
		const result = await runGate(`@keyframes pi-orphan { 0% { opacity: 1; } }
.a { color: red; }`);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("pi-orphan");
		expect(result.output).toContain("defined and never named");
	});

	it("reports the line the reference is on, counting through comments", async () => {
		const result = await runGate(`/* A comment that mentions
   animation: pi-ghost 1s linear infinite;
   and spans several lines. */
.a { animation: pi-missing 1s linear infinite; }`);

		expect(result.exitCode).toBe(1);
		// The comment's own `animation:` is not a reference, and the real one is on
		// line 4 — which only holds if stripping kept the newlines.
		expect(result.output).toContain("styles.css:4");
		expect(result.output).not.toContain("pi-ghost");
	});

	it("leaves the animation longhands alone", async () => {
		// `animation-delay` and `animation-play-state` carry no keyframes name, and a
		// gate that read their values would fail on every staggered list in the repo.
		const result = await runGate(`${PAIRED}
.b { animation-delay: 0.18s; animation-play-state: paused; animation-duration: 2s; }`);

		expect(result.exitCode).toBe(0);
	});

	it("treats every shorthand keyword as not-a-name", async () => {
		const result = await runGate(`${PAIRED}
.b { animation: none; }
.c { animation: piem-breathe 2s steps(4, end) 0.5s infinite alternate-reverse both paused; }
.d { animation: piem-breathe 1s cubic-bezier(0.16, 1, 0.3, 1) 3 reverse forwards; }`);

		expect(result.exitCode).toBe(0);
	});

	it("checks every layer of a comma-separated shorthand", async () => {
		const result = await runGate(`@keyframes pi-spin { to { transform: rotate(360deg); } }
.a { animation: pi-spin 1s linear infinite, pi-nowhere 2s ease both; }`);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("pi-nowhere");
		expect(result.output).not.toContain('names "pi-spin"');
	});

	it("reads animation-name as well as the shorthand", async () => {
		const result = await runGate(`@keyframes piem-breathe { 0% { opacity: 1; } }
.a { animation-name: piem-breathe; }`);

		expect(result.exitCode).toBe(0);
	});

	it("counts a name behind var() as unresolved rather than failing it", async () => {
		// Nothing static can follow a custom property, and guessing would make the
		// gate wrong in a direction that costs it its credibility.
		const result = await runGate(`${PAIRED}
.b { animation: var(--piem-anim) 1s linear infinite; }`);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("1 behind var() and unchecked");
	});

	it("accepts a vendor-prefixed definition for an unprefixed use", async () => {
		// Obsidian ships webkit, and a stylesheet that defines both would otherwise
		// have to name the prefixed block from somewhere to satisfy the reverse check.
		const result = await runGate(`@-webkit-keyframes pi-spin { to { transform: rotate(360deg); } }
@keyframes pi-spin { to { transform: rotate(360deg); } }
.a { animation: pi-spin 1s linear infinite; }`);

		expect(result.exitCode).toBe(0);
	});
});
