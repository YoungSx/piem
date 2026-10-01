/**
 * Real Obsidian smoke for the undocumented settings surface `get_settings` and
 * `update_setting` are built on (issue: the agent could read `.obsidian/` but
 * had no door to change anything in it).
 *
 * Question under test: does Obsidian 1.13.7 actually expose the members the
 * tools probe for — `vault.getConfig` / `setConfig` (the app's own settings),
 * `vault.readPluginData` / `writePluginData` (a plugin's data.json), and
 * `app.plugins` with its `plugins` / `manifests` / `enabledPlugins` — and does
 * a write through `setConfig` really persist and fire `config-changed`? Those
 * are exactly the members absent from the public `obsidian.d.ts`, which is why
 * the tools probe for them rather than assume them. Existence alone is not the
 * claim: a store that accepts a write without telling the app is the failure
 * this rules out.
 *
 * It flips one app setting (`readableLineLength`) to the other value and back,
 * so the net effect on the disposable vault is nil. No plugin data is touched,
 * and Piem's own plugin is never a target — the tool refuses it by id.
 *
 * Disposable vault only; no model request is sent and no host is contacted.
 * Usage: node scripts/smoke-settings-api-obsidian.mjs <CDP-port> <output-dir>
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

async function runSmoke() {
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
		// Waited on for its side effect only: the predicate returns the plugin
		// manager because that is the member whose arrival means the App is built,
		// and `wait` hands that truthy value back — so `app` is read from `window`
		// afterwards rather than from the predicate's return value.
		await wait(() => window.app?.plugins, 30000, "app.plugins");
		const app = window.app;

		// The two probes the tools make, verbatim: each is a pair of members, and a
		// half-present pair is the case a lone truthiness check would let through.
		const config = app.vault;
		check("vault.getConfig", typeof config.getConfig === "function", typeof config.getConfig);
		check("vault.setConfig", typeof config.setConfig === "function", typeof config.setConfig);
		check("vault.readPluginData", typeof config.readPluginData === "function", typeof config.readPluginData);
		check("vault.writePluginData", typeof config.writePluginData === "function", typeof config.writePluginData);
		check("app.plugins.plugins", typeof app.plugins.plugins === "object", typeof app.plugins.plugins);
		check("app.plugins.manifests", typeof app.plugins.manifests === "object", typeof app.plugins.manifests);
		check("app.plugins.enabledPlugins", app.plugins.enabledPlugins instanceof Set, app.plugins.enabledPlugins?.constructor?.name);

		// Piem itself is a live instance, so this also proves the shape a plugin
		// read takes: `settings` in memory, `saveData` as the write route.
		const piem = app.plugins.plugins.piem;
		check("a live plugin exposes settings", piem !== undefined && typeof piem.settings === "object", typeof piem?.settings);
		check("a live plugin exposes saveData", typeof piem?.saveData === "function", typeof piem?.saveData);

		// The round trip: a write that is accepted but neither visible nor
		// broadcast would leave the agent reporting a change that never happened.
		const key = "readableLineLength";
		const before = config.getConfig(key);
		const want = !before;
		let fired = 0;
		const onChanged = () => fired++;
		app.vault.on("config-changed", onChanged);
		try {
			config.setConfig(key, want);
			check("setConfig is readable back", config.getConfig(key) === want, `${before} -> ${JSON.stringify(config.getConfig(key))}`);
			check("setConfig fires config-changed", fired > 0, `${fired} event(s)`);
			check("a same-value write does not fire", (config.setConfig(key, want), fired) === 1, `${fired} events after a repeat write`);
		} finally {
			app.vault.off("config-changed", onChanged);
			config.setConfig(key, before);
		}
		check("the original value is restored", config.getConfig(key) === before, `${JSON.stringify(config.getConfig(key))} vs ${JSON.stringify(before)}`);

		// What `get_settings` with no plugin id lists, on a real install.
		const ids = Object.keys(app.plugins.manifests).sort();
		check("manifests enumerates installed plugins", ids.includes("piem"), `${ids.length} plugins, piem present: ${ids.includes("piem")}`);
		report.diag = { plugins: ids, enabled: [...app.plugins.enabledPlugins], before, restored: config.getConfig(key) };

		report.passed = report.errors.length === 0;
	} catch (e) {
		report.errors.push(String(e));
	}
	return report;
}

const [port, root] = process.argv.slice(2);
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
		expression: `(${runSmoke.toString()})()`,
		awaitPromise: true,
		returnByValue: true,
	});
	if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
	const report = result.result.value;
	const { readFile } = await import("node:fs/promises");
	const artifact = await readFile(resolve(root, "vault/.obsidian/plugins/piem/main.js"));
	report.artifactSha256 = createHash("sha256").update(artifact).digest("hex");

	await mkdir(root, { recursive: true });
	await writeFile(resolve(root, "settings-api.json"), `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify({ passed: report.passed, checks: report.checks?.length ?? 0, diag: report.diag, errors: report.errors, artifactSha256: report.artifactSha256 }));
	if (!report.passed) process.exitCode = 1;
} finally {
	clearTimeout(timer);
	socket.close();
}