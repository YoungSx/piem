/** Real preview bundle, real Vault, official phone loader with Node negative controls.
 * Build: PIEM_NATIVE_CHAT_PREVIEW=1 npm run build
 * Usage: node scripts/smoke-native-chat-obsidian.mjs <CDP-port> <rig-root> [--expect-mobile]
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
const fixture = createServer(async (req, res) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Headers", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
	if (req.url === "/state") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(requests)); return; }
	if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
	try {
		let text = "";
		for await (const chunk of req) { text += chunk; if (text.length > 2_000_000) throw new Error("Fixture request too large"); }
		const body = JSON.parse(text);
		const index = body.tools?.length ? body.messages.findLastIndex(message => message.role === "user" && /native-chat-smoke-(simple|tool|stop|legacy)/.test(JSON.stringify(message.content))) : -1;
		const prompt = JSON.stringify(body.messages[index]?.content ?? "");
		const results = body.messages.slice(index + 1).filter(message => message.role === "tool");
		requests.push({ prompt, results, tools: body.tools?.map(tool => tool.function?.name) ?? [] });
		if (prompt.includes("native-chat-smoke-stop")) {
			held.add(res); res.once("close", () => held.delete(res)); return;
		}
		res.setHeader("Content-Type", "text/event-stream");
		const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "native-chat", object: "chat.completion.chunk", model: "smoke", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
		chunk({ role: "assistant" });
		if (prompt.includes("native-chat-smoke-tool") && !results.length) {
			chunk({ tool_calls: [{ index: 0, id: "native-write", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "/native-chat-smoke-note.md", content: "Native chat smoke: written once.\n" }) } }] });
			chunk({}, "tool_calls");
		} else {
			chunk({ content: index < 0 ? "[]" : results.length ? "Recovered without repeating the write." : "Native chat smoke ready." });
			chunk({}, "stop");
		}
		res.end("data: [DONE]\n\n");
	} catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${fixture.address().port}`;

async function runSmoke(root, mobile, endpoint, observe) {
	const report = { passed: false, checks: [], errors: [], writes: 0, faultInjection: "Official write executes against the Vault; only its result is held until unload" };
	window.__piemNativeChatSmoke = report;
	const until = performance.now() + 125_000;
	const check = (name, condition) => { if (!condition) throw new Error(name); report.checks.push(name); };
	const wait = async (condition, name) => {
		const deadline = Math.min(until, performance.now() + 15_000);
		while (performance.now() < deadline) { if (await condition()) return; await new Promise(resolve => window.setTimeout(resolve, 25)); }
		throw new Error(`Timed out: ${name}`);
	};
	const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	const fixtureState = async () => (await fetch(`${endpoint}/state`)).json();
	const taskWrites = text => text.trim().split("\n").slice(1).flatMap(line => JSON.parse(line).writes ?? []).filter(write => write.type === "task").map(write => write.value);
	const view = () => app.workspace.getLeavesOfType("piem-chat-view")[0]?.view;
	const host = () => view()?.nativeSession;
	const panel = () => view()?.contentEl;
	const busy = session => !!session.getSnapshot().view.docs["pi.live"]?.run || !!session.getSnapshot().view.docs["pi.live"]?.compactions?.length;
	const messages = session => session.getSnapshot().view.entries.flatMap(entry => entry.model ?? []);
	const onError = event => report.errors.push(String(event.error ?? event.reason ?? event.message));
	let plugin, audit, releaseTool, restoreRegistry, originalWrite;
	const unload = async () => {
		const previous = app.plugins.plugins.piem;
		const manager = previous?.nativeChats;
		if (!previous) return;
		await app.plugins.unloadPlugin("piem");
		await manager?.close();
		return manager;
	};
	window.__piemNativeChatCleanup = unload;
	const reload = async path => {
		await unload();
		await app.plugins.loadPlugin("piem");
		await wait(() => app.plugins.plugins.piem?.nativeChats, "preview plugin loaded (PIEM_NATIVE_CHAT_PREVIEW=1)");
		plugin = app.plugins.plugins.piem;
		await plugin.activateChatView();
		if (path) await view().showNative(path);
		await wait(() => path ? host()?.path === path && panel()?.querySelector("textarea") : !!view(), "reopened product panel");
		await frames();
	};
	const sendUI = async text => {
		await wait(() => panel()?.querySelector(".piem-chat__composer textarea"), "product composer");
		const textarea = panel().querySelector(".piem-chat__composer textarea");
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(textarea, text);
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
		await frames();
		await wait(() => textarea.value === text && panel()?.querySelector(".piem-chat__send-button")?.disabled === false, "draft and enabled Send");
		panel().querySelector(".piem-chat__send-button").click();
	};
	const newChat = async () => {
		const oldPath = host()?.path;
		check("registered new-chat command", app.commands.executeCommandById("piem:new-chat") === true);
		await wait(() => host()?.path && host().path !== oldPath && panel()?.querySelector("textarea"), "new native chat from command");
		await frames();
		const session = host();
		check("new chat uses v7", JSON.parse((await app.vault.adapter.read(session.path)).split("\n", 1)[0]).v === 7);
		return session;
	};
	const openHistoryRow = async text => {
		app.commands.executeCommandById("piem:search-chats");
		await wait(() => [...document.querySelectorAll(".suggestion-item")].some(item => item.textContent.includes(text)), `history row ${text}`);
		const row = [...document.querySelectorAll(".suggestion-item")].find(item => item.textContent.includes(text));
		row.click();
		await wait(() => !document.querySelector(".prompt"), "history picker closed");
		await frames();
	};
	try {
		if (!app.plugins.plugins.piem) await app.plugins.loadPlugin("piem");
		await wait(() => app.plugins.plugins.piem?.agentService, "initial Piem service");
		check("disposable vault", app.vault.adapter.getBasePath() === `${root}/vault`);
		check("official device mode", app.isMobile === mobile);
		if (mobile) check("official phone viewport", document.body.classList.contains("emulate-mobile") && document.body.classList.contains("is-phone") && innerWidth === 390);
		else check("desktop viewport", innerWidth >= 900 && innerHeight >= 700);
		plugin = app.plugins.plugins.piem;
		Object.assign(plugin.settings, {
			language: "en", networkTransport: "fetch", shareDiagnostics: false, mobileComposerCollapsed: false,
			providers: [{ id: "native-chat-smoke", name: "Local native chat fixture", baseUrl: `${endpoint}/v1`, protocol: "openai-completions", apiKey: "fixture-only", secretRef: "", source: "user", oauthFlow: "" }],
			models: [{ id: "native-chat-smoke", providerId: "native-chat-smoke", modelApiId: "smoke", displayName: "Native chat fixture", reasoning: false, supportsImages: false }],
			activeModelId: "native-chat-smoke", codemodeMode: "on",
			mcpServers: [{ id: "builtin-exa", name: "Exa", url: "https://mcp.exa.ai/mcp", enabled: false }],
		});
		await plugin.saveSettings({ reconfigure: false });
		audit = mobile ? observe("piem", true) : undefined;
		await reload();
		window.addEventListener("error", onError); window.addEventListener("unhandledrejection", onError);
		report.environment = { mobile: app.isMobile, width: innerWidth, height: innerHeight, userAgent: navigator.userAgent, platform: audit?.report.platform };

		report.stage = "legacy UI remains usable";
		await newChat();
		const originalChat = [...panel().querySelectorAll("button")].find(button => button.textContent === "Open original chat");
		check("original chat reachable from preview", !!originalChat);
		originalChat.click();
		await wait(() => panel()?.querySelector("textarea") && !host(), "original chat");
		const legacyPrompt = `native-chat-smoke-legacy ${Date.now()}`;
		const beforeLegacy = (await fixtureState()).length;
		await sendUI(legacyPrompt);
		await wait(async () => (await fixtureState()).length > beforeLegacy, "original UI request dispatched");
		await wait(() => plugin.agentService.getSnapshot().messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes("Native chat smoke ready")) && !plugin.agentService.getSnapshot().isStreaming, "original chat response");
		const legacyPath = plugin.agentService.getActiveSessionPath();
		check("legacy file remains separate", JSON.parse((await app.vault.adapter.read(legacyPath)).split("\n", 1)[0]).v !== 7);

		report.stage = "new command and native UI";
		let session = await newChat();
		await sendUI("native-chat-smoke-simple");
		await wait(() => messages(session).some(message => message.role === "assistant") && !busy(session), "native simple response");
		check("native response rendered", panel().querySelector(".piem-chat__messages")?.textContent.includes("Native chat smoke ready"));
		check("official generation persisted", taskWrites(await app.vault.adapter.read(session.path)).some(task => task.kind === "pi.generation"));
		check("no custom run wrapper", !taskWrites(await app.vault.adapter.read(session.path)).some(task => task.kind?.startsWith("piem.run")));
		const simplePath = session.path;
		const beforeSimple = await app.vault.adapter.read(simplePath);
		await openHistoryRow(legacyPrompt);
		await wait(() => !host() && plugin.agentService.getActiveSessionPath() === legacyPath, "history routes original chat");
		await openHistoryRow("native-chat-smoke-simple");
		await wait(() => host()?.path === simplePath, "history routes native chat");
		check("history routing never rewrites native file", await app.vault.adapter.read(simplePath) === beforeSimple);
		check("native history and legacy history route separately", !plugin.agentService.getActiveSessionPath().includes("/native/") && host().path === simplePath);

		report.stage = "write side effect before result checkpoint";
		session = await newChat();
		const note = app.vault.getFileByPath("native-chat-smoke-note.md");
		if (note) await app.vault.delete(note);
		originalWrite = app.vault.adapter.write;
		app.vault.adapter.write = async function (path, ...args) {
			if (path === "native-chat-smoke-note.md") report.writes++;
			return originalWrite.call(this, path, ...args);
		};
		const registry = session.options.registry;
		const extension = registry.snapshot().extension("piem-vault");
		const write = extension?.tools.find(tool => tool.name === "write");
		check("official Vault write registered", !!write);
		let written = false;
		const heldWrite = { ...write, async execute(...args) {
			const result = await write.execute(...args);
			written = true;
			const signal = args[2]?.abortSignal;
			let cancel;
			try {
				await new Promise(resolve => {
					releaseTool = resolve; cancel = resolve;
					if (signal?.aborted) resolve(); else signal?.addEventListener("abort", cancel, { once: true });
				});
				signal?.throwIfAborted();
				return result;
			} finally { signal?.removeEventListener("abort", cancel); }
		} };
		registry.install({ ...extension, tools: extension.tools.map(tool => tool.name === "write" ? heldWrite : tool) });
		restoreRegistry = () => registry.install(extension);
		await sendUI("native-chat-smoke-tool: write the fixture note once.");
		await wait(() => written, "real Vault side effect");
		check("note exists before durable tool result", (await app.vault.adapter.read("native-chat-smoke-note.md")).includes("written once") && !messages(session).some(message => message.role === "toolResult"));
		check("official tool task owns the write", taskWrites(await app.vault.adapter.read(session.path)).some(task => task.kind === "pi.tool" && task.owner != null));
		const recoveryPath = session.path;
		const beforeList = await app.vault.adapter.read(recoveryPath);
		await plugin.nativeChats.list();
		check("history observer does not take over a running task", await app.vault.adapter.read(recoveryPath) === beforeList);
		await unload();
		const suspendedBytes = await app.vault.adapter.read(recoveryPath);
		const requestsBefore = (await fixtureState()).length;
		await reload(recoveryPath);
		session = host();
		await new Promise(resolve => window.setTimeout(resolve, 250));
		check("reopen is read-only before Continue", await app.vault.adapter.read(recoveryPath) === suspendedBytes);
		check("reopen makes zero model requests", (await fixtureState()).length === requestsBefore);
		const resume = [...panel().querySelectorAll("button")].find(button => button.textContent === "Continue");
		check("Continue offered for interrupted write", !!resume);
		resume.click();
		await wait(() => !busy(session) && messages(session).some(message => message.role === "assistant" && JSON.stringify(message.content).includes("Recovered without repeating")), "UI continuation completes");
		check("real write executed exactly once in this scenario", report.writes === 1);
		check("unsafe missing result is interrupted", messages(session).some(message => message.role === "toolResult" && message.isError && JSON.stringify(message.content).includes("interrupted")));
		check("recovered answer visible", panel().querySelector(".piem-chat__messages")?.textContent.includes("Recovered without repeating"));
		report.recoveredPath = recoveryPath;

		report.stage = "UI Stop then reload";
		session = await newChat();
		await sendUI("native-chat-smoke-stop");
		await wait(async () => (await fixtureState()).some(request => request.prompt.includes("native-chat-smoke-stop")), "request blocked");
		await wait(() => panel()?.querySelector(".piem-chat__stop-button"), "Stop control");
		panel().querySelector(".piem-chat__stop-button").click();
		await wait(async () => taskWrites(await app.vault.adapter.read(session.path)).some(task => task.abortRequested), "Stop intent committed");
		const stoppedPath = session.path;
		await reload(stoppedPath);
		session = host();
		const stoppedRequests = (await fixtureState()).length;
		await new Promise(resolve => window.setTimeout(resolve, 250));
		check("stopped chat offers no Continue", ![...panel().querySelectorAll("button")].some(button => button.textContent === "Continue"));
		check("Stop does not restart on reload", (await fixtureState()).length === stoppedRequests && !busy(session));
		await view().showNative(recoveryPath); await frames();
		await wait(() => panel()?.querySelector(".piem-chat__messages")?.textContent.includes("Recovered without repeating"), "final recovered transcript");
		if (mobile) {
			check("strict mobile platform flags", audit.report.platform?.isMobileApp === true && audit.report.platform?.isDesktopApp === false);
			check("six official loader Node controls denied", audit.report.controls.length === 6 && audit.report.controls.every(control => !control.provided));
			check("real plugin evaluations audited", audit.report.evaluations >= 3);
			check("no forbidden modules acquired", audit.report.requests.every(request => request.id === "obsidian" || !request.provided));
			check("no unexpected loader errors", audit.report.consoleErrors.every(error => error.control));
		}
		check("no unhandled renderer errors", report.errors.length === 0);
		for (const notice of document.querySelectorAll(".notice")) if (/piem attempted to load NodeJS package/i.test(notice.textContent ?? "")) notice.click();
		await wait(() => ![...document.querySelectorAll(".notice")].some(notice => /piem attempted to load NodeJS package/i.test(notice.textContent ?? "")), "negative control notices dismissed");
		await frames();
		report.passed = true;
	} catch (error) { report.failure = String(error.stack ?? error); }
	finally {
		releaseTool?.(); restoreRegistry?.();
		if (originalWrite) app.vault.adapter.write = originalWrite;
		report.nodeAudit = audit?.report;
		audit?.restore();
		window.removeEventListener("error", onError); window.removeEventListener("unhandledrejection", onError);
	}
	return report;
}

let socket, deadline, call;
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
	call = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
	deadline = setTimeout(() => { for (const waiter of pending.values()) waiter.reject(new Error("Native chat smoke deadline")); socket.close(); }, 150_000);
	const reply = await call("Runtime.evaluate", { expression: `(${runSmoke})(${JSON.stringify(root)},${mobile},${JSON.stringify(endpoint)},(${observePluginNodeAccess}))`, awaitPromise: true, returnByValue: true });
	const report = reply.exceptionDetails ? { passed: false, failure: reply.exceptionDetails.exception?.description } : reply.result.value;
	const bytes = await readFile(resolve(root, "vault/.obsidian/plugins/piem/main.js"));
	report.artifactSha256 = createHash("sha256").update(bytes).digest("hex");
	report.fixture = { requests, heldRequests: held.size };
	const kind = mobile ? "mobile" : "desktop";
	await writeFile(resolve(root, `native-chat-${kind}.json`), JSON.stringify(report, null, 2));
	const shot = await call("Page.captureScreenshot", { format: "png" });
	await writeFile(resolve(root, `native-chat-${kind}.png`), Buffer.from(shot.data, "base64"));
	const cleanup = await call("Runtime.evaluate", { expression: "window.__piemNativeChatCleanup?.().then(() => { delete window.__piemNativeChatCleanup; return true; })", awaitPromise: true, returnByValue: true });
	if (cleanup.exceptionDetails || cleanup.result?.value !== true) {
		report.passed = false; report.cleanupFailure = cleanup.exceptionDetails?.exception?.description ?? "Plugin cleanup did not complete";
	} else report.cleanup = "Plugin unloaded and native manager closed";
	await writeFile(resolve(root, `native-chat-${kind}.json`), JSON.stringify(report, null, 2));
	console.log(JSON.stringify({ passed: report.passed, checks: report.checks?.length, failure: report.failure, report: resolve(root, `native-chat-${kind}.json`) }));
	if (!report.passed) process.exitCode = 1;
} finally {
	if (socket?.readyState === WebSocket.OPEN && call) {
		let cleanupTimer;
		try { await Promise.race([call("Runtime.evaluate", { expression: "window.__piemNativeChatCleanup?.()", awaitPromise: true }), new Promise(resolve => { cleanupTimer = setTimeout(resolve, 5_000); })]); } catch { /* Main failure is already reported; fixture teardown still runs. */ }
		finally { clearTimeout(cleanupTimer); }
	}
	clearTimeout(deadline); socket?.close();
	for (const response of held) response.destroy();
	fixture.closeAllConnections();
	await new Promise(resolve => fixture.close(resolve));
}
