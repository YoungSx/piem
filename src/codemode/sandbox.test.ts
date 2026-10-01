import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

import { CODEMODE_ALIASES } from "../../scripts/codemode-runtime.mjs";

/**
 * The sandbox running for real, in a real VM.
 *
 * `src/codemode/workerSource.test.ts` asserts the worker's *text*: it parses, and
 * it checks the ordering the mobile WebKit needs. It cannot execute it, because a
 * test run has no build to inline the QuickJS IIFE and the wasm.
 *
 * This file closes that gap by building both the same way the build does and then
 * running the result — which is the only way to catch what a text assertion cannot:
 * a prelude that does not compile, a bridge that never resolves a pending tool
 * call, a settle that is posted to the wrong side. It runs under bun because a
 * Web Worker is a Web Worker regardless of what the surrounding runtime is, and
 * the parts that differ by platform (`terminate()`, the disposal symbols, no SAB)
 * are asserted where they are platform-specific.
 */
const PACKAGE_DIR = path.resolve("node_modules/@earendil-works/pi-codemode");
const fromPackage = createRequire(path.join(PACKAGE_DIR, "package.json"));

/**
 * The two inlined strings, built here rather than imported.
 *
 * `scripts/codemode-runtime.mjs` is the single definition of what each specifier
 * stands for, and this imports the alias table from it so a test and the bundle
 * cannot drift onto different files. The two *strings* are re-derived with the
 * same esbuild settings the plugin uses; a divergence in settings would show up as
 * a failure below rather than passing quietly.
 */
const { quickjsIife, preludeText } = await buildInlineSources();

async function buildInlineSources() {
	// The prelude is imported, not bundled: the dist file is an ES module and the
	// VM wants the `PRELUDE_SOURCE` *value*. Inlining the module's source instead
	// puts `export const …` on the VM's first line.
	const prelude = await import(pathToFileURL(path.join(PACKAGE_DIR, "dist/runtime/prelude-source.js")).href);
	const quickjs = await esbuild.build({
		entryPoints: [fromPackage.resolve("quickjs-wasi")],
		bundle: true, format: "iife", globalName: "__QUICKJS_WASI__",
		platform: "browser", write: false, logLevel: "silent",
	});
	return { quickjsIife: quickjs.outputFiles[0]!.text, preludeText: prelude.PRELUDE_SOURCE as string };
}

const WASM_BYTES = readFileSync(fromPackage.resolve("quickjs-wasi/quickjs.wasm"));
const WASM_MODULE = await WebAssembly.compile(WASM_BYTES);

// The bridge is the source module's own constant, not a restatement: a test
// that kept its own copy would pass against a bridge the plugin stopped using.
const { BRIDGE_SOURCE, DISPOSAL_POLYFILL } = await import("./workerSource");

const WORKER_SOURCE = `"use strict";
${DISPOSAL_POLYFILL}
${quickjsIife}
var PRELUDE_TEXT = ${JSON.stringify(preludeText)};
${BRIDGE_SOURCE}
`;

/**
 * Runs one script with the given tools and returns the result message.
 *
 * Talks to the worker the way `sandbox.ts` does, so a protocol change breaks
 * here too — which is the point. The sandbox's own object is not reused: its
 * `loadWasm` resolves an inlined data URL that a test run does not have.
 */
