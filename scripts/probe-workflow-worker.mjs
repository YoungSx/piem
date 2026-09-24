/**
 * Isolated parse + run smoke for WORKER_SOURCE (not the vault harness).
 * Node's worker_threads gives us a real thread; the worker source speaks the
 * Web Worker API (self/onmessage/postMessage), so we shim those three onto the
 * node parentPort before eval-ing the source. Proves: the template parses, the
 * AsyncFunction compile runs a real script with top-level await, the RPC/init
 * handshake works, parallel/pipeline/phase/log flow, and the determinism
 * prelude fires. Run: node scripts/probe-workflow-worker.mjs
 */
import { Worker } from "node:worker_threads";

// Import the real module (node strips the trivial types) so WORKER_SOURCE is
// the exact runtime string, interpolation resolved — no fragile regex extract.
const { WORKER_SOURCE } = await import("../src/workflow/workerSource.ts");
const { extractMeta } = await import("../src/workflow/meta.ts");
const workerBody = WORKER_SOURCE;

const shim = `
const { parentPort } = require("node:worker_threads");
const self = {
  onmessage: null,
  postMessage: (m) => parentPort.postMessage(m),
};
globalThis.self = self;
parentPort.on("message", (m) => { if (self.onmessage) self.onmessage({ data: m }); });
${workerBody}
`;

const worker = new Worker(shim, { eval: true });
const scriptSource = [
  'export const meta = { name: "probe", description: "d", phases: [{ title: "P" }] };',
  'phase("P");',
  'log("hello from script");',
  'const a = await agent("one");',
  'const b = await parallel([() => agent("two"), () => agent("three")]);',
  'const c = await pipeline([1, 2], (n) => agent("stage:" + n));',
  'let clockThrew = false;',
  'try { Date.now(); } catch (e) { clockThrew = true; }',
  'let selfBlinded = (typeof self === "undefined");',
  'return { a, b, c, clockThrew, selfBlinded, spent: budget.spent() };',
].join("\n");

const meta = extractMeta(scriptSource);
console.log("meta:", JSON.stringify(meta.meta));

const calls = [];
worker.on("message", (m) => {
  if (m.type === "call" && m.method === "agent") {
    calls.push(m.payload.prompt);
    worker.postMessage({ type: "response", callId: m.callId, ok: true, value: "ok:" + m.payload.prompt, spent: calls.length * 10 });
  } else if (m.type === "progress") {
    for (const e of m.entries) console.log("  progress:", e.type, e.title ?? e.message ?? e.label ?? "");
  } else if (m.type === "complete") {
    const result = m.resultJson ? JSON.parse(m.resultJson) : undefined;
    console.log("RESULT:", JSON.stringify(result));
    const ok = result?.a === "ok:one"
      && result?.b?.length === 2 && result.b[1] === "ok:three"
      && result?.c?.length === 2 && result.c[0] === "ok:stage:1"
      && result?.clockThrew === true
      && result?.selfBlinded === true
      && result?.spent === calls.length * 10;
    console.log(ok ? "PASS ✅" : "FAIL ❌", "calls:", calls.length);
    worker.terminate();
    process.exit(ok ? 0 : 1);
  } else if (m.type === "error") {
    console.error("WORKER ERROR:", m.message, "\n", m.stack);
    worker.terminate();
    process.exit(1);
  }
});
worker.postMessage({ type: "init", body: meta.body, argsJson: undefined, itemCap: 4096, nestedCap: 256 });
setTimeout(() => { console.error("timeout"); worker.terminate(); process.exit(3); }, 10000);
