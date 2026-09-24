/**
 * Real Obsidian smoke for the workflow engine.
 * Disposable vault only. Drives the ACTUAL bundled run_workflow tool inside the
 * real Obsidian WebView — the blob-URL Web Worker, the worker source compiled
 * with AsyncFunction, the RPC bridge, and the host adapter — proving the whole
 * integrated path runs on the shipped bytes, not just under bun.
 *
 * No model is configured in the disposable vault, so the child spawn fails and
 * agent() returns null; the script is written to tolerate that. What is under
 * test is the engine reaching that point in-WebView, not a model call.
 *
 * Usage: node scripts/smoke-workflow-obsidian.mjs <CDP-port> <output-dir> [--expect-mobile]
 */
const [port, directory, mode, ...extra] = process.argv.slice(2);
if (!port || !directory || (mode !== undefined && mode !== "--expect-mobile") || extra.length > 0) {
	throw new Error("Usage: node scripts/smoke-workflow-obsidian.mjs <CDP-port> <output-dir> [--expect-mobile]");
}
const expectMobile = mode === "--expect-mobile";

async function runSmoke(root, expect) {
	const report = { passed: false, checks: [], errors: [] };
	const record = (name, ok) => { if (!ok) throw new Error(name); report.checks.push(name); };
	const wait = async (test) => {
		for (let attempt = 0; attempt < 1500; attempt++) {
			if (await test()) return;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error("Condition timed out");
	};

	// Ensure the plugin is enabled before waiting on it. A fresh vault boots in
	// restricted mode and the boot-time load can race the rig's own unlock, so
	// the smoke re-asserts it idempotently rather than trusting prior state.
	try {
		app.plugins.setEnable(true);
		if (!app.plugins.plugins?.piem?.agentService) {
			await app.plugins.enablePluginAndSave("piem");
		}
	} catch (cause) {
		report.errors.push(`enable: ${String(cause)}`);
	}
	await wait(() => window.app?.plugins?.plugins?.piem?.agentService);
	if (app.vault.adapter.getBasePath() !== `${root}/vault`) throw new Error("Use a disposable vault at <output-dir>/vault.");
	report.environment = { mobile: app.isMobile, phone: document.body.classList.contains("is-phone"), obsidian: document.title.match(/Obsidian ([0-9.]+)/)?.[1] };
	record("correct official device mode", app.isMobile === expect);
	if (expect) record("official phone emulation", document.body.classList.contains("emulate-mobile"));

	const errors = [];
	const onError = (event) => errors.push(String(event.error ?? event.reason ?? event.message));
	window.addEventListener("error", onError);
	window.addEventListener("unhandledrejection", onError);

	const service = app.plugins.plugins.piem.agentService;
	const tool = service.getWorkflowTool();
	record("run_workflow tool is present", !!tool && tool.name === "run_workflow");
	record("tool description advertises the primitives", /agent\(|parallel\(|pipeline\(/.test(tool.description ?? ""));

	// A script that fans out, phases, logs, tolerates a null agent result, and
	// returns a JSON value — everything the worker + runtime + host must do.
	const script = [
		'export const meta = { name: "smoke", description: "d", phases: [{ title: "Fan" }] };',
		'phase("Fan");',
		'log("workflow running in the webview");',
		'const one = await agent("first");',
		'const many = await parallel([() => agent("a"), () => agent("b")]);',
		'const piped = await pipeline([1, 2], (n) => agent("s:" + n));',
		'let clockThrew = false;',
		'try { Date.now(); } catch (e) { clockThrew = true; }',
		'return {',
		'  agentReturnedNull: one === null,',
		'  parallelLength: many.length,',
		'  pipelineLength: piped.length,',
		'  clockThrew,',
		'};',
	].join("\n");

	const result = await tool.execute("smoke-call", { script }, new AbortController().signal);
	const details = result?.details ?? {};
	const text = result?.content?.[0]?.text ?? "";
	report.workflow = { status: details.status, value: details.value, runId: details.runId, summaryHead: text.split("\n")[0] };

	// The engine ran to completion in the WebView: a real blob Worker executed
	// the compiled script, the RPC bridge answered every agent(), the run
	// returned its value and a summary.
	record("workflow completed in the webview", details.status === "completed");
	record("worker executed parallel + pipeline", details.value?.parallelLength === 2 && details.value?.pipelineLength === 2);
	record("determinism prelude fired (Date.now threw)", details.value?.clockThrew === true);
	record("child spawn attempted with no model, agent() returned null", details.value?.agentReturnedNull === true);
	record("summary names the workflow", /Workflow "smoke"/.test(text));
	record("a run id was issued", typeof details.runId === "string" && details.runId.length > 0);

	// resumeFromRunId with the same script re-runs cleanly. Note: with no model
	// every agent failed, and a failed agent is journalled as a failure that is
	// never replayed (resume exists to retry it) — so replayedCount is correctly
	// 0 here. The replay-hit path is covered by the bun runtime test, where
	// stubbed agents succeed. What this proves in-WebView is that the journal
	// store round-trips and the resume path executes on the shipped bytes.
	const resumed = await tool.execute("smoke-call-2", { script, resumeFromRunId: details.runId }, new AbortController().signal);
	record("resume path runs against the stored journal", resumed?.details?.status === "completed" && typeof resumed?.details?.replayedCount === "number");
	record("unknown resume id is reported, not crashed", (await tool.execute("smoke-call-3", { script, resumeFromRunId: "no-such-run" }, new AbortController().signal))?.details?.resumed === false);

	record("no uncaught errors in the page", errors.length === 0);

	window.removeEventListener("error", onError);
	window.removeEventListener("unhandledrejection", onError);
	report.passed = true;
	return report;
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((t) => t.type === "page" && t.url.startsWith("app://") && t.url.includes("index.html"))
	?? targets.find((t) => t.type === "page" && t.url.startsWith("app://"));
if (!target) { console.error("no index.html target"); process.exit(2); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
const reply = await new Promise((resolve, reject) => {
	const id = 1;
	ws.addEventListener("message", (ev) => {
		const m = JSON.parse(ev.data);
		if (m.id === id) m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
	});
	ws.send(JSON.stringify({
		id,
		method: "Runtime.evaluate",
		params: {
			expression: `(${runSmoke})(${JSON.stringify(directory)}, ${expectMobile})`,
			awaitPromise: true,
			returnByValue: true,
		},
	}));
	setTimeout(() => reject(new Error("cdp timeout")), 120000);
});
ws.close();
if (reply.exceptionDetails) {
	console.log(JSON.stringify({ passed: false, failure: reply.exceptionDetails.exception?.description ?? "exception" }));
	process.exit(1);
}
console.log(JSON.stringify(reply.result.value));
process.exit(reply.result.value?.passed ? 0 : 1);
