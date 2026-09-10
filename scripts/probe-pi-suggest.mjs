import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import esbuild from "esbuild";

// Opt-in research only. Pass an unpacked npm package; this does not install it
// or execute its extension factory. The audited pure helper gets no host APIs.
const directory = process.argv[2];
if (!directory) throw new Error("Pass the unpacked pi-suggest package directory.");
const metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
assert.equal(metadata.name, "pi-suggest");
assert.equal(metadata.version, "0.1.2", "Re-audit before probing another version.");
const source = await readFile(path.join(directory, "extensions/suggestions.ts"), "utf8");
const sourceSha256 = createHash("sha256").update(source).digest("hex");
assert.equal(sourceSha256, "af66e37539ac58256fc2ee320aa8e9222d72cb060cd7904976f38b24ed767a8e");
const { code } = await esbuild.transform(source, { format: "cjs", target: "es2022", loader: "ts" });
const realm = vm.createContext({ module: { exports: {} } });
vm.runInContext(code, realm, { filename: "pi-suggest-pure-helper.cjs", timeout: 1_000 });

const result = await vm.runInContext(`(async () => {
  const { normalizeConfig, parseSuggestions, createSuggestionStore } = module.exports;
  const choices = Array.from({ length: 5 }, (_, i) => ({ title: "Choice " + i, prompt: "Ask " + i }));
  const count = normalizeConfig({ suggestionCount: 5 }).suggestionCount;
  const parsed = parseSuggestions(JSON.stringify({ suggestions: choices }));

  const concurrent = createSuggestionStore();
  const releases = [];
  let calls = 0;
  const generate = () => {
    calls++;
    return new Promise(resolve => releases.push(() => resolve([choices[0]])));
  };
  const first = concurrent.getOrGenerate("same-reply", undefined, generate);
  const second = concurrent.getOrGenerate("same-reply", undefined, generate);
  const concurrentCalls = calls;
  releases.forEach(release => release());
  await Promise.all([first, second]);

  const cleared = createSuggestionStore();
  let finish;
  const pending = cleared.getOrGenerate("old-reply", undefined, () => new Promise(resolve => { finish = resolve; }));
  cleared.clear();
  finish([choices[1]]);
  await pending;
  let regenerated = false;
  const afterClear = await cleared.getOrGenerate("old-reply", undefined, async () => {
    regenerated = true;
    return [choices[2]];
  });
  return {
    configuredCount: count,
    parsedCount: parsed.length,
    sameReplyConcurrentGenerateCalls: concurrentCalls,
    lateResultRepopulatesClearedCache: !regenerated && afterClear[0].prompt === choices[1].prompt,
    globals: { process: typeof process, require: typeof require, fetch: typeof fetch, setTimeout: typeof setTimeout },
  };
})()`, realm, { timeout: 1_000 });

// These characterize the pinned upstream implementation, not desired behavior
// for Piem. A changed result means the findings need a fresh audit.
assert.equal(result.configuredCount, 5);
assert.equal(result.parsedCount, 3);
assert.equal(result.sameReplyConcurrentGenerateCalls, 2);
assert.equal(result.lateResultRepopulatesClearedCache, true);
assert(Object.values(result.globals).every(value => value === "undefined"));
console.log(JSON.stringify({
  package: metadata.name,
  version: metadata.version,
  sourceSha256,
  ...result,
}, null, 2));
