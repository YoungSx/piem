/**
 * Real Obsidian smoke for the two-pass post-reply quick actions.
 *
 * After a reply settles the row fills in two waves: a fast pass of three chips
 * shown at once, then a deeper pass fetched the instant they land and appended
 * behind them. This drives a real panel against a local deterministic model
 * that answers the fast and deep suggestion requests with distinct chips, and
 * asserts the row goes empty → fast three → fast three + deep, in order.
 *
 * Disposable vault only; the model endpoint is local and deterministic.
 * Usage: node scripts/smoke-reply-suggestions-obsidian.mjs <CDP-port> <output-dir>
 */
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

async function runSmoke(root, endpoint) {
	const report = { passed: false, checks: [], errors: [] };
	const record = (name, value, detail) => {
		if (!value) throw new Error(detail ? `${name}: ${detail}` : name);
		console.info(`[check] ${name}`);
		report.checks.push(name);
	};
	const wait = async (test, timeoutMs = 15000, desc = "") => {
		const until = performance.now() + timeoutMs;
		while (performance.now() < until) {
			if (await test()) return;
			await new Promise((res) => setTimeout(res, 30));
		}
		throw new Error(`Condition timed out: ${typeof desc === "function" ? desc() : desc}`);
	};
	const stripLabels = () =>
		[...document.querySelectorAll(".piem-chat__quick-actions--strip .piem-chat__quick-action")].map((el) => el.textContent.trim());

	await wait(() => window.app?.plugins, 30000, "app.plugins ready");
	if (app.vault.adapter.getBasePath() !== `${root}/vault`) {
		throw new Error("Use a disposable vault at <output-dir>/vault.");
	}
	report.environment = { obsidian: document.title.match(/Obsidian ([0-9.]+)/)?.[1] };

	const error = (event) => report.errors.push(String(event.error ?? event.reason ?? event.message));
	window.addEventListener("error", error);
	window.addEventListener("unhandledrejection", error);

	let plugin = app.plugins.plugins.piem;
	try {
		// The rig registers the plugin in enabledPlugins but does not always finish
		// loading it before the smoke connects; enabling is idempotent and the only
		// reliable gate on agentService existing.
		if (!plugin?.agentService) {
			app.plugins.setEnable(true);
			await app.plugins.enablePluginAndSave("piem");
		}
		await wait(() => app.plugins.plugins.piem?.agentService, 60000, "piem agentService ready");
		plugin = app.plugins.plugins.piem;
		await plugin.agentService.initialize();

		Object.assign(plugin.settings, {
			language: "en",
			// The renderer's own fetch, not requestUrl: this rig's main process never
			// answers an Obsidian network request, so requestUrl would hang.
			networkTransport: "fetch",
			providers: [
				{ id: "reply-smoke", name: "Local smoke", baseUrl: `${endpoint}/v1`, protocol: "openai-completions", apiKey: "local-fixture-only", secretRef: "", source: "user", oauthFlow: "" },
			],
			models: [
				{ id: "reply-model", providerId: "reply-smoke", modelApiId: "smoke", displayName: "Smoke", reasoning: false, supportsImages: false },
			],
			activeModelId: "reply-model",
		});
		await plugin.saveSettings();
		await plugin.activateChatView();
		const service = plugin.agentService;
		await service.newSession();

		await service.sendPrompt("Tell me about vector search recall.");
		await wait(
			() => service.getSnapshot().messages.some((m) => m.role === "assistant" && m.stopReason !== "aborted" && !service.getSnapshot().isStreaming),
			25000,
			() => `expected a settled assistant reply, panelError=${service.getSnapshot().errorMessage ?? "none"}`,
		);

		// The strip fills across two model requests: the fast pass ("Fast n") and
		// the deeper pass ("Deep n") the mock answers only when the prompt carries
		// the deep marker. Against a local mock the deeper pass can land before the
		// three-only frame is sampled, so the settled row — not an intermediate
		// frame — is what the assertions read; its shape alone proves both requests
		// fired and merged in order (a single request of six could not split the
		// labels this way).
		await wait(() => stripLabels().length >= 6, 20000, () => `expected six chips across two passes, saw ${JSON.stringify(stripLabels())}`);
		const merged = stripLabels();
		record("both passes fill one row of six", merged.length === 6, JSON.stringify(merged));
		record("fast pass leads, in order", merged.slice(0, 3).join("|") === "Fast 1|Fast 2|Fast 3", JSON.stringify(merged));
		record("deeper pass follows, in order", merged.slice(3).join("|") === "Deep 1|Deep 2|Deep 3", JSON.stringify(merged));

		record("no renderer errors or unhandled rejections", report.errors.length === 0, JSON.stringify(report.errors));
		report.rowLabels = merged;
		report.passed = true;
	} catch (cause) {
		report.failure = String(cause.stack ?? cause);
		report.panelError = plugin?.agentService?.getSnapshot().errorMessage;
	} finally {
		window.removeEventListener("error", error);
		window.removeEventListener("unhandledrejection", error);
	}
	return report;
}

