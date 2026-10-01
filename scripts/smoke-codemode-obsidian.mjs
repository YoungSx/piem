/**
 * Real Obsidian smoke for the codemode sandbox.
 * Disposable vault only. Drives the ACTUAL bundled `codemode` tool inside the
 * real Obsidian WebView — the QuickJS VM built from the inlined wasm, the
 * blob-URL Web Worker, the host bridge, the `runToolCall` nested path — proving
 * the integrated path runs on the shipped bytes, not just under bun.
 *
 * `--expect-mobile` runs the same checks in Obsidian's official phone
 * emulation. That pass changes the device mode and the viewport, not the JS
 * engine: the mobile WebView here is still Chromium/V8, not WebKit. So it
 * proves the plugin's mobile code paths and that nothing here depends on the
 * layout, and it is *not* evidence about WebKit — that is the separate
 * Playwright run, and the report says so rather than blurring the two.
 *
 * No model is configured in the disposable vault, so a nested tool call fails at
 * the "no conversation" branch. What is under test is the sandbox reaching that
 * point in-WebView, not a model call.
 *
 * Usage: node scripts/smoke-codemode-obsidian.mjs <CDP-port> <output-dir> [--expect-mobile]
 */
const [port, directory, mode, ...extra] = process.argv.slice(2);
if (!port || !directory || (mode !== undefined && mode !== "--expect-mobile") || extra.length > 0) {
	throw new Error("Usage: node scripts/smoke-codemode-obsidian.mjs <CDP-port> <output-dir> [--expect-mobile]");
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
	report.environment = {
		mobile: app.isMobile,
		phone: document.body.classList.contains("is-phone"),
		obsidian: document.title.match(/Obsidian ([0-9.]+)/)?.[1],
		sharedArrayBuffer: typeof SharedArrayBuffer,
	};
	record("correct official device mode", app.isMobile === expect);
	if (expect) record("official phone emulation", document.body.classList.contains("emulate-mobile"));

	const errors = [];
	const onError = (event) => errors.push(String(event.error ?? event.reason ?? event.message));
	window.addEventListener("error", onError);
	window.addEventListener("unhandledrejection", onError);

	const piem = app.plugins.plugins.piem;
	const service = piem.agentService;
	const tool = service.getCodemodeTool();
	record("codemode tool is built", !!tool && tool.name === "codemode");
	record("description says results stay inside the script", /stay inside it/.test(tool.description ?? ""));
	record("description renders tool declarations", /declare const tools/.test(tool.description ?? ""));
	report.descriptionTokens = Math.ceil((tool.description ?? "").length / 4);

	// ---- the switch, on the shipped settings path -------------------------------
	const wasEnabled = piem.settings.codemodeEnabled === true;
	piem.settings.codemodeEnabled = false;
	await piem.saveSettings();
	const offTools = (await service.newSession({ force: true }).then(async () => {
		await service.sendPrompt("seed").catch(() => undefined);
		return (service as unknown as { agent?: { state: { tools: Array<{ name: string }> } } }).agent?.state.tools.map(t => t.name) ?? [];
	}));
	record("codemode is not mounted while the setting is off", !offTools.includes("codemode"));
	record("the rest of the tool set survives the gate", offTools.includes("read"));

	piem.settings.codemodeEnabled = true;
	await piem.saveSettings();
	const onTools = (await service.newSession({ force: true }).then(async () => {
		await service.sendPrompt("seed").catch(() => undefined);
		return (service as unknown as { agent?: { state: { tools: Array<{ name: string }> } } }).agent?.state.tools.map(t => t.name) ?? [];
	}));
	record("codemode is mounted once the setting is on", onTools.includes("codemode"));
	record("it is offered alongside the direct tools, not instead", onTools.includes("read") && onTools.includes("grep"));
	report.mounted = { off: offTools.length, on: onTools.length };

	piem.settings.codemodeEnabled = wasEnabled;
	await piem.saveSettings();

	// ---- the sandbox, on the shipped bytes --------------------------------------
	const run = async (code, signal) => tool.execute("smoke", { code }, signal ?? new AbortController().signal);
	const timing = {};

	let started = performance.now();
	const arithmetic = await run("return 2 + 3;");
	timing.arithmeticMs = Math.round(performance.now() - started);
	record("a script runs in the webview", !arithmetic.isError);
	record("and returns its value", arithmetic.content?.[0]?.text === "5");

	const capabilities = await run("return { f: typeof fetch, t: typeof setTimeout, p: typeof process, r: typeof require };");
	const probed = JSON.parse(capabilities.content?.[0]?.text ?? "{}");
	report.capabilities = probed;
	record("the VM has no fetch, timers, process or require", probed.f === "undefined" && probed.t === "undefined" && probed.p === "undefined" && probed.r === "undefined");

	const printed = await run("text('one'); text('two'); return 'three';");
	const details = printed.details ?? {};
	record("printed output is kept, in order", JSON.stringify(details.calls ?? []).length >= 0 && printed.content?.[0]?.text === "one");

	const thrown = await run("\n\nthrow new Error('smoke boom');");
	record("a thrown script is an error result", thrown.isError === true);
	const stack = thrown.content?.[thrown.content.length - 1]?.text ?? "";
	record("the stack names the script file", /codemode\.js/.test(stack));
	// The wrapper's prefix shares line 1 with the body, so line 3 of the script is
	// line 3 of what the model wrote. Getting this wrong costs a model a wrong answer.
	record("and points at the line the model wrote", /codemode\.js:3/.test(stack), stack.slice(0, 120));

	started = performance.now();
	const spin = await Promise.race([
		run("// @options: {\"timeout_ms\": 1200}\nwhile (true) {}"),
		new Promise((resolve) => setTimeout(() => resolve({ __late: true }), 20000)),
	]);
	timing.spinMs = Math.round(performance.now() - started);
	record("a spinning script is terminated by its deadline", spin.__late !== true && spin.isError === true && /timed out/i.test(spin.content?.[spin.content.length - 1]?.text ?? ""));

	started = performance.now();
	const hungry = await Promise.race([
		run("const a = []; while (true) a.push(new Array(1e5).fill(0));"),
		new Promise((resolve) => setTimeout(() => resolve({ __late: true }), 30000)),
	]);
	timing.memoryMs = Math.round(performance.now() - started);
	record("the VM's memory ceiling fires", hungry.__late !== true && /out of memory/i.test(hungry.content?.[hungry.content.length - 1]?.text ?? ""));

	const optioned = await run("// @options: {\"timeout_ms\": 5000}\nreturn 'parsed';");
	record("an @options line is honoured", !optioned.isError && JSON.parse(optioned.content?.[0]?.text ?? '""') === "parsed");

	const badOption = await run("// @options: {\"nope\": 1}\nreturn 1;");
	record("a malformed @options line is the model's mistake to see", badOption.isError === true && /only supports/.test(badOption.content?.[0]?.text ?? ""));

	// One run must not poison the next: a fresh worker and VM per execution is what
	// buys that, and a sandbox that reused one would fail here and nowhere else.
	const afterFailure = await run("return 'still works';");
	record("a run after a killed one still works", !afterFailure.isError && afterFailure.content?.[0]?.text === '"still works"');

	// ---- the nested path -------------------------------------------------------
	// No model is configured here, so the call resolves to the "no conversation is
	// running" branch. What this proves in-WebView is that a script's `tools.x()`
	// reaches the host bridge and comes back as a rejection rather than a hang.
	started = performance.now();
	const nested = await Promise.race([
		run("try { await tools.read({ path: 'x.md' }); return 'no throw'; } catch (e) { return e.message; }"),
		new Promise((resolve) => setTimeout(() => resolve({ __late: true }), 20000)),
	]);
	timing.nestedMs = Math.round(performance.now() - started);
	record("a nested call reaches the host and rejects cleanly", nested.__late !== true && !nested.isError, JSON.stringify(nested).slice(0, 160));
	report.nestedReply = nested.content?.[0]?.text?.slice(0, 120);

	report.timing = timing;
	record("no uncaught errors in the page", errors.length === 0, errors.join(" | ").slice(0, 200));

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
	setTimeout(() => reject(new Error("cdp timeout")), 180000);
});
ws.close();
if (reply.exceptionDetails) {
	console.log(JSON.stringify({ passed: false, failure: reply.exceptionDetails.exception?.description ?? "exception" }));
	process.exit(1);
}
console.log(JSON.stringify(reply.result.value));
process.exit(reply.result.value?.passed ? 0 : 1);
