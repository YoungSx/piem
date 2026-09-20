/**
 * Real Obsidian smoke for Proactive Intelligence and Cadence Awareness.
 * Disposable vault only; the model endpoint is local and deterministic.
 * Usage: node scripts/smoke-proactive-obsidian.mjs <CDP-port> <output-dir> [--expect-mobile]
 */
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { observePluginNodeAccess } from "./obsidian-plugin-node-audit.mjs";

async function runSmoke(root, endpoint, expectMobile, observeNodeAccess) {
	const report = { passed: false, checks: [], errors: [], stages: [] };
	const record = (name, value) => {
		if (!value) throw new Error(name);
		report.checks.push(name);
	};
	const wait = async (test, timeoutMs = 8000, desc = "") => {
		const until = performance.now() + timeoutMs;
		while (performance.now() < until) {
			if (await test()) return;
			await new Promise((res) => setTimeout(res, 30));
		}
		const reason = typeof desc === "function" ? desc() : desc;
		throw new Error(`Condition timed out: ${reason}`);
	};

	await wait(() => window.app?.plugins?.plugins?.piem?.agentService, 10000, "piem agentService ready");
	if (app.vault.adapter.getBasePath() !== `${root}/vault`) {
		throw new Error("Use a disposable vault at <output-dir>/vault.");
	}

	report.environment = {
		mobile: app.isMobile,
		phone: document.body.classList.contains("is-phone"),
		width: innerWidth,
		height: innerHeight,
		obsidian: document.title.match(/Obsidian ([0-9.]+)/)?.[1],
	};
	record("correct official device mode", app.isMobile === expectMobile);
	if (expectMobile) {
		record("official phone emulation", document.body.classList.contains("emulate-mobile") && report.environment.phone);
	}

	const error = (event) => report.errors.push(String(event.error ?? event.reason ?? event.message));
	window.addEventListener("error", error);
	window.addEventListener("unhandledrejection", error);
	const audit = expectMobile ? observeNodeAccess("piem") : undefined;

	let plugin = app.plugins.plugins.piem;
	const reload = async () => {
		await app.plugins.unloadPlugin("piem");
		await app.plugins.loadPlugin("piem");
		await wait(() => app.plugins.plugins.piem?.agentService, 10000, "reload agentService");
		plugin = app.plugins.plugins.piem;
		await plugin.agentService.initialize();
	};

	const holdForStage = async (stageName) => {
		await plugin.activateChatView();
		[...document.querySelectorAll(".notice")].forEach((n) => n.remove());
		await new Promise((res) => setTimeout(res, 200));
		return new Promise((res) => {
			window.__piemHoldStage = stageName;
			window.__piemHoldResolve = () => {
				delete window.__piemHoldStage;
				delete window.__piemHoldResolve;
				res();
			};
			setTimeout(() => {
				if (window.__piemHoldResolve) window.__piemHoldResolve();
			}, 15000);
		});
	};

	try {
		await reload();
		Object.assign(plugin.settings, {
			language: "zh-cn",
			networkTransport: "requestUrl",
			providers: [
				{
					id: "proactive-smoke",
					name: "Local smoke",
					baseUrl: `${endpoint}/v1`,
					protocol: "openai-completions",
					apiKey: "local-fixture-only",
					secretRef: "",
					source: "user",
					oauthFlow: "",
				},
			],
			models: [
				{
					id: "proactive-model",
					providerId: "proactive-smoke",
					modelApiId: "smoke",
					displayName: "Smoke",
					reasoning: false,
					supportsImages: false,
				},
			],
			activeModelId: "proactive-model",
			showAgentDetails: true,
		});
		await plugin.saveSettings();
		await plugin.activateChatView();
		const service = plugin.agentService;
		await service.newSession();

		// Wait for metadata cache to index vault files
		await wait(() => {
			const tf = app.vault.getAbstractFileByPath("Tasks/Project-Roadmap.md");
			return tf && app.metadataCache.getFileCache(tf) !== null;
		}, 15000, "waiting for metadata cache of Tasks/Project-Roadmap.md");

		const leaf = app.workspace.getLeaf(false);

		// --- Scenario 1: Note with tasks (Tasks/Project-Roadmap.md) ---
		const taskFile = app.vault.getAbstractFileByPath("Tasks/Project-Roadmap.md");
		await leaf.openFile(taskFile);
		app.workspace.setActiveLeaf(leaf, { focus: true });

		let taskSeen = [];
		await wait(() => {
			taskSeen = [...document.querySelectorAll(".piem-chat__quick-action")].map((el) => el.textContent.trim());
			return taskSeen.includes("整理未完待办");
		}, 10000, () => `expected "整理未完待办", saw: ${JSON.stringify(taskSeen)}, activeFile: ${app.workspace.getActiveFile()?.path}, isConfigured: ${service.getSnapshot().isConfigured}`);

		const taskChips = [...document.querySelectorAll(".piem-chat__quick-action")].map((el) => el.textContent.trim());
		record("tasks note offers extractTodos chip", taskChips.includes("整理未完待办"));
		report.stages.push({ stage: "tasks-note", chips: taskChips });
		await holdForStage(expectMobile ? "mobile-tasks" : "desktop-tasks");

		// --- Scenario 2: Note with code (Code/Algorithm.md) ---
		const codeFile = app.vault.getAbstractFileByPath("Code/Algorithm.md");
		await leaf.openFile(codeFile);
		app.workspace.setActiveLeaf(leaf, { focus: true });
		let codeSeen = [];
		await wait(() => {
			codeSeen = [...document.querySelectorAll(".piem-chat__quick-action")].map((el) => el.textContent.trim());
			return codeSeen.includes("审查代码质量") || codeSeen.includes("解析代码逻辑");
		}, 10000, () => `expected code chips, saw: ${JSON.stringify(codeSeen)}`);
		const codeChips = [...document.querySelectorAll(".piem-chat__quick-action")].map((el) => el.textContent.trim());
		record("code note offers code quality chip", codeChips.includes("审查代码质量"));
		record("code note offers code logic chip", codeChips.includes("解析代码逻辑"));
		report.stages.push({ stage: "code-note", chips: codeChips });

		// --- Scenario 3: Daily note with today's date (Daily/2026-09-20.md) ---
		const dailyFile = app.vault.getAbstractFileByPath("Daily/2026-09-20.md");
		await leaf.openFile(dailyFile);
		app.workspace.setActiveLeaf(leaf, { focus: true });
		let dailySeen = [];
		await wait(() => {
			dailySeen = [...document.querySelectorAll(".piem-chat__quick-action")].map((el) => el.textContent.trim());
			return dailySeen.includes("晨间专注规划") || dailySeen.includes("碎片整理归档");
		}, 10000, () => `expected daily chips, saw: ${JSON.stringify(dailySeen)}`);
		const dailyChips = [...document.querySelectorAll(".piem-chat__quick-action")].map((el) => el.textContent.trim());
		record("daily note offers cadence-aware chip", dailyChips.includes("晨间专注规划") || dailyChips.includes("碎片整理归档"));
		report.stages.push({ stage: "daily-note", chips: dailyChips });
		await holdForStage(expectMobile ? "mobile-daily" : "desktop-daily");

		// --- Scenario 4: Note with prior session recall (Research/PriorDiscussion.md) ---
		service.noteSessionIndex.record("Research/PriorDiscussion.md", "prior-session-42", "深入研读向量检索");
		const resFile = app.vault.getAbstractFileByPath("Research/PriorDiscussion.md");
		await leaf.openFile(resFile);
		app.workspace.setActiveLeaf(leaf, { focus: true });
		let resSeen = [];
		await wait(() => {
			resSeen = [...document.querySelectorAll(".piem-chat__quick-action")].map((el) => el.textContent.trim());
			return resSeen.includes("继续上次探讨");
		}, 10000, () => `expected "继续上次探讨", saw: ${JSON.stringify(resSeen)}`);
		const resChips = [...document.querySelectorAll(".piem-chat__quick-action")].map((el) => el.textContent.trim());
		record("note with session index offers recallSession chip", resChips.includes("继续上次探讨"));
		report.stages.push({ stage: "recall-note", chips: resChips });
		await holdForStage(expectMobile ? "mobile-recall" : "desktop-recall");

		// --- Scenario 5: Responsive layout & interaction ---
		const actionsContainer = document.querySelector(".piem-chat__quick-actions");
		if (actionsContainer) {
			// In mobile (390px), horizontal scroll should be 0 (scrollWidth <= clientWidth + 2)
			const noOverflow = actionsContainer.scrollWidth <= actionsContainer.clientWidth + 2;
			record("quick actions chips do not overflow horizontally", noOverflow);
		}

		// Click the recall button to verify prompt dispatch
		const recallBtn = [...document.querySelectorAll(".piem-chat__quick-action")].find((btn) =>
			btn.textContent.includes("继续上次探讨"),
		);
		record("found recall quick action button", Boolean(recallBtn));
		if (recallBtn) {
			recallBtn.click();
		}

		// Wait for the assistant turn to complete
		await wait(() => {
			const msgs = service.getSnapshot().messages;
			return msgs.some((m) => m.role === "assistant");
		}, 10000);
		record("quick action click completes assistant turn", true);

		const finalMsgs = service.getSnapshot().messages;
		report.stages.push({
			stage: "completed-turn",
			userPrompt: finalMsgs.find((m) => m.role === "user")?.content?.[0]?.text,
			assistantReply: finalMsgs.find((m) => m.role === "assistant")?.content?.[0]?.text,
		});

		if (audit) {
			record("negative Node controls refused", audit.report.controls.length === 6 && audit.report.controls.every((item) => !item.provided));
			record("plugin only requests Obsidian", audit.report.requests.length > 0 && audit.report.requests.every((item) => item.id === "obsidian" && item.provided));
			record("no unexpected console errors", audit.report.consoleErrors.every((item) => item.control));
			report.nodeAccess = audit.report;
		}

		record("no renderer errors or unhandled rejections", report.errors.length === 0);
		report.passed = true;
	} catch (cause) {
		report.failure = String(cause.stack ?? cause);
		report.panelError = plugin?.agentService?.getSnapshot().errorMessage;
	} finally {
		delete window.__piemHoldResolve;
		delete window.__piemHoldStage;
		audit?.restore();
		window.removeEventListener("error", error);
		window.removeEventListener("unhandledrejection", error);
	}
	return report;
}

