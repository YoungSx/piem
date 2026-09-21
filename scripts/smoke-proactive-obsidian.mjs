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
	// Progress goes to stderr: the launcher reads the last stdout line as the
	// report JSON, and a silent 3-minute pass is indistinguishable from a hang.
	const record = (name, value, detail) => {
		if (!value) throw new Error(detail ? `${name}: ${detail}` : name);
		// `console.log`, not `error`: the mobile pass's own audit hooks
		// `console.error` and would count this progress line as a failure.
		console.info(`[check] ${name}`);
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

	// Thirty seconds, not ten: the plugin's first onload parses a 2.3 MiB bundle
	// whose module graph is the whole pi runtime, and the launch path that gets
	// here may have just reloaded the window (the mobile-emulation switch does).
	// Ten seconds was measured against a warm app and reads as a product failure
	// when the rig is simply still cold.
	await wait(() => window.app?.plugins?.plugins?.piem?.agentService, 30000, "piem agentService ready");
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
		await wait(() => app.plugins.plugins.piem?.agentService, 30000, "reload agentService");
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
			// The renderer's own fetch, not `requestUrl`: this runtime's main process never
			// answers an Obsidian network request — even a dead port hangs instead of
			// erroring — so the smoke would spend its budget on a transport that is
			// dead in the rig alone. Fetch exercises the same model, prompt and parse.
			networkTransport: "fetch",
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

		// Instrumented before anything can observe a note: the panel's own seed and
		// the fixture loop both run observes, and a wrap installed later would miss
		// the very dispatch the scenario is about to assert on.
		const scout = service.getSilentScout();
		// The reload above re-created the service: its fresh scout has empty gates,
		// but the panel's seed may have already perceived a note before the pass
		// reaches scenario 0 — reset both gates so the scenario asserts on its own
		// dispatch, not the cooldown an earlier focus spent.
		scout.dispatchedAt.clear();
		scout.perceivedHash.clear();
		window.__scoutLog = [];
		window.__scoutWrapAt = `${Date.now() % 100000}`;
		const runner = scout.runPrefetch;
		scout.runPrefetch = async (request, signal) => {
			window.__scoutLog.push(`${Date.now() % 100000} ${request.notePath}`);
			return runner(request, signal);
		};
		const observeBound = scout.observe.bind(scout);
		window.__observeLog = [];
		scout.observe = (file, content, tags, onReady, timing) => {
			const verdict = observeBound(file, content, tags, onReady, timing);
			window.__observeLog.push(`${Date.now() % 100000} ${file.path} changed=${verdict}`);
			return verdict;
		};

		// The smoke owns its fixtures. A reused vault may hold none of them, and a
		// vault seeded on an earlier day holds a daily note the cadence branch no
		// longer recognises — neither is a product failure, so both are repaired
		// here rather than asserted about.
		const pad = (value) => String(value).padStart(2, "0");
		const today = new Date();
		const dailyPath = `Daily/${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}.md`;
		const fixtures = {
			"Notes/Contradictions.md":
				"# Release Notes\n\n启动预算写的是 50ms。\n\n## 性能\n\n启动预算是 200ms，我们轻松达标。\n\n移动端没有 Node 运行时，一切都在渲染进程里跑。\n\n参考：https://example.com/design-doc\n",
			"Tasks/Project-Roadmap.md":
				"# Project Roadmap\n\n- [ ] Ship the perception pipeline\n- [ ] Write the migration guide\n- [x] Draft the audit\n\n待验证：哈希门在长笔记上的碰撞概率。\n",
			"Code/Algorithm.md": "# Algorithm\n\n```ts\nexport function hashContent(content: string): string {\n\treturn content;\n}\n```\n",
			"Research/PriorDiscussion.md": "# 向量检索\n\n讨论过召回率评估，尚未补上数据。\n",
			[dailyPath]: "# 今日\n\n梳理感知链路的记录。\n",
		};
		const alreadyIndexed = async (path) => {
			const file = app.vault.getAbstractFileByPath(path);
			return Boolean(file) && app.metadataCache.getFileCache(file) !== null;
		};
		for (const [path, content] of Object.entries(fixtures)) {
			const existing = app.vault.getAbstractFileByPath(path);
			if (existing) {
				// A fixture left by an earlier run may not match this pass's copy —
				// the vault, not this script, would then decide what the scenarios
				// assert about. Overwrite on drift so the fixtures stay authoritative.
				const current = await app.vault.cachedRead(existing);
				if (current !== content) {
					await app.vault.modify(existing, content);
					await wait(() => alreadyIndexed(path), 15000, `waiting for re-index of ${path}`);
				}
				continue;
			}
			const slash = path.lastIndexOf("/");
			if (slash > 0 && !app.vault.getAbstractFileByPath(path.slice(0, slash))) {
				await app.vault.createFolder(path.slice(0, slash)).catch(() => undefined);
			}
			await app.vault.create(path, content);
			await wait(() => alreadyIndexed(path), 15000, `waiting for metadata cache of ${path}`);
		}

		const leaf = app.workspace.getLeaf(false);

		// --- Scenario 0: model-driven perception (Silent Scout) ---
		// The page cannot read the mock's counters, so both spend gates are
		// asserted as counts of what reached the endpoint.
		const scoutState = async () => (await (await fetch(`${endpoint}/scout`)).json());
		const scoutCount = async () => (await scoutState()).fixturePerceptions;

		const contradictionFile = app.vault.getAbstractFileByPath("Notes/Contradictions.md");
		await leaf.openFile(contradictionFile);
		app.workspace.setActiveLeaf(leaf, { focus: true });
		// The workspace events that drive this in production are delivered by the
		// host on its own schedule, which a headless rig does not guarantee within
		// the pass's budget — so the scenario calls the same entry point the events
		// call, and the event path is covered by the panel's own seed above.
		service.setActiveNotePath("Notes/Contradictions.md");
		// The workspace events that drive this in production are delivered by the
		// host on its own schedule, which a headless rig does not guarantee within
		// the pass's budget — so the scenario calls the same entry point the events
		// call, and the event path is covered by the panel's own seed above.
		service.setActiveNotePath("Notes/Contradictions.md");

		// The debounce is 1.5s, but a cold rig throttles timers: the count is read
		// inside the wait loop, so the 20s window covers a late dispatch too. A
		// perception that never reached the endpoint did not leave the plugin.
		const endpointState = await scoutState();
		const insight = service.getScoutInsight("Notes/Contradictions.md");
		let stagedCount = endpointState.fixturePerceptions;
		let scoutChips = [];
		await wait(async () => {
			scoutChips = [...document.querySelectorAll(".piem-chat__quick-action")].map((el) => el.textContent.trim());
			stagedCount = (await scoutState()).fixturePerceptions;
			return scoutChips.some((label) => label.includes("已就绪"));
		}, 20000, () => `expected a staged perception chip; endpoint=${JSON.stringify({ endpointState, stagedCount })}, runnerLog=${JSON.stringify(window.__scoutLog)}, observeLog=${JSON.stringify(window.__observeLog)}, timer=${scout.debounceTimer ?? "none"}, gates=${JSON.stringify({ dispatched: [...scout.dispatchedAt.entries()], perceived: [...scout.perceivedHash.entries()] })}, insights=${JSON.stringify(insight)}, chips: ${JSON.stringify(scoutChips)}`);
		record("perception stages a ready chip", scoutChips.some((label) => label.includes("[已就绪] 2 处矛盾")));
		report.stages.push({ stage: "scout-perception", chips: scoutChips });
		await holdForStage(expectMobile ? "mobile-scout" : "desktop-scout");

		record("perception reached the endpoint once", (await scoutCount()) === 1);

		// Gate 1: leaving and returning to an unchanged note must not bill again.
		await leaf.openFile(app.vault.getAbstractFileByPath("Tasks/Project-Roadmap.md"));
		app.workspace.setActiveLeaf(leaf, { focus: true });
		await new Promise((res) => setTimeout(res, 2500));
		await leaf.openFile(contradictionFile);
		app.workspace.setActiveLeaf(leaf, { focus: true });
		await new Promise((res) => setTimeout(res, 2500));
		record("an unchanged note is not perceived twice", (await scoutCount()) === 1);

		// Gate 2: even text that moved waits out the cooldown.
		await app.vault.append(contradictionFile, "\n\n另起一段。\n");
		await new Promise((res) => setTimeout(res, 2500));
		record("a changed note waits out the cooldown", (await scoutCount()) === 1);

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

		// --- Scenario 3: Daily note with today's date ---
		// The cadence rows differ by the wall clock (morning / afternoon / evening),
		// so the assertion is the *set* of chips those three rows can show rather
		// than one row: a generic connected-note row (改进这篇笔记, 头脑风暴) would
		// fail this, which is the point.
		const dailyFile = app.vault.getAbstractFileByPath(dailyPath);
		await leaf.openFile(dailyFile);
		app.workspace.setActiveLeaf(leaf, { focus: true });
		const cadenceChips = new Set(["晨间专注规划", "今日待办简报", "规划今日安排", "总结与复盘", "碎片整理归档"]);
		let dailySeen = [];
		await wait(() => {
			dailySeen = [...document.querySelectorAll(".piem-chat__quick-action")].map((el) => el.textContent.trim());
			return dailySeen.length === 3 && dailySeen.every((chip) => cadenceChips.has(chip));
		}, 10000, () => `expected a cadence-aware daily row, saw: ${JSON.stringify(dailySeen)}`);
		const dailyChips = [...document.querySelectorAll(".piem-chat__quick-action")].map((el) => el.textContent.trim());
		record("daily note offers cadence-aware chips", dailyChips.length === 3 && dailyChips.every((chip) => cadenceChips.has(chip)));
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
			return msgs.some((m) => m.role === "assistant" && m.stopReason !== "aborted");
		}, 20000, () => `expected an assistant reply, panelError=${service.getSnapshot().errorMessage ?? "none"}`);

		const finalMsgs = service.getSnapshot().messages;
		report.stages.push({
			stage: "completed-turn",
			userPrompt: finalMsgs.find((m) => m.role === "user")?.content?.[0]?.text,
			assistantReply: finalMsgs.find((m) => m.role === "assistant")?.content?.[0]?.text,
		});

		if (audit) {
			record("negative Node controls refused", audit.report.controls.length === 6 && audit.report.controls.every((item) => !item.provided));
			record("plugin only requests Obsidian", audit.report.requests.length > 0 && audit.report.requests.every((item) => item.id === "obsidian" && item.provided));
			report.nodeAccess = audit.report;
			const unexpected = audit.report.consoleErrors.filter((item) => !item.control);
			record("no unexpected console errors", unexpected.length === 0, JSON.stringify(unexpected.map((item) => item.message.slice(0, 200))));
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
/**
 * Perception requests that named the contradiction fixture, in arrival order.
 *
 * The page cannot read this process's memory, so the scout's two spend gates
 * are asserted as counts of what actually reached the endpoint.
 */
const fixturePerceptions = [];
await mkdir(root, { recursive: true });

/** `app://obsidian.md` is another origin, so the page's own fetch needs this header. */
const CORS = { "access-control-allow-origin": "*" };

/** Stable substring of the perception instruction, authored in `src/agent/scoutPerception.ts`. */
const PERCEPTION_MARKER = "looking for problems the author would want to know about";
const FIXTURE_NOTE = "Notes/Contradictions.md";

const server = createServer(async (request, response) => {
	try {
		if (request.method === "OPTIONS") {
			// The renderer's own fetch preflights every cross-origin POST.
			response.writeHead(204, { ...CORS, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, authorization" });
			response.end();
			return;
		}
		if (request.method === "GET" && request.url === "/scout") {
			// `total` and `sample` are diagnostics, not assertions: "the model was
			// never asked" and "the answer never arrived" look identical from the
			// page, and the pass needs to say which one happened.
			response.writeHead(200, { "content-type": "application/json", ...CORS });
			response.end(
				JSON.stringify({
					fixturePerceptions: fixturePerceptions.length,
					total: requests.length,
					sample: requests.slice(-2).map((body) => String(body.messages?.[0]?.content ?? "").slice(0, 120)),
				}),
			);
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
		requests.push(body);

		const promptText = JSON.stringify(body.messages ?? []);
		const requestPrompt = (body.messages ?? [])
			.map((message) => (typeof message.content === "string" ? message.content : ""))
			.join("\n");

		// Perception is checked before the suggestion branch: its instruction also
		// contains the words that branch looks for, and an `[]` answer there would
		// be read as a perception that found nothing.
		if (requestPrompt.includes(PERCEPTION_MARKER)) {
			if (requestPrompt.includes(FIXTURE_NOTE)) {
				fixturePerceptions.push(body);
			}
			// Only the contradiction fixture reports defects; every other note
			// answers empty, so the static-chip scenarios keep their rows.
			const content = requestPrompt.includes(FIXTURE_NOTE)
				? JSON.stringify([
						{
							label: "2 处矛盾",
							prompt: "修正启动预算与移动端 Node 权限这两处互相冲突的说法。",
							summary: "启动预算写了两遍，数字不同。",
						},
						{
							label: "缺 Frontmatter",
							prompt: "为这篇笔记补上 tags 与 updated 时间戳。",
							summary: "笔记没有 YAML frontmatter。",
						},
					])
				: "[]";
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...CORS });
			const chunk = {
				id: `chatcmpl-scout-${fixturePerceptions.length}`,
				object: "chat.completion.chunk",
				created: 1,
				model: body.model,
				choices: [{ index: 0, delta: { content }, finish_reason: null }],
			};
			const done = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
			response.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`);
			return;
		}

		// Quick actions suggestion query expects a JSON array or empty
		const isSuggestionQuery = promptText.includes("quick") || promptText.includes("suggestion") || body.messages?.some((m) => m.content?.includes("JSON array"));

		if (isSuggestionQuery) {
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...CORS });
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
	// `index.html` first, then any other `app://` page. Opening a vault from the
	// first-run starter leaves the starter's dead target listed ahead of the live
	// one, and a socket to it accepts the evaluate and never answers — the pass
	// then sits silent until the overall timer kills it, reading as a hang.
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
		if (message.error) {
			waiter.reject(new Error(JSON.stringify(message.error)));
		} else {
			waiter.resolve(message.result);
		}
	});

	timer = setTimeout(() => {
		for (const waiter of waiters.values()) waiter.reject(new Error("Smoke timed out"));
		socket.close();
	// Six scenarios, three of which wait out real debounce and cooldown windows;
	// 90 seconds measured the pass before the perception scenario existed and
	// fired mid-run, killing a healthy pass.
	}, 240000);

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
