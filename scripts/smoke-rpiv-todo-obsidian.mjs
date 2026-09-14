/**
 * Real Obsidian smoke for the @juicesharp/rpiv-todo compat bridge.
 * Disposable vault only; the model endpoint is local and deterministic.
 * Usage: node scripts/smoke-rpiv-todo-obsidian.mjs <CDP-port> <output-dir> [--expect-mobile]
 * Start Obsidian with <output-dir>/vault and official mobile emulation for the mobile pass.
 * The script closes its HTTP server/CDP socket and restores all observers on every exit.
 */
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { observePluginNodeAccess } from "./obsidian-plugin-node-audit.mjs";

const SUBJECT = "整理周五笔记";

async function runSmoke(root, endpoint, expectMobile, observeNodeAccess) {
	// Serialized into the page via toString(): constants must live in here.
	const SUBJECT = "整理周五笔记";
	const report = { passed: false, checks: [], errors: [] };
	const record = (name, value) => { if (!value) throw new Error(name); report.checks.push(name); };
	const wait = async test => {
		for (let attempt = 0; attempt < 400; attempt++) {
			if (await test()) return;
			await new Promise(resolve => setTimeout(resolve, 20));
		}
		throw new Error("Condition timed out");
	};
	await wait(() => window.app?.plugins?.plugins?.piem?.agentService);
	if (app.vault.adapter.getBasePath() !== `${root}/vault`) throw new Error("Use a disposable vault at <output-dir>/vault.");
	report.environment = { mobile: app.isMobile, phone: document.body.classList.contains("is-phone"), width: innerWidth, obsidian: document.title.match(/Obsidian ([0-9.]+)/)?.[1] };
	record("correct official device mode", app.isMobile === expectMobile);
	if (expectMobile) record("official phone emulation", document.body.classList.contains("emulate-mobile") && report.environment.phone);
	const error = event => report.errors.push(String(event.error ?? event.reason ?? event.message));
	window.addEventListener("error", error);
	window.addEventListener("unhandledrejection", error);
	const audit = expectMobile ? observeNodeAccess("piem") : undefined;
	let plugin = app.plugins.plugins.piem;
	const reload = async () => {
		await app.plugins.unloadPlugin("piem");
		await app.plugins.loadPlugin("piem");
		await wait(() => app.plugins.plugins.piem?.agentService);
		plugin = app.plugins.plugins.piem;
		await plugin.agentService.initialize();
	};
	// The controlling process takes the desktop screenshot once the overlay is
	// mounted; a standalone run must never wait on that forever.
	const holdForScreenshot = () => new Promise(resolve => {
		window.__piemTodoHoldResolve = () => { delete window.__piemTodoHoldResolve; resolve(); };
		setTimeout(() => { if (window.__piemTodoHoldResolve) window.__piemTodoHoldResolve(); }, 30000);
	});
	const surfaces = () => document.querySelector(".piem-chat__extension-surfaces");
	const overlayText = () => surfaces()?.textContent ?? "";
	// A brand-new session's panel adapter attaches asynchronously; the first
	// command can land in the detached window and answer "requires interactive
	// mode". Retry at human pace instead of pinning the smoke to that race.
	const runTodos = async () => {
		const service = plugin.agentService;
		const snapshot = () => service.getSnapshot();
		// Upstream routes the detached-UI message through notify(..., "error"),
		// so it lands in errorMessage while a success lands in noticeMessage.
		// Retry until the notice carries real content; the stale error banner
		// is harmless because only the notice text is asserted downstream.
		let text = "";
		for (let attempt = 0; attempt < 30; attempt++) {
			if (attempt) await new Promise(resolve => setTimeout(resolve, 100));
			await service.runExtensionCommand("todos");
			text = snapshot().noticeMessage ?? "";
			if (text && !/interactive/i.test(text)) return text;
		}
		const error = snapshot().errorMessage ?? "";
		return `${text}${error ? `\n${error}` : ""}`;
	};
	try {
		await reload();
		Object.assign(plugin.settings, {
			language: "zh-cn", networkTransport: "requestUrl",
			providers: [{ id: "todo-smoke", name: "Local smoke", baseUrl: `${endpoint}/v1`, protocol: "openai-completions", apiKey: "local-fixture-only", secretRef: "", source: "user", oauthFlow: "" }],
			models: [{ id: "todo-model", providerId: "todo-smoke", modelApiId: "todo", displayName: "Todo", reasoning: false, supportsImages: false }],
			activeModelId: "todo-model", showAgentDetails: true,
		});
		await plugin.saveSettings();
		await plugin.activateChatView();
		const service = plugin.agentService;
		await service.newSession();
		const path = service.getActiveSessionPath();
		const started = performance.now();
		// Turn 1: the scripted provider answers with the original todo tool.
		record("create turn completes", await service.sendPrompt(`请创建一个待办任务：${SUBJECT}。`));
		await wait(() => overlayText().includes(SUBJECT));
		record("overlay widget mounts above editor", surfaces()?.querySelector(".piem-native-extension__text") !== null);
		record("no chat error after tool run", !service.getSnapshot().errorMessage);
		// Visual evidence while the overlay is on screen.
		report.stage = "overlay mounted";
		await holdForScreenshot();
		// /todos: the original command reads the same branch state through notify.
		const notice = await runTodos();
		record("todos command reports the task", notice.includes(SUBJECT));
		// Reload cycles the real plugin loader; the reopened session replays state.
		const registrations = plugin._events.length;
		await reload();
		await plugin.agentService.openSession(path);
		await wait(() => overlayText().includes(SUBJECT));
		record("overlay remounts from persisted session", true);
		record("plugin listener count stable", plugin._events.length === registrations);
		record("todos works after reload", await plugin.agentService.runExtensionCommand("todos") !== undefined);
		record("notice still lists the task", plugin.agentService.getSnapshot().noticeMessage?.includes(SUBJECT) === true);
		// Turn 2: clearing the list must unregister the widget.
		record("clear turn completes", await plugin.agentService.sendPrompt("把待办任务全部清空。"));
		await wait(() => !overlayText().includes(SUBJECT));
		record("overlay unmounts when the list empties", !surfaces()?.querySelector(".piem-native-extension__text"));
		await plugin.agentService.newSession();
		const emptyNotice = await runTodos();
		// The upstream English fallback for an empty list; a detached-UI race
		// that survives the retry would answer "requires interactive mode".
		record("empty branch reports no todos", /no todos/i.test(emptyNotice));
		report.session = path;
		report.durationMs = Math.round(performance.now() - started);
		if (audit) {
			record("negative Node controls refused", audit.report.controls.length === 6 && audit.report.controls.every(item => !item.provided));
			record("plugin only requests Obsidian", audit.report.requests.length > 0 && audit.report.requests.every(item => item.id === "obsidian" && item.provided));
			record("no unexpected console errors", audit.report.consoleErrors.every(item => item.control));
			report.nodeAccess = audit.report;
		}
		record("no renderer errors or unhandled rejections", report.errors.length === 0);
		report.passed = true;
	} catch (cause) {
		report.failure = String(cause.stack ?? cause);
		report.notice = plugin?.agentService?.getSnapshot().noticeMessage;
		report.panelError = plugin?.agentService?.getSnapshot().errorMessage;
	} finally {
		delete window.__piemTodoHoldResolve;
		audit?.restore();
		window.removeEventListener("error", error);
		window.removeEventListener("unhandledrejection", error);
	}
	return report;
}

