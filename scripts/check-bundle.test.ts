import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "check-bundle.mjs");
const providers = "node_modules/@earendil-works/pi-ai/dist/providers/";
const agent = "node_modules/@earendil-works/pi-agent-core/dist/";
const codingAgent = "node_modules/@earendil-works/pi-coding-agent/";

async function gate(inputs: Record<string, { bytesInOutput: number }>) {
	const dir = mkdtempSync(join(tmpdir(), "piem-bundle-gate-"));
	try {
		const bundle = join(dir, "main.js");
		// One opaque import reproduces the existing ratchet. This file is
		// parsed, never evaluated; no request can leave the test process.
		writeFileSync(bundle, "module.exports = () => import(globalThis.specifier);");
		writeFileSync(`${bundle}.meta.json`, JSON.stringify({ outputs: { [bundle]: { inputs: {
			[`${agent}harness/env/nodejs.js`]: { bytesInOutput: 100 },
			[`${agent}harness/tools/edit-diff.js`]: { bytesInOutput: 100 },
			[`${agent}harness/session/jsonl/codec.js`]: { bytesInOutput: 100 },
			[`${codingAgent}dist/core/extensions/loader.js`]: { bytesInOutput: 100 },
			[`${codingAgent}dist/core/extensions/runner.js`]: { bytesInOutput: 100 },
			[`${codingAgent}dist/core/event-bus.js`]: { bytesInOutput: 100 },
			[`${codingAgent}examples/extensions/bookmark.ts`]: { bytesInOutput: 100 },
			...inputs,
		} } } }));
		const child = Bun.spawn(["node", script, bundle], { stdout: "pipe", stderr: "pipe" });
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
		]);
		return { exitCode, output: stdout + stderr };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("bundle composition after adding the public Node environment", () => {
	it("allows only the measured empty faux initializer", async () => {
		expect((await gate({ [`${providers}faux.js`]: { bytesInOutput: 17 } })).exitCode).toBe(0);
	});

	it("fails as soon as faux contributes more than its empty initializer", async () => {
		const result = await gate({ [`${providers}faux.js`]: { bytesInOutput: 18 } });
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("banned module in bundle");
	});

	it("keeps every other provider banned even with the same tiny contribution", async () => {
		const result = await gate({ [`${providers}openai.js`]: { bytesInOutput: 17 } });
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("banned module in bundle");
	});

	it("does not relax the SDK ban", async () => {
		const result = await gate({ "node_modules/openai/index.js": { bytesInOutput: 17 } });
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("banned module in bundle: node_modules/openai/");
	});

	it("requires Pi's filesystem to actually contribute to the bundle", async () => {
		const result = await gate({ [`${agent}harness/env/nodejs.js`]: { bytesInOutput: 0 } });
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("required module missing from bundle");
	});
	it("requires the original bookmark and keeps the terminal and dynamic loader out", async () => {
		expect((await gate({ [`${codingAgent}examples/extensions/bookmark.ts`]: { bytesInOutput: 0 } })).output).toContain("required module missing");
		for (const module of ["jiti/lib/jiti.mjs", "@earendil-works/pi-tui/dist/index.js", "highlight.js/lib/index.js", "cross-spawn/index.js"]) {
			expect((await gate({ [`node_modules/${module}`]: { bytesInOutput: 1 } })).output).toContain("banned module in bundle");
		}
	});
});
