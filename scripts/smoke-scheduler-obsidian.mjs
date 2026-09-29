/**
 * Real Obsidian smoke for the @vincentff/pi-scheduler community extension.
 * Validates the runtime path the fixture harness cannot reach: an idle
 * background timer that fires, delivers a follow-up, and wakes one model turn —
 * plus persistence of a recurring task across a plugin reload.
 * Disposable vault only; the model endpoint is local and deterministic.
 * Usage: node scripts/smoke-scheduler-obsidian.mjs <CDP-port> <output-dir>
 */
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const MARK = "SCHEDULER_FIRE_MARK";

async function runSmoke(root, endpoint) {
	const MARK = "SCHEDULER_FIRE_MARK";
	const report = { passed: false, checks: [], errors: [] };
	const record = (name, value) => { if (!value) throw new Error(name); report.checks.push(name); };
	const wait = async (test, tries = 500) => {
		for (let attempt = 0; attempt < tries; attempt++) { if (await test()) return; await new Promise(r => setTimeout(r, 20)); }
		throw new Error(`Condition timed out: ${test}`);
	};
	await wait(() => window.app?.plugins?.plugins?.piem?.agentService);
	if (app.vault.adapter.getBasePath() !== `${root}/vault`) throw new Error("Use a disposable vault at <output-dir>/vault.");
	report.environment = { obsidian: document.title.match(/Obsidian ([0-9.]+)/)?.[1], width: innerWidth };
	const error = event => report.errors.push(String(event.error ?? event.reason ?? event.message));
	window.addEventListener("error", error);
	window.addEventListener("unhandledrejection", error);
	let plugin = app.plugins.plugins.piem;
	const reload = async () => {
		await app.plugins.unloadPlugin("piem");
		await app.plugins.loadPlugin("piem");
		await wait(() => app.plugins.plugins.piem?.agentService);
		plugin = app.plugins.plugins.piem;
		await plugin.agentService.initialize();
	};
	const messages = () => plugin.agentService.getSnapshot().messages ?? [];
	const body = message => JSON.stringify(message?.content ?? "");
	// Read the persisted schedule straight from the namespaced config store: the
	// `/schedule list` command is interactive (ctx.ui.select) under hasUI and does
	// not resolve in piem's non-terminal UI, so it is unusable as a probe.
	const configJson = () => plugin.settings?.extensionConfig?.["@vincentff/pi-scheduler"]?.["scheduler-tasks.json"] ?? "";
	const schedule = async args => {
		await plugin.agentService.runExtensionCommand("schedule", args);
		const snapshot = plugin.agentService.getSnapshot();
		return snapshot.noticeMessage ?? snapshot.errorMessage ?? "";
	};
	// PLACEHOLDER_RUNSMOKE_BODY
	const stage = s => { window.__schedStage = s; report.lastStage = s; };
	try {
		stage("reload");
		await reload();
		stage("settings");
		Object.assign(plugin.settings, {
			language: "zh-cn", networkTransport: "requestUrl",
			providers: [{ id: "sched-smoke", name: "Local smoke", baseUrl: `${endpoint}/v1`, protocol: "openai-completions", apiKey: "local-fixture-only", secretRef: "", source: "user", oauthFlow: "" }],
			models: [{ id: "sched-model", providerId: "sched-smoke", modelApiId: "sched", displayName: "Sched", reasoning: false, supportsImages: false }],
			activeModelId: "sched-model", showAgentDetails: true, disabledExtensions: [],
		});
		await plugin.saveSettings();
		// The scheduler ships disabled; enabling it (disabledExtensions: []) takes
		// effect when the host is next built, so reload once more from the saved
		// data.json before opening the session that must carry it.
		stage("reload-enable");
		await reload();
		stage("activateChatView");
		await plugin.activateChatView();
		const service = plugin.agentService;
		stage("newSession");
		await service.newSession();
		const path = service.getActiveSessionPath();
		report.enabledDisabledExtensions = [...(plugin.settings?.disabledExtensions ?? [])];
		const started = performance.now();
		// Persistence first, with a 30s recurring task that will not fire during the
		// run — kept clear of the one-time fire below, whose own config rewrite
		// (removing the spent task) would otherwise race this write in upstream's
		// unlocked read-modify-write.
		stage("schedule-recurring");
		const recur = await schedule("add every 30s | 循环任务保活");
		report.recurNotice = recur;
		record("recurring schedule add is accepted", recur.length > 0 && !/unknown subcommand|unknown command|no such/i.test(recur));
		await wait(() => configJson().includes("循环任务保活"), 200);
		record("recurring task written to the namespace", true);
		stage("reload-2");
		await reload();
		await plugin.agentService.openSession(path);
		stage("verify-persist");
		record("recurring task survives a plugin reload", configJson().includes("循环任务保活"));
		record("no chat error after reload", !plugin.agentService.getSnapshot().errorMessage);
		// A one-time task 3s out; the session then sits idle until it fires.
		const fireStart = performance.now();
		stage("schedule-add");
		const added = await schedule(`add in 3s | 定时触发：请只回复 ${MARK}`);
		report.addNotice = added;
		record("schedule add is accepted", added.length > 0 && !/unknown subcommand|unrecognized/i.test(added));
		await wait(() => configJson().includes(MARK), 200);
		record("scheduled task is persisted before firing", true);
		record("no error arming the timer", !plugin.agentService.getSnapshot().errorMessage);
		// The idle background timer must fire, deliver a followUp, and wake a turn:
		// the transcript grows a user message carrying MARK, then an assistant PONG.
		stage("await-fire-user");
		await wait(() => messages().some(m => m.role === "user" && body(m).includes(MARK)), 800);
		record("idle background timer fires a follow-up user turn", true);
		stage("await-fire-assistant");
		await wait(() => messages().some(m => m.role === "assistant" && body(m).includes("PONG")), 800);
		record("fired follow-up wakes a model turn (assistant PONG)", true);
		report.stage = "fired";
		report.fireMs = Math.round(performance.now() - fireStart);
		report.session = path;
		report.durationMs = Math.round(performance.now() - started);
		record("no renderer errors or unhandled rejections", report.errors.length === 0);
		stage("done");
		report.passed = true;
	} catch (cause) {
		report.failure = String(cause.stack ?? cause);
		report.notice = plugin?.agentService?.getSnapshot().noticeMessage;
		report.panelError = plugin?.agentService?.getSnapshot().errorMessage;
		report.transcript = plugin?.agentService?.getSnapshot().messages?.map(m => ({ role: m.role, content: JSON.stringify(m.content).slice(0, 120) }));
	} finally {
		window.removeEventListener("error", error);
		window.removeEventListener("unhandledrejection", error);
	}
	return report;
}

