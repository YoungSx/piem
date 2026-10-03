/**
 * Real Obsidian + official phone emulation, using the unmodified release bundle.
 * A loopback OpenAI/MCP fixture makes the test independent of credentials.
 * Usage: node scripts/smoke-codemode-obsidian.mjs <CDP-port> <rig-root> [--expect-mobile]
 * The rig must own <rig-root>/vault. Phone emulation is Chromium, not iOS WebKit.
 */
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { observePluginNodeAccess } from "./obsidian-plugin-node-audit.mjs";

const [port, directory, mode, ...extra] = process.argv.slice(2);
if (!port || !directory || (mode !== undefined && mode !== "--expect-mobile") || extra.length) {
	throw new Error("Usage: node scripts/smoke-codemode-obsidian.mjs <CDP-port> <rig-root> [--expect-mobile]");
}
const mobile = mode === "--expect-mobile";
const state = { requests: [], writes: [], probes: 0 };
const timers = new Set();
const fixture = createServer(async (req, res) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Headers", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
	const json = value => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
	try {
		if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
		if (req.url === "/state") { json(state); return; }
		if (req.method !== "POST") { res.writeHead(405).end(); return; }
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw);
		if (req.url === "/mcp") {
			if (body.id === undefined) { res.writeHead(202).end(); return; }
			let result;
			if (body.method === "initialize") result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "smoke", version: "1.0.0" } };
			else if (body.method === "tools/list") result = { tools: [
				{ name: "probe", description: "Return probe-ok", inputSchema: { type: "object", properties: {} } },
				{ name: "write_probe", description: "Record a test write after a short delay", inputSchema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] } },
			] };
			else if (body.method === "tools/call") {
				if (body.params.name === "write_probe") {
					state.writes.push(body.params.arguments.n);
					await new Promise(resolve => { const timer = setTimeout(() => { timers.delete(timer); resolve(); }, 350); timers.add(timer); });
				} else state.probes++;
				result = { content: [{ type: "text", text: "probe-ok" }] };
			} else if (body.method === "ping") result = {};
			else { json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Unknown fixture method" } }); return; }
			json({ jsonrpc: "2.0", id: body.id, result });
			return;
		}
		if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
		const lastUser = body.messages.findLastIndex(message => message.role === "user" && /smoke-seed|codemode-runtime-roundtrip/.test(JSON.stringify(message.content)));
		const prompt = JSON.stringify(body.messages[lastUser]?.content ?? "");
		const roundtrip = prompt.includes("codemode-runtime-roundtrip");
		const afterTool = body.messages.slice(lastUser + 1).some(message => message.role === "tool");
		state.requests.push({ prompt, tools: body.tools?.map(tool => tool.function?.name ?? tool.name) ?? [], toolResults: body.messages.filter(message => message.role === "tool").length });
		res.setHeader("Content-Type", "text/event-stream");
		const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", model: "smoke", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
		chunk({ role: "assistant" });
		if (roundtrip && !afterTool) {
			chunk({ tool_calls: [{ index: 0, id: "smoke-codemode", type: "function", function: { name: "codemode", arguments: JSON.stringify({ code: 'text(await tools.mcp_smoke_probe({})); text(await tools.read({path:"smoke-note.md"})); store("roundtrip",42); return "runtime-ok";' }) } }] });
			chunk({}, "tool_calls");
		} else { chunk({ content: roundtrip ? "Smoke complete" : "Seed complete" }); chunk({}, "stop"); }
		res.end("data: [DONE]\n\n");
	} catch (error) { res.writeHead(500).end(String(error)); }
});
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${fixture.address().port}`;

async function runSmoke(root, expectMobile, endpoint, observeNodeAccess) {
	const report = { passed: false, checks: [], errors: [] };
	const check = (name, ok) => { if (!ok) throw new Error(name); report.checks.push(name); };
	const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
	const wait = async (test, label) => {
		const end = performance.now() + 15000;
		while (performance.now() < end) { if (await test()) return; await pause(25); }
		throw new Error(`Timed out: ${label}`);
	};
	let audit;
	const workers = new Set();
	const workerUrls = new Set();
	let created = 0;
	let revoked = 0;
	const NativeWorker = window.Worker;
	const revoke = URL.revokeObjectURL;
	const onError = event => report.errors.push(String(event.error ?? event.reason ?? event.message));
	try {
		if (app.vault.adapter.getBasePath() !== `${root}/vault`) throw new Error("Use the disposable <rig-root>/vault.");
		check("official device mode", app.isMobile === expectMobile);
		if (expectMobile) check("official phone emulation", document.body.classList.contains("emulate-mobile") && document.body.classList.contains("is-phone"));
		const initialPlugin = app.plugins.plugins.piem;
		Object.assign(initialPlugin.settings, {
			language: "en", networkTransport: "requestUrl", shareDiagnostics: false,
			providers: [{ id: "runtime-smoke", name: "Local smoke", baseUrl: `${endpoint}/v1`, protocol: "openai-completions", apiKey: "local-fixture-only", secretRef: "", source: "user", oauthFlow: "" }],
			models: [{ id: "runtime-smoke", providerId: "runtime-smoke", modelApiId: "smoke", displayName: "Smoke", reasoning: false, supportsImages: false }],
			activeModelId: "runtime-smoke",
			mcpServers: [{ id: "builtin-exa", name: "Exa", url: "https://mcp.exa.ai/mcp", token: "", secretRef: "", enabled: false },
				{ id: "runtime-smoke", name: "smoke", url: `${endpoint}/mcp`, token: "", secretRef: "", enabled: true }],
			codemodeEnabled: true, codemodeMode: "on",
		});
		// Persist the new loopback endpoint before reload, so startup cannot race a dead previous fixture.
		await initialPlugin.saveSettings({ reconfigure: false });
		audit = expectMobile ? observeNodeAccess("piem") : undefined;
		await app.plugins.unloadPlugin("piem");
		await app.plugins.loadPlugin("piem");
		await wait(() => app.plugins.plugins.piem?.agentService, "plugin service");
		const plugin = app.plugins.plugins.piem;
		const service = plugin.agentService;
		await plugin.activateChatView();
		await service.newSession({ force: true });
		await wait(() => service.agent?.state.tools.some(tool => tool.name === "mcp_smoke_probe"), "MCP handshake and mount");
		if (!app.vault.getFileByPath("smoke-note.md")) await app.vault.create("smoke-note.md", "runtime fixture note\n");
		report.environment = { obsidian: document.title.match(/Obsidian ([0-9.]+)/)?.[1], plugin: plugin.manifest.version,
			mobile: app.isMobile, phone: document.body.classList.contains("is-phone"), width: innerWidth, height: innerHeight, engine: navigator.userAgent };
		window.addEventListener("error", onError);
		window.addEventListener("unhandledrejection", onError);
		window.Worker = class extends NativeWorker {
			constructor(...args) { super(...args); created++; workers.add(this); workerUrls.add(String(args[0])); }
			terminate() { try { super.terminate(); } finally { workers.delete(this); } }
		};
		URL.revokeObjectURL = function (url) { if (workerUrls.delete(url)) revoked++; return revoke.call(URL, url); };
		const names = () => service.agent.state.tools.map(tool => tool.name);
		const run = (code, signal) => service.getCodemodeTool().execute("runtime-smoke", { code }, signal ?? new AbortController().signal);
		const text = result => result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
		const stats = async () => (await fetch(`${endpoint}/state`)).json();

		check("on declares direct and script tools", names().includes("codemode") && names().includes("read") && names().includes("mcp_smoke_probe"));
		await service.sendPrompt("smoke-seed-on");
		check("configured local model responds", !service.getSnapshot().errorMessage);
		check("on sends direct MCP declaration", (await stats()).requests.find(request => request.prompt.includes("smoke-seed-on"))?.tools.includes("mcp_smoke_probe"));
		await service.sendPrompt("/codemode only");
		check("only declares exactly codemode", JSON.stringify(names()) === '["codemode"]');
		const data = JSON.parse(await app.vault.adapter.read(".obsidian/plugins/piem/data.json"));
		check("slash command persists the setting", data.codemodeEnabled && data.codemodeMode === "only");
		check("only description supplies tool parameters", /read\(args:/.test(service.getCodemodeTool().description));
		await service.sendPrompt("codemode-runtime-roundtrip");
		const wire = (await stats()).requests.filter(request => request.prompt.includes("codemode-runtime-roundtrip"));
		check("only stays exclusive on the actual provider requests", wire.length >= 2 && wire.every(request => JSON.stringify(request.tools) === '["codemode"]'));
		check("provider sees the completed tool result", wire.some(request => request.toolResults > 0));
		check("real model-tool-model loop completes", !service.getSnapshot().errorMessage && JSON.stringify(service.getSnapshot().messages).includes("runtime-ok"));
		check("MCP tool reaches the local HTTP server", (await stats()).probes > 0);
		check("MCP string is not double quoted", text(await run("return await tools.mcp_smoke_probe({})")) === "probe-ok");
		check("real Vault read returns the fixture", text(await run('return await tools.read({path:"smoke-note.md"})')).includes("runtime fixture note"));
		check("ALL_TOOLS provides discoverable parameters", text(await run('return ALL_TOOLS.find(t=>t.name==="read").description')).includes("path: string"));

		check("store survives the agent loop", text(await run('return load("roundtrip")')) === "42");
		const ownerPath = service.getActiveSessionPath();
		const ownerTool = service.getCodemodeTool();
		await service.newSession();
		await service.sendPrompt("smoke-seed-second-chat");
		check("new chat does not inherit another store", text(await run('return load("roundtrip") ?? "empty"')) === "empty");
		check("captured tool keeps its owning chat", text(await ownerTool.execute("owner", { code: 'return load("roundtrip")' }, new AbortController().signal)) === "42");
		await service.openSession(ownerPath);
		const failedStore = await run('store("roundtrip", 99); throw new Error("expected failure")');
		check("failed scripts discard store writes", failedStore.isError && text(await run('return load("roundtrip")')) === "42");
		await run('store("roundtrip", undefined)');
		check("undefined deletes a stored key", text(await run('return load("roundtrip") ?? "deleted"')) === "deleted");

		const capabilities = JSON.parse(text(await run('return [typeof fetch,typeof process,typeof require,typeof setTimeout]')));
		check("VM has no direct host capabilities", capabilities.every(value => value === "undefined"));
		check("strings are returned as text", text(await run('text("one"); return "two"')) === "one\ntwo");
		const oversized = text(await run('// @options: {"max_output_tokens":20}\ntext("a".repeat(80)); return "z".repeat(80)'));
		check("return value shares the output budget", oversized.includes("truncated output") && oversized.includes("a".repeat(40)) && oversized.includes("z".repeat(40)) && !oversized.includes("z".repeat(41)));
		const image = await run('// @options: {"max_output_tokens":1}\nimage("data:image/png;base64,aGVsbG8="); return "x".repeat(200)');
		check("output truncation preserves images", image.content.some(item => item.type === "image" && item.data === "aGVsbG8="));
		const thrown = await run('\n\nthrow new Error("smoke boom")');
		check("error stack keeps script line numbers", thrown.isError && /codemode\.js:3/.test(text(thrown)));
		const missing = await run('await tools.read({path:"missing-smoke-note.md"})');
		check("nested tool errors propagate", missing.isError && text(missing).includes("Script error"));

		const started = performance.now();
		const spin = await run('// @options: {"timeout_ms":200}\nwhile(true){}');
		report.spinMs = Math.round(performance.now() - started);
		check("runaway worker is terminated", spin.isError && /timed out/.test(text(spin)) && report.spinMs < 5000);
		const hungry = await run('const all=[]; while(true) all.push(new Array(1e5).fill(0));');
		check("VM heap limit is enforced", hungry.isError && /out of memory/i.test(text(hungry)));
		const controller = new AbortController();
		const cancelled = run('await Promise.all([tools.mcp_smoke_write_probe({n:1}),tools.mcp_smoke_write_probe({n:2})]);', controller.signal);
		await wait(async () => (await stats()).writes.includes(1), "first sequential call");
		controller.abort();
		check("caller cancellation returns an error", (await cancelled).isError);
		await pause(500);
		check("cancelled queued write never reaches MCP", JSON.stringify((await stats()).writes) === "[1]");
		check("new VM works after failed runs", text(await run('return "still works"')) === "still works");
		await service.sendPrompt("/codemode off");
		check("off restores direct tools", !names().includes("codemode") && names().includes("read") && names().includes("mcp_smoke_probe"));
		await service.sendPrompt("smoke-seed-off");
		check("off removes codemode from provider requests", !(await stats()).requests.find(request => request.prompt.includes("smoke-seed-off"))?.tools.includes("codemode"));
		await service.sendPrompt("/codemode on");
		check("all script workers and blob URLs are released", workers.size === 0 && workerUrls.size === 0 && created === revoked);
		report.resources = { createdWorkers: created, liveWorkers: workers.size, revokedWorkerUrls: revoked };
		if (audit) {
			report.nodeAudit = audit.report;
			check("mobile plugin loaded exactly once", audit.report.evaluations === 1);
			check("mobile reload has no unexpected console errors", audit.report.consoleErrors.every(error => error.control));
			check("mobile loader denies Node negative controls", audit.report.controls.every(control => !control.provided));
			check("mobile plugin does not request Node modules", audit.report.requests.every(request => !/^(node:|fs$|child_process$|electron$)/.test(request.id)));
		}
		check("no unhandled renderer errors", report.errors.length === 0);
		report.passed = true;
	} catch (error) { report.failure = String(error.stack ?? error); }
	finally {
		if (audit) report.nodeAudit = audit.report;
		for (const worker of workers) worker.terminate();
		for (const url of workerUrls) URL.revokeObjectURL(url);
		window.Worker = NativeWorker;
		URL.revokeObjectURL = revoke;
		window.removeEventListener("error", onError);
		window.removeEventListener("unhandledrejection", onError);
		audit?.restore();
	}
	return report;
}

let ws;
let deadline;
try {
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	const target = targets.find(target => target.type === "page" && target.url.startsWith("app://") && target.url.includes("index.html"));
	if (!target) throw new Error("No Obsidian index.html target");
	ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
	const call = (id, method, params) => new Promise((resolve, reject) => {
		const listener = event => {
			const message = JSON.parse(event.data);
			if (message.id !== id) return;
			ws.removeEventListener("message", listener);
			message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
		};
		ws.addEventListener("message", listener);
		ws.send(JSON.stringify({ id, method, params }));
	});
	const reply = await Promise.race([
		call(1, "Runtime.evaluate", { expression: `(${runSmoke})(${JSON.stringify(directory)},${mobile},${JSON.stringify(endpoint)},(${observePluginNodeAccess}))`, awaitPromise: true, returnByValue: true }),
		new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("Smoke CDP timeout")), 180000); }),
	]);
	const report = reply.exceptionDetails ? { passed: false, failure: reply.exceptionDetails.exception?.description } : reply.result.value;
	const kind = mobile ? "mobile" : "desktop";
	await writeFile(`${directory}/${kind}.json`, JSON.stringify({ ...report, fixture: state }, null, 2));
	const screenshot = await call(2, "Page.captureScreenshot", { format: "png" });
	await writeFile(`${directory}/${kind}.png`, Buffer.from(screenshot.data, "base64"));
	console.log(JSON.stringify(report));
	process.exitCode = report.passed ? 0 : 1;
} finally {
	clearTimeout(deadline);
	ws?.close();
	for (const timer of timers) clearTimeout(timer);
	fixture.closeAllConnections();
	await new Promise(resolve => fixture.close(resolve));
}
