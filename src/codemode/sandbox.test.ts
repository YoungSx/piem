import { describe, expect, it } from "bun:test";
import { buildCodemodeAssets } from "../../scripts/codemode-runtime.mjs";
import { PRELUDE_SOURCE as preludeText } from "../../node_modules/@earendil-works/pi-codemode/dist/runtime/prelude-source.js";

// Exercise the shipped worker and the exact assets produced by the release build.
const { quickjs: quickjsIife, wasm: WASM_BYTES } = await buildCodemodeAssets();
const WASM_MODULE = await WebAssembly.compile(WASM_BYTES);

// The bridge is the source module's own constant, not a restatement: a test
// that kept its own copy would pass against a bridge the plugin stopped using.
const { BRIDGE_SOURCE, DISPOSAL_POLYFILL } = await import("./workerSource");
const { CodemodeSandbox: CodemodeSandboxClass } = await import("./sandbox");
// Imported as a value (the worker harness needs the constructor) and as a type
// (the return annotations below). A dynamic `await import` binding satisfies
// only the first, so the type is spelled out here rather than left to inference.
type CodemodeSandbox = InstanceType<typeof CodemodeSandboxClass>;
const CodemodeSandbox = CodemodeSandboxClass;
const { stubWindowMembers } = await import("../testUtils/windowStub");

// `window` for the sandbox's deadline. Obsidian always has one, and the sandbox
// reads it so a popout window's timer throttle cannot fire
// (`obsidianmd/prefer-window-timers`). Bun has none, so the stub is what makes
// `execute` reachable here; the timers are the real ones, so a deadline still
// expires.
stubWindowMembers({
	setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
	clearTimeout: (...args: Parameters<typeof clearTimeout>) => clearTimeout(...args),
});

const WORKER_SOURCE = `"use strict";
${DISPOSAL_POLYFILL}
${quickjsIife}
var PRELUDE_TEXT = ${JSON.stringify(preludeText)};
${BRIDGE_SOURCE}
`;

/**
 * Runs one script with the given tools and returns the result message.
 *
 * Talks to the worker directly, so a protocol change breaks here too. The
 * sandbox's own class is exercised separately below, with the wasm handed in.
 */
async function runInWorker(
	code: string,
	tools: { name: string; jsName: string; description: string }[],
	options: { memoryLimitBytes?: number; onCall?: (name: string, args: unknown) => { ok: boolean; value?: unknown; error?: string } } = {},
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
				const message = event.data as { type: string; id?: number; name?: string; args?: string };
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
					// Default: every call succeeds with a fixed value. A test that cares
					// what the script receives passes its own responder.
					const reply = options.onCall?.(message.name ?? "", message.args === undefined ? undefined : JSON.parse(message.args))
						?? { ok: true, value: { ok: true } };
					// The prelude parses the success payload and rejects with the error
					// one verbatim, so encoding both would put quotes in a script's
					// `catch (e) { e.message }`. This mirrors that asymmetry on purpose.
					worker.postMessage({
						type: "settle",
						id: message.id,
						ok: reply.ok,
						payload: reply.ok ? JSON.stringify(reply.value ?? null) : (reply.error ?? "failed"),
					});
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

	it("runs with no interrupt flag at all, which is all a WebView leaves us", async () => {
		// A WebView is not cross-origin isolated, so `SharedArrayBuffer` is
		// `undefined` there (measured in WebKit 26.4) and no flag can cross the worker
		// boundary. `terminate()` is the mechanism; a normal run must be undisturbed
		// by its absence.
		const result = await runInWorker("let s = 0; for (let i = 0; i < 1e5; i++) s += i; return s;", []);
		expect(result.payload.ok).toBe(true);
		expect(JSON.parse(result.payload.value as string)).toBe(4999950000);
	}, 30_000);

	it("runs the prelude's own exit() to an early success", async () => {
		const result = await runInWorker("exit(); return 'unreachable';", []);
		expect(result.kind).toBe("done");
		expect(result.payload.ok).toBe(true);
	}, 30_000);
});