const [port, directory, mode, ...extra] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port) || !directory || (mode && mode !== "--expect-mobile") || extra.length) throw new Error("Usage: node scripts/smoke-rpiv-todo-obsidian.mjs <CDP-port> <output-dir> [--expect-mobile]");
const root = resolve(directory), mobile = mode === "--expect-mobile", requests = [];
await mkdir(root, { recursive: true });
// The scripted provider plays the model: first call per turn issues the todo
// tool call, the follow-up ends the turn with plain content.
const script = [
	{ tool: { action: "create", subject: SUBJECT, description: "把周五的散记归档", activeForm: "整理周五笔记中" } },
	{ content: "已创建待办：整理周五笔记。" },
	{ tool: { action: "clear" } },
	{ content: "已清空全部待办。" },
];
const server = createServer(async (request, response) => {
	try {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
		let text = "";
		for await (const chunk of request) { text += chunk; if (text.length > 2 * 1024 * 1024) throw new Error("Request too large"); }
		const body = JSON.parse(text);
		// Side requests (title/summary) carry no tools; never feed them the script.
		const chat = body.tools?.some(tool => tool.function.name === "todo");
		if (!chat) {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(`data: ${JSON.stringify({ id: "chatcmpl-local-smoke", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { content: "[]" }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`);
			return;
		}
		requests.push(body);
		const step = script.shift() ?? { content: "剧本已用尽。" };
		const delta = step.tool
			? { tool_calls: [{ index: 0, id: `smoke-todo-${requests.length}`, type: "function", function: { name: "todo", arguments: JSON.stringify(step.tool) } }] }
			: { content: step.content };
		const chunk = { id: "chatcmpl-local-smoke", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] };
		const done = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: step.tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 } };
		await new Promise(resolve => setTimeout(resolve, 60));
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		response.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`);
	} catch (cause) { response.writeHead(500).end(String(cause)); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let socket, timer;
const waiters = new Map();
let nextId = 0;
try {
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
	const target = targets.find(item => item.type === "page" && item.url.startsWith("app://"));
	if (!target) throw new Error("No Obsidian page.");
	socket = new WebSocket(target.webSocketDebuggerUrl);
	socket.addEventListener("message", event => {
		const message = JSON.parse(event.data);
		const waiter = waiters.get(message.id);
		if (!waiter) return;
		waiters.delete(message.id);
		message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
	});
	timer = setTimeout(() => { for (const waiter of waiters.values()) waiter.reject(new Error("Smoke timed out")); socket.close(); }, 90000);
	await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const id = ++nextId;
		waiters.set(id, { resolve, reject });
		socket.send(JSON.stringify({ id, method, params }));
	});
	const endpoint = `http://127.0.0.1:${server.address().port}`;
	const run = send("Runtime.evaluate", { expression: `(${runSmoke.toString()})(${JSON.stringify(root)},${JSON.stringify(endpoint)},${mobile},${observePluginNodeAccess.toString()})`, awaitPromise: true, returnByValue: true });
	// Screenshot the overlay exactly once it reports itself mounted.
	let ready = false;
	for (let attempt = 0; attempt < 120 && !ready; attempt++) {
		await new Promise(resolve => setTimeout(resolve, 250));
		const probe = await send("Runtime.evaluate", { expression: "window.__piemTodoHoldResolve ? 1 : 0", returnByValue: true });
		ready = probe.result?.value === 1;
	}
	if (ready) {
		const shot = await send("Page.captureScreenshot", { format: "png" });
		await writeFile(resolve(root, mobile ? "rpiv-todo-mobile-overlay.png" : "rpiv-todo-desktop-overlay.png"), Buffer.from(shot.data, "base64"));
		await send("Runtime.evaluate", { expression: "window.__piemTodoHoldResolve && window.__piemTodoHoldResolve()", awaitPromise: true });
	}
	const result = await run;
	if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
	const report = result.result.value;
	const artifact = await readFile(resolve(root, "vault/.obsidian/plugins/piem/main.js"));
	report.artifactSha256 = createHash("sha256").update(artifact).digest("hex");
	report.bytes = artifact.length;
	report.requests = requests.map(body => ({ model: body.model, tools: body.tools?.map(tool => tool.function.name), messages: body.messages }));
	const wireChecks = [
		["todo tool registered in every request", requests.length > 0 && requests.every(body => body.tools?.some(tool => tool.function.name === "todo"))],
		["created subject reaches the provider transcript", Boolean(requests[1]?.messages) && JSON.stringify(requests[1].messages).includes(SUBJECT)],
		["clear action reaches the provider transcript", requests.length > 3 && JSON.stringify(requests[3].messages).includes('\\"clear\\"')],
	];
	for (const [name, passed] of wireChecks) { if (passed) report.checks.push(name); else { report.passed = false; report.failure ??= name; } }
	const filename = mobile ? "rpiv-todo-mobile.json" : "rpiv-todo-desktop.json";
	await writeFile(resolve(root, filename), `${JSON.stringify(report, null, 2)}\n`);
	const finalShot = await send("Page.captureScreenshot", { format: "png" });
	await writeFile(resolve(root, mobile ? "rpiv-todo-mobile-final.png" : "rpiv-todo-desktop-final.png"), Buffer.from(finalShot.data, "base64"));
	console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, requests: requests.length, environment: report.environment, artifactSha256: report.artifactSha256, result: resolve(root, filename), failure: report.failure }));
	if (!report.passed) process.exitCode = 1;
} finally {
	clearTimeout(timer);
	socket?.close();
	server.closeAllConnections();
	await new Promise(resolve => server.close(resolve));
}
