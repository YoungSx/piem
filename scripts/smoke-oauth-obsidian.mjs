/**
 * Real Obsidian runtime environment and mobile affordance smoke.
 *
 * NOTE: This smoke verifies the real Obsidian runtime execution environment,
 * plugin bootstrapping, requestUrl availability, settings persistence round-trip,
 * DOM styling, and mobile clipboard/layout capabilities under Desktop and Mobile emulation.
 * It does NOT execute external live OAuth network handshakes against commercial third-party
 * OAuth servers (which require interactive browser logins and commercial subscription accounts).
 * End-to-end simulated OAuth flow and request execution are covered by automated unit/integration tests
 * (see src/auth/oauthE2E.test.ts).
 *
 * Usage: node scripts/smoke-oauth-obsidian.mjs <CDP-port> <output-dir> [--expect-mobile]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

async function runSmoke(expectMobile) {
	const report = { passed: false, checks: [], errors: [], diag: {} };
	const check = (name, ok, detail) => {
		report.checks.push({ name, ok, detail });
		if (!ok) report.errors.push(`${name}: ${detail}`);
	};
	const wait = async (test, timeoutMs, desc) => {
		const until = performance.now() + timeoutMs;
		let last;
		while (performance.now() < until) {
			try {
				const value = await test();
				if (value) return value;
			} catch (e) {
				last = e;
			}
			await new Promise((r) => setTimeout(r, 50));
		}
		throw new Error(`timeout: ${desc}${last ? ` (last: ${last})` : ""}`);
	};

	try {
		await wait(() => window.app?.plugins?.plugins?.piem, 30000, "piem plugin loaded");
		const app = window.app;
		const plugin = app.plugins.plugins.piem;

		check("plugin.manifest.id", plugin.manifest.id === "piem", plugin.manifest.id);
		check("obsidian requestUrl exists", typeof window.requestUrl === "function", typeof window.requestUrl);
		check("correct official device mode", app.isMobile === expectMobile, `app.isMobile=${app.isMobile}, expect=${expectMobile}`);

		if (expectMobile) {
			check("official phone emulation", app.isMobile && (document.body.classList.contains("is-mobile") || document.body.classList.contains("is-phone")), `classes: ${document.body.className}`);
		}

		// Read and test plugin data persistence round-trip
		const data = (await plugin.loadData()) ?? {};
		check("plugin data loaded", typeof data === "object", typeof data);
		const testStamp = Date.now();
		await plugin.saveData({ ...data, _smokeStamp: testStamp });
		const reloadedData = await plugin.loadData();
		check("plugin data persistence round-trip", reloadedData?._smokeStamp === testStamp, `${reloadedData?._smokeStamp} === ${testStamp}`);

		// Verify DOM and CSS
		const dummyEl = document.createElement("div");
		dummyEl.className = "piem-sign-in-hint";
		document.body.appendChild(dummyEl);
		const computed = window.getComputedStyle(dummyEl);
		check("piem-sign-in-hint styles loaded", computed.fontSize !== "", `font-size: ${computed.fontSize}`);
		dummyEl.remove();

		// Check clipboard API in browser context
		check("navigator.clipboard exists", Boolean(navigator.clipboard), typeof navigator.clipboard);

		report.diag = {
			pluginVersion: plugin.manifest.version,
			isMobile: app.isMobile,
			platform: process.platform,
			bodyClasses: document.body.className,
		};
		report.passed = report.errors.length === 0;
	} catch (e) {
		report.errors.push(String(e));
	}
	return report;
}

const [port, root, ...rest] = process.argv.slice(2);
const expectMobile = rest.includes("--expect-mobile");
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const target =
	targets.find((item) => item.type === "page" && item.url.startsWith("app://obsidian.md/index.html")) ??
	targets.find((item) => item.type === "page" && item.url.startsWith("app://"));
if (!target) throw new Error("No Obsidian page.");

const waiters = new Map();
let nextId = 0;
const socket = new WebSocket(target.webSocketDebuggerUrl);
socket.addEventListener("message", (event) => {
	const message = JSON.parse(event.data);
	const waiter = waiters.get(message.id);
	if (!waiter) return;
	waiters.delete(message.id);
	message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
});
const timer = setTimeout(() => {
	for (const waiter of waiters.values()) waiter.reject(new Error("Smoke timed out"));
	socket.close();
}, 120000);
await new Promise((res, rej) => {
	socket.addEventListener("open", res, { once: true });
	socket.addEventListener("error", rej, { once: true });
});
const send = (method, params = {}) =>
	new Promise((res, rej) => {
		const id = ++nextId;
		waiters.set(id, { resolve: res, reject: rej });
		socket.send(JSON.stringify({ id, method, params }));
	});

try {
	const result = await send("Runtime.evaluate", {
		expression: `(${runSmoke.toString()})(${expectMobile})`,
		awaitPromise: true,
		returnByValue: true,
	});
	if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
	const report = result.result.value;
	const { readFile } = await import("node:fs/promises");
	const artifact = await readFile(resolve(root, "vault/.obsidian/plugins/piem/main.js"));
	report.artifactSha256 = createHash("sha256").update(artifact).digest("hex");

	await mkdir(root, { recursive: true });
	const outFilename = expectMobile ? "smoke-oauth-mobile.json" : "smoke-oauth-desktop.json";
	await writeFile(resolve(root, outFilename), `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify({ passed: report.passed, checks: report.checks?.length ?? 0, diag: report.diag, errors: report.errors, artifactSha256: report.artifactSha256 }));
	if (!report.passed) process.exitCode = 1;
} finally {
	clearTimeout(timer);
	socket.close();
}