describe("a script's nested call", () => {
	it("reaches the host with the arguments it passed, and the host's value reaches the script", async () => {
		const routed: string[] = [];
		const result = await runInWorker(
			"const body = await tools.read({ path: 'a.md' }); return body.length;",
			[READ],
			{
				onCall: (name, args) => {
					routed.push(`${name}:${String((args as { path?: string } | undefined)?.path ?? "")}`);
					return { ok: true, value: `contents of ${(args as { path?: string }).path}` };
				},
			},
		);
		expect(routed).toEqual(["read:a.md"]);
		// The script counted real characters, which it could only do by receiving the
		// host's string rather than the default reply.
		expect(JSON.parse(result.payload.value as string)).toBe("contents of a.md".length);
	}, 30_000);

	it("rejects in the script when the host reports the call failed", async () => {
		// A failure must not look like `undefined`: a script that cannot tell a
		// failure from an empty result writes the empty result into a note.
		const result = await runInWorker(
			"try { await tools.read({ path: 'missing.md' }); return 'no throw'; } catch (e) { return e.message; }",
			[READ],
			{ onCall: () => ({ ok: false, error: "no such note" }) },
		);
		expect(result.payload.ok).toBe(true);
		expect(JSON.parse(result.payload.value as string)).toBe("no such note");
	}, 30_000);

	it("lets a script retry a call that failed", async () => {
		// The reason a failure rejects rather than returning `undefined`: a script
		// can decide the miss is survivable and try something else.
		const result = await runInWorker(
			"let body; try { body = await tools.read({ path: 'a.md' }); } catch { body = await tools.read({ path: 'b.md' }); } return body;",
			[READ],
			{ onCall: (_name, args) => ((args as { path: string }).path === "b.md" ? { ok: true, value: "found b" } : { ok: false, error: "missing" }) },
		);
		expect(JSON.parse(result.payload.value as string)).toBe("found b");
	}, 30_000);

	it("reports a failed call as an error record, not a success", async () => {
		const result = await runInWorker("try { await tools.read({}); } catch {} return 'done';", [READ], {
			onCall: () => ({ ok: false, error: "nope" }),
		});
		expect(result.payload.ok).toBe(true);
	}, 30_000);
});

it("ALL_TOOLS exposes parameter declarations and callable identifiers for discovery", async () => {
	const sandbox = new CodemodeSandbox({
		wasm: WASM_MODULE,
		workerSource: WORKER_SOURCE,
		timeoutMs: 5_000,
		tools: [{
			name: "read-note",
			description: "Read a note.",
			inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			execute: async (args) => args,
		}],
	});
	try {
		const result = await sandbox.execute(`
			const [tool] = ALL_TOOLS.filter(t => /note/i.test(t.name + " " + t.description));
			text(tool.description);
			return await tools[tool.name]({ path: "a.md" });
		`);
		expect(result.ok).toBe(true);
		expect(result.ok && result.value).toEqual({ path: "a.md" });
		expect(result.calls).toMatchObject([{ name: "read-note", status: "ok" }]);
		const description = result.output
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map(item => item.text)
			.join("\n");
		expect(description).toContain("read_note(args:");
		expect(description).toContain("path: string");
	} finally {
		await sandbox.close();
	}
});

/**
 * The sandbox's own class, driven end to end.
 *
 * Every other block here talks to the worker directly, which means none of them
 * covers `CodemodeSandbox.execute` — the init/run handshake, the call relay, the
 * finish path. A build that omitted the `run` post passed all sixty of them and
 * hung in a real Obsidian for the full five-minute deadline. So these go through
 * the class, with the wasm handed in through upstream's `wasm` option, because a
 * test run has no inlined data URL to decode.
 */
