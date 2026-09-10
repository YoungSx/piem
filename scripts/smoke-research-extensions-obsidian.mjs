/**
 * Real Obsidian + a local deterministic provider. Does not launch Obsidian.
 * node scripts/smoke-research-extensions-obsidian.mjs <CDP-port> <output-dir> [--expect-mobile]
 * Obsidian must open <output-dir>/vault; mobile mode must use app.emulateMobile(true)
 * with a 390px viewport. Uses the installed unmodified main.js and real plugin loader.
 * Request bodies contain disposable fixture content only; no real keys are needed.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { observePluginNodeAccess } from "./obsidian-plugin-node-audit.mjs";
import { createResearchFixture } from "./smoke-research-extensions-fixtures.mjs";
import { runResearchSmoke } from "./smoke-research-extensions-renderer.mjs";
import { searchScenarios } from "./smoke-research-extensions-search.mjs";
import { clarifyScenarios } from "./smoke-research-extensions-clarify.mjs";
import { contextScenarios } from "./smoke-research-extensions-context.mjs";

const [port, directory, mode, ...extra] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !directory || mode && mode !== "--expect-mobile" || extra.length) {
	throw new Error("Usage: node scripts/smoke-research-extensions-obsidian.mjs <CDP-port> <output-dir> [--expect-mobile]");
}
const root = resolve(directory), mobile = mode === "--expect-mobile";
const stem = `research-extensions-${mobile ? "mobile" : "desktop"}`;
await mkdir(root, { recursive: true });
let report = { passed: false, checks: [], errors: [] }, socket, endpoint, interrupted;
const fixture = createResearchFixture(), pending = new Map();
let sequence = 0, closing = false;
const rejectPending = cause => {
	for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(cause); }
	pending.clear();
};
const send = (method, params = {}, timeout = 10000) => new Promise((resolve, reject) => {
	if (!socket || socket.readyState !== WebSocket.OPEN) { reject(new Error(`CDP disconnected: ${method}`)); return; }
	const id = ++sequence;
	const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} exceeded ${timeout}ms`)); }, timeout);
	pending.set(id, { resolve, reject, timer });
	try { socket.send(JSON.stringify({ id, method, params })); }
	catch (cause) { clearTimeout(timer); pending.delete(id); reject(cause); }
});
const cleanupRenderer = async () => {
	if (socket?.readyState !== WebSocket.OPEN) return;
	await send("Runtime.evaluate", {
		expression: "window.__piemResearchSmoke?.cleanup()", awaitPromise: true, returnByValue: true,
	}, 10000);
};
const signal = name => {
	if (closing || interrupted) return;
	interrupted = name;
	void cleanupRenderer().catch(() => undefined).finally(() => rejectPending(new Error(`Smoke interrupted by ${name}`)));
};
const onInt = () => signal("SIGINT"), onTerm = () => signal("SIGTERM");
process.once("SIGINT", onInt); process.once("SIGTERM", onTerm);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
try {
	const installed = await readFile(resolve(root, "vault/.obsidian/plugins/piem/main.js"));
	const built = await readFile(new URL("../main.js", import.meta.url));
	report.artifactSha256 = sha(installed); report.bytes = installed.length;
	if (sha(built) !== report.artifactSha256) throw new Error("Installed plugin differs from this checkout's main.js; copy the final build before smoke.");
	endpoint = await fixture.listen();
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
	const target = targets.find(item => item.type === "page" && item.url.startsWith("app://"));
	if (!target) throw new Error("No Obsidian page on the supplied CDP port.");
	socket = new WebSocket(target.webSocketDebuggerUrl);
	socket.addEventListener("message", event => {
		let message;
		try { message = JSON.parse(event.data); } catch { return; }
		const entry = pending.get(message.id);
		if (!entry) return;
		clearTimeout(entry.timer); pending.delete(message.id);
		if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result);
	});
	socket.addEventListener("close", () => rejectPending(new Error("CDP socket closed")));
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("CDP connection timed out")), 5000);
		const done = (cause) => { clearTimeout(timer); cause ? reject(cause) : resolve(); };
		socket.addEventListener("open", () => done(), { once: true });
		socket.addEventListener("error", () => done(new Error("CDP connection failed")), { once: true });
	});
	const scenarios = `[${[searchScenarios, clarifyScenarios, contextScenarios].map(scenario => scenario.toString()).join(",")}]`;
	const expression = `(${runResearchSmoke.toString()})(${JSON.stringify(root)},${JSON.stringify(endpoint)},${JSON.stringify(fixture.token)},${mobile},${observePluginNodeAccess.toString()},${scenarios})`;
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, 150000);
	if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
	if (!result.result?.value || !Array.isArray(result.result.value.checks)) throw new Error("Renderer returned no smoke report.");
	report = { ...result.result.value, artifactSha256: sha(installed), bytes: installed.length };
	if (sha(await readFile(resolve(root, "vault/.obsidian/plugins/piem/main.js"))) !== report.artifactSha256) throw new Error("Installed plugin changed during smoke.");
	report.checks.push("installed artifact equals final build and stays unchanged");
} catch (cause) {
	if (socket?.readyState === WebSocket.OPEN) {
		try {
			const partial = await send("Runtime.evaluate", { expression: "window.__piemResearchSmoke?.report", returnByValue: true }, 3000);
			if (partial.result?.value) report = { ...report, ...partial.result.value };
		} catch { /* A dead renderer still gets a host-side failure report. */ }
	}
	report.passed = false;
	report.failure ??= String(cause.stack ?? cause);
} finally {
	closing = true;
	try { await cleanupRenderer(); } catch (cause) { report.passed = false; report.errors.push(`Renderer cleanup: ${String(cause)}`); }
	if (socket?.readyState === WebSocket.OPEN) {
		try {
			const shot = await send("Page.captureScreenshot", { format: "png" });
			await writeFile(resolve(root, `${stem}.png`), Buffer.from(shot.data, "base64"));
			report.screenshot = `${stem}.png`;
		} catch (cause) { report.passed = false; report.errors.push(`Screenshot: ${String(cause)}`); }
	}
	try { await fixture.close(); report.endpointClosed = true; }
	catch (cause) { report.passed = false; report.errors.push(`Fixture cleanup: ${String(cause)}`); }
	report.fixture = fixture.snapshot();
	if (report.fixture.errors.length || report.fixture.gates.some(gate => !gate.released)) {
		report.passed = false; report.failure ??= "Fixture has protocol errors or unreleased requests";
	}
	rejectPending(new Error("Smoke finished"));
	if (socket && socket.readyState !== WebSocket.CLOSED) {
		await new Promise(resolve => {
			const timer = setTimeout(resolve, 1000);
			socket.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
			socket.close();
		});
	}
	report.cdpClosed = !socket || socket.readyState === WebSocket.CLOSED;
	if (!report.cdpClosed) { report.passed = false; report.errors.push("CDP socket did not close"); }
	process.removeListener("SIGINT", onInt); process.removeListener("SIGTERM", onTerm);
	if (interrupted) { report.passed = false; report.failure ??= `Interrupted by ${interrupted}`; }
	await writeFile(resolve(root, `${stem}.json`), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, requests: report.fixture?.requests.length, environment: report.environment, artifactSha256: report.artifactSha256, result: resolve(root, `${stem}.json`), screenshot: report.screenshot, endpointClosed: report.endpointClosed, cdpClosed: report.cdpClosed, failure: report.failure }));
if (!report.passed) process.exitCode = 1;
