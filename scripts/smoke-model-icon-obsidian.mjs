/**
 * Real Obsidian smoke for the composer model-switcher vendor mark (issue #161).
 *
 * Question under test: in a real Obsidian, does the little vendor logo next to
 * the model name actually paint, and does it track the active model? It seeds
 * several configured models whose api ids name a vendor (claude/gpt/qwen) plus
 * one custom id that names none, then switches the active model through each
 * along the real onSelect path and reads the switcher DOM: the vendor cases
 * must show a painted, non-zero <svg> classed for that vendor; the custom case
 * must show none (the documented by-design fallback). This exercises the whole
 * chain — addIcon registration, matchVendorForModel, setIcon paint, the CSS box,
 * and the live re-render — that source inspection alone cannot confirm is live.
 *
 * Disposable vault only; the endpoint is a local deterministic mock — no model
 * request is sent and no official host is ever contacted.
 * Usage: node scripts/smoke-model-icon-obsidian.mjs <CDP-port> <output-dir>
 */
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

async function runSmoke(root, endpoint) {
	const report = { passed: false, checks: [], errors: [], cases: [], diag: {} };
	const wait = async (test, timeoutMs = 15000, desc = "") => {
		const until = performance.now() + timeoutMs;
		let last;
		while (performance.now() < until) {
			try {
				if (await test()) return;
			} catch (e) {
				last = e;
			}
			await new Promise((r) => setTimeout(r, 40));
		}
		throw new Error(`timeout: ${typeof desc === "function" ? desc() : desc}${last ? ` (last: ${last})` : ""}`);
	};
	const paint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	const dismissTrust = () => {
		const b = [...document.querySelectorAll(".modal-container button, .modal button")].find((x) => /trust author/i.test(x.textContent || ""));
		if (b) b.click();
		return !!b;
	};
	const readMark = () => {
		const holder = document.querySelector(".piem-chat__model-switcher-mark");
		const svg = holder?.querySelector("svg") ?? null;
		const box = svg?.getBoundingClientRect();
		return {
			svgPainted: !!svg,
			box: box ? { w: Math.round(box.width), h: Math.round(box.height) } : null,
			svgClass: svg?.getAttribute("class") ?? null,
			name: document.querySelector(".piem-chat__model-switcher-name")?.textContent?.trim() ?? null,
		};
	};

	await wait(() => window.app?.plugins, 30000, "app.plugins");
	if (app.vault.adapter.getBasePath() !== `${root}/vault`) throw new Error("disposable vault at <output-dir>/vault expected");
	report.environment = { obsidian: document.title.match(/Obsidian ([0-9.]+)/)?.[1] };
	report.diag.trustDismissedAtStart = dismissTrust();

	const onError = (e) => report.errors.push(String(e.error ?? e.reason ?? e.message));
	window.addEventListener("error", onError);
	window.addEventListener("unhandledrejection", onError);

	let plugin = app.plugins.plugins.piem;
	try {
		if (!plugin?.agentService) {
			app.plugins.setEnable(true);
			await app.plugins.enablePluginAndSave("piem");
		}
		await wait(() => app.plugins.plugins.piem?.agentService, 60000, "piem agentService ready");
		plugin = app.plugins.plugins.piem;
		const service = plugin.agentService;
		await service.initialize();

		const CASES = [
			{ id: "m-claude", apiId: "claude-opus-5", display: "Claude Opus 5", expect: "piem-vendor-anthropic", keyword: "claude" },
			{ id: "m-gpt", apiId: "gpt-4o", display: "GPT 4o", expect: "piem-vendor-openai", keyword: "gpt" },
			{ id: "m-qwen", apiId: "qwen-max", display: "Qwen Max", expect: "piem-vendor-qwen", keyword: "qwen" },
			{ id: "m-custom", apiId: "my-private-model", display: "My Private", expect: null, keyword: "private" },
		];
		Object.assign(plugin.settings, {
			language: "en",
			networkTransport: "fetch",
			providers: [{ id: "icon-smoke", name: "Local", baseUrl: `${endpoint}/v1`, protocol: "openai-completions", apiKey: "local-fixture-only", secretRef: "", source: "user", oauthFlow: "" }],
			models: CASES.map((c) => ({ id: c.id, providerId: "icon-smoke", modelApiId: c.apiId, displayName: c.display, reasoning: false, supportsImages: false })),
			activeModelId: CASES[0].id,
		});
		await plugin.saveSettings();
		await plugin.activateChatView();
		await service.newSession();
		dismissTrust();

		const snap = () => service.getSnapshot();
		// The view must carry the seed before the switcher can show anything but
		// the builtin fallback; a stuck view fails loudly here, not silently later.
		await wait(() => (snap().modelChoices?.length ?? 0) >= CASES.length, 20000, () => `modelChoices to carry the seed, saw ${JSON.stringify((snap().modelChoices || []).map((c) => c.id))}`);
		report.diag.afterSeed = { isConfigured: snap().isConfigured, activeModelId: snap().activeModelId, modelId: snap().modelId, vendorIcon: snap().vendorIcon, choices: (snap().modelChoices || []).map((c) => c.id) };

		for (const c of CASES) {
			// The exact call the switcher menu's onSelect makes (ChatApp.tsx) — the
			// real switch path, not a settings poke.
			await service.setActiveModel(c.id);
			await wait(() => snap().activeModelId === c.id, 8000, () => `snapshot activeModelId === ${c.id}`);
			const snapshotVendorIcon = snap().vendorIcon ?? null;
			await paint();
			// Wait for the DOM to actually re-render to this model, so a frozen view
			// fails loudly here instead of reading a stale mark.
			await wait(() => (readMark().name || "").toLowerCase().replace(/[\s-]/g, "").includes(c.keyword), 8000, () => `switcher DOM to show "${c.display}", saw "${readMark().name}"`);
			report.cases.push({ case: c.id, apiId: c.apiId, expect: c.expect, snapshotVendorIcon, dom: readMark() });
		}

		const byId = Object.fromEntries(report.cases.map((x) => [x.case, x]));
		const check = (name, ok, detail) => {
			if (!ok) throw new Error(`${name}: ${detail}`);
			report.checks.push(name);
		};
		for (const c of CASES.filter((x) => x.expect)) {
			const r = byId[c.id];
			check(`${c.id} snapshot resolves ${c.expect}`, r.snapshotVendorIcon === c.expect, JSON.stringify(r));
			check(`${c.id} svg painted, sized, classed ${c.expect}`, r.dom.svgPainted && r.dom.box && r.dom.box.w > 0 && r.dom.box.h > 0 && (r.dom.svgClass || "").includes(c.expect), JSON.stringify(r.dom));
		}
		const custom = byId["m-custom"];
		check("custom-id model shows NO mark (by design)", custom.snapshotVendorIcon === null && !custom.dom.svgPainted, JSON.stringify(custom));
		check("no renderer errors during the switcher exercise", report.errors.length === 0, JSON.stringify(report.errors));

		// Land on Claude so the screenshot shows a real vendor mark by its name.
		await service.setActiveModel("m-claude");
		await wait(() => (readMark().name || "").toLowerCase().includes("claude"), 8000, "switcher back on Claude for the shot");
		await paint();
		report.passed = true;
	} catch (cause) {
		report.failure = String(cause.stack ?? cause);
		report.panelError = plugin?.agentService?.getSnapshot?.().errorMessage;
	} finally {
		window.removeEventListener("error", onError);
		window.removeEventListener("unhandledrejection", onError);
	}
	return report;
}