describe("CodemodeSandbox.execute", () => {
	const tools = [{
		name: "read",
		description: "Read a note.",
		execute: async (args: unknown) => `contents of ${(args as { path: string }).path}`,
	}];

	function sandboxWith(onCall?: (name: string, args: unknown) => unknown): { sandbox: CodemodeSandbox; routed: string[] } {
		const routed: string[] = [];
		const sandbox = new CodemodeSandbox({
			wasm: WASM_MODULE,
			// The same script the build inlines, built here because a test run has no
			// build. That is the whole point of the option: without it, `execute` is
			// only reachable in a real Obsidian.
			workerSource: WORKER_SOURCE,
			timeoutMs: 15_000,
			tools: [{
				name: "read",
				description: "Read a note.",
				execute: async (args) => {
					routed.push(`read:${(args as { path: string }).path}`);
					return onCall ? onCall("read", args) : `contents of ${(args as { path: string }).path}`;
				},
			}],
		});
		return { sandbox, routed };
	}

	it("runs a script and returns its value", async () => {
		const { sandbox } = sandboxWith();
		const result = await sandbox.execute("return 2 + 3;");
		expect(result.ok ? result.value : JSON.stringify(result)).toBe(5);
		await sandbox.close();
	}, 30_000);

	// The regression: `ready` arrives and the host must post `run` on it. Without
	// that post the worker idles and the call waits out the whole deadline, which is
	// indistinguishable from a hang in a real vault.
	it("posts the script once the worker reports its VM is ready", async () => {
		const { sandbox, routed } = sandboxWith();
		const result = await sandbox.execute("const body = await tools.read({ path: 'a.md' }); return body;");
		expect(routed).toEqual(["read:a.md"]);
		expect(result.ok).toBe(true);
		await sandbox.close();
	}, 30_000);

	it("reports a thrown script as a script error, not a sandbox fault", async () => {
		const { sandbox } = sandboxWith();
		const result = await sandbox.execute("throw new Error('boom');");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("script");
			expect(result.error.message).toContain("boom");
		}
		await sandbox.close();
	}, 30_000);

	// A spinning script is the one the deadline exists for: the prelude's own guard
	// only catches a promise that can never settle, not a loop that never yields.
	it("times out a script that spins, and terminates its worker", async () => {
		const { sandbox } = sandboxWith();
		const started = Date.now();
		const result = await sandbox.execute("while (true) {}", { timeoutMs: 1_000 });
		expect(Date.now() - started).toBeLessThan(15_000);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("timeout");
		await sandbox.close();
	}, 30_000);

	it("aborts when the caller's signal fires", async () => {
		const { sandbox } = sandboxWith();
		const controller = new AbortController();
		const pending = sandbox.execute("await new Promise(() => {});", { signal: controller.signal });
		controller.abort(new Error("user stopped"));
		const result = await pending;
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("aborted");
		await sandbox.close();
	}, 30_000);

	it("reports a call's outcome and its duration", async () => {
		const { sandbox } = sandboxWith();
		const result = await sandbox.execute("await tools.read({ path: 'x.md' }); return 1;");
		expect(result.calls).toHaveLength(1);
		expect(result.calls[0]).toMatchObject({ name: "read", status: "ok" });
		expect(result.calls[0]?.durationMs).toBeGreaterThanOrEqual(0);
		await sandbox.close();
	}, 30_000);

	it("records a failed call as an error, so the panel can say so", async () => {
		const { sandbox } = sandboxWith(() => { throw new Error("no such note"); });
		const result = await sandbox.execute("try { await tools.read({ path: 'y.md' }); } catch {} return 1;");
		expect(result.calls[0]).toMatchObject({ name: "read", status: "error" });
		await sandbox.close();
	}, 30_000);

	it("collects the script's printed output in order, and keeps the return value apart", async () => {
		// The distinction is load-bearing: `text()` is what the model reads as the
		// script's narration, `return` is its answer. The tool layer appends the
		// value after the output rather than merging them, so a script that both
		// prints and returns does not have its answer land mid-narration.
		const { sandbox } = sandboxWith();
		const result = await sandbox.execute("text('one'); text('two'); return 'three';");
		expect(result.output.filter(item => item.type === "text").map(item => (item.type === "text" ? item.text : ""))).toEqual(["one", "two"]);
		expect(result.ok && result.value).toBe("three");
		await sandbox.close();
	}, 30_000);

	it("round-trips a store write back as writes, and leaves the caller's store alone", async () => {
		const { sandbox } = sandboxWith();
		const store: Record<string, unknown> = { kept: 1 };
		const result = await sandbox.execute("store('k', 41); return load('kept');", { store });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe(1);
			expect(result.storeWrites.set).toEqual({ k: 41 });
		}
		// The store belongs to the caller: the sandbox reports writes, it does not
		// apply them.
		expect(store).toEqual({ kept: 1 });
		await sandbox.close();
	}, 30_000);

	it("enforces the memory limit inside the script", async () => {
		const sandbox = new CodemodeSandbox({ wasm: WASM_MODULE, workerSource: WORKER_SOURCE, timeoutMs: 15_000, memoryLimitBytes: 8 * 1024 * 1024 });
		const result = await sandbox.execute("const a = []; while (true) a.push(new Array(1e5).fill(0));");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toMatch(/out of memory/i);
		await sandbox.close();
	}, 30_000);

	it("survives one run not poisoning the next", async () => {
		// One worker and one VM per execution is what buys this: a runaway script is
		// terminated, and the next call gets a clean runtime.
		const first = sandboxWith();
		await first.sandbox.execute("while (true) {}", { timeoutMs: 50 });
		await first.sandbox.close();
		const second = sandboxWith();
		const result = await second.sandbox.execute("return 'clean';");
		expect(result.ok).toBe(true);
		await second.sandbox.close();
	}, 30_000);

	it("surfaces a throwing tool as a rejection the script can catch", async () => {
		const { sandbox } = sandboxWith(() => { throw new Error("no such note"); });
		const result = await sandbox.execute(
			"let caught = null; try { await tools.read({ path: 'z.md' }); } catch (e) { caught = e.message; } return caught;",
		);
		expect(result.ok).toBe(true);
		// Verbatim, not JSON-encoded: the prelude rejects with the payload as the
		// message, so quoting it here would put quotes in a script's own error text.
		if (result.ok) expect(result.value).toBe("no such note");
		await sandbox.close();
	}, 30_000);

	it("fails at once on a script that waits on nothing that can settle", async () => {
		// The prelude's own guard: no pending tool call and no timers means the wait
		// is unresolvable. It reports a script error immediately rather than burning
		// the deadline, which is the difference between a model that can retry and
		// one that waits out the clock.
		const { sandbox } = sandboxWith();
		const started = Date.now();
		const result = await sandbox.execute("await new Promise(() => {});");
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("script");
			expect(result.error.message).toMatch(/never settle|stalled/i);
		}
		await sandbox.close();
	}, 30_000);
});

