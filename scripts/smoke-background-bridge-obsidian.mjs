/** Disposable real Obsidian contract. Usage: <CDP-port> <output-dir> [--expect-mobile]. */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import esbuild from "esbuild";
import { buildScopedFactory } from "./pi-scoped-factories.mjs";

async function runInObsidian(root, endpoint, mobile) {
	const checks = [], failures = [], platforms = [], hooks = [];
	const check = (name, value) => { if (!value) throw new Error(name); checks.push(name); };
	check("disposable vault", app.vault.adapter.getBasePath() === `${root}/vault`);
	check("device mode", app.isMobile === mobile);
	const plugin = app.plugins.plugins.piem;
	check("plugin and static fixture loaded", !!plugin && typeof window.__piemBackgroundContract?.createFactory === "function");
	const original = plugin.agentService;
	const oldSettings = { ...plugin.settings };
	let service;
	const backgroundHosts = [];
	const onError = event => failures.push(String(event.reason ?? event.error ?? event.message));
	window.addEventListener("error", onError);
	window.addEventListener("unhandledrejection", onError);
	try {
		for (const leaf of app.workspace.getLeavesOfType("piem-chat-view")) await leaf.detach();
		Object.assign(plugin.settings, {
			providers: [{ id: "background-fixture", name: "Local fixture", baseUrl: `${endpoint}/v1`, protocol: "openai-completions", apiKey: "fixture-only-secret", secretRef: "", source: "user", oauthFlow: "" }],
			models: [{ id: "background-model", providerId: "background-fixture", modelApiId: "fixture", displayName: "Fixture", reasoning: false, supportsImages: false }],
			activeModelId: "background-model", networkTransport: "requestUrl",
		});
		service = new original.constructor(app, () => plugin.settings, plugin.sessionManager, {
			loadUserSkills: async () => ({ skills: [], diagnostics: [], searched: [] }),
			extensionFactories: [{ id: "background-contract", createFactory(platform) {
				platform.process.env.BRIDGE_ENDPOINT = endpoint;
				platforms.push(platform);
				const factory = window.__piemBackgroundContract.createFactory(platform);
				return pi => {
					factory(pi);
					pi.on("before_provider_request", event => { hooks.push({ type: event.type, payload: structuredClone(event.payload) }); return { ...event.payload, temperature: 0.17 }; });
					pi.on("after_provider_response", event => { hooks.push(structuredClone(event)); });
					pi.on("session_shutdown", async (_event, ctx) => {
						await platform.fetch(`${endpoint}/shutdown`, { method: "POST", body: JSON.stringify({ pid: platform.process.pid, id: ctx.sessionManager.getSessionId(), model: ctx.model?.id }) });
					});
				};
			} }],
		});
		plugin.agentService = service;
		await service.initialize();
		await service.newSession({ force: true });
		await service.sendPrompt("First background fixture");
		const firstPath = service.getActiveSessionPath();
		const firstHost = service.runtimes.get(firstPath).communityHost;
		backgroundHosts.push(firstHost);
		check("first compiled command", await service.runExtensionCommand("bridge-probe", "first"));
		check("first periodic work starts", await service.runExtensionCommand("bridge-start", "first"));
		check("background does not hold composer busy", !firstHost.busy);
		await service.newSession();
		await service.sendPrompt("Second background fixture");
		const secondPath = service.getActiveSessionPath();
		const secondHost = service.runtimes.get(secondPath).communityHost;
		backgroundHosts.push(secondHost);
		check("second compiled command", await service.runExtensionCommand("bridge-probe", "second"));
		check("second periodic work starts", await service.runExtensionCommand("bridge-start", "second"));
		await new Promise(resolve => setTimeout(resolve, 80));
		check("separate conversation files", firstPath !== secondPath);
		const activePlatforms = platforms.filter(platform => {
			try { return platform.process.env.BRIDGE_CONTRACT; } catch { return false; }
		});
		check("separate virtual environment", activePlatforms.length === 2 && activePlatforms[0].process.env.BRIDGE_CONTRACT === "first" && activePlatforms[1].process.env.BRIDGE_CONTRACT === "second");
		check("separate virtual identity", activePlatforms[0].process.pid !== activePlatforms[1].process.pid);
		await service.deleteSession(firstPath);
		await firstHost.closed();
		let retired = false;
		try { activePlatforms[0].process.env.BRIDGE_CONTRACT; } catch { retired = true; }
		check("deleted conversation resources retired", retired);
		check("remaining conversation usable", await service.runExtensionCommand("bridge-probe", "second-after-delete"));
		check("provider hooks dispatched", hooks.some(event => event.type === "before_provider_request") && hooks.some(event => event.type === "after_provider_response" && event.status === 200));
		check("provider credentials stay out of events", !JSON.stringify(hooks).includes("fixture-only-secret"));
		service.dispose();
		await Promise.all(backgroundHosts.map(host => host.closed()));
		check("no renderer failures", failures.length === 0);
		return { passed: true, checks, failures, environment: { mobile: app.isMobile, phone: document.body.classList.contains("is-phone") } };
	} finally {
		service?.dispose();
		await Promise.all(backgroundHosts.map(host => host.closed().catch(() => {})));
		plugin.agentService = original;
		Object.assign(plugin.settings, oldSettings);
		window.removeEventListener("error", onError);
		window.removeEventListener("unhandledrejection", onError);
	}
}

