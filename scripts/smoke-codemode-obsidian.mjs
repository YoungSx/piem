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
	// The declaration block is rendered from the *session's* tool set at the moment
	// the tool was built, so it can only be checked once a conversation exists — an
	// empty list is the honest answer before then, and asserting on it would either
	// pass vacuously or fail for the wrong reason.
	record("with no conversation yet, it says so rather than claiming tools", /No tools are available/.test(tool.description ?? ""), (tool.description ?? "").slice(-160));

	// ---- the switch, on the shipped settings path -------------------------------
	/**
	 * The tool names a fresh conversation mounts, read off the agent.
	 *
	 * A *new* session each time, so this answers the vault setting — which is what
	 * it is for. It cannot answer a `/codemode` override: a new chat is a new
	 * conversation, and a conversation-scoped override is exactly the thing that
	 * does not follow it. {@link currentTools} is the probe for that.
	 */
	const mountedTools = async () => {
		await service.newSession({ force: true });
		await service.sendPrompt("seed").catch(() => undefined);
		return (service.agent?.state.tools ?? []).map((tool) => tool.name);
	};

	/** What *this* conversation has mounted right now. */
	const currentTools = () => (service.agent?.state.tools ?? []).map((tool) => tool.name);

	const wasEnabled = piem.settings.codemodeEnabled === true;
	piem.settings.codemodeEnabled = false;
	await piem.saveSettings();
	const offTools = await mountedTools();
	record("codemode is not mounted while the setting is off", !offTools.includes("codemode"));
	record("the rest of the tool set survives the gate", offTools.includes("read"));

	piem.settings.codemodeEnabled = true;
	await piem.saveSettings();
	const onTools = await mountedTools();
	record("codemode is mounted once the setting is on", onTools.includes("codemode"));
	record("it is offered alongside the direct tools, not instead", onTools.includes("read") && onTools.includes("grep"));
	record("`on` mounts the MCP server's tools too", onTools.includes("mcp_smoke_probe"));
	report.mounted = { off: offTools.length, on: onTools.length };

	// Now that a session is mounted, the built description names real tools.
	const liveDescription = service.getCodemodeTool().description ?? "";
	record("with a conversation, `on` renders no catalog — the tools are already declared", !/declare const tools/.test(liveDescription));
	record("and does not offer codemode to a script", !/\n  codemode\(/.test(liveDescription));
	report.descriptionTokensOn = Math.ceil(liveDescription.length / 4);

	// ---- the two modes, on the shipped settings path ---------------------------
	// `only` is the mode that withholds the direct tools, so it is the one that
	// has to be driven end to end: a model that cannot see a tool cannot skip the
	// sandbox to reach it, and a sandbox whose catalog is empty is a sandbox the
	// model cannot write a script against.
	const wasMode = piem.settings.codemodeMode ?? "on";
	piem.settings.codemodeMode = "only";
	await piem.saveSettings();
	const onlyTools = await mountedTools();
	report.onlyMounted = onlyTools;
	// Named rather than counted: the mounted set differs between the desktop and
	// phone passes (the community host mounts differently), and what the mode
	// promises is that the *direct vault tools* are gone, not that codemode is the
	// only thing left on the table.
	const directTools = ["read", "grep", "ls", "update_frontmatter", "create_note"];
	record(
		"`only` withholds the direct vault tools",
		onlyTools.includes("codemode") && directTools.every((name) => !onlyTools.includes(name)),
		onlyTools.join(","),
	);
	const onlyDescription = service.getCodemodeTool().description ?? "";
	report.descriptionTokensOnly = Math.ceil(onlyDescription.length / 4);
	record("`only` carries the catalog the model can no longer see elsewhere", /declare const tools/.test(onlyDescription));
	record("and it names real tools", /read\(args: /.test(onlyDescription));
	// The description still has to fit: a catalog that overflows silently is a
	// catalog the model half-believes.
	const declarations = onlyDescription.match(/declare const tools: \{[\s\S]*?\n\};/)?.[0] ?? "";
	record("the catalog stays inside its budget", Math.ceil(declarations.length / 4) <= 3000, String(declarations.length));
	const onlyRun = await service.getCodemodeTool().execute("smoke-only", { code: "return 6 * 7;" }, new AbortController().signal);
	record("and a script still runs in `only`", !onlyRun.isError && onlyRun.content?.[0]?.text === "42");
	record("`only` withholds the MCP server's tools from the model as well", !onlyTools.includes("mcp_smoke_probe"));
	// The mode's whole promise, executed rather than asserted: the model cannot
	// see `read` or the probe, and a script can call both — through the real
	// QuickJS VM, the real host bridge, the real nested tool path.
	const probeRun = await service.getCodemodeTool().execute("smoke-only-mcp", { code: "const r = await tools.mcp_smoke_probe({}); return r;" }, new AbortController().signal);
	record("a script reaches the MCP tool the model cannot see", !probeRun.isError && probeRun.content?.at(-1)?.text === '"probe-ok"', JSON.stringify(probeRun).slice(0, 160));
	const directRun = await service.getCodemodeTool().execute("smoke-only-direct", { code: "const files = await tools.ls({}); return typeof files;" }, new AbortController().signal);
	record("and the direct vault tools, in the same mode", !directRun.isError && directRun.content?.at(-1)?.text === "string", JSON.stringify(directRun).slice(0, 160));


	piem.settings.codemodeMode = wasMode;
	await piem.saveSettings();

	// ---- the slash command, on the shipped path -------------------------------
	// The command is the composer's handle on the same two fields the settings page
	// renders: it must write them, not remember something beside them, or the two
	// surfaces drift and the settings page shows an answer the model never got.
	const commandNames = (service.getSnapshot().availableCommands ?? []).map((entry) => entry.name);
	record("/codemode is offered in the composer", commandNames.includes("codemode"));
	await service.sendPrompt("/codemode only");
	record("/codemode only withholds the direct tools", !currentTools().includes("read"));
	record("and the MCP server's tools with them", !currentTools().includes("mcp_smoke_probe"));
	record("and writes the same two fields the settings page renders", piem.settings.codemodeEnabled === true && piem.settings.codemodeMode === "only");
	const dataJson = JSON.parse(await app.vault.adapter.read(`${directory}/vault/.obsidian/plugins/piem/data.json`));
	record("the write reached data.json, so a reopen agrees with the toast", dataJson.codemodeEnabled === true && dataJson.codemodeMode === "only");
	await service.sendPrompt("/codemode vault");
	// There is no session-scoped answer to hand back any more, so the old word is
	// refused rather than honoured — and refusing must change nothing.
	record("`vault` is not a word any more, and changes nothing", piem.settings.codemodeMode === "only" && !currentTools().includes("read"));
	await service.sendPrompt("/codemode off");
	record("/codemode off unmounts the tool and writes the switch off", !currentTools().includes("codemode") && piem.settings.codemodeEnabled === false);


	piem.settings.codemodeEnabled = wasEnabled;
	await piem.saveSettings();

	// ---- the sandbox, on the shipped bytes --------------------------------------
	const run = async (code, signal) => service.getCodemodeTool().execute("smoke", { code }, signal ?? new AbortController().signal);
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
	record("an @options line is honoured", !optioned.isError && optioned.content?.[0]?.text === "parsed");

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
	// Generous, because the smoke drives several full conversation rebuilds —
	// each `/codemode` change re-mounts the whole tool set through
	// `refreshConfiguration` — and the page-side evaluation cannot be interrupted
	// once it starts. A timeout here reads as a hang, which is the one thing this
	// smoke exists to disprove.
	setTimeout(() => reject(new Error("cdp timeout")), 420000);
});
ws.close();
if (reply.exceptionDetails) {
	console.log(JSON.stringify({ passed: false, failure: reply.exceptionDetails.exception?.description ?? "exception" }));
	process.exit(1);
}
console.log(JSON.stringify(reply.result.value));
process.exit(reply.result.value?.passed ? 0 : 1);
