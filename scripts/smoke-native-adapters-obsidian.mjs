/** Stage 1: unchanged production plugin smoke, then native adapters in an official test-plugin loader.
 * Usage: node scripts/smoke-native-adapters-obsidian.mjs <CDP-port> <rig-root> [--expect-mobile]
 * The test plugin is separate from main.js; its hash and measurements are reported separately.
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { builtinModules } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";
import { piExtensionsPlugin } from "./pi-extensions.mjs";
import { observePluginNodeAccess } from "./obsidian-plugin-node-audit.mjs";

const [port, directory, mode, ...extra] = process.argv.slice(2);
if (!/^\d+$/.test(port ?? "") || !directory || (mode && mode !== "--expect-mobile") || extra.length) throw new Error("Usage: <CDP-port> <rig-root> [--expect-mobile]");
const root = resolve(directory), mobile = mode === "--expect-mobile", kind = mobile ? "mobile" : "desktop";
const legacy = await promisify(execFile)(process.execPath, [resolve("scripts/smoke-durable-obsidian.mjs"), port, root, ...(mobile ? [mode] : [])], { timeout: 180_000 });
if (!JSON.parse(legacy.stdout.trim().split("\n").at(-1)).passed) throw new Error("Production smoke failed");
const id = "piem-native-adapters-fixture";
const fixtureDir = resolve(root, "vault/.obsidian/plugins", id);
await mkdir(fixtureDir, { recursive: true });
const manifest = { id, name: "Piem native adapter test fixture", version: "0.0.0", minAppVersion: "1.8.0", description: "Disposable native adapter smoke fixture", author: "Piem tests", isDesktopOnly: false };
await writeFile(resolve(fixtureDir, "manifest.json"), JSON.stringify(manifest));
const artifact = await build({
	entryPoints: ["scripts/native-adapters-fixture.ts"], outfile: resolve(fixtureDir, "main.js"), bundle: true, minify: true, format: "cjs", target: "es2022", metafile: true,
	plugins: [piExtensionsPlugin()], external: ["obsidian", "node:*", ...builtinModules],
	alias: { openai: resolve("src/net/shims/openaiSdk.ts"), "@anthropic-ai/sdk": resolve("src/net/shims/anthropicSdk.ts") },
});
const external = Object.values(artifact.metafile.outputs).flatMap(output => output.imports).filter(item => item.external).map(item => item.path);
// pi-ai carries a Bun-only /proc environment fallback; Chromium never enters it.
// As in production, the actual phone loader audit below must observe zero Node access.
if (external.some(path => path !== "obsidian" && path !== "node:fs")) throw new Error(`Unexpected fixture imports: ${external}`);

const requests = [], timers = new Set();
const server = createServer(async (req, res) => {
	res.setHeader("Access-Control-Allow-Origin", "*"); res.setHeader("Access-Control-Allow-Headers", "*");
	if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
	try {
		if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
		let raw = "";
		for await (const chunk of req) { raw += chunk; if (raw.length > 2_000_000) throw new Error("Fixture input limit"); }
		const body = JSON.parse(raw), prompt = JSON.stringify(body.messages.findLast(message => message.role === "user")?.content);
		const afterTool = body.messages.some(message => message.role === "tool");
		requests.push({ model: body.model, prompt, authorization: req.headers.authorization === "Bearer fixture-only", afterTool });
		res.setHeader("Content-Type", "text/event-stream");
		const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "native", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
		chunk({ role: "assistant" });
		if (prompt.includes("native-write") && !afterTool) {
			chunk({ tool_calls: [
				{ index: 0, id: "native-write", type: "function", function: { name: "write", arguments: JSON.stringify({ path: `Piem/native-stage1-${kind}/note.md`, content: "Native adapters: written once.\n" }) } },
				{ index: 1, id: "native-metadata", type: "function", function: { name: "get_note_metadata", arguments: JSON.stringify({ path: `Piem/native-stage1-${kind}/note.md` }) } },
			] });
			chunk({}, "tool_calls");
		} else if (prompt.includes("native-stream")) {
			for (const text of ["First. ", "Second. ", "Third. ", "Done."]) {
				chunk({ content: text });
				await new Promise(resolve => { const timer = setTimeout(() => { timers.delete(timer); resolve(); }, 180); timers.add(timer); });
			}
			chunk({}, "stop");
		} else { chunk({ content: "Recovered without repeating the write." }); chunk({}, "stop"); }
		res.end("data: [DONE]\n\n");
	} catch (error) { res.writeHead(500).end(String(error)); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;

async function runNative(id, manifest, endpoint, mobile, observe) {
	const errors = [];
	const onError = event => errors.push(String(event.error ?? event.reason ?? event.message));
	window.addEventListener("error", onError); window.addEventListener("unhandledrejection", onError);
	const audit = mobile ? observe(id, true) : undefined;
	try {
		app.plugins.manifests[id] = { ...manifest, dir: `${app.vault.configDir}/plugins/${id}` };
		await app.plugins.loadPlugin(id);
		const fixture = app.plugins.plugins[id];
		if (!fixture?.run) throw new Error("Native test plugin did not load");
		const service = app.plugins.plugins.piem.agentService;
		await service.initialize();
		const metadata = service.current().agent.state.tools.find(tool => tool.name === "get_note_metadata");
		if (!metadata) throw new Error("Production Obsidian metadata tool missing");
		const result = await fixture.run(endpoint, metadata, mobile);
		if (mobile) {
			const denied = audit.report.controls.length === 6 && audit.report.controls.every(control => !control.provided);
			if (!denied || audit.report.requests.some(request => request.id !== "obsidian")) throw new Error("Native fixture acquired Node modules");
			if (audit.report.consoleErrors.some(error => !error.control)) throw new Error("Native fixture loader error");
			result.checks.push("six real loader negative controls denied", "no Node modules acquired");
		}
		await app.workspace.openLinkText(`Piem/native-stage1-${mobile ? "mobile" : "desktop"}/note.md`, "", false);
		// Only dismiss notices deliberately created by the loader negative controls.
		for (const notice of document.querySelectorAll(".notice")) {
			if (notice.textContent?.includes(`${id} attempted to load NodeJS package`)) notice.click();
		}
		const until = performance.now() + 3_000;
		while ([...document.querySelectorAll(".notice")].some(notice => notice.textContent?.includes(`${id} attempted to load NodeJS package`))) {
			if (performance.now() > until) throw new Error("Negative-control notices did not dismiss");
			await new Promise(resolve => setTimeout(resolve, 25));
		}
		if (mobile) for (const leaf of app.workspace.getLeavesOfType("piem-chat-view")) leaf.detach();
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		if (errors.length) throw new Error(errors.join("\n"));
		return { ...result, errors, nodeAudit: audit?.report, environment: { mobile: app.isMobile, width: innerWidth, height: innerHeight } };
	} finally {
		try { await app.plugins.plugins[id]?.close(); } finally {
			try { await app.plugins.unloadPlugin(id); } finally {
				delete app.plugins.manifests[id];
				audit?.restore();
				window.removeEventListener("error", onError); window.removeEventListener("unhandledrejection", onError);
			}
		}
	}
}

let socket, deadline;
let sequence = 0;
const pending = new Map();
try {
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	const target = targets.find(target => target.type === "page" && target.url.startsWith("app://") && target.url.includes("index.html"));
	if (!target) throw new Error("No Obsidian target");
	socket = new WebSocket(target.webSocketDebuggerUrl);
	socket.addEventListener("message", event => { const reply = JSON.parse(event.data), waiter = pending.get(reply.id); if (!waiter) return; pending.delete(reply.id); reply.error ? waiter.reject(new Error(JSON.stringify(reply.error))) : waiter.resolve(reply.result); });
	await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
	const call = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
	deadline = setTimeout(() => { for (const waiter of pending.values()) waiter.reject(new Error("Native smoke deadline")); socket.close(); }, 120_000);
	const reply = await call("Runtime.evaluate", { expression: `(${runNative})(${JSON.stringify(id)},${JSON.stringify(manifest)},${JSON.stringify(endpoint)},${mobile},(${observePluginNodeAccess}))`, awaitPromise: true, returnByValue: true });
	const report = reply.exceptionDetails ? { passed: false, failure: reply.exceptionDetails.exception?.description } : reply.result.value;
	report.requests = requests;
	report.externalImports = [...new Set(external)];
	report.productionSha256 = createHash("sha256").update(await readFile(resolve(root, "vault/.obsidian/plugins/piem/main.js"))).digest("hex");
	report.fixtureSha256 = createHash("sha256").update(await readFile(resolve(fixtureDir, "main.js"))).digest("hex");
	if (report.passed && !requests.every(request => request.model === "wire-model" && request.authorization)) { report.passed = false; report.failure = "Native model reference leaked to wire or missing credentials"; }
	await writeFile(resolve(root, `native-adapters-${kind}.json`), JSON.stringify(report, null, 2));
	const shot = await call("Page.captureScreenshot", { format: "png" });
	await writeFile(resolve(root, `native-adapters-${kind}.png`), Buffer.from(shot.data, "base64"));
	console.log(JSON.stringify({ passed: report.passed, checks: report.checks?.length, failure: report.failure, report: resolve(root, `native-adapters-${kind}.json`) }));
	if (!report.passed) process.exitCode = 1;
} finally {
	clearTimeout(deadline); socket?.close();
	for (const timer of timers) clearTimeout(timer);
	server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
