/**
 * Opt-in smoke of the installed bundle in a disposable, real Obsidian vault.
 * Usage: node scripts/smoke-session-obsidian.mjs <CDP-port> <output-dir>
 * The running vault must be <output-dir>/vault. No model request or GUI launch.
 * Native JSONL fixtures remain in the vault for inspection. Recreated managers
 * remove application caches, not OS caches; timings are observations, not gates.
 * The held read checks loading UI only and is excluded from timing measurements.
 * Obsidian cannot cancel an adapter write already in progress on a fixture.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async function runSmoke(root) {
	const report = { passed: false, checks: [], measurements: [], errors: [] };
	const state = { report, phase: "running", captureDone: false };
	window.__piemSessionSmoke = state;
	const timers = new Set(), frames = new Set(), services = [];
	let plugin, originalService, originalManager, observed, gate, cleanupDone = false;
	let activeReads = 0, lastRead = performance.now(), rejectDeadline;
	const restorers = [];
	const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
	// A shared rejection is always handled, including if it fires between steps.
	void deadline.catch(() => undefined);
	const bounded = promise => Promise.race([promise, deadline]);
	const check = (name, value) => { if (!value) throw new Error(name); report.checks.push(name); };
	const delay = ms => bounded(new Promise(resolve => {
		const timer = window.setTimeout(() => { timers.delete(timer); resolve(); }, ms);
		timers.add(timer);
	}));
	const wait = async predicate => {
		const until = performance.now() + 6_000;
		while (!await predicate()) {
			if (performance.now() > until) throw new Error(`Condition timed out: ${report.stage}`);
			await delay(20);
		}
	};
	const paint = async () => {
		for (let i = 0; i < 2; i++) await bounded(new Promise(resolve => {
			const id = requestAnimationFrame(() => { frames.delete(id); resolve(); });
			frames.add(id);
		}));
	};
	const idle = () => wait(() => activeReads === 0 && performance.now() - lastRead > 120);
	const closePanel = async () => { for (const leaf of app.workspace.getLeavesOfType("piem-chat-view")) await leaf.detach(); };
	const error = event => report.errors.push(String(event.error ?? event.reason ?? event.message));
	const cleanup = () => {
		if (cleanupDone) return;
		cleanupDone = true;
		const attempt = action => {
			try { action(); } catch (cause) { (report.cleanupErrors ??= []).push(String(cause)); }
		};
		observed = undefined;
		attempt(() => gate?.release());
		for (const restore of restorers.reverse()) attempt(restore);
		for (const service of services) attempt(() => service.dispose());
		attempt(() => { if (originalService) { plugin.agentService = originalService; plugin.sessionManager = originalManager; } });
		window.removeEventListener("error", error);
		window.removeEventListener("unhandledrejection", error);
		for (const timer of timers) window.clearTimeout(timer);
		for (const id of frames) cancelAnimationFrame(id);
		timers.clear(); frames.clear();
	};
	state.cancel = () => { rejectDeadline(new Error(`Smoke timed out: ${report.stage}`)); cleanup(); };
	timers.add(window.setTimeout(state.cancel, 38_000));
	try {
		report.stage = "validate vault";
		await wait(() => window.app?.plugins?.plugins?.piem?.sessionManager);
		check("disposable vault path matches", app.vault.adapter.getBasePath() === `${root}/vault`);
		plugin = app.plugins.plugins.piem;
		originalService = plugin.agentService; originalManager = plugin.sessionManager;
		report.versions = { plugin: plugin.manifest.version, host: document.title, chrome: navigator.userAgent };
		await bounded(closePanel());
		window.addEventListener("error", error);
		window.addEventListener("unhandledrejection", error);
		const adapter = app.vault.adapter;
		const originalRead = adapter.read, originalWrite = adapter.write;
		const folder = `Piem-session-smoke-${Date.now()}`;
		const isLog = path => path.startsWith(`${folder}/`) && path.endsWith(".jsonl");
		for (const method of ["read", "write", "append", "list"]) {
			const descriptor = Object.getOwnPropertyDescriptor(adapter, method), original = adapter[method];
			restorers.push(() => { if (descriptor) Object.defineProperty(adapter, method, descriptor); else delete adapter[method]; });
			adapter[method] = async function(path, ...args) {
				const sample = observed, start = performance.now();
				if (method === "read") activeReads++;
				try {
					if (method === "read" && gate?.path === path) { gate.reached = true; await gate.promise; }
					const result = await original.call(this, path, ...args);
					if (sample && !cleanupDone) {
						if (method === "read" && isLog(path)) sample.reads.push({ path, bytes: new TextEncoder().encode(result).length, ms: performance.now() - start });
						else if (["write", "append"].includes(method) && isLog(path)) sample.writes.push({ method, path });
						else if (method === "list" && path.startsWith(folder)) sample.listings.push(path);
					}
					return result;
				} finally { if (method === "read") { activeReads--; lastRead = performance.now(); } }
			};
		}
		const defaults = { provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "off" };
		const settings = { ...plugin.settings, sessionDir: folder, language: "zh-cn", provider: defaults.provider,
			modelId: defaults.modelId, providers: [], models: [], activeModelId: undefined, mcpServers: [] };
		const writer = new originalManager.constructor(adapter, folder, "piem");
		const userMessage = text => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
		const assistantMessage = text => ({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now(),
			api: "anthropic-messages", provider: defaults.provider, model: defaults.modelId, stopReason: "stop",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
		report.stage = "seed native logs";
		const target = (await bounded(writer.createSession(defaults))).path;
		for (let i = 0; i < 80; i++) {
			await bounded(writer.appendMessage(userMessage(`请整理第 ${i + 1} 份笔记。`)));
			await bounded(writer.appendMessage(assistantMessage(`### 整理结果 ${i + 1}\n\n${"供冷开验证使用的真实历史内容。".repeat(24)}\n\n- 第一步\n- 第二步\n\n\`\`\`js\nconst count = ${i};\n\`\`\``)));
		}
		const source = await bounded(originalRead.call(adapter, target));
		const siblings = [];
		for (let i = 0; i < 6; i++) {
			const path = (await bounded(writer.createSession(defaults))).path;
			const header = (await bounded(originalRead.call(adapter, path))).split("\n")[0];
			// Preserve each native header/identity; copy only native entries from the fixture.
			await bounded(originalWrite.call(adapter, path, `${header}\n${source.slice(source.indexOf("\n") + 1)}`));
			siblings.push(path);
		}
		const control = (await bounded(writer.createSession(defaults))).path;
		await bounded(writer.appendMessage(userMessage("短会话：加载时应保留这条消息。")));
		report.fixture = { target, control, siblings, messages: 160, bytes: new TextEncoder().encode(source).length, format: "native JSONL; no legacy migration fixture" };
		const fingerprint = async () => {
			const text = await bounded(originalRead.call(adapter, target));
			return [...new Uint8Array(await bounded(crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))))].map(byte => byte.toString(16).padStart(2, "0")).join("");
		};
		report.sourceSha256 = await fingerprint();
		const fresh = async () => {
			let focused = control;
			const manager = new originalManager.constructor(adapter, folder, "piem", undefined, { read: () => focused, write: path => { focused = path; } });
			const service = new originalService.constructor(app, () => settings, manager, {
				loadUserSkills: async () => ({ skills: [], diagnostics: [], searched: [] }), extensionFactories: [],
			});
			services.push(service);
			await bounded(service.initialize());
			check("fresh service initialized on control", service.getActiveSessionPath() === control && !!service.agent);
			return { manager, service };
		};
		const measure = async (label, operation, expected, scope) => {
			report.stage = label;
			await idle();
			const sample = { label, scope, reads: [], writes: [], listings: [], longTasks: [] };
			const observer = new PerformanceObserver(list => sample.longTasks.push(...list.getEntries().map(entry => entry.duration)));
			observer.observe({ type: "longtask" });
			observed = sample;
			const start = performance.now();
			try { await bounded(operation()); sample.durationMs = performance.now() - start; }
			finally { observed = undefined; sample.longTasks.push(...observer.takeRecords().map(entry => entry.duration)); observer.disconnect(); }
			sample.otherChatReads = sample.reads.filter(read => read.path !== expected).length;
			sample.sourceUnchanged = await fingerprint() === report.sourceSha256;
			report.measurements.push(sample);
			check(`${label}: no unrelated logs read`, sample.otherChatReads === 0);
			check(`${label}: source unchanged and no writes`, sample.sourceUnchanged && sample.writes.length === 0);
			return sample;
		};
		const scope = "real service, no mounted ChatApp; no simulated IO latency";
		for (let cycle = 0; cycle < 2; cycle++) {
			const { service } = await fresh();
			const cold = await measure(cycle ? "recreated-manager" : "cold-open", () => service.openSession(target), target, scope);
			check("cold open actually reads target", cold.reads.length > 0 && cold.listings.length === 0);
			check("cold open restores every message", service.getActiveSessionPath() === target && service.getSnapshot().messages.length === 160);
			await bounded(service.openSession(control));
			const warm = await measure(`warm-open-${cycle}`, () => service.openSession(target), target, scope);
			check("warm open needs no log reads", warm.reads.length === 0);
			service.dispose();
		}
		report.stage = "mount real ChatApp";
		const { manager, service } = await fresh();
		plugin.agentService = service; plugin.sessionManager = manager;
		await bounded(plugin.activateChatView());
		await wait(() => document.querySelector(".piem-chat")?.getAttribute("aria-busy") === "false");
		await idle(); // Picker/background discovery is outside the timed operations.
		let release;
		gate = { path: target, reached: false, promise: new Promise(resolve => { release = resolve; }), release: () => release() };
		report.stage = "held read loading UI (not a benchmark)";
		const opening = service.openSession(target);
		void opening.catch(() => undefined);
		check("opening snapshot is immediate", service.getSnapshot().isOpeningSession === true);
		await wait(() => gate.reached && document.querySelector(".piem-chat__status .piem-chat__spinner"));
		await paint();
		const panel = document.querySelector(".piem-chat"), spinner = panel.querySelector(".piem-chat__status .piem-chat__spinner");
		const animation = spinner.getAnimations()[0], before = animation?.currentTime;
		await delay(100);
		report.loadingUI = { artificialReadHold: true, busy: panel.getAttribute("aria-busy"), status: panel.querySelector(".piem-chat__status")?.textContent,
			reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches, animationName: getComputedStyle(spinner).animationName,
			animationAdvanced: typeof before === "number" && animation?.currentTime > before, previousChatRetained: service.getActiveSessionPath() === control,
			previousTextRetained: panel.querySelector(".piem-chat__messages")?.textContent.includes("短会话：加载时应保留这条消息。"),
			sendDisabled: panel.querySelector(".piem-chat__send-button")?.disabled === true };
		check("loading is visible while previous chat remains", report.loadingUI.busy === "true" && report.loadingUI.previousChatRetained && spinner.getBoundingClientRect().width > 0);
		check("loading status names the wait", report.loadingUI.status?.includes("正在打开对话"));
		check("previous transcript remains visible during loading", report.loadingUI.previousTextRetained);
		check("send stays disabled while opening", report.loadingUI.sendDisabled);
		check("spinner advances unless reduced motion is requested", report.loadingUI.reducedMotion || report.loadingUI.animationAdvanced);
		const screenshot = async phase => { state.captureDone = false; state.phase = phase; await wait(() => state.captureDone); state.phase = "running"; };
		await screenshot("loading");
		gate.release(); gate = undefined;
		await bounded(opening); await paint();
		check("loaded chat clears busy state", service.getActiveSessionPath() === target && !service.getSnapshot().isOpeningSession && panel.getAttribute("aria-busy") === "false");
		await screenshot("opened");
		report.stage = "real note changes";
		const leaf = app.workspace.getLeaf("tab");
		for (const name of ["甲笔记", "乙笔记"]) {
			const file = await bounded(app.vault.create(`${folder}/${name}.md`, `# ${name}\n\n会话性能验证。\n`));
			await idle();
			const messages = service.getSnapshot().messages;
			await measure(`note-${name}`, async () => {
				app.workspace.setActiveLeaf(leaf, { focus: true });
				await leaf.openFile(file);
				app.workspace.setActiveLeaf(leaf, { focus: true });
				await wait(() => app.workspace.getActiveFile()?.path === file.path && service.getSnapshot().contextRefs.some(ref => ref.kind === "active" && ref.path === file.path));
				await paint();
			}, null, "actual focused workspace leaf; includes context update and two paint frames");
			check(`${name}: note update reuses transcript`, service.getSnapshot().messages === messages);
		}
		check("no renderer errors", report.errors.length === 0);
		report.passed = true;
	} catch (cause) { report.failure = String(cause.stack ?? cause); report.failedStage = report.stage; }
	finally {
		cleanup();
		// Disposal already cancelled work and restored the adapter, even on timeout.
		if (plugin) {
			let timer;
			try { await Promise.race([closePanel(), new Promise((_, reject) => { timer = window.setTimeout(() => reject(new Error("Panel cleanup timed out")), 2_000); })]); }
			catch (cause) { (report.cleanupErrors ??= []).push(String(cause)); }
			finally { window.clearTimeout(timer); }
		}
		report.runtimeCountAfterDispose = services.reduce((count, service) => count + service.runtimes.size, 0);
		if (report.cleanupErrors?.length || report.runtimeCountAfterDispose) { report.passed = false; report.failure ??= "Smoke cleanup failed"; }
		state.phase = "done";
		delete state.cancel;
	}
	return report;
}

const [port, directory, ...extra] = process.argv.slice(2);
if (!/^\d+$/.test(port ?? "") || !directory || extra.length) throw new Error("Usage: <CDP-port> <output-dir>");
const root = resolve(directory);
await mkdir(root, { recursive: true });
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5_000) })).json();
const target = targets.find(item => item.type === "page" && item.url.startsWith("app://"));
if (!target) throw new Error("No Obsidian page on this debugging port.");
const socket = new WebSocket(target.webSocketDebuggerUrl), pending = new Map();
let sequence = 0, finished = false, timer;
socket.addEventListener("message", event => {
	const reply = JSON.parse(event.data), entry = pending.get(reply.id);
	if (!entry) return;
	pending.delete(reply.id);
	if (reply.error) entry.reject(new Error(JSON.stringify(reply.error))); else entry.resolve(reply.result);
});
const send = (method, params) => new Promise((resolve, reject) => {
	const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
	const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
	return reply.result.value;
};
try {
	timer = setTimeout(() => { for (const entry of pending.values()) entry.reject(new Error("CDP timed out")); socket.close(); }, 48_000);
	await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
	const running = evaluate(`(${runSmoke.toString()})(${JSON.stringify(root)})`).finally(() => { finished = true; });
	void running.catch(() => undefined);
	while (!finished) {
		const phase = await evaluate("window.__piemSessionSmoke?.phase");
		if (phase === "loading" || phase === "opened") {
			const shot = await send("Page.captureScreenshot", { format: "png" });
			await writeFile(resolve(root, `session-${phase}.png`), Buffer.from(shot.data, "base64"));
			await evaluate("window.__piemSessionSmoke.captureDone = true");
		}
		if (!finished) await new Promise(resolve => setTimeout(resolve, 100));
	}
	const report = await running;
	report.artifactSha256 = createHash("sha256").update(await readFile(resolve(root, "vault/.obsidian/plugins/piem/main.js"))).digest("hex");
	await writeFile(resolve(root, "session-performance.json"), `${JSON.stringify(report, null, 2)}\n`);
	if (!report.passed) {
		const shot = await send("Page.captureScreenshot", { format: "png" });
		await writeFile(resolve(root, "session-failure.png"), Buffer.from(shot.data, "base64"));
	}
	console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failure: report.failure, report: resolve(root, "session-performance.json") }));
	if (!report.passed) process.exitCode = 1;
} finally {
	if (!finished && socket.readyState === WebSocket.OPEN) await evaluate("window.__piemSessionSmoke?.cancel?.()").catch(() => undefined);
	clearTimeout(timer);
	socket.close();
}