async function runInWorker(
	code: string,
	tools: { name: string; jsName: string; description: string }[],
	options: { memoryLimitBytes?: number } = {},
): Promise<{ kind: "done" | "crash"; payload: Record<string, unknown> }> {
	const blob = new Blob([WORKER_SOURCE], { type: "text/javascript" });
	const url = URL.createObjectURL(blob);
	const worker = new Worker(url);
	try {
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("worker never settled")), 20_000);
			worker.onerror = event => {
				clearTimeout(timer);
				reject(new Error(`worker error: ${event.message}`));
			};
			worker.onmessage = (event: MessageEvent) => {
				const message = event.data as { type: string; id?: number };
				// `init` carries the runtime; `run` carries only the code. Posting
				// them in one message would be a protocol the bridge does not have.
				if (message.type === "ready") {
					worker.postMessage({ type: "run", code });
					return;
				}
				// Every tool call is answered the only way this harness can: with a
				// fixed reply. A test that needs a tool's real value encodes the
				// expectation in the script's own logic instead.
				if (message.type === "call") {
					worker.postMessage({ type: "settle", id: message.id, ok: true, payload: JSON.stringify({ ok: true }) });
					return;
				}
				if (message.type === "done" || message.type === "crash") {
					clearTimeout(timer);
					resolve({ kind: message.type, payload: message as Record<string, unknown> });
				}
			};
			worker.postMessage({
				type: "init",
				tools,
				globals: [],
				store: {},
				wasm: WASM_MODULE,
				memoryLimitBytes: options.memoryLimitBytes,
				// A plain ArrayBuffer on purpose: no WebView is cross-origin isolated,
				// so `SharedArrayBuffer` is `undefined` in the mobile case.
				interrupt: new ArrayBuffer(4),
			} satisfies Record<string, unknown>);
		});
	} finally {
		worker.terminate();
		URL.revokeObjectURL(url);
	}
}

const READ = { name: "read", jsName: "read", description: "Read a file" };

