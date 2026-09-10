/**
 * Opt-in contract smoke in a disposable real Obsidian vault. The temporary test
 * bundle exposes __piemBridgeContract from scripts/fixtures/native-extension-contract.mjs.
 * It shares the production module graph; the normal release never exports this fixture.
 * Usage: node scripts/smoke-generic-bridge-obsidian.mjs <CDP-port> <output-dir> [--expect-mobile]
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async function beginSmoke(root, endpoint, expectMobile) {
	const report = { passed: false, checks: [], errors: [], stage: "prepare" };
	const record = {};
	window.__piemGenericSmoke = { report, record };
	const check = (name, value) => { if (!value) throw new Error(name); report.checks.push(name); };
	const wait = async predicate => {
		for (let attempt = 0; attempt < 250; attempt++) {
			if (await predicate()) return;
			await new Promise(resolve => setTimeout(resolve, 20));
		}
		throw new Error(`Condition timed out: ${report.stage}`);
	};
	await wait(() => window.app?.plugins?.plugins?.piem?.agentService);
	check("disposable vault", app.vault.adapter.getBasePath() === `${root}/vault`);
	check("correct official device mode", app.isMobile === expectMobile);
	if (expectMobile) check("official phone emulation", document.body.classList.contains("is-phone") && document.body.classList.contains("emulate-mobile"));
	check("test-only contract factory present", typeof window.__piemBridgeContract?.createContractFactory === "function");
	const error = event => report.errors.push(String(event.error ?? event.reason ?? event.message));
	window.addEventListener("error", error);
	window.addEventListener("unhandledrejection", error);
	const plugin = app.plugins.plugins.piem;
	await wait(() => !plugin.builtinSkillInstaller || plugin.builtinSkillInstaller.getReport().status === "ready");
	const original = plugin.agentService;
	const closePanel = async () => {
		for (const leaf of app.workspace.getLeavesOfType("piem-chat-view")) await leaf.detach();
	};
	let service;
	const ui = window.__piemGenericSmoke;
	ui.cleanup = async () => {
		await closePanel();
		service?.dispose();
		plugin.agentService = original;
		window.removeEventListener("error", error);
		window.removeEventListener("unhandledrejection", error);
	};
	try {
		await closePanel();
		Object.assign(plugin.settings, {
			language: "zh-cn", networkTransport: "fetch",
			providers: [{ id: "generic-smoke", name: "Local fixture", baseUrl: `${endpoint}/v1`, protocol: "openai-completions", apiKey: "local-fixture-only", secretRef: "", source: "user", oauthFlow: "" }],
			models: [{ id: "generic-model", providerId: "generic-smoke", modelApiId: "generic", displayName: "Generic", reasoning: false, supportsImages: false }],
			activeModelId: "generic-model",
		});
		service = new original.constructor(app, () => plugin.settings, plugin.sessionManager, {
			extensionFactories: [{ id: "generic-contract", factory: window.__piemBridgeContract.createContractFactory(record) }],
			loadUserSkills: async () => ({ skills: [], diagnostics: [], searched: [] }),
		});
		plugin.agentService = service;
		await service.initialize();
		await service.newSession();
		await plugin.activateChatView();
		ui.service = service;
		ui.path = service.getActiveSessionPath();
		ui.wait = wait;
		ui.check = check;
		ui.textarea = () => document.querySelector(".piem-chat__composer textarea");
		ui.action = label => [...document.querySelectorAll(".piem-chat__extension-actions button")].find(button => button.textContent.includes(label));
		ui.modal = () => [...document.querySelectorAll(".piem-native-extension-dialog")].at(-1);
		ui.pending = () => service.runtimes.get(service.getActiveSessionPath())?.extensionUI?.getSnapshot().shortcutPending;
		ui.open = async label => {
			report.stage = label;
			await wait(() => ui.action(label) && !ui.action(label).disabled);
			// Obsidian's mobile exit animation retains the departing modal's
			// controls; wait for dismissal before locating the next picker.
			await wait(() => !ui.modal());
			const details = ui.action(label).closest("details");
			details.open = true;
			ui.action(label).click();
		};
		ui.finish = async () => {
			check("no renderer errors", report.errors.length === 0);
			report.passed = true;
			return report;
		};
		report.stage = "native widget";
		await wait(() => document.querySelector(".piem-native-extension__text")?.textContent === "Native component ready");
		check("component widget reaches real panel", true);
		check("plain widget remains supported", document.querySelector(".piem-chat__extension-widget")?.textContent === "Bridge contract fixture");
		check("markup stays literal text", [...document.querySelectorAll(".piem-native-extension__text")].some(element => element.textContent === "<script>literal text</script>"));
		check("no HTML element created from extension text", !document.querySelector(".piem-native-extension script"));
		await wait(() => ui.action("Choose a bridge item"));
		check("touch actions available", document.querySelectorAll(".piem-chat__extension-actions button").length === 3);
		check("actions collapsed initially", !document.querySelector(".piem-chat__extension-actions").open);
		record.context.ui.setEditorText("");
		await wait(() => ui.textarea()?.value === "");
		report.environment = { mobile: app.isMobile, phone: document.body.classList.contains("is-phone"), width: innerWidth, transport: "fetch" };
		return report;
	} catch (error) {
		report.failure = String(error.stack ?? error);
		return report;
	}
}

const [port, directory, mode, ...extra] = process.argv.slice(2);
if (!/^\d+$/.test(port ?? "") || !directory || (mode && mode !== "--expect-mobile") || extra.length) throw new Error("Usage: <CDP-port> <output-dir> [--expect-mobile]");
const root = resolve(directory);
const name = mode ? "generic-bridge-mobile" : "generic-bridge-desktop";
const requests = [];
await mkdir(root, { recursive: true });
const server = createServer(async (request, response) => {
	try {
		response.setHeader("Access-Control-Allow-Origin", "*");
		response.setHeader("Access-Control-Allow-Headers", request.headers["access-control-request-headers"] ?? "*");
		response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
		if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
		let body = "";
		for await (const chunk of request) {
			body += chunk;
			if (body.length > 2 * 1024 * 1024) throw new Error("Fixture request too large");
		}
		const parsed = JSON.parse(body);
		requests.push({ body: parsed, authenticated: request.headers.authorization === "Bearer local-fixture-only" });
		const content = JSON.stringify(parsed.messages).includes("GENERIC_BRIDGE_REQUEST") ? "Generic bridge complete" : "[]";
		const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
		if (!parsed.stream) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ id: "generic-fixture", object: "chat.completion", created: 1, model: "generic", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage }));
			return;
		}
		const chunk = { id: "generic-fixture", object: "chat.completion.chunk", created: 1, model: "generic", choices: [{ index: 0, delta: { content }, finish_reason: null }] };
		const done = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage };
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`);
	} catch (error) { response.writeHead(500).end(String(error)); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let socket;
let timer;
let sequence = 0;
let send;
let evaluate;
const pending = new Map();
let report;
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
	timer = setTimeout(() => { for (const entry of pending.values()) entry.reject(new Error("Smoke timed out")); socket.close(); }, 55_000);
	await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
	send = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
	evaluate = async expression => {
		const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
		return result.result.value;
	};
	const step = body => evaluate(`(async () => {const s=window.__piemGenericSmoke; ${body}})()`);
	const screenshot = async suffix => {
		const shot = await send("Page.captureScreenshot", { format: "png" });
		await writeFile(resolve(root, `${name}-${suffix}.png`), Buffer.from(shot.data, "base64"));
	};
	report = await evaluate(`(${beginSmoke.toString()})(${JSON.stringify(root)},${JSON.stringify(`http://127.0.0.1:${server.address().port}`)},${mode === "--expect-mobile"})`);
	if (report.failure) throw new Error(report.failure);
	await screenshot("panel");
	await step(`
		await s.open("Choose a bridge item");
		await s.wait(()=>s.modal()?.querySelectorAll('[role=option]').length===2);
		s.check("native picker has real options",true);
		s.check("native picker focuses first option",document.activeElement?.textContent.includes("Review notes"));
		return true;
	`);
	await screenshot("picker");
	await step(`
		const first=s.modal().querySelector('[role=option]');
		first.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
		await s.wait(()=>s.modal().querySelectorAll('[role=option]')[1].getAttribute('aria-selected')==='true');
		document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
		await s.wait(()=>s.record.selection==='organize'&&s.textarea()?.value==='Selected: organize'&&!s.pending());
		s.check("native keyboard choice reaches draft",s.record.selection==='organize');
		s.check("picker disposed after selection",s.record.pickerDisposals===1);
		s.check("selection never auto-sends",s.service.getSnapshot().messages.length===0);
		await s.wait(()=>!s.action('Choose a bridge item').disabled);
		await s.open('Choose a bridge item');
		await s.wait(()=>s.modal()?.querySelector('[role=option]'));
		s.modal().querySelector('[role=option]').click();
		await s.wait(()=>s.record.selection==='review'&&s.textarea()?.value==='Selected: review'&&!s.pending());
		s.check("touch choice reaches draft",s.record.selection==='review');
		return true;
	`);
	await step(`
		await s.open('Open cancellable bridge task');
		await s.wait(()=>s.modal()?.querySelector('progress'));
		s.check('native loader provides cancel',!!s.modal().querySelector('button'));
		return true;
	`);
	await screenshot("loader");
	await step(`
		s.modal().querySelector('button').click();
		await s.wait(()=>s.record.loaderResult===null&&!s.pending());
		s.check('cancel aborts loader signal',s.record.loaderSignal.aborted);
		await s.open('Run bridge model request');
		await s.wait(()=>s.record.completion&&!s.pending());
		s.check('legacy complete uses host model',s.record.completion.content.some(p=>p.type==='text'&&p.text==='Generic bridge complete'));
		s.check('extension receives no real credential',JSON.stringify(s.record.auth).indexOf('local-fixture-only')<0);
		s.check('side request usage counted',s.service.getSnapshot().usage.requests>=1);
		return true;
	`);
	if (!mode) {
		await step(`
			await s.wait(()=>!s.action('Choose a bridge item').disabled);
			await s.wait(()=>!s.modal());
			s.textarea().focus();
			const before=s.record.pickerDisposals;
			document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'J',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));
			s.check('shortcut does not bind globally',s.record.pickerDisposals===before&&!s.modal());
			s.textarea().dispatchEvent(new KeyboardEvent('keydown',{key:'J',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));
			await s.wait(()=>s.modal()?.querySelector('[role=option]'));
			s.modal().querySelector('[role=option]').click();
			await s.wait(()=>s.record.pickerDisposals===before+1);
			s.check('desktop textarea shortcut opens native picker',true);
			return true;
		`);
	}
	await step(`
		s.report.stage='switch conversation';
		await s.wait(()=>!s.action('Choose a bridge item').disabled);
		s.check('local prompt establishes a conversation',await s.service.sendPrompt('GENERIC_SESSION_MARKER'));
		const old=s.record.context;
		const before=s.record.widgetDisposals??0;
		const oldPath=s.service.getActiveSessionPath();
		await s.service.newSession();
		s.check('new session gets a distinct path',s.service.getActiveSessionPath()!==oldPath);
		await s.wait(()=>s.record.context!==old&&!!s.action('Choose a bridge item'));
		let rejected=false; try{old.ui.setEditorText('wrong session')}catch{rejected=true}
		s.check('departed context cannot change current draft',rejected&&s.textarea()?.value!=='wrong session');
		s.check('departed component disposed',s.record.widgetDisposals>before);
		s.check('new conversation mounts a fresh component',s.record.widgetMounts>=2);
		s.report.widgetMounts=s.record.widgetMounts;s.report.widgetDisposals=s.record.widgetDisposals;
		return true;
	`);
	report = await step("return await s.finish();");
	if (!requests.some(({ body, authenticated }) => authenticated && body.max_tokens === 128 && JSON.stringify(body.messages).includes("GENERIC_BRIDGE_REQUEST"))) {
		report.passed = false;
		report.failure = "Legacy completion did not use the host transport with its requested token limit";
	} else report.checks.push("host credential and token limit reach local model transport");
} catch (error) {
	try { report = await evaluate?.("window.__piemGenericSmoke?.report"); } catch { /* CDP failure still produces a report. */ }
	report ??= { checks: [], errors: [] };
	report.passed = false;
	report.failure = String(error.stack ?? error);
	try {
		report.diagnostics = await evaluate?.(`(() => {
			const s=window.__piemGenericSmoke;
			const adapter=s?.service?.runtimes.get(s.service.getActiveSessionPath())?.extensionUI;
			const snapshot=adapter?.getSnapshot();
			return {shortcutPending:snapshot?.shortcutPending,shortcutError:snapshot?.shortcutError,
				dialogCount:adapter?.dialogs?.size,authIssued:!!s?.record.auth,authOkay:s?.record.auth?.ok,
				completionReason:s?.record.completion?.stopReason,completionError:s?.record.completion?.errorMessage,
				loaderAborted:s?.record.loaderSignal?.aborted,pickerDisposals:s?.record.pickerDisposals,
				serviceError:s?.service?.getSnapshot().errorMessage,
				modalTitles:[...document.querySelectorAll('.modal-title')].map(el=>el.textContent)};
		})()`);
	} catch { /* Diagnostics must not replace the first failure. */ }
	try {
		const shot = await send?.("Page.captureScreenshot", { format: "png" });
		if (shot) await writeFile(resolve(root, `${name}-failure.png`), Buffer.from(shot.data, "base64"));
	} catch { /* Keep the original failure. */ }
} finally {
	try { await evaluate?.("window.__piemGenericSmoke?.cleanup?.()"); }
	catch (error) { if (report) { report.passed = false; report.cleanupError = String(error); } }
	clearTimeout(timer);
	socket?.close();
	server.closeAllConnections();
	await new Promise(resolve => server.close(resolve));
}
const bytes = await readFile(resolve(root, "vault/.obsidian/plugins/piem/main.js"));
report.artifactSha256 = createHash("sha256").update(bytes).digest("hex");
report.artifactKind = "test-only bundle with generic contract factory in the production module graph";
report.requests = requests.map(({ body, authenticated }) => ({ model: body.model, maxTokens: body.max_tokens, authenticated }));
await writeFile(resolve(root, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, requests: requests.length, failure: report.failure, result: resolve(root, `${name}.json`) }));
if (!report.passed) process.exitCode = 1;
