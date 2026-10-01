import { describe, expect, it } from "bun:test";
import { CodemodeSandbox } from "./sandbox";
import { QUICKJS_IIFE_SOURCE } from "./runtimeAsset";
import { CODEMODE_WORKER_SOURCE } from "./workerSource";

/**
 * The worker's shape, checked without running it.
 *
 * The source is a string, so an unescaped backtick or a `\n` where `\\n` was
 * meant type-checks cleanly and then fails inside the worker as a syntax error
 * the user never sees. Same reason `src/workflow/workerSource.test.ts` parses
 * its source: these are asserts about text, not about a running VM.
 *
 * They cannot run the VM. `bun test` evaluates this module without esbuild, so
 * {@link ./runtimeAsset} is the empty-constant version and the worker has no VM to
 * create. What runs the real thing is the WebKit and rig smokes; what runs a VM
 * under bun is {@link ./sandbox.test.ts}, which builds the sources itself.
 */
describe("CODEMODE_WORKER_SOURCE", () => {
	it("parses as JavaScript", () => {
		expect(() => new Function(CODEMODE_WORKER_SOURCE)).not.toThrow();
	});

	it("polyfills the disposal symbols before anything else", () => {
		// Order is the whole point: `quickjs-wasi` compiles to ES2018, so its
		// `using` desugaring reads `Symbol.dispose` on core paths. WebKit has
		// neither symbol, so a polyfill after the IIFE is no polyfill at all.
		// The polyfill line is the first statement of the source; the IIFE is
		// whatever `runtimeAsset` supplied — empty under a test, present in a
		// build — so the ordering is asserted on the text, not on the payload.
		const disposeAt = CODEMODE_WORKER_SOURCE.indexOf("Symbol.dispose =");
		expect(disposeAt).toBeGreaterThan(0);
		const iifeAt = QUICKJS_IIFE_SOURCE ? CODEMODE_WORKER_SOURCE.indexOf(QUICKJS_IIFE_SOURCE) : -1;
		if (iifeAt >= 0) expect(disposeAt).toBeLessThan(iifeAt);
	});

	it("polyfills both disposal symbols", () => {
		expect(CODEMODE_WORKER_SOURCE).toContain("Symbol.asyncDispose =");
		expect(CODEMODE_WORKER_SOURCE).toContain('Symbol("Symbol.dispose")');
		expect(CODEMODE_WORKER_SOURCE).toContain('Symbol("Symbol.asyncDispose")');
	});

	it("carries the prelude, the QuickJS runtime and the bridge", () => {
		expect(CODEMODE_WORKER_SOURCE).toContain("__QUICKJS_WASI__");
		// The prelude's own fingerprint: its factory signature.
		expect(CODEMODE_WORKER_SOURCE).toContain("codemode-prelude.js");
		expect(CODEMODE_WORKER_SOURCE).toContain("PRELUDE_TEXT");
		expect(CODEMODE_WORKER_SOURCE).toContain("self.onmessage");
	});

	it("installs no interrupt handler, and says why", () => {
		// pi's flag exists to stop a thread spinning inside wasm *on Bun*, which
		// `terminate()` cannot reach. A plain ArrayBuffer cannot replace it —
		// `postMessage` structured-clones it, so the worker would read a different
		// buffer than the host writes and the flag would never fire. Carrying it as
		// dead code under a comment calling it the graceful path is worse than not
		// having it.
		//
		// Asserted on the call, not the bare word: the comment explaining the absence
		// names it, and an assertion on the word would fail on its own prose.
		expect(CODEMODE_WORKER_SOURCE).not.toContain("interruptHandler:");
		expect(CODEMODE_WORKER_SOURCE).not.toContain("SharedArrayBuffer");
		expect(CODEMODE_WORKER_SOURCE).not.toContain("new Int32Array(interrupt)");
	});

	it("reports the bytes fd_write claims to have written", () => {
		// Returning 0 from the WASI discard makes libc believe nothing was written
		// and retry forever, which hangs the worker rather than failing it.
		expect(CODEMODE_WORKER_SOURCE).toContain("view.setUint32(nwrittenPtr, written, true)");
	});

	it("wraps the script so stack traces point at the model's own line 1", () => {
		// The wrapper's prefix shares line 1 with the body, which is what keeps a
		// reported line number equal to the line the model wrote.
		expect(CODEMODE_WORKER_SOURCE).toContain('"(async (tools, console) => {"');
	});

	it("registers exactly one host-call entry point", () => {
		// The prelude's closure is only a boundary if there is one way through it.
		const bridges = CODEMODE_WORKER_SOURCE.match(/VM\.newFunction\(/g) ?? [];
		expect(bridges).toHaveLength(1);
	});
});

describe("CodemodeSandbox validation", () => {
	it("rejects a duplicate tool name", () => {
		const sandbox = new CodemodeSandbox({ tools: [{ name: "read", execute: () => "a" }] });
		expect(() => sandbox.registerTool({ name: "read", execute: () => "b" })).toThrow(/already registered/);
	});

	it.each(["tools", "ALL_TOOLS", "console", "text", "image", "exit", "store", "load", "globalThis"])(
		"rejects a global shadowing the reserved name %s",
		name => {
			expect(() => new CodemodeSandbox({ globals: [{ name, execute: () => null }] })).toThrow(/Invalid global name/);
		},
	);

	it("rejects a global name that is not an identifier", () => {
		expect(() => new CodemodeSandbox({ globals: [{ name: "not-valid", execute: () => null }] })).toThrow(/Invalid global name/);
	});

	it("rejects a global with more than one dot", () => {
		expect(() => new CodemodeSandbox({ globals: [{ name: "a.b.c", execute: () => null }] })).toThrow(/Invalid global name/);
	});

	it("accepts a namespaced global", () => {
		const sandbox = new CodemodeSandbox({ globals: [{ name: "models.classify", execute: () => null }] });
		expect(sandbox.globals.map(global => global.name)).toEqual(["models.classify"]);
	});

	it("rejects a global that collides with its own namespace", () => {
		expect(() => new CodemodeSandbox({
			globals: [{ name: "models.classify", execute: () => null }, { name: "models", execute: () => null }],
		})).toThrow(/conflicts with the namespace/);
	});

	it("refuses to execute once closed", async () => {
		const sandbox = new CodemodeSandbox();
		await sandbox.close();
		await expect(sandbox.execute("1")).rejects.toThrow(/closed/);
	});
});
