/**
 * The prelude: the JavaScript that runs *inside* the QuickJS VM.
 *
 * Kept upstream's, deliberately. This is ~11 KB that builds `tools`, `ALL_TOOLS`,
 * `text`, `image`, `exit`, `store`/`load` and the globals over a single closure-
 * held host bridge, and that closure is the whole boundary — the VM can reach
 * nothing but what the host hands it. pi has run its test suite against exactly
 * this text.
 *
 * It is imported as a string rather than evaluated here because the worker's
 * only input is text (a blob URL has no module graph), so every line it runs has
 * to be inlined before the worker starts. {@link ./runtimeAsset} holds the other
 * half.
 */
import { PRELUDE_SOURCE } from "../../node_modules/@earendil-works/pi-codemode/dist/runtime/prelude-source.js";
import { QUICKJS_IIFE_SOURCE } from "./runtimeAsset";

export const BRIDGE_SOURCE = `
var VM = null;
var api = null;
var TOOLS = [];
var GLOBALS = [];
var STORE = {};

function post(message) {
  self.postMessage(message);
}

function wasiDiscard(memory) {
  return {
    fd_write: function (fd, iovsPtr, iovsLen, nwrittenPtr) {
      var view = new DataView(memory.buffer);
      var written = 0;
      for (var i = 0; i < iovsLen; i++) written += view.getUint32(iovsPtr + i * 8 + 4, true);
      view.setUint32(nwrittenPtr, written, true);
      return 0;
    }
  };
}

// QuickJS stacks list frames only, so this is what a model reads back: the
// name and message V8 would have shown, then the QuickJS frames.
function describe(error) {
  var message = error && error.message ? String(error.message) : String(error);
  var name = error && error.name ? String(error.name) : "Error";
  var head = message ? name + ": " + message : name;
  var stack = error && typeof error.stack === "string" ? error.stack.replace(/\\s+$/, "") : "";
  return JSON.stringify({ name: name, message: message, stack: stack ? head + "\\n" + stack : head });
}

function crash(error) {
  post({ type: "crash", message: error && error.message ? String(error.message) : String(error) });
}

// No interrupt handler. pi installs one so Bun can stop a thread spinning inside
// wasm, which Bun's terminate() cannot reach; a plain ArrayBuffer cannot stand in
// for it, because postMessage structured-clones the buffer and the worker would
// read a different one from the one the host writes — the flag would look wired
// and never fire. The host ends a runaway script with terminate(), measured at
// 301 ms in WebKit, so nothing is lost by leaving it out.
function createVM(wasm, memoryLimitBytes) {
  return __QUICKJS_WASI__.QuickJS.create({
    wasm: wasm,
    memoryLimit: memoryLimitBytes,
    // Without this guard a deep recursion overflows the wasm stack and traps,
    // which the host cannot tell apart from a crash.
    maxStackSize: __QUICKJS_WASI__.MAX_STACK_SIZE,
    wasi: wasiDiscard
  });
}

// The one host-call entry point the prelude can reach. Everything a script does
// leaves the VM through here, which is what makes the prelude's closure a
// boundary rather than a convention.
function makeBridge() {
  return VM.newFunction("bridge", function (kind, a, b, c) {
    switch (kind.toString()) {
      case "call":
      case "global":
        post({
          type: "call",
          id: a.toNumber(),
          target: kind.toString() === "call" ? "tool" : "global",
          name: b.toString(),
          args: c === undefined || c.isUndefined ? undefined : c.toString()
        });
        break;
      case "output":
        post({
          type: "output",
          item: a.toString() === "image"
            ? { type: "image", data: b.toString(), mimeType: c.toString() }
            : { type: "text", text: b.toString() }
        });
        break;
      case "done":
        if (a.toBoolean()) {
          post({
            type: "done", ok: true,
            value: b === undefined || b.isUndefined ? undefined : b.toString(),
            writes: c.toString()
          });
        } else {
          post({ type: "done", ok: false, error: b.toString() });
        }
        break;
    }
    return VM.undefined;
  });
}

function drain() {
  // Run the microtasks a settled tool call produced, then let the prelude catch
  // a script that is waiting on nothing that can ever resume it.
  VM.executePendingJobs();
  VM.callFunction(api.getProp("stalled"), api).dispose();
}

function run(code) {
  try {
    api = VM.withScope(function (scope) {
      return scope.escape(VM.callFunction(
        VM.evalCode(PRELUDE_TEXT, "codemode-prelude.js"),
        VM.undefined,
        makeBridge(),
        VM.newString(JSON.stringify(TOOLS)),
        VM.newString(JSON.stringify(GLOBALS)),
        VM.newString(JSON.stringify(STORE))
      ));
    });
  } catch (error) {
    // A prelude that will not compile is a runtime fault rather than a script
    // fault; \`crash\` lets the host report it as \`sandbox\` and keep the two apart.
    crash(error);
    return;
  }

  var fn;
  try {
    // Both parameters are supplied by the prelude's \`run\`, which calls the
    // function and settles the result itself — so this wrapper only has to carry
    // the body. The prefix shares line 1 with the script, so a stack trace points
    // at the line the model actually wrote.
    fn = VM.evalCode("(async (tools, console) => {" + code + "\\n})", "codemode.js");
  } catch (error) {
    post({ type: "done", ok: false, error: describe(error) });
    return;
  }
  try {
    VM.callFunction(api.getProp("run"), api, fn).dispose();
    fn.dispose();
    drain();
  } catch (error) {
    post({ type: "done", ok: false, error: describe(error) });
  }
}

self.onmessage = function (event) {
  var message = event.data;
  if (message.type === "init") {
    TOOLS = message.tools || [];
    GLOBALS = message.globals || [];
    STORE = message.store || {};
    createVM(message.wasm, message.memoryLimitBytes).then(function (vm) {
      VM = vm;
      post({ type: "ready" });
    }, crash);
    return;
  }
  if (message.type === "run") {
    run(message.code);
    return;
  }
  if (message.type === "settle") {
    // The host finished a tool call and is handing back the answer.
    try {
      VM.withScope(function () {
        VM.callFunction(
          api.getProp("settle"), api,
          VM.newNumber(message.id),
          message.ok ? VM.true : VM.false,
          message.payload === undefined ? VM.undefined : VM.newString(message.payload)
        );
      });
      drain();
    } catch (error) {
      crash(error);
    }
  }
};
`;