const [port, directory, mode, ...extra] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port) || !directory || (mode && mode !== "--expect-mobile") || extra.length) {
	throw new Error("Usage: node scripts/smoke-proactive-obsidian.mjs <CDP-port> <output-dir> [--expect-mobile]");
}
const root = resolve(directory);
const mobile = mode === "--expect-mobile";
const requests = [];
await mkdir(root, { recursive: true });

const server = createServer(async (request, response) => {
	try {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		let text = "";
		for await (const chunk of request) {
			text += chunk;
			if (text.length > 2 * 1024 * 1024) throw new Error("Request too large");
		}
		const body = JSON.parse(text);
		requests.push(body);

		const promptText = JSON.stringify(body.messages ?? []);
		// Quick actions suggestion query expects a JSON array or empty
		const isSuggestionQuery = promptText.includes("quick") || promptText.includes("suggestion") || body.messages?.some((m) => m.content?.includes("JSON array"));

		if (isSuggestionQuery) {
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const chunk = {
				id: `chatcmpl-mock-${requests.length}`,
				object: "chat.completion.chunk",
				created: 1,
				model: body.model,
				choices: [{ index: 0, delta: { content: "[]" }, finish_reason: null }],
			};
			const done = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
			response.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`);
			return;
		}

		// User prompt reply
		const reply = "已为您调出上次关于向量检索的讨论记录，我们可以从当时尚未完成的检索召回率评估继续展开。";
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		const chunk = {
			id: `chatcmpl-mock-${requests.length}`,
			object: "chat.completion.chunk",
			created: 1,
			model: body.model,
			choices: [{ index: 0, delta: { content: reply }, finish_reason: null }],
		};
		const done = {
			...chunk,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
		};
		await new Promise((res) => setTimeout(res, 40));
		response.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`);
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
	const target = targets.find((item) => item.type === "page" && item.url.startsWith("app://"));
	if (!target) throw new Error("No Obsidian page.");

	socket = new WebSocket(target.webSocketDebuggerUrl);
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		const waiter = waiters.get(message.id);
		if (!waiter) return;
		waiters.delete(message.id);
		if (message.error) {
			waiter.reject(new Error(JSON.stringify(message.error)));
		} else {
			waiter.resolve(message.result);
		}
	});

	timer = setTimeout(() => {
		for (const waiter of waiters.values()) waiter.reject(new Error("Smoke timed out"));
		socket.close();
	}, 90000);

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
	const run = send("Runtime.evaluate", {
		expression: `(${runSmoke.toString()})(${JSON.stringify(root)},${JSON.stringify(endpoint)},${mobile},${observePluginNodeAccess.toString()})`,
		awaitPromise: true,
		returnByValue: true,
	});

	// Screenshot capturing loop while stages are reported
	const seenStages = new Set();
	while (true) {
		const checkStatus = await send("Runtime.evaluate", {
			expression: "window.__piemHoldStage || ''",
			returnByValue: true,
		});
		const stage = checkStatus.result?.value;
		if (stage && !seenStages.has(stage)) {
			seenStages.add(stage);
			const shot = await send("Page.captureScreenshot", { format: "png" });
			await writeFile(resolve(root, `proactive-${stage}.png`), Buffer.from(shot.data, "base64"));
			await send("Runtime.evaluate", {
				expression: "window.__piemHoldResolve && window.__piemHoldResolve()",
				awaitPromise: true,
			});
		}

		// Check if run finished
		const isRunning = await Promise.race([
			run.then(() => false),
			new Promise((res) => setTimeout(() => res(true), 250)),
		]);
		if (!isRunning) break;
	}

	const result = await run;
	if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
	const report = result.result.value;

	const artifact = await readFile(resolve(root, "vault/.obsidian/plugins/piem/main.js"));
	report.artifactSha256 = createHash("sha256").update(artifact).digest("hex");
	report.bytes = artifact.length;

	await send("Runtime.evaluate", {
		expression: "app.plugins.plugins.piem?.activateChatView(); [...document.querySelectorAll('.notice')].forEach(n => n.remove());",
		awaitPromise: true,
	});
	await new Promise((res) => setTimeout(res, 200));

	const finalShot = await send("Page.captureScreenshot", { format: "png" });
	await writeFile(resolve(root, mobile ? "proactive-mobile-final.png" : "proactive-desktop-final.png"), Buffer.from(finalShot.data, "base64"));

	const filename = mobile ? "proactive-mobile.json" : "proactive-desktop.json";
	await writeFile(resolve(root, filename), `${JSON.stringify(report, null, 2)}\n`);

	console.log(
		JSON.stringify({
			passed: report.passed,
			checks: report.checks?.length ?? 0,
			environment: report.environment,
			artifactSha256: report.artifactSha256,
			result: resolve(root, filename),
			failure: report.failure,
		}),
	);

	if (!report.passed) process.exitCode = 1;
} finally {
	clearTimeout(timer);
	socket?.close();
	server.closeAllConnections();
	await new Promise((res) => server.close(res));
}
