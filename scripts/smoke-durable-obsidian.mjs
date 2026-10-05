/** Real release bundle, real Vault, official phone loader with Node negative controls.
 * Usage: node scripts/smoke-durable-obsidian.mjs <CDP-port> <rig-root> [--expect-mobile]
 * Fault injection holds a real write's result after its side effect, then unloads Piem.
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { observePluginNodeAccess } from "./obsidian-plugin-node-audit.mjs";

const [port, directory, mode, ...extra] = process.argv.slice(2);
if (!/^\d+$/.test(port ?? "") || !directory || (mode && mode !== "--expect-mobile") || extra.length) throw new Error("Usage: <CDP-port> <rig-root> [--expect-mobile]");
const root = resolve(directory), mobile = mode === "--expect-mobile";
const requests = [], held = new Set();
let releaseToolResponse;
const fixture = createServer(async (req, res) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Headers", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
	if (req.url === "/state") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(requests)); return; }
	if (req.url === "/release-tool") { releaseToolResponse?.(); res.end("released"); return; }
	if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
	try {
		let text = "";
		for await (const chunk of req) { text += chunk; if (text.length > 2_000_000) throw new Error("Fixture request too large"); }
		const body = JSON.parse(text);
		const index = body.tools?.length ? body.messages.findLastIndex(message => message.role === "user" && /durable-smoke-(simple|tool|stop)/.test(JSON.stringify(message.content))) : -1;
		const prompt = JSON.stringify(body.messages[index]?.content ?? "");
		const results = body.messages.slice(index + 1).filter(message => message.role === "tool");
		requests.push({ prompt, results, tools: body.tools?.map(tool => tool.function?.name) ?? [] });
		if (prompt.includes("durable-smoke-stop")) {
			held.add(res); res.once("close", () => held.delete(res)); return;
		}
		if (prompt.includes("durable-smoke-tool") && !results.length) {
			held.add(res);
			await new Promise(resolve => { releaseToolResponse = resolve; res.once("close", resolve); });
			held.delete(res);
		}
		res.setHeader("Content-Type", "text/event-stream");
		const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "durable", object: "chat.completion.chunk", model: "smoke", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
		chunk({ role: "assistant" });
		if (prompt.includes("durable-smoke-tool") && !results.length) {
			chunk({ tool_calls: [{ index: 0, id: "durable-write", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "durable-smoke-note.md", content: "Durable smoke: written once.\n" }) } }] });
			chunk({}, "tool_calls");
		} else {
			chunk({ content: index < 0 ? "[]" : results.length ? "Recovered without repeating the write." : "Durable smoke ready." });
			chunk({}, "stop");
		}
		res.end("data: [DONE]\n\n");
	} catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${fixture.address().port}`;

async function runSmoke(root, mobile, endpoint, observe) {
	const report = { passed: false, checks: [], errors: [], writes: 0, faultInjection: "Hold the real vault write's result, then unload the plugin" };
	window.__piemDurableSmoke = report;
	const check = (name, condition) => { if (!condition) throw new Error(name); report.checks.push(name); };
	const wait = async (condition, name) => {
		const until = performance.now() + 20_000;
		while (performance.now() < until) { if (await condition()) return; await new Promise(resolve => window.setTimeout(resolve, 25)); }
		throw new Error(`Timed out: ${name}`);
	};
	const onError = event => report.errors.push(String(event.error ?? event.reason ?? event.message));
	let plugin, audit, originalWrite, releaseTool, restoreTool;
	const reload = async () => {
		const previous = app.plugins.plugins.piem?.agentService;
		await app.plugins.unloadPlugin("piem");
		await app.plugins.loadPlugin("piem");
		await wait(() => app.plugins.plugins.piem?.agentService, "Piem service");
		plugin = app.plugins.plugins.piem;
		await plugin.agentService.initialize();
		await plugin.activateChatView();
		check("previous runtime released", !previous || previous.runtimes.size === 0);
	};
	const execution = async (service, path = service.getActiveSessionPath()) => service.sessionManager.getSessionFor(path).execution();
	try {
		await wait(() => window.app?.plugins?.plugins?.piem?.agentService, "initial service");
		check("disposable vault", app.vault.adapter.getBasePath() === `${root}/vault`);
		check("official device mode", app.isMobile === mobile);
		if (!mobile) check("desktop viewport", innerWidth >= 900 && innerHeight >= 700);
		if (mobile) check("official phone emulation", document.body.classList.contains("emulate-mobile") && document.body.classList.contains("is-phone") && innerWidth === 390);
		plugin = app.plugins.plugins.piem;
		Object.assign(plugin.settings, {
			language: "en", networkTransport: "fetch", shareDiagnostics: false, mobileComposerCollapsed: false,
			providers: [{ id: "durable-smoke", name: "Local durable fixture", baseUrl: `${endpoint}/v1`, protocol: "openai-completions", apiKey: "fixture-only", secretRef: "", source: "user", oauthFlow: "" }],
			models: [{ id: "durable-smoke", providerId: "durable-smoke", modelApiId: "smoke", displayName: "Durable fixture", reasoning: false, supportsImages: false }],
			activeModelId: "durable-smoke", codemodeMode: "on",
			mcpServers: [{ id: "builtin-exa", name: "Exa", url: "https://mcp.exa.ai/mcp", enabled: false }],
		});
		await plugin.saveSettings({ reconfigure: false });
		audit = mobile ? observe("piem", true) : undefined;
		await reload();
		window.addEventListener("error", onError); window.addEventListener("unhandledrejection", onError);
		report.environment = { mobile: app.isMobile, width: innerWidth, height: innerHeight, userAgent: navigator.userAgent, title: document.title, platform: audit?.report.platform };
		let service = plugin.agentService;
		await service.newSession({ force: true });
		await wait(() => document.querySelector(".piem-chat__composer textarea"), "composer");
		await wait(() => service.runtimes.get(service.getActiveSessionPath())?.extensionUI, "current composer attached");
		const textarea = document.querySelector(".piem-chat__composer textarea");
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(textarea, "durable-smoke-simple");
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
		await wait(() => service.runtimes.get(service.getActiveSessionPath())?.extensionUI?.getEditorText() === "durable-smoke-simple", "draft reached current session");
		await wait(() => !document.querySelector(".piem-chat__send-button")?.disabled, "send enabled");
		document.querySelector(".piem-chat__send-button").click();
		await wait(() => service.getSnapshot().messages.some(message => message.role === "assistant"), "UI response");
		await service.agent.waitForIdle();
		check("UI run settled", !await (await execution(service)).hasPending());
		check("answer rendered", document.querySelector(".piem-chat__messages")?.textContent.includes("Durable smoke ready"));

		report.stage = "write result interrupted by unload";
		await service.newSession({ force: true });
		const oldNote = app.vault.getFileByPath("durable-smoke-note.md");
		if (oldNote) await app.vault.delete(oldNote);
		originalWrite = app.vault.adapter.write;
		app.vault.adapter.write = async function (path, ...args) {
			if (path === "durable-smoke-note.md") report.writes++;
			return originalWrite.call(this, path, ...args);
		};
		// The real vault tool still runs. Only its return is held, emulating the
		// gap between the side effect and the durable result checkpoint.
		const running = service.sendPrompt("durable-smoke-tool: write the fixture note once.").catch(() => false);
		await wait(async () => (await (await fetch(`${endpoint}/state`)).json()).some(request => request.prompt.includes("durable-smoke-tool")), "tool request prepared");
		const tool = service.agent.state.tools.find(tool => tool.name === "write");
		check("real vault write tool", !!tool);
		let written = false;
		const execute = tool.execute;
		restoreTool = () => { tool.execute = execute; };
		tool.execute = async function (...args) {
			const result = await execute.apply(this, args);
			written = true;
			await new Promise(resolve => {
				releaseTool = resolve;
				if (args[2]?.aborted) resolve(); else args[2]?.addEventListener("abort", resolve, { once: true });
			});
			args[2]?.throwIfAborted();
			return result;
		};
		await fetch(`${endpoint}/release-tool`, { method: "POST" });
		await wait(() => written, "real write completed");
		const path = service.getActiveSessionPath(), oldAgent = service.agent;
		check("write exists before result", (await app.vault.adapter.read("durable-smoke-note.md")).includes("written once"));
		check("task remains recoverable", await (await execution(service)).hasPending());
		const before = await app.vault.adapter.read(path);
		await plugin.sessionManager.readActiveSessionName();
		await plugin.sessionManager.readLastSessionThinkingLevel();
		await service.listSessions();
		check("readers do not rewrite running task", await app.vault.adapter.read(path) === before);
		await reload();
		await oldAgent.waitForIdle(); await running;
		service = plugin.agentService;
		await service.openSession(path);
		check("reload offers interrupted run", service.getSnapshot().canResumeInterrupted === true);
		await service.resumeInterruptedRun();
		await service.agent.waitForIdle();
		check("write not repeated", report.writes === 1);
		check("missing result reported as interrupted", service.getSnapshot().messages.some(message => message.role === "toolResult" && message.isError && JSON.stringify(message.content).includes("interrupted")));
		check("recovered task settled", !await (await execution(service)).hasPending());
		check("recovery answer rendered", service.getSnapshot().messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes("Recovered without repeating")));
		report.recoveredPath = path;

		report.stage = "stop then reload";
		await service.newSession({ force: true });
		const stopped = service.sendPrompt("durable-smoke-stop").catch(() => false);
		await wait(async () => (await (await fetch(`${endpoint}/state`)).json()).some(request => request.prompt.includes("durable-smoke-stop")), "blocked request");
		const stopPath = service.getActiveSessionPath();
		await wait(() => document.querySelector(".piem-chat__stop-button"), "Stop button");
		document.querySelector(".piem-chat__stop-button").click();
		await wait(async () => !await (await execution(service, stopPath)).hasPending(), "durable cancellation");
		await reload(); await stopped;
		service = plugin.agentService;
		await service.openSession(stopPath);
		check("stopped task not resurrected", !await (await execution(service)).hasPending() && !service.getSnapshot().canResumeInterrupted);
		await service.openSession(report.recoveredPath);
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		if (mobile) {
			check("mobile platform contract", audit.report.platform?.isMobileApp === true && audit.report.platform?.isDesktopApp === false);
			check("Node negative controls denied", audit.report.controls.length === 6 && audit.report.controls.every(control => !control.provided));
			check("plugin reloads audited", audit.report.evaluations === 3);
			check("no Node modules acquired", audit.report.requests.every(request => request.id === "obsidian" || !request.provided));
			check("no unexpected loader errors", audit.report.consoleErrors.every(error => error.control));
		}
		check("no unhandled renderer errors", report.errors.length === 0);
		// The loader's six intentional failures show Notices. Dismiss only
		// those controls after recording them, so the final capture shows chat.
		for (const notice of document.querySelectorAll(".notice")) {
			if (/piem attempted to load NodeJS package/i.test(notice.textContent ?? "")) notice.click();
		}
		await wait(() => ![...document.querySelectorAll(".notice")].some(notice => /piem attempted to load NodeJS package/i.test(notice.textContent ?? "")), "negative control notices dismissed");
		report.passed = true;
	} catch (error) { report.failure = String(error.stack ?? error); }
	finally {
		releaseTool?.();
		restoreTool?.();
		if (originalWrite) app.vault.adapter.write = originalWrite;
		report.nodeAudit = audit?.report;
		audit?.restore();
		window.removeEventListener("error", onError); window.removeEventListener("unhandledrejection", onError);
	}
	return report;
}

let socket, deadline;
const pending = new Map(); let sequence = 0;
try {
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	const target = targets.find(target => target.type === "page" && target.url.startsWith("app://") && target.url.includes("index.html"));
	if (!target) throw new Error("No Obsidian index.html target");
	socket = new WebSocket(target.webSocketDebuggerUrl);
	socket.addEventListener("message", event => {
		const reply = JSON.parse(event.data), waiter = pending.get(reply.id);
		if (!waiter) return;
		pending.delete(reply.id);
		reply.error ? waiter.reject(new Error(JSON.stringify(reply.error))) : waiter.resolve(reply.result);
	});
	await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
	const call = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
	deadline = setTimeout(() => { for (const waiter of pending.values()) waiter.reject(new Error("Durable smoke deadline")); socket.close(); }, 150_000);
	const reply = await call("Runtime.evaluate", { expression: `(${runSmoke})(${JSON.stringify(root)},${mobile},${JSON.stringify(endpoint)},(${observePluginNodeAccess}))`, awaitPromise: true, returnByValue: true });
	const report = reply.exceptionDetails ? { passed: false, failure: reply.exceptionDetails.exception?.description } : reply.result.value;
	const bytes = await readFile(resolve(root, "vault/.obsidian/plugins/piem/main.js"));
	report.artifactSha256 = createHash("sha256").update(bytes).digest("hex");
	report.fixture = { requests, heldRequests: held.size };
	const kind = mobile ? "mobile" : "desktop";
	await writeFile(resolve(root, `durable-${kind}.json`), JSON.stringify(report, null, 2));
	const shot = await call("Page.captureScreenshot", { format: "png" });
	await writeFile(resolve(root, `durable-${kind}.png`), Buffer.from(shot.data, "base64"));
	console.log(JSON.stringify({ passed: report.passed, checks: report.checks?.length, failure: report.failure, report: resolve(root, `durable-${kind}.json`) }));
	if (!report.passed) process.exitCode = 1;
} finally {
	clearTimeout(deadline); socket?.close();
	for (const response of held) response.destroy();
	fixture.closeAllConnections();
	await new Promise(resolve => fixture.close(resolve));
}