describe("sequential tools", () => {
	it("runs a sequential tool one at a time, however the script fans out", async () => {
		// `executionMode: "sequential"` is the *primary* serialization for the
		// frontmatter, navigation, interaction and sequential MCP tools, none of
		// which has an internal lock. A sandbox that dispatched every call at once
		// would drop the pin, and `Promise.all` over a loop is ordinary output.
		let inFlight = 0;
		let peak = 0;
		const order: number[] = [];
		const sandbox = new CodemodeSandbox({
			wasm: WASM_MODULE,
			workerSource: WORKER_SOURCE,
			timeoutMs: 15_000,
			tools: [{
				name: "write",
				sequential: true,
				execute: async (args) => {
					inFlight++;
					peak = Math.max(peak, inFlight);
					await Bun.sleep(5);
					order.push((args as { n: number }).n);
					inFlight--;
					return (args as { n: number }).n;
				},
			}],
		});
		const result = await sandbox.execute(
			"await Promise.all([0,1,2,3,4].map(n => tools.write({ n }))); return 'done';",
		);
		expect(result.ok).toBe(true);
		expect(peak).toBe(1);
		// Order is preserved, so a second caller cannot interleave either.
		expect(order).toEqual([0, 1, 2, 3, 4]);
		await sandbox.close();
	}, 30_000);

	it("leaves a non-sequential tool free to run in parallel", async () => {
		// The lane is only for tools that asked for it; serializing everything would
		// throw away the concurrency the sandbox exists to provide.
		let inFlight = 0;
		let peak = 0;
		const sandbox = new CodemodeSandbox({
			wasm: WASM_MODULE,
			workerSource: WORKER_SOURCE,
			timeoutMs: 15_000,
			tools: [{
				name: "read",
				execute: async () => {
					inFlight++;
					peak = Math.max(peak, inFlight);
					await Bun.sleep(5);
					inFlight--;
					return "ok";
				},
			}],
		});
		await sandbox.execute("await Promise.all([0,1,2,3,4].map(() => tools.read({}))); return 'done';");
		expect(peak).toBeGreaterThan(1);
		await sandbox.close();
	}, 30_000);

	it("releases the lane when a sequential tool throws", async () => {
		// Otherwise one failure wedges every later sequential call in the script.
		const sandbox = new CodemodeSandbox({
			wasm: WASM_MODULE,
			workerSource: WORKER_SOURCE,
			timeoutMs: 15_000,
			tools: [{
				name: "write",
				sequential: true,
				execute: async (args) => {
					if ((args as { n: number }).n === 0) throw new Error("first failed");
					return (args as { n: number }).n;
				},
			}],
		});
		const result = await sandbox.execute(
			"let caught = null; try { await tools.write({ n: 0 }); } catch (e) { caught = e.message; } const after = await tools.write({ n: 1 }); return caught + '|' + after;",
		);
		expect(result.ok ? result.value : JSON.stringify(result)).toBe("first failed|1");
		await sandbox.close();
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

});

describe("cancelling queued writes", () => {
	it.each(["abort", "close", "timeout"] as const)("does not start a queued call after %s", async end => {
		let release!: () => void;
		let started!: () => void;
		const holding = new Promise<void>(resolve => { release = resolve; });
		const firstStarted = new Promise<void>(resolve => { started = resolve; });
		const calls: number[] = [];
		const controller = new AbortController();
		const sandbox = new CodemodeSandbox({
			wasm: WASM_MODULE, workerSource: WORKER_SOURCE, timeoutMs: end === "timeout" ? 100 : 5_000,
			tools: [{ name: "write", sequential: true, execute: async args => {
				const n = (args as { n: number }).n;
				calls.push(n);
				if (n === 1) { started(); await holding; }
				return n;
			} }],
		});
		try {
			const run = sandbox.execute("await Promise.all([tools.write({n:1}), tools.write({n:2})]);", { signal: controller.signal });
			await firstStarted;
			await new Promise(resolve => setTimeout(resolve, 10));
			if (end === "abort") controller.abort();
			else if (end === "close") await sandbox.close();
			const result = await run;
			expect(result.ok).toBe(false);
			release();
			await new Promise(resolve => setTimeout(resolve, 10));
			expect(calls).toEqual([1]);
			expect(result.calls.map(call => call.status)).toEqual(["cancelled", "cancelled"]);
		} finally { release(); await sandbox.close(); }
	});
});

const { createCodemodeTool } = await import("./tool");
const { Type } = await import("typebox");
describe("browser codemode tool contract", () => {
	const runtime = { wasm: WASM_MODULE, workerSource: WORKER_SOURCE };
	const emptyHost = () => ({ tools: () => [], executeTool: async () => ({ content: [], details: undefined }) });

	it("uses the documented deadline unless explicitly overridden", async () => {
		const original = window.setTimeout;
		const deadlines: number[] = [];
		window.setTimeout = ((handler: TimerHandler, timeout?: number) => {
			deadlines.push(timeout ?? 0);
			return original(handler, timeout);
		}) as typeof window.setTimeout;
		try {
			const tool = createCodemodeTool(emptyHost, runtime);
			await tool.execute("default", { code: "return 1" });
			await tool.execute("override", { code: '// @options: {"timeout_ms": 500}\nreturn 1' });
			await tool.execute("clamp", { code: '// @options: {"timeout_ms": 900000}\nreturn 1' });
			expect(deadlines).toEqual([120_000, 500, 600_000]);
		} finally { window.setTimeout = original; }
	});

	it("bounds printing and the return value together, preserving head and tail", async () => {
		const tool = createCodemodeTool(emptyHost, runtime);
		const result = await tool.execute("budget", { code: '// @options: {"max_output_tokens": 20}\ntext("a".repeat(80)); return "z".repeat(80)' });
		const text = JSON.stringify(result.content);
		expect(text).toContain("truncated output");
		expect(text).toContain("a".repeat(40));
		expect(text).toContain("z".repeat(40));
		expect(text).not.toContain("z".repeat(41));
		expect(result.isError).toBe(false);
	});

	it("bounds errors too, without treating base64 images as text tokens", async () => {
		const tool = createCodemodeTool(emptyHost, runtime);
		const result = await tool.execute("error", { code: '// @options: {"max_output_tokens": 20}\nimage("data:image/png;base64,aGVsbG8="); throw new Error("x".repeat(1000))' });
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).not.toContain("x".repeat(100));
		expect(result.content).toContainEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
	});

	it("returns strings unquoted, as text() does", async () => {
		const result = await createCodemodeTool(emptyHost, runtime).execute("string", { code: 'return "hello"' });
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("honors outputSchema, including structured MCP error results", async () => {
		const tools = [false, true].map(structured => ({
			name: structured ? "structured" : "textual", label: "probe", description: "Probe",
			parameters: Type.Object({}), ...(structured ? { outputSchema: Type.Object({ isError: Type.Boolean() }) } : {}),
			execute: async () => ({ content: [], details: undefined }),
		}));
		const tool = createCodemodeTool(() => ({ tools: () => tools, executeTool: async () => ({
			content: [{ type: "text" as const, text: "failed" }], details: undefined, isError: true, structuredContent: { isError: true },
		}) }), runtime);
		const result = await tool.execute("schema", { code: 'text(await tools.structured({})); try { await tools.textual({}); } catch(e) { text(e.message); }' });
		expect(result.content).toEqual([{ type: "text", text: '{"isError":true}' }, { type: "text", text: "failed" }]);
	});

	it("commits only successful store writes and captures the host before awaiting", async () => {
		let saved: Record<string, unknown> = {};
		let writes = 0;
		let owner = "first";
		const tool = createCodemodeTool(() => {
			const captured = owner;
			return { ...emptyHost(),
				readStore: async () => { owner = "second"; return saved; },
				writeStore: async (changes: import("@earendil-works/pi-codemode").CodemodeStoreWrites) => {
					expect(captured).toBe("first");
					writes++;
					for (const key of changes.delete) delete saved[key];
					saved = { ...saved, ...changes.set };
				},
			};
		}, runtime);
		await tool.execute("set", { code: 'store("n", 41)' });
		expect(saved).toEqual({ n: 41 });
		owner = "first";
		const failed = await tool.execute("failed", { code: 'store("n", 99); throw new Error("no")' });
		expect(failed.isError).toBe(true);
		expect(saved).toEqual({ n: 41 });
		owner = "first";
		const loaded = await tool.execute("load", { code: 'text(load("n")); store("n", undefined)' });
		expect(loaded.content).toEqual([{ type: "text", text: "41" }]);
		expect(saved).toEqual({});
		expect(writes).toBe(2);
	});
});