const [port, output, mode, ...extra] = process.argv.slice(2);
if (!/^\d+$/.test(port ?? "") || !output || mode && mode !== "--expect-mobile" || extra.length) throw new Error("Usage: <CDP-port> <output-dir> [--expect-mobile]");
const root = path.resolve(output), repo = path.resolve(import.meta.dirname, "..");
const mobile = mode === "--expect-mobile";
const installedPath = path.join(root, "vault/.obsidian/plugins/piem/main.js");
const original = await readFile(installedPath);
const compiledRoot = path.join(root, "background-compiler");
const requests = [], pending = new Map();
let socket, sequence = 0, report, evaluate;
const server = createServer(async (request, response) => {
	try {
		let body = "";
		for await (const chunk of request) { body += chunk; if (body.length > 1024 * 1024) throw new Error("Fixture body limit"); }
		requests.push({ path: request.url, body, authenticated: request.headers.authorization === "Bearer fixture-only-secret" });
		if (request.url === "/v1/chat/completions") {
			const payload = JSON.parse(body);
			const base = { id: "fixture", object: "chat.completion.chunk", model: "fixture", created: 1 };
			response.writeHead(200, { "content-type": "text/event-stream", "x-bridge-response": "fixture" });
			response.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: "Fixture complete" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
			if (payload.temperature !== 0.17) throw new Error("Extension payload modification missing");
		} else response.writeHead(200, { "content-type": "text/plain" }).end(body);
	} catch (error) { if (!response.headersSent) response.writeHead(500).end(String(error)); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
try {
	const auditFor = async (name, fixture) => {
		const folder = path.join(compiledRoot, "node_modules", name);
		await mkdir(folder, { recursive: true });
		const bytes = await readFile(path.join(repo, fixture));
		await writeFile(path.join(folder, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
		await writeFile(path.join(folder, "index.mjs"), bytes);
		return { entry: "index.mjs", version: "1.0.0", files: { "index.mjs": createHash("sha256").update(bytes).digest("hex") } };
	};
	const dependency = await auditFor("@piem-bridge/contract-dependency", "scripts/fixtures/scoped-extension-dependency.mjs");
	const audit = { ...await auditFor("contract", "scripts/fixtures/scoped-extension-contract.mjs"), dependencies: { "@piem-bridge/contract-dependency": dependency } };
	const { contents } = await buildScopedFactory(compiledRoot, "contract", audit);
	const built = await esbuild.build({
		stdin: { contents, resolveDir: repo, loader: "js" }, bundle: true, write: false, metafile: true, platform: "browser", format: "iife", globalName: "__piemBackgroundContract", minify: true,
		plugins: [{ name: "fixture-primitives", setup(build) { build.onResolve({ filter: /[/\\]src[/\\]extensions[/\\](node|compat)[/\\]/ }, args => args.path.startsWith(`${compiledRoot}${path.sep}`) ? { path: path.join(repo, path.relative(compiledRoot, args.path)) } : undefined); } }],
	});
	if (Object.values(built.metafile.outputs).some(value => value.imports.length)) throw new Error("Fixture leaked an external import");
	await writeFile(installedPath, Buffer.concat([original, Buffer.from(`\n${built.outputFiles[0].text}\nwindow.__piemBackgroundContract=__piemBackgroundContract;\n`)]));
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
	const target = targets.find(item => item.type === "page" && item.url.startsWith("app://"));
	if (!target) throw new Error("No Obsidian page");
	socket = new WebSocket(target.webSocketDebuggerUrl);
	socket.addEventListener("message", event => {
		const reply = JSON.parse(event.data), task = pending.get(reply.id);
		if (!task) return;
		clearTimeout(task.timer); pending.delete(reply.id);
		if (reply.error) task.reject(new Error(JSON.stringify(reply.error))); else task.resolve(reply.result);
	});
	await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
	const send = (method, params) => new Promise((resolve, reject) => {
		const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP timeout")); }, 45_000);
		pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
	});
	evaluate = async expression => {
		const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
		return result.result.value;
	};
	await evaluate('(async()=>{await app.plugins.disablePlugin("piem");await app.plugins.enablePlugin("piem");return true;})()');
	if (mobile) await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
	report = await evaluate(`(${runInObsidian.toString()})(${JSON.stringify(root)},${JSON.stringify(endpoint)},${mobile})`);
	const count = requests.length;
	await new Promise(resolve => setTimeout(resolve, 80));
	if (requests.length !== count) throw new Error("Requests continued after disposal");
	for (const value of ["first", "second"]) if (!requests.some(request => request.path === "/periodic" && request.body === `interval:${value}`)) throw new Error(`Missing periodic ${value} request`);
	if (requests.filter(request => request.path === "/shutdown").length !== 2) throw new Error("Missing final shutdown requests");
	if (!requests.filter(request => request.path === "/v1/chat/completions").every(request => request.authenticated && JSON.parse(request.body).temperature === 0.17)) throw new Error("Provider hooks did not reach wire");
	report.checks.push("both periodic requests reached real requestUrl", "two shutdown flushes", "requests stopped after disposal", "provider auth and rewritten payload reached local endpoint");
} catch (error) { report = { ...report, passed: false, failure: String(error.stack ?? error) }; }
finally {
	await writeFile(installedPath, original);
	try { await evaluate?.('(async()=>{await app.plugins.disablePlugin("piem");await app.plugins.enablePlugin("piem");delete window.__piemBackgroundContract;return true;})()'); } catch (error) { report = { ...report, passed: false, cleanupError: String(error) }; }
	for (const task of pending.values()) clearTimeout(task.timer);
	pending.clear(); socket?.close();
	server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
	await rm(compiledRoot, { recursive: true, force: true });
}
report.artifactKind = "production bundle plus static test-only background factory";
report.productionSha256 = createHash("sha256").update(original).digest("hex");
report.requests = requests.map(request => ({ path: request.path, bodyBytes: Buffer.byteLength(request.body) }));
const result = path.join(root, `background-bridge-${mobile ? "mobile" : "desktop"}.json`);
await writeFile(result, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks?.length, failure: report.failure, requests: requests.length, result }));
if (!report.passed) process.exitCode = 1;
