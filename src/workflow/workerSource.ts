/**
 * workerSource.ts — the JavaScript that runs inside the workflow Web Worker.
 *
 * Ported from tintinweb/pi-subagents' `worker-source.ts`. The source is an
 * inlined string because a blob-URL worker needs its text at runtime and a file
 * path would not survive bundling; the worker is plain JavaScript and never
 * sees the TypeScript pipeline. `workerSource.test.ts` parses it, because an
 * unescaped backtick or a `\n` where `\\n` was meant type-checks cleanly and
 * then fails at runtime as "missing ) after argument list" inside the worker.
 *
 * ## Boundaries, and why this port is thinner than upstream
 *
 * Upstream stacks two boundaries: host ⇄ worker (for *killability* —
 * `terminate()` stops a runaway script mid-loop, which an in-process `vm`
 * timeout cannot do once the script is inside an `await`) and worker ⇄ vm
 * context (for determinism and accident-avoidance).
 *
 * A WebView has no `node:vm`, so this port keeps the first boundary and folds
 * the second into the worker itself: the worker realm IS the script's realm.
 * The script compiles with the AsyncFunction constructor inside the worker, and
 * the names it must not reach — the RPC channel, the network, timers — are
 * shadowed by function *parameters* bound to `undefined`, the one shadowing a
 * global cannot climb over.
 *
 * What is genuinely lost, stated plainly: upstream's `codeGeneration: false`
 * made `Function("…")` throw inside the realm, so a script could not compile
 * code at all. A worker cannot turn that off, so a script that means to escape
 * the shadowing can — via `(function(){}).constructor` — and reach the worker's
 * globals. Upstream's own header calls its boundary "a determinism boundary,
 * not a security boundary against a hostile script", and that is what remains:
 * the shadowing stops accidents, the prelude keeps replay deterministic, and
 * the worker keeps a runaway script killable. Workflow scripts here are
 * model-authored under a user who asked for orchestration, not hostile input.
 *
 * ## Init arrives as the first message
 *
 * Upstream reads `workerData`; a Web Worker built from a blob URL has no data
 * channel, so the host posts `{type:"init", …}` immediately after the worker is
 * constructed and `main()` awaits it.
 */

/**
 * Runs ahead of the script body; reassigns the clock in-realm so replay is
 * deterministic. It captures the real Date/Math through `__wfRealDate` /
 * `__wfRealMath` — worker-scope vars the script's parameter shadowing does not
 * cover — rather than `globalThis`, which IS shadowed to undefined and would
 * throw here. `const Date` inside cannot reference `Date` (temporal dead zone),
 * so the capture is the only way in.
 */
const DETERMINISM_PRELUDE =
	"const Date = (function () {" +
	" const RealDate = __wfRealDate;" +
	" const die = function (what) {" +
	" throw new Error(what + \" is unavailable in workflow scripts (breaks resume).\");" +
	" };" +
	" RealDate.now = function () { return die(\"Date.now()\"); };" +
	" __wfRealMath.random = function () { return die(\"Math.random()\"); };" +
	" return class WorkflowDate extends RealDate {" +
	" constructor() { if (arguments.length === 0) die(\"new Date()\"); super(...arguments); }" +
	"};" +
	"})();";