const [port, directory, ...extra] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port) || !directory || extra.length) throw new Error("Usage: node scripts/smoke-scheduler-obsidian.mjs <CDP-port> <output-dir>");
const root = resolve(directory), requests = [];
await mkdir(root, { recursive: true });
// Deterministic provider: a turn whose transcript carries MARK is the fired
// follow-up, answered with PONG; every other request (titles, summaries) is benign.
const server = createServer(async (request, response) => {
	try {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
		let text = "";
		for await (const chunk of request) { text += chunk; if (text.length > 2 * 1024 * 1024) throw new Error("Request too large"); }
		const payload = JSON.parse(text);
		requests.push(payload);
		const content = JSON.stringify(payload.messages ?? "").includes(MARK) ? "PONG" : "OK";
		const chunk = { id: "chatcmpl-sched-smoke", object: "chat.completion.chunk", created: 1, model: payload.model, choices: [{ index: 0, delta: { content }, finish_reason: null }] };
		const done = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } };
		await new Promise(resolve => setTimeout(resolve, 40));
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
	timer = setTimeout(() => { for (const waiter of waiters.values()) waiter.reject(new Error("Smoke timed out")); socket.close(); }, 150000);
	await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const id = ++nextId;
		waiters.set(id, { resolve, reject });
		socket.send(JSON.stringify({ id, method, params }));
	});
	// PLACEHOLDER_HARNESS_TAIL
	const endpoint = `http://127.0.0.1:${server.address().port}`;
	const runPromise = send("Runtime.evaluate", { expression: `(${runSmoke.toString()})(${JSON.stringify(root)},${JSON.stringify(endpoint)})`, awaitPromise: true, returnByValue: true });
	// Trace the in-page stage while the smoke runs, so a hang names its step.
	let done = false, lastStage = "";
	runPromise.then(() => { done = true; }, () => { done = true; });
	for (let i = 0; i < 280 && !done; i++) {
		await new Promise(r => setTimeout(r, 500));
		try {
			const probe = await send("Runtime.evaluate", { expression: "window.__schedStage ?? ''", returnByValue: true });
			const s = probe.result?.value ?? "";
			if (s !== lastStage) { lastStage = s; console.error(`[stage] ${s} (+${i * 0.5}s)`); }
		} catch { break; }
	}
	const run = await runPromise;
	if (run.exceptionDetails) throw new Error(JSON.stringify(run.exceptionDetails));
	const report = run.result.value;
	const artifact = await readFile(resolve(root, "vault/.obsidian/plugins/piem/main.js"));
	report.artifactSha256 = createHash("sha256").update(artifact).digest("hex");
	report.bytes = artifact.length;
	// The wire is the ground truth for the fire: the delivered follow-up ran a
	// model turn only if the provider actually received a request carrying MARK.
	const firedRequest = requests.some(payload => JSON.stringify(payload.messages ?? "").includes(MARK));
	if (firedRequest) report.checks.push("fired follow-up reached the provider transcript");
	else { report.passed = false; report.failure ??= "fired follow-up never reached the provider"; }
	report.requestCount = requests.length;
	await writeFile(resolve(root, "scheduler-desktop.json"), `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, requests: requests.length, fireMs: report.fireMs, lastStage: report.lastStage, environment: report.environment, artifactSha256: report.artifactSha256, failure: report.failure }));
	if (!report.passed) process.exitCode = 1;
} finally {
	clearTimeout(timer);
	socket?.close();
	server.closeAllConnections();
	await new Promise(resolve => server.close(resolve));
}