const [port, directory, ...extra] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port) || !directory || extra.length) {
	throw new Error("Usage: node scripts/smoke-model-icon-obsidian.mjs <CDP-port> <output-dir>");
}
const root = resolve(directory);
await mkdir(root, { recursive: true });

const CORS = { "access-control-allow-origin": "*" };
const server = createServer(async (request, response) => {
	try {
		if (request.method === "OPTIONS") {
			response.writeHead(204, { ...CORS, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, authorization" });
			response.end();
			return;
		}
		if (request.method === "GET" && request.url === "/v1/models") {
			response.writeHead(200, { "content-type": "application/json", ...CORS });
			response.end(JSON.stringify({ object: "list", data: ["claude-opus-5", "gpt-4o", "qwen-max", "my-private-model"].map((id) => ({ id, object: "model" })) }));
			return;
		}
		if (request.method === "POST" && request.url === "/v1/chat/completions") {
			let text = "";
			for await (const chunk of request) {
				text += chunk;
				if (text.length > 2 * 1024 * 1024) throw new Error("Request too large");
			}
			const body = JSON.parse(text);
			const prompt = (body.messages ?? []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
			const content = prompt.includes("JSON array") ? "[]" : "ok";
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...CORS });
			const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: body.model };
			const chunk = { ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] };
			const done = { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } };
			response.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`);
			return;
		}
		response.writeHead(404, CORS).end();
	} catch (cause) {
		response.writeHead(500).end(String(cause));
	}
});
await new Promise((res) => server.listen(0, "127.0.0.1", res));

let socket;
let timer;
const waiters = new Map();
let nextId = 0;
try {
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
	const target =
		targets.find((item) => item.type === "page" && item.url.startsWith("app://obsidian.md/index.html")) ??
		targets.find((item) => item.type === "page" && item.url.startsWith("app://"));
	if (!target) throw new Error("No Obsidian page.");

	socket = new WebSocket(target.webSocketDebuggerUrl);
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		const waiter = waiters.get(message.id);
		if (!waiter) return;
		waiters.delete(message.id);
		message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
	});
	timer = setTimeout(() => {
		for (const waiter of waiters.values()) waiter.reject(new Error("Smoke timed out"));
		socket.close();
	}, 180000);
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

	const endpoint = `http://127.0.0.1:${server.address().port}`;
	const result = await send("Runtime.evaluate", {
		expression: `(${runSmoke.toString()})(${JSON.stringify(root)},${JSON.stringify(endpoint)})`,
		awaitPromise: true,
		returnByValue: true,
	});
	if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
	const report = result.result.value;

	const artifact = await readFile(resolve(root, "vault/.obsidian/plugins/piem/main.js"));
	report.artifactSha256 = createHash("sha256").update(artifact).digest("hex");

	await send("Runtime.evaluate", { expression: "[...document.querySelectorAll('.notice')].forEach(n => n.remove());", awaitPromise: true });
	const shot = await send("Page.captureScreenshot", { format: "png" });
	await writeFile(resolve(root, "model-icon-final.png"), Buffer.from(shot.data, "base64"));
	await writeFile(resolve(root, "model-icon.json"), `${JSON.stringify(report, null, 2)}\n`);

	console.log(JSON.stringify({ passed: report.passed, checks: report.checks?.length ?? 0, diag: report.diag, cases: report.cases, artifactSha256: report.artifactSha256, errors: report.errors, failure: report.failure, panelError: report.panelError }));
	if (!report.passed) process.exitCode = 1;
} finally {
	clearTimeout(timer);
	socket?.close();
	server.closeAllConnections();
	await new Promise((res) => server.close(res));
}
