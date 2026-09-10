/**
 * Opt-in smoke over the shipped bundle in a disposable, real Obsidian vault.
 * A local factory exercises the host contract; it is not pi-suggest integration.
 * Usage: node scripts/smoke-extension-ui-obsidian.mjs <CDP-port> <output-dir> [--expect-mobile]
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async function runSmoke(root, endpoint, expectMobile) {
	const report = { passed: false, checks: [], errors: [], starts: [], events: [] };
	// A CDP timeout can still retrieve the last completed checkpoint.
	window.__piemNativeSmokeReport = report;
	const check = (name, value) => { if (!value) throw new Error(name); report.checks.push(name); };
	const wait = async predicate => {
		for (let attempt = 0; attempt < 250; attempt++) {
			if (await predicate()) return;
			await new Promise(resolve => window.setTimeout(resolve, 20));
		}
		throw new Error("Condition timed out");
	};
	await wait(() => window.app?.plugins?.plugins?.piem?.agentService);
	if (app.vault.adapter.getBasePath() !== `${root}/vault`) throw new Error("Use a disposable vault at <output-dir>/vault.");
	check("correct official device mode", app.isMobile === expectMobile);
	if (expectMobile) check("official phone emulation", document.body.classList.contains("is-phone") && document.body.classList.contains("emulate-mobile"));
	const error = event => report.errors.push(String(event.error ?? event.reason ?? event.message));
	window.addEventListener("error", error);
	window.addEventListener("unhandledrejection", error);
	const plugin = app.plugins.plugins.piem;
	await wait(() => !plugin.builtinSkillInstaller || plugin.builtinSkillInstaller.getReport().status === "ready");
	const original = plugin.agentService;
	let service;
	let releaseLate;
	let pendingLate;
	let lateReached;
	let lastContext;
	let completeResult;
	let branchSnapshot;
	let uiResult;
	let idleAtSettled = false;
	const closePanel = async () => {
		for (const leaf of app.workspace.getLeavesOfType("piem-chat-view")) await leaf.detach();
	};
	const textarea = () => document.querySelector(".piem-chat__composer textarea");
	const confirmDialog = async (title, value) => {
		report.stage = `dialog: ${title}`;
		// Mobile retains the closing modal while its exit animation runs. Match
		// the new dialog's title rather than clicking the departing form again.
		const currentForm = () => [...document.querySelectorAll(".piem-extension-dialog form")]
			.find(form => form.closest(".modal")?.querySelector(".modal-title")?.textContent === title);
		await wait(currentForm);
		const form = currentForm();
		const input = form.querySelector("input, textarea, select");
		if (input && value !== undefined) input.value = value;
		form.querySelector('button[type="submit"]').click();
	};
	const factory = pi => {
		pi.on("session_start", (_event, ctx) => {
			lastContext = ctx;
			report.starts.push({ session: ctx.sessionManager.getSessionFile(), mode: ctx.mode, hasUI: ctx.hasUI });
			if (!ctx.hasUI) return;
			ctx.ui.setWidget("smoke", ["原生扩展：准备好了"]);
			ctx.ui.setStatus("smoke", "原生界面已连接");
			ctx.ui.addAutocompleteProvider(current => ({
				...current,
				async getSuggestions(lines, line, col, options) {
					const result = await current.getSuggestions(lines, line, col, options);
					if (result?.items.length) return result;
					return { prefix: lines[line].slice(0, col), items: [{ label: "整理下一步", value: "请整理下一步。", description: "原生输入建议" }] };
				},
			}));
		});
		pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\nNATIVE_BRIDGE_SMOKE` }));
		pi.on("agent_start", () => { report.events.push("agent_start"); });
		pi.on("agent_end", () => { report.events.push("agent_end"); });
		pi.on("agent_settled", (_event, ctx) => { report.events.push("agent_settled"); idleAtSettled = ctx.isIdle(); });
		pi.on("session_shutdown", () => { report.events.push("session_shutdown"); });
		pi.registerCommand("native-smoke", { handler: async (_args, ctx) => {
			lastContext = ctx;
			const selected = await ctx.ui.select("选择下一步", ["阅读", "整理"]);
			const entered = await ctx.ui.input("起个名字", "名称");
			const edited = await ctx.ui.editor("修改草稿", "第一行\n第二行");
			const confirmed = await ctx.ui.confirm("确认", "使用这份草稿？");
			uiResult = { selected, entered, edited, confirmed };
			ctx.ui.setEditorText(edited ?? "");
			ctx.ui.pasteToEditor("\n已确认");
		} });
		pi.registerCommand("native-model", { handler: async (_args, ctx) => {
			branchSnapshot = ctx.sessionManager.getBranch();
			completeResult = await ctx.modelRegistry.complete(ctx.model, {
				messages: [{ role: "user", content: "NATIVE_SIDE_REQUEST", timestamp: Date.now() }],
			}, { maxTokens: 128 });
		} });
		pi.registerCommand("native-late", { handler: async (_args, ctx) => {
			const setText = ctx.ui.setEditorText;
			lateReached = true;
			pendingLate = new Promise(resolve => { releaseLate = resolve; });
			await pendingLate;
			try { setText("旧任务不该写进来的文字"); report.lateWrite = "allowed"; }
			catch { report.lateWrite = "rejected"; }
		} });
	};
	try {
		await closePanel();
		Object.assign(plugin.settings, {
			language: "zh-cn", networkTransport: "requestUrl",
			providers: [{ id: "native-smoke", name: "Local fixture", baseUrl: `${endpoint}/v1`, protocol: "openai-completions", apiKey: "local-fixture-only", secretRef: "", source: "user", oauthFlow: "" }],
			models: [{ id: "native-model", providerId: "native-smoke", modelApiId: "native", displayName: "Native", reasoning: false, supportsImages: false }],
			activeModelId: "native-model",
		});
		service = new original.constructor(app, () => plugin.settings, plugin.sessionManager, {
			extensionFactories: [{ id: "native-smoke", factory }],
			loadUserSkills: async () => ({ skills: [], diagnostics: [], searched: [] }),
		});
		plugin.agentService = service;
		await service.initialize();
		await service.newSession();
		await plugin.activateChatView();
		await wait(() => report.starts.some(entry => entry.hasUI));
		const path = service.getActiveSessionPath();
		check("session starts with native UI", report.starts.at(-1)?.mode === "rpc" && report.starts.at(-1)?.hasUI);
		await wait(() => document.querySelector(".piem-chat__extension-widget")?.textContent.includes("准备好了"));
		check("text widget reaches actual panel", true);
		check("status reaches actual panel", document.querySelector(".piem-chat__extension-status")?.textContent.includes("已连接"));
		await wait(() => {
			const runtime = service.runtimes.get(path);
			return runtime && !runtime.promptPreparations && !runtime.sessionRefreshing && !runtime.sessionOperations && !runtime.isCompacting;
		});
		const command = service.runExtensionCommand("native-smoke").then(result => { report.dialogCommandResult = result; return result; });
		report.stage = "native dialogs";
		await confirmDialog("选择下一步", "整理");
		await confirmDialog("起个名字", "我的笔记");
		await confirmDialog("修改草稿", "整理后的第一行\n第二行");
		await confirmDialog("确认");
		await command;
		check("native dialogs return chosen values", uiResult?.selected === "整理" && uiResult.entered === "我的笔记" && uiResult.confirmed);
		await wait(() => textarea()?.value === "整理后的第一行\n第二行\n已确认");
		check("editor writes reach actual conversation draft", true);
		lastContext.ui.setEditorText("");
		textarea().focus();
		document.querySelector('button[aria-label="显示建议"]').click();
		await wait(() => [...document.querySelectorAll('.piem-chat__command-menu-button')].some(button => button.textContent.includes("整理下一步")));
		[...document.querySelectorAll('.piem-chat__command-menu-button')].find(button => button.textContent.includes("整理下一步")).click();
		await wait(() => textarea()?.value === "请整理下一步。");
		check("completion inserts without sending", service.getSnapshot().messages.length === 0);
		report.stage = "real prompt";
		lastContext.ui.setEditorText("");
		check("real agent prompt completes", await service.sendPrompt("原生桥接回归"));
		await wait(() => idleAtSettled);
		check("settled fires after actual agent idle", idleAtSettled);
		await service.runExtensionCommand("native-model");
		report.stage = "stop late handler";
		check("completion reaches configured model", completeResult?.content.some(part => part.type === "text" && part.text === "原生模型完成"));
		check("branch reads actual persisted conversation", branchSnapshot?.some(entry => entry.type === "message" && entry.message?.role === "assistant") && branchSnapshot.every(entry => typeof entry.id === "string"));
		check("side request usage included", service.getSnapshot().usage.requests >= 2);
		const late = service.runExtensionCommand("native-late");
		await wait(() => lateReached);
		await service.abortSession(path);
		releaseLate();
		await late;
		await wait(() => report.lateWrite);
		check("stopped handler cannot write a late draft", report.lateWrite === "rejected");
		check("late text never reaches input", !textarea()?.value.includes("旧任务"));
		const oldContext = lastContext;
		report.stage = "switch conversation";
		await service.newSession();
		await wait(() => report.starts.some(entry => entry.session === service.getActiveSessionPath()));
		let refused = false;
		try { oldContext.ui.setEditorText("越界旧草稿"); } catch { refused = true; }
		check("old conversation cannot write current editor", refused);
		check("conversation switch keeps fresh draft", textarea()?.value !== "越界旧草稿");
		check("no renderer errors", report.errors.length === 0);
		report.passed = true;
	} catch (cause) {
		report.failedStage = report.stage;
		report.panelNotice = service?.getSnapshot().noticeMessage;
		report.panelError = service?.getSnapshot().errorMessage;
		report.dialogsAtFailure = [...document.querySelectorAll(".modal")].map(modal => ({ title: modal.querySelector(".modal-title")?.textContent, text: modal.textContent.slice(0,500) }));
		report.failure = String(cause.stack ?? cause);
	} finally {
		report.stage = "cleanup";
		releaseLate?.();
		await closePanel();
		service?.dispose();
		plugin.agentService = original;
		window.removeEventListener("error", error);
		window.removeEventListener("unhandledrejection", error);
	}
	return report;
}

const [port, directory, mode, ...extra] = process.argv.slice(2);
if (!/^\d+$/.test(port ?? "") || !directory || (mode && mode !== "--expect-mobile") || extra.length) throw new Error("Usage: <CDP-port> <output-dir> [--expect-mobile]");
const root = resolve(directory);
const requests = [];
await mkdir(root, { recursive: true });
const server = createServer(async (request, response) => {
	try {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
		let body = "";
		for await (const chunk of request) {
			body += chunk;
			if (body.length > 2 * 1024 * 1024) throw new Error("Fixture request too large");
		}
		const parsed = JSON.parse(body);
		requests.push(parsed);
		const side = JSON.stringify(parsed.messages).includes("NATIVE_SIDE_REQUEST");
		const content = side ? "原生模型完成" : parsed.tools?.length ? "桥接已连接。" : "[]";
		const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
		if (!parsed.stream) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ id: "native-fixture", object: "chat.completion", created: 1, model: "native", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage }));
			return;
		}
		const chunk = { id: "native-fixture", object: "chat.completion.chunk", created: 1, model: "native", choices: [{ index: 0, delta: { content }, finish_reason: null }] };
		const done = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage };
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`);
	} catch (error) { response.writeHead(500).end(String(error)); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let socket;
let timer;
let sequence = 0;
const pending = new Map();
try {
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5_000) })).json();
	const target = targets.find(item => item.type === "page" && item.url.startsWith("app://"));
	if (!target) throw new Error("No Obsidian page.");
	socket = new WebSocket(target.webSocketDebuggerUrl);
	socket.addEventListener("message", event => {
		const reply = JSON.parse(event.data);
		const waiting = pending.get(reply.id);
		if (!waiting) return;
		pending.delete(reply.id);
		if (reply.error) waiting.reject(new Error(JSON.stringify(reply.error))); else waiting.resolve(reply.result);
	});
	timer = setTimeout(() => { for (const entry of pending.values()) entry.reject(new Error("Smoke timed out")); socket.close(); }, 50_000);
	await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
	const send = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
	const endpoint = `http://127.0.0.1:${server.address().port}`;
	const expression = `(async () => { let timer; try { return await Promise.race([(${runSmoke.toString()})(${JSON.stringify(root)},${JSON.stringify(endpoint)},${mode === "--expect-mobile"}), new Promise(resolve => { timer=window.setTimeout(() => resolve({...window.__piemNativeSmokeReport, passed:false, failure:"Smoke stage timed out: "+window.__piemNativeSmokeReport?.stage}), 40000); })]); } finally { window.clearTimeout(timer); } })()`;
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
	const report = result.result.value;
	if (!report.passed) {
		const diagnostics = await send("Runtime.evaluate", { expression: `JSON.stringify({report:window.__piemNativeSmokeReport,dialogs:[...document.querySelectorAll('.modal')].map(modal=>({title:modal.querySelector('.modal-title')?.textContent,text:modal.textContent.slice(0,600)}))})`, returnByValue: true });
		report.diagnostics = diagnostics.result.value;
		const shot = await send("Page.captureScreenshot", { format: "png" });
		await writeFile(resolve(root, "native-extension-failure.png"), Buffer.from(shot.data, "base64"));
	}
	const bytes = await readFile(resolve(root, "vault/.obsidian/plugins/piem/main.js"));
	report.artifactSha256 = createHash("sha256").update(bytes).digest("hex");
	report.requests = requests.map(body => ({ model: body.model, maxTokens: body.max_tokens, messages: body.messages }));
	if (!requests.some(body => JSON.stringify(body.messages).includes("NATIVE_BRIDGE_SMOKE"))) { report.passed = false; report.failure ??= "before_agent_start prompt never reached provider"; }
	else report.checks.push("before_agent_start prompt reaches provider");
	const name = mode ? "native-extension-mobile" : "native-extension-desktop";
	await writeFile(resolve(root, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, requests: requests.length, failure: report.failure, result: resolve(root, `${name}.json`) }));
	if (!report.passed) process.exitCode = 1;
} finally {
	clearTimeout(timer);
	socket?.close();
	server.closeAllConnections();
	await new Promise(resolve => server.close(resolve));
}