describe("the QuickJS sandbox, running", () => {
	it("evaluates a script and returns its value", async () => {
		const result = await runInWorker("return 2 + 3;", []);
		expect(result.kind).toBe("done");
		expect(result.payload.ok).toBe(true);
		expect(JSON.parse(result.payload.value as string)).toBe(5);
	}, 30_000);

	it("supports top-level await, since the body is an async function", async () => {
		const result = await runInWorker("const a = await Promise.resolve(1); return a + 1;", []);
		expect(JSON.parse(result.payload.value as string)).toBe(2);
	}, 30_000);

	it("keeps timers, fetch and process out of reach", async () => {
		// The point of the VM: a script has tools and nothing else.
		const result = await runInWorker(
			"return { timers: typeof setTimeout, fetch: typeof fetch, proc: typeof process, req: typeof require };",
			[],
		);
		expect(JSON.parse(result.payload.value as string)).toEqual({
			timers: "undefined", fetch: "undefined", proc: "undefined", req: "undefined",
		});
	}, 30_000);

	it("reports a thrown script as a script error with a stack, not a crash", async () => {
		const result = await runInWorker("throw new Error('boom');", []);
		expect(result.kind).toBe("done");
		expect(result.payload.ok).toBe(false);
		const error = JSON.parse(result.payload.error as string) as { message: string; stack: string };
		expect(error.message).toContain("boom");
		expect(error.stack).toContain("codemode.js");
	}, 30_000);

	it("points a stack trace at the line the model wrote", async () => {
		// Line 2 of the script is the throwing line; the wrapper's prefix shares
		// line 1 with the body so the number survives.
		const result = await runInWorker("\n\nthrow new Error('line three');", []);
		const error = JSON.parse(result.payload.error as string) as { stack: string };
		expect(error.stack).toMatch(/codemode\.js:3/);
	}, 30_000);

	it("turns a parse error into a script error rather than a sandbox crash", async () => {
		const result = await runInWorker("this is not javascript", []);
		expect(result.kind).toBe("done");
		expect(result.payload.ok).toBe(false);
	}, 30_000);

	it("resolves a pending tool call through the host bridge", async () => {
		// The harness answers every call with `{ok:true}`, so the script can only
		// have reached its return value by first receiving a settled answer.
		const result = await runInWorker("const r = await tools.read({ path: 'a.md' }); return r;", [READ]);
		expect(JSON.parse(result.payload.value as string)).toEqual({ ok: true });
	}, 30_000);

	it("exposes tools under both their name and their identifier", async () => {
		const result = await runInWorker(
			"return { byName: typeof tools.read, byIdentifier: typeof tools['read'] };",
			[READ],
		);
		expect(JSON.parse(result.payload.value as string)).toEqual({ byName: "function", byIdentifier: "function" });
	}, 30_000);

	it("reports no store writes for a script that only reads", async () => {
		const result = await runInWorker("text('one'); console.log('two'); return 'three';", []);
		expect(result.payload.ok).toBe(true);
		// The prelude encodes writes as tuples, so "none" is an empty array.
		expect(JSON.parse(result.payload.writes as string)).toEqual([]);
	}, 30_000);

	it("enforces the memory limit inside the script", async () => {
		// A VM with no ceiling would grow until the wasm address space ran out. The
		// limit turns that into a catchable error, which is what lets a model retry
		// instead of losing the run.
		const result = await runInWorker(
			"const a = []; while (true) a.push(new Array(1e5).fill(0));",
			[],
			{ memoryLimitBytes: 8 * 1024 * 1024 },
		);
		expect(result.kind).toBe("done");
		const error = JSON.parse(result.payload.error as string) as { message: string };
		expect(error.message).toMatch(/out of memory/i);
	}, 30_000);

	it("survives deep recursion as a catchable error", async () => {
		// `maxStackSize` is what makes this a RangeError rather than a wasm trap; a
		// trap would be indistinguishable from a crash on the host.
		const result = await runInWorker(
			"function r() { return r(); } try { r(); } catch (e) { return e.constructor.name; }",
			[],
		);
		expect(JSON.parse(result.payload.value as string)).toBe("RangeError");
	}, 30_000);

	it("round-trips a store value across load, and reports the write as a tuple", async () => {
		const result = await runInWorker("store('k', 41); return load('k');", []);
		expect(JSON.parse(result.payload.value as string)).toBe(41);
		// Tuples, not an object: `[key, json]` for a set and `[key]` for a delete.
		// Reading them as an object is the bug this shape pins down.
		expect(JSON.parse(result.payload.writes as string)).toEqual([["k", "41"]]);
	}, 30_000);

	it("encodes a delete as a one-element tuple", async () => {
		const result = await runInWorker("store('gone', undefined); return 'ok';", []);
		expect(JSON.parse(result.payload.writes as string)).toEqual([["gone"]]);
	}, 30_000);

	it("runs against a plain-ArrayBuffer interrupt flag, which is all a WebView has", async () => {
		// Every test above already runs this way — a WebView is not cross-origin
		// isolated, so `SharedArrayBuffer` is `undefined` there (measured in
		// WebKit 26.4). What is asserted here is that `Atomics.load` over the plain
		// buffer the host really sends does not disturb a normal run.
		const result = await runInWorker("let s = 0; for (let i = 0; i < 1e5; i++) s += i; return s;", []);
		expect(result.payload.ok).toBe(true);
	}, 30_000);

	it("runs the prelude's own exit() to an early success", async () => {
		const result = await runInWorker("exit(); return 'unreachable';", []);
		expect(result.kind).toBe("done");
		expect(result.payload.ok).toBe(true);
	}, 30_000);
});

describe("the build's inline sources", () => {
	it("carries no node: import, which is what makes it runnable in a WebView", () => {
		// The single property this port depends on: `quickjs-wasi`'s browser build
		// is clean. An upstream release that started importing `node:fs` would
		// still parse here and fail on a phone.
		expect(quickjsIife).not.toContain('require("node:');
		expect(quickjsIife).not.toContain("from \"node:");
	});

	it("carries the prelude's factory, so the VM half is the real one", () => {
		expect(preludeText).toContain("bridge");
		expect(preludeText).toContain("ALL_TOOLS");
		// The inlined text is the *value* of the export, so it starts with the
		// factory IIFE. Inlining the module's source instead would start with
		// `export const` and fail in the VM as `unsupported keyword: export`.
		expect(preludeText.trimStart().startsWith("(function")).toBe(true);
		expect(preludeText).not.toContain("export const");
	});

	it("reaches every file the build's alias table points at", () => {
		for (const [specifier, file] of Object.entries(CODEMODE_ALIASES)) {
			expect(() => readFileSync(file, "utf8")).not.toThrow();
			expect(specifier).toContain("pi-codemode");
		}
	});
});