export const WORKER_SOURCE = `"use strict";

var PRELUDE = ${JSON.stringify(DETERMINISM_PRELUDE)};

/* Names the compiled script must not see, shadowed as function parameters bound
 * to undefined: the RPC channel itself, the network, and the timers whose
 * scheduling is not replayable. The worker's own helpers (callHost, emit) close
 * over the real globals, so only the script body is blinded. */
var SHADOWED = [
  "self", "globalThis", "postMessage", "onmessage", "onerror",
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts",
  "Worker", "SharedWorker", "indexedDB", "caches", "navigator", "location",
  "close", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "requestAnimationFrame", "queueMicrotask", "performance"
];

var AsyncFunction = (async function () {}).constructor;

/* Init and the RPC responses share one channel, registered synchronously before
 * main() runs: the host posts init the moment the worker is constructed, and a
 * listener attached later would miss it. */
var pendingInit = null;
var initResolve = null;
var initOnce = new Promise(function (resolve) { initResolve = resolve; });

var nextCallId = 1;
var pendingCalls = new Map();
var spentOutput = 0;
var nestedCount = 0;

self.onmessage = function (event) {
  var message = event && event.data;
  if (!message) return;
  if (message.type === "init") {
    pendingInit = message;
    if (initResolve) initResolve(message);
    return;
  }
  if (message.type !== "response") return;
  if (typeof message.spent === "number") spentOutput = message.spent;
  var waiter = pendingCalls.get(message.callId);
  if (!waiter) return;
  pendingCalls.delete(message.callId);
  if (message.ok) { waiter.resolve(message.value); return; }
  var error = new Error(message.error || "The workflow host rejected the call.");
  if (message.fatal) error.workflowFatal = true;
  waiter.reject(error);
};

function isFatal(error) {
  return !!(error && typeof error === "object" && error.workflowFatal === true);
}

function callHost(method, payload) {
  // Drain first, so the phase() that named this agent reaches the host ahead of
  // the agent entry rather than a tick behind it.
  flushProgress();
  return new Promise(function (resolve, reject) {
    var callId = nextCallId++;
    pendingCalls.set(callId, { resolve: resolve, reject: reject });
    self.postMessage({ type: "call", callId: callId, method: method, payload: payload });
  });
}

/* Progress entries, batched on a macrotask: a fan-out emits a burst of
 * phase/log entries in one turn, and the host renders once per batch. */
var progressQueue = [];
var flushTimer = null;

function emit(entry) {
  progressQueue.push(entry);
  if (flushTimer === null) flushTimer = setTimeout(flushProgress, 0);
}

function flushProgress() {
  if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
  if (progressQueue.length === 0) return;
  var batch = progressQueue;
  progressQueue = [];
  self.postMessage({ type: "progress", entries: batch });
}

/* The JSON boundary — checked here rather than trusting structured clone, which
 * happily carries cycles, BigInt and Maps the progress log and resume journal
 * cannot represent. Rejecting loudly beats writing a journal that will not replay. */
function boundaryError(what, path) {
  return new Error("Cannot pass " + what + " across the workflow boundary (at " + path + ").");
}

function assertBoundary(value, path, seen) {
  if (value === null) return;
  var kind = typeof value;
  if (kind === "string" || kind === "boolean") return;
  if (kind === "number") {
    if (!Number.isFinite(value)) throw boundaryError("a non-finite number", path);
    return;
  }
  if (kind === "undefined") {
    if (path === "the workflow result") return;
    throw boundaryError("undefined", path);
  }
  if (kind === "bigint") throw boundaryError("a BigInt", path);
  if (kind === "symbol") throw boundaryError("a symbol", path);
  if (kind === "function") throw boundaryError("a function", path);
  if (kind !== "object") throw boundaryError("a " + kind, path);
  if (seen.has(value)) throw boundaryError("a circular structure", path);
  seen.add(value);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw boundaryError("an object with symbol keys", path);
  }
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) {
        throw boundaryError("a sparse array", path + "[" + i + "]");
      }
      assertBoundary(value[i], path + "[" + i + "]", seen);
    }
    seen.delete(value);
    return;
  }
  var prototype = Object.getPrototypeOf(value);
  // Host and script share one realm, so Object.prototype (or a null prototype)
  // is the only legitimate shape; Map, Set, Date, a class instance lose meaning.
  if (prototype !== null && prototype !== Object.prototype) {
    throw boundaryError("a non-plain object", path);
  }
  var keys = Object.keys(value);
  for (var k = 0; k < keys.length; k++) assertBoundary(value[keys[k]], path + "." + keys[k], seen);
  seen.delete(value);
}

function checkBoundary(value, path) {
  assertBoundary(value, path, new Set());
  return value;
}

function toList(value, what) {
  if (!Array.isArray(value)) throw new Error(what + " expects an array.");
  var length = value.length >>> 0;
  if (length > pendingInit.itemCap) {
    throw new Error(what + " was given " + length + " items, over the limit of " + pendingInit.itemCap + ".");
  }
  var out = [];
  for (var i = 0; i < length; i++) out.push(value[i]);
  return out;
}

function requireText(value, what) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(what + " requires a non-empty string.");
  }
  return value;
}

function optionalText(value, what) {
  if (value === undefined || value === null) return undefined;
  return requireText(value, what);
}

/* A superset of Claude Code's five thinking levels; the extra "minimal" is the
 * host's own. Validated worker-side so a typo stops the script at the call that
 * made it, not later as an agent that ran at the wrong depth. */
var EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

var AGENT_OPTIONS = ["label", "phase", "model", "agentType", "resume", "effort", "schema"];

/* Options this host does not have, and why. Failing loudly beats a silent no-op
 * that hands the script the wrong thing several lines from where it asked. */
var UNSUPPORTED_AGENT_OPTIONS = {
  isolation: "worktree isolation needs the git command line, which this host does not run; agents work directly in the vault.",
  gate: "gate commands need a shell, which this host does not run; verify inside the agent's task instead."
};

var nextPhaseIndex = 0;

function makeScope(name, depth) {
  var scope = {
    name: name,
    depth: depth,
    prefix: name === undefined ? "" : "\\u25b8 " + name,
    ambientPhaseIndex: undefined,
    ambientPhaseTitle: undefined,
    phaseIndexByTitle: new Map()
  };
  scope.agent = function (prompt, opts) { return agentIn(scope, prompt, opts); };
  scope.phase = function (title) { return phaseIn(scope, title); };
  scope.log = function (message) { return logIn(scope, message); };
  scope.workflow = function (ref, args) { return workflowIn(scope, ref, args); };
  scope.console = makeConsole(scope);
  return scope;
}

function scopedTitle(scope, title) {
  if (scope.prefix === "") return title;
  return title === undefined ? scope.prefix : scope.prefix + " \\u203a " + title;
}

function definePhaseIn(scope, title) {
  var index = scope.phaseIndexByTitle.get(title);
  if (index !== undefined) return index;
  index = nextPhaseIndex++;
  scope.phaseIndexByTitle.set(title, index);
  emit({ type: "workflow_phase", index: index, title: scopedTitle(scope, title) });
  return index;
}

function phaseIn(scope, title) {
  var text = requireText(title, "phase(title)");
  scope.ambientPhaseIndex = definePhaseIn(scope, text);
  scope.ambientPhaseTitle = scopedTitle(scope, text);
}

function describe(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.message === "string" && typeof value.stack === "string") {
    return value.message;
  }
  try {
    var json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch (error) { /* cycles and BigInt fall through to String() */ }
  return String(value);
}

function logPrefix(scope) { return scope.prefix === "" ? "" : scope.prefix + ": "; }

function logIn(scope, message) {
  emit({ type: "workflow_log", message: logPrefix(scope) + describe(message) });
}

function makeConsole(scope) {
  var write = function () {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(describe(arguments[i]));
    emit({ type: "workflow_log", message: logPrefix(scope) + parts.join(" ") });
  };
  return { log: write, info: write, warn: write, error: write, debug: write };
}

async function agentIn(scope, prompt, opts) {
  var text = requireText(prompt, "agent(prompt)");
  var options = opts === undefined || opts === null ? {} : opts;
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new Error("agent(prompt, opts) expects opts to be an object.");
  }
  for (var ki = 0, keys = Object.keys(options); ki < keys.length; ki++) {
    var key = keys[ki];
    if (AGENT_OPTIONS.indexOf(key) !== -1) continue;
    var why = UNSUPPORTED_AGENT_OPTIONS[key];
    throw new Error(
      why !== undefined
        ? "agent() opts." + key + " is not supported here: " + why
        : "agent() opts." + key + " is not a recognised option. Supported: " + AGENT_OPTIONS.join(", ") + "."
    );
  }
  var label = optionalText(options.label, "agent() opts.label");
  var phaseName = optionalText(options.phase, "agent() opts.phase");
  var model = optionalText(options.model, "agent() opts.model");
  var agentType = optionalText(options.agentType, "agent() opts.agentType");
  var resume = optionalText(options.resume, "agent() opts.resume");
  var effort = optionalText(options.effort, "agent() opts.effort");
  var schema = options.schema;
  if (schema !== undefined) {
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
      throw new Error("agent() opts.schema must be a JSON Schema object.");
    }
    checkBoundary(schema, "agent() opts.schema");
  }
  if (effort !== undefined && EFFORT_LEVELS.indexOf(effort) === -1) {
    throw new Error("agent() opts.effort must be one of: " + EFFORT_LEVELS.join(", ") + ".");
  }
  // resume revives a child that already exists, so start-time options are not
  // this call's to decide; rejecting beats silently ignoring them.
  if (resume !== undefined) {
    if (agentType !== undefined) throw new Error("agent() opts.resume and opts.agentType are mutually exclusive: a resumed agent keeps the agent type it was started with.");
    if (model !== undefined) throw new Error("agent() opts.resume and opts.model are mutually exclusive: a resumed agent keeps the model it was started with.");
    if (effort !== undefined) throw new Error("agent() opts.resume and opts.effort are mutually exclusive: a resumed agent keeps the reasoning effort it was started with.");
    if (schema !== undefined) throw new Error("agent() opts.resume and opts.schema are mutually exclusive: a resumed child re-prompts a session whose answer contract was fixed when it started.");
  }
  // An explicit opts.phase files this agent under that phase without moving the
  // ambient one, so a stray verify step does not re-point the phases after it.
  var phaseIndex = phaseName !== undefined ? definePhaseIn(scope, phaseName) : scope.ambientPhaseIndex;
  var phaseTitle = phaseName !== undefined ? scopedTitle(scope, phaseName) : scope.ambientPhaseTitle;
  var result = await callHost("agent", {
    prompt: text, label: label, model: model, agentType: agentType,
    phaseIndex: phaseIndex, phaseTitle: phaseTitle, resume: resume, effort: effort, schema: schema
  });
  if (result === undefined || result === null) return null;
  if (schema === undefined) return result;
  try {
    return JSON.parse(result);
  } catch (error) {
    logIn(scope, "agent(): the host returned a structured result that is not JSON");
    return null;
  }
}

/* A barrier: every thunk starts now, nothing past the await runs until all
 * settle. A thunk that throws resolves to null rather than failing its siblings
 * — the script filters, it does not try/catch. A fatal error still propagates. */
async function parallel(thunks) {
  var list = toList(thunks, "parallel(thunks)");
  for (var i = 0; i < list.length; i++) {
    if (typeof list[i] !== "function") {
      throw new Error("parallel(thunks) expects an array of functions; item " + i + " is not one.");
    }
  }
  return await Promise.all(list.map(async function (thunk) {
    try { return await thunk(); }
    catch (error) { if (isFatal(error)) throw error; return null; }
  }));
}

/* No barrier between stages: item A can be in stage 3 while item B is in stage 1,
 * which is the point — a barrier makes every stage wait on its slowest sibling.
 * A stage that throws drops that item to null. Every stage sees
 * (previousResult, originalItem, index). */
async function pipeline(items) {
  var list = toList(items, "pipeline(items, ...stages)");
  var stages = [];
  for (var s = 1; s < arguments.length; s++) {
    if (typeof arguments[s] !== "function") {
      throw new Error("pipeline(items, ...stages) expects stages to be functions; stage " + (s - 1) + " is not one.");
    }
    stages.push(arguments[s]);
  }
  return await Promise.all(list.map(async function (item, index) {
    var value = item;
    for (var j = 0; j < stages.length; j++) {
      try { value = await stages[j](value, item, index); }
      catch (error) { if (isFatal(error)) throw error; return null; }
    }
    return value;
  }));
}

function makeBudget() {
  // total is permanently null — this host has no "+500k" directive — so every
  // Claude Code guard (while (budget.total && ...), budget.total ? ... : 5)
  // takes its no-target branch. spent() is real; it counts this run's agents.
  return { total: null, spent: function () { return spentOutput; }, remaining: function () { return Infinity; } };
}

/* Compile a workflow body into an async function of its injected globals. The
 * shadowed names are parameters so the script's scope chain cannot reach the
 * worker globals of the same name. meta is deliberately NOT a parameter: the
 * body still opens with its own const meta = {...} (the extractor strips only
 * the export), so a parameter of that name would collide with it. */
var SCRIPT_GLOBALS = ["agent", "parallel", "pipeline", "phase", "log", "workflow", "budget", "console", "args"];

/* The determinism prelude needs the real Date/Math, and injecting them as
 * parameters (rather than a global lookup) keeps them reachable in every
 * environment and keeps the shadowing airtight — the script never names these. */
var CLOCK_GLOBALS = ["__wfRealDate", "__wfRealMath"];

function runCompiled(body, scope, args) {
  var params = SCRIPT_GLOBALS.concat(CLOCK_GLOBALS).concat(SHADOWED);
  var fn = Reflect.construct(AsyncFunction, params.concat([PRELUDE + "\\n" + body + "\\n"]));
  var values = [scope.agent, parallel, pipeline, scope.phase, scope.log, scope.workflow, makeBudget(), scope.console, args];
  values.push(Date, Math);
  for (var i = 0; i < SHADOWED.length; i++) values.push(undefined);
  return fn.apply(undefined, values);
}

async function workflowIn(scope, nameOrRef, args) {
  if (scope.depth > 0) {
    throw new Error("workflow() cannot be nested more than one level deep — you are already inside the workflow '" + scope.name + "'. Call the agents inline instead.");
  }
  var ref;
  if (typeof nameOrRef === "string") {
    if (nameOrRef.trim() === "") throw new Error("workflow(nameOrRef) expects a non-empty name.");
    ref = { name: nameOrRef };
  } else if (nameOrRef && typeof nameOrRef === "object" && !Array.isArray(nameOrRef)) {
    var scriptPath = optionalText(nameOrRef.scriptPath, "workflow() scriptPath");
    var name = optionalText(nameOrRef.name, "workflow() name");
    if (scriptPath === undefined && name === undefined) {
      throw new Error("workflow({ ... }) expects a name or a scriptPath.");
    }
    ref = { name: name, scriptPath: scriptPath };
  } else {
    throw new Error("workflow(nameOrRef) expects a saved workflow name or { scriptPath }.");
  }
  var label = ref.name !== undefined ? ref.name : ref.scriptPath;
  if (args !== undefined) checkBoundary(args, 'workflow("' + label + '") args');
  if (nestedCount >= pendingInit.nestedCap) {
    var capError = new Error("Workflow exceeded its cap of " + pendingInit.nestedCap + " nested workflow() calls.");
    capError.workflowFatal = true;
    throw capError;
  }
  nestedCount++;
  var loaded;
  try {
    loaded = await callHost("workflow", ref);
  } catch (error) {
    if (isFatal(error)) throw error;
    throw new Error('workflow("' + label + '"): ' + describe(error));
  }
  var child = makeScope(loaded.name, scope.depth + 1);
  child.ambientPhaseIndex = definePhaseIn(child, undefined);
  child.ambientPhaseTitle = scopedTitle(child, undefined);
  var value;
  try {
    value = await runCompiled(loaded.body, child, args);
  } catch (error) {
    throw new Error('workflow("' + label + '"): ' + describe(error));
  }
  checkBoundary(value, 'the result of workflow("' + label + '")');
  return value;
}

async function main() {
  var init = pendingInit !== null ? pendingInit : await initOnce;
  var scope = makeScope(undefined, 0);
  var value = await runCompiled(init.body, scope, init.argsJson === undefined ? undefined : JSON.parse(init.argsJson));
  checkBoundary(value, "the workflow result");
  flushProgress();
  self.postMessage({ type: "complete", resultJson: value === undefined ? undefined : JSON.stringify(value) });
}

main().catch(function (error) {
  flushProgress();
  self.postMessage({
    type: "error",
    message: error && error.message ? String(error.message) : String(error),
    stack: error && error.stack ? String(error.stack) : undefined
  });
});
`;