const [port, directory, ...extra] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port) || !directory || extra.length) {
	throw new Error("Usage: node scripts/smoke-reply-suggestions-obsidian.mjs <CDP-port> <output-dir>");
}
const root = resolve(directory);
await mkdir(root, { recursive: true });

const CORS = { "access-control-allow-origin": "*" };
/** Distinctive substring of REPLY_DEEP_INSTRUCTION (src/agent/quickActionSuggestionRequest.ts). */
const DEEP_MARKER = "deeper second set";
/** Distinctive substring of the reply placement's framing (both passes carry it). */
const REPLY_MARKER = "Base the suggestions on this assistant reply";

const sse = (response, content, model) => {
	response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...CORS });
	const chunk = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content }, finish_reason: null }] };
	const done = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } };
	response.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`);
};
const chips = (prefix) => JSON.stringify([1, 2, 3].map((n) => ({ label: `${prefix} ${n}`, prompt: `${prefix} prompt ${n}, distinct enough to never collide.` })));

const server = createServer(async (request, response) => {
	try {
		if (request.method === "OPTIONS") {
			response.writeHead(204, { ...CORS, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, authorization" });
			response.end();
			return;
		}
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404, CORS).end();
			return;
		}
		let text = "";
		for await (const chunk of request) {
			text += chunk;
			if (text.length > 2 * 1024 * 1024) throw new Error("Request too large");
		}
		const body = JSON.parse(text);
		const prompt = (body.messages ?? []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");

		// Deep is checked first: its instruction also carries the reply framing.
		if (prompt.includes(DEEP_MARKER)) {
			sse(response, chips("Deep"), body.model);
			return;
		}
		if (prompt.includes(REPLY_MARKER)) {
			sse(response, chips("Fast"), body.model);
			return;
		}
		// The empty-screen suggestion request (fires on session open) keeps its
		// built-in chips: answering empty leaves them untouched.
		if (prompt.includes("JSON array")) {
			sse(response, "[]", body.model);
			return;
		}
		await new Promise((res) => setTimeout(res, 40));
		sse(response, "Vector search recall is the fraction of relevant documents your retriever actually returns.", body.model);
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
	await writeFile(resolve(root, "reply-suggestions-final.png"), Buffer.from(shot.data, "base64"));
	await writeFile(resolve(root, "reply-suggestions.json"), `${JSON.stringify(report, null, 2)}\n`);

	console.log(JSON.stringify({ passed: report.passed, checks: report.checks?.length ?? 0, rowLabels: report.rowLabels, artifactSha256: report.artifactSha256, failure: report.failure, panelError: report.panelError }));
	if (!report.passed) process.exitCode = 1;
} finally {
	clearTimeout(timer);
	socket?.close();
	server.closeAllConnections();
	await new Promise((res) => server.close(res));
}