/**
 * The complete worker script, as text.
 *
 * Four parts in a fixed order, and the order is load-bearing three times over:
 *
 * 1. `Symbol.dispose` / `Symbol.asyncDispose`. **This must come before anything
 *    else.** `quickjs-wasi` compiles to ES2018, so its `using` declarations
 *    desugar into a `__addDisposableResource` helper that reads
 *    `Symbol.dispose` — and that helper runs on core paths (property
 *    enumeration, `newString`, error handling). WebKit has neither symbol, so
 *    without this line the VM throws on ordinary work rather than on something
 *    exotic. Measured in Playwright WebKit 26.4: without it a 1e6-iteration
 *    script dies on `TypeError: Symbol.dispose is not defined`; with it the same
 *    script runs in 195 ms, no slower than the same script on V8.
 * 2. The `quickjs-wasi` IIFE, defining `__QUICKJS_WASI__`.
 * 3. The prelude text, bound to the name the bridge reads.
 * 4. This file's own bridge.
 *
 * The wasm bytes do not appear here — the host compiles them and passes the
 * `WebAssembly.Module` in the init message, which is structured-cloneable and
 * so survives the trip into the worker without a second copy on disk or a fetch.
 */
/**
 * The disposal-symbol polyfill, as a statement list.
 *
 * Guarded rather than assigned: `Symbol.dispose` is a **read-only** property on
 * the engines that have it, and this source is strict mode, so a bare assignment
 * throws `TypeError: Attempted to assign to readonly property` on exactly those
 * engines — while WebKit, which lacks the symbol and is the case the polyfill is
 * for, is the only one where the assignment was needed. Both halves were found by
 * running the worker, not by reading it.
 *
 * Exported so a test splices in the same lines the plugin runs rather than its own
 * copy, which is the failure this file already had once.
 */
export const DISPOSAL_POLYFILL = `if (!Symbol.dispose) Symbol.dispose = Symbol("Symbol.dispose");
if (!Symbol.asyncDispose) Symbol.asyncDispose = Symbol("Symbol.asyncDispose");`;

export const CODEMODE_WORKER_SOURCE = `"use strict";
// 1. WebKit (iOS, and desktop Safari) has neither symbol.
${DISPOSAL_POLYFILL}
// 2. The VM runtime.
${QUICKJS_IIFE_SOURCE}
// 3. The in-VM half, evaluated below rather than at parse time so the bridge
// that closes over it is already defined when the prelude's factory runs.
var PRELUDE_TEXT = ${JSON.stringify(PRELUDE_SOURCE)};
// 4. The host bridge.
${BRIDGE_SOURCE}
`;

/**
 * The host bridge, as text.
 *
 * A template of the worker half of pi's `runtime/worker.js`, with the parts a
 * WebView cannot have removed and the parts it can have spelled out:
 *
 * - `parentPort` becomes `onmessage`/`postMessage`.
 * - `workerData` becomes the init message the host posts first.
 * - The `SharedArrayBuffer` interrupt flag is gone rather than downgraded; see
 *   `createVM` for why a plain buffer cannot stand in for it.
 * - `wasi.fd_write` is a discard that *reports* the byte count. Returning 0
 *   makes libc believe nothing was written and retry forever.
 */


