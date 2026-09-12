/** Real ChatApp + MarkdownRenderer in an already running disposable Obsidian.
 * Usage: node scripts/smoke-typography-obsidian.mjs <CDP-port> <output-dir> [--baseline]
 * The host must open <output-dir>/vault with the built plugin installed. No
 * model requests, app launch, copied Markdown DOM, or replacement content CSS.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async function prepare(root) {
	if (app.vault.adapter.getBasePath() !== `${root}/vault`) throw new Error("Use the exact disposable <output-dir>/vault.");
	if (window.__piemTypographySmoke) throw new Error("Another typography smoke owns this renderer.");
	const plugin = app.plugins.plugins.piem, service = plugin?.agentService, manager = plugin?.sessionManager;
	if (!service || !manager) throw new Error("The installed Piem plugin is not ready.");
	const errors = [], timers = new Map(), frames = new Map(), restores = [];
	let closed = false, cleanupTask, path, oldPath, leaf, panel, messages, initialRuntimes;
	const originalLeaves = new Set(app.workspace.getLeavesOfType("piem-chat-view"));
	const onError = event => errors.push(String(event.error ?? event.reason ?? event.message));
	const delay = ms => new Promise((resolve, reject) => {
		if (closed) { reject(new Error("Typography smoke cancelled.")); return; }
		const id = window.setTimeout(() => { timers.delete(id); resolve(); }, ms);
		timers.set(id, reject);
	});
	const wait = async predicate => {
		const end = performance.now() + 8000;
		while (true) {
			if (closed) throw new Error("Typography smoke cancelled.");
			if (await predicate()) return;
			if (performance.now() >= end) throw new Error("Typography fixture did not become ready.");
			await delay(25);
		}
	};
	const paint = async () => {
		await document.fonts.ready;
		for (let frame = 0; frame < 2; frame++) await new Promise((resolve, reject) => {
			if (closed) { reject(new Error("Typography smoke cancelled.")); return; }
			const id = requestAnimationFrame(() => { frames.delete(id); resolve(); }); frames.set(id, reject);
		});
	};
	const rememberStyle = element => {
		const original = element.getAttribute("style");
		restores.push(() => original === null ? element.removeAttribute("style") : element.setAttribute("style", original));
	};
	const wasLight = document.body.classList.contains("theme-light"), wasDark = document.body.classList.contains("theme-dark");
	const language = plugin.settings.language;
	rememberStyle(document.body);
	restores.push(() => { document.body.classList.toggle("theme-light", wasLight); document.body.classList.toggle("theme-dark", wasDark); plugin.settings.language = language; });
	window.addEventListener("error", onError); window.addEventListener("unhandledrejection", onError);
	const cleanup = () => cleanupTask ??= (async () => {
		closed = true;
		for (const [id, reject] of timers) { window.clearTimeout(id); reject(new Error("Typography smoke cleaned up.")); }
		for (const [id, reject] of frames) { cancelAnimationFrame(id); reject(new Error("Typography smoke cleaned up.")); }
		timers.clear(); frames.clear(); window.clearTimeout(deadline);
		for (const restore of restores.reverse()) { try { restore(); } catch (error) { errors.push(`Restore: ${String(error)}`); } }
		try { if (oldPath && service.getActiveSessionPath() !== oldPath) await service.openSession(oldPath); }
		catch (error) { errors.push(`Restore session: ${String(error)}`); }
		if (path && !initialRuntimes?.has(path)) {
			const runtime = service.runtimes.get(path);
			try { if (runtime) { const host = runtime.communityHost; service.removeRuntime(runtime); await host?.closed(); } }
			catch (error) { errors.push(`Release fixture: ${String(error)}`); }
		}
		for (const current of app.workspace.getLeavesOfType("piem-chat-view")) {
			try { if (!originalLeaves.has(current)) current.detach(); } catch (error) { errors.push(`Close fixture leaf: ${String(error)}`); }
		}
		window.removeEventListener("error", onError); window.removeEventListener("unhandledrejection", onError);
		delete window.__piemTypographySmoke;
		return { errors, timers: timers.size, frames: frames.size, fixtureRuntimeReleased: !path || !service.runtimes.has(path), settingsRestored: plugin.settings.language === language, sessionRestored: !oldPath || service.getActiveSessionPath() === oldPath };
	})();
	const deadline = window.setTimeout(() => { void cleanup().catch(error => errors.push(String(error))); }, 120000);
	window.__piemTypographySmoke = { cleanup, errors };
	try {
		await service.initialize(); if (closed) throw new Error("Typography smoke cancelled.");
		oldPath = service.getActiveSessionPath(); initialRuntimes = new Set(service.runtimes.keys());
		plugin.settings.language = "zh-cn";
		const note = `Piem-typography-${Date.now()}`, missing = `${note}-missing`;
		await app.vault.create(`${note}.md`, "# 排版验证资料\n\n这是可删除的排版样例笔记，不含用户资料。\n");
		await wait(() => app.metadataCache.getFirstLinkpathDest(note, "") !== null);
		const defaults = { provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "off" };
		path = (await manager.createSession(defaults)).path;
		const text = text => ({ type: "text", text });
		const thinking = thinking => ({ type: "thinking", thinking });
		const assistant = content => ({ role: "assistant", content, timestamp: Date.now(), api: "anthropic-messages", provider: defaults.provider,
			model: defaults.modelId, stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
		const token = "a".repeat(96);
		const prose = [
			"## 中文正文与混排",
			"正文一：评价标准按性能、协议转换兼容性和使用体验排序。OpenRouter 与 Bifrost 的差别需要结合实际负载理解。段落稍长时，读者仍应很容易找到下一行，不必靠手指沿着屏幕寻找刚才读到的位置。",
			"正文二：先保留原始资料，再核对 OpenAI / Anthropic / Gemini 的接口行为。启用 `is_byok_only` 后观察 `send_back_raw_response`，再添加 `complexity_tier == \"COMPLEX\"` 规则。英文、中文与代码应该排在同一条清楚的阅读节奏里。",
			"1. **先测性能**：用真实请求核对首字延迟、错误率和峰值负载；长列表项换行后仍要看得出它属于哪一个编号。\n2. **再查兼容**：检查工具调用与流式响应，保留可以复现的参数。\n   - 嵌套条目：读完这一项应能顺着缩进找到下一项。\n   - 嵌套条目：检查同一段中的 `base_url`。\n3. **最后比较使用体验**：模型切换和故障定位应当清楚。",
			`长标识符必须完整可读：\`${token}\`。不要让它把整列聊天拖宽。`,
		].join("\n\n");
		const constructs = [
			"## 松列表与宽内容",
			"- 第一项包含独立段落，检查 Markdown 松列表的真实段距。\n\n  这一段仍属于第一项，不能误读成新的列表项。\n\n- 第二项用来观察列表项之间的停顿。",
			"代码里的列必须完整保留，宽内容可以在自己的框里横向滚动：",
			`\`\`\`js\nconst value = "${token}";\nexport async function compareProtocolResponse(provider, request, options, compatibility, observations, expectedStatus, performanceBudget) { return { provider, request, options, compatibility, observations, expectedStatus, performanceBudget }; }\n\`\`\``,
			`| 提供商 | 请求标识 | 结果 |\n| --- | --- | --- |\n| Bifrost | ${token} | 协议转换兼容 |`,
			`现存笔记 [[${note}]] 与尚不存在的 [[${missing}]] 应保留可区分的链接标记。`,
		].join("\n\n");
		await manager.appendMessageFor(path, { role: "user", content: [text("请比较这些资料，先说明性能，再核对兼容性。")], timestamp: Date.now() });
		await manager.appendMessageFor(path, assistant([thinking("先核对问题。"), text(prose), thinking("正在核对资料。"), { type: "toolCall", id: "typography-read", name: "read", arguments: { path: `${note}.md` } }]));
		await manager.appendMessageFor(path, { role: "toolResult", toolCallId: "typography-read", toolName: "read", content: [text("排版验证资料读取完成。")], isError: false, timestamp: Date.now() });
		await manager.appendMessageFor(path, assistant([thinking("资料已经核对。"), text(constructs), thinking("整理最后的结论。") ]));
		await manager.appendMessageFor(path, assistant([text("结论：先测性能，再核对协议转换，保留原始资料和复现参数。") ]));
		await service.openSession(path); await plugin.activateChatView();
		await wait(() => document.querySelector(".piem-chat__messages")?.textContent.includes(missing));
		leaf = app.workspace.getLeavesOfType("piem-chat-view")[0]; panel = leaf.view.containerEl.querySelector(".piem-chat"); messages = panel.querySelector(".piem-chat__messages");
		const split = app.workspace.rightSplit, shell = split?.containerEl?.contains(panel) ? split.containerEl : panel.closest(".workspace-leaf");
		rememberStyle(shell);
		const originalSize = typeof split?.size === "number" ? split.size : split?.containerEl?.getBoundingClientRect().width;
		if (typeof originalSize === "number" && typeof split.setSize === "function") restores.push(() => split.setSize(originalSize));
		const properties = ["--font-ui-medium", "--line-height-normal", "--p-spacing", "--list-spacing", "--font-monospace"];
		const originalTokens = properties.map(name => [name, document.body.style.getPropertyValue(name), document.body.style.getPropertyPriority(name)]);
		const baseFont = parseFloat(getComputedStyle(panel.querySelector(".piem-chat__message-content")).fontSize);
		const resetTokens = () => { for (const [name, value, priority] of originalTokens) value ? document.body.style.setProperty(name, value, priority) : document.body.style.removeProperty(name); };
		const configure = async scenario => {
			if (closed) throw new Error("Typography smoke cancelled.");
			resetTokens(); document.body.classList.toggle("theme-light", scenario.theme === "light"); document.body.classList.toggle("theme-dark", scenario.theme === "dark");
			if (scenario.scale) document.body.style.setProperty("--font-ui-medium", `${baseFont * scenario.scale}px`);
			for (const [name, value] of Object.entries(scenario.tokens ?? {})) document.body.style.setProperty(name, value);
			// Only the genuine host container's size changes; content styles stay shipped.
			for (let attempt = 0; attempt < 3; attempt++) {
				const wanted = shell.getBoundingClientRect().width + scenario.width - panel.getBoundingClientRect().width;
				if (shell === split?.containerEl && typeof split.setSize === "function") split.setSize(wanted);
				else { shell.style.width = `${wanted}px`; shell.style.flex = "none"; shell.style.maxWidth = "none"; }
				leaf.onResize(); await paint();
				if (Math.abs(panel.getBoundingClientRect().width - scenario.width) <= 1) break;
			}
			return measure();
		};
		const box = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
		const typography = element => {
			const s = getComputedStyle(element);
			return { font: s.fontFamily, fontSize: parseFloat(s.fontSize), lineHeight: parseFloat(s.lineHeight), marginTop: parseFloat(s.marginTop), marginBottom: parseFloat(s.marginBottom), paddingTop: parseFloat(s.paddingTop), paddingBottom: parseFloat(s.paddingBottom), whiteSpace: s.whiteSpace,
				tokens: Object.fromEntries(properties.slice(1).map(name => [name, s.getPropertyValue(name).trim()])) };
		};
		const scrollBox = element => {
			const old = element.scrollLeft; element.scrollLeft = element.scrollWidth; const reachable = element.scrollLeft; element.scrollLeft = old;
			return { ...box(element), clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, overflowX: getComputedStyle(element).overflowX, reachable };
		};
		const measure = () => {
			const roots = [...messages.querySelectorAll(".piem-chat__message-content > .piem-chat__markdown")];
			const body = roots.find(element => element.textContent.includes("正文一"));
			const paragraphs = [...body.querySelectorAll(":scope > p")].slice(0, 2), list = body.querySelector("ol"), inline = body.querySelector("p code");
			const pre = messages.querySelector(".piem-chat__markdown pre"), code = pre.querySelector("code"), range = document.createRange(); range.selectNodeContents(code);
			const lineTops = [...new Set([...range.getClientRects()].filter(r => r.height > 0).map(r => Math.round(r.top * 10) / 10))];
			const nodes = [...messages.querySelectorAll(".piem-chat__message-content > .piem-chat__text--prose, .piem-chat__trace")]
				.filter(element => !element.closest(".piem-chat__message--user") && element.getClientRects().length && !element.parentElement.closest(".piem-chat__trace"));
			const rhythm = nodes.slice(1).map((to, i) => {
				const from = nodes[i], isPill = element => element.classList.contains("piem-chat__trace");
				return { from: isPill(from) ? "pill" : "prose", to: isPill(to) ? "pill" : "prose", acrossMessage: from.closest(".piem-chat__message") !== to.closest(".piem-chat__message"), gap: to.getBoundingClientRect().top - from.getBoundingClientRect().bottom };
			});
			return { panel: box(panel), viewport: { width: innerWidth, height: innerHeight }, messages: scrollBox(messages), body: { ...typography(body), ...scrollBox(body) },
				prose: roots.map(element => ({ nativeClass: element.classList.contains("markdown-rendered"), ...typography(element) })),
				paragraphs: paragraphs.map(element => ({ ...typography(element), ...box(element) })), paragraphGap: paragraphs[1].getBoundingClientRect().top - paragraphs[0].getBoundingClientRect().bottom,
				list: [...list.children].map(element => ({ ...typography(element), ...box(element) })), inline: typography(inline),
				pre: { ...scrollBox(pre), ...typography(pre) }, code: { ...typography(code), sourceLines: code.textContent.trimEnd().split("\n").length, renderedLineTops: lineTops },
				table: scrollBox(messages.querySelector(".piem-chat__markdown table")),
				links: [...messages.querySelectorAll("a.internal-link")].map(element => ({ text: element.textContent, unresolved: element.classList.contains("is-unresolved"), opacity: getComputedStyle(element).opacity, color: getComputedStyle(element).color, decorationColor: getComputedStyle(element).textDecorationColor, decorationStyle: getComputedStyle(element).textDecorationStyle, filter: getComputedStyle(element).filter })), rhythm, errors: [...errors] };
		};
		const scroll = async region => {
			const anchor = region === "prose" ? messages.firstElementChild : region === "rhythm" ? [...messages.querySelectorAll(".piem-chat__trace")][1] : messages.querySelector(".piem-chat__markdown pre");
			messages.scrollTop += anchor.getBoundingClientRect().top - messages.getBoundingClientRect().top;
			await paint(); return box(panel);
		};
		Object.assign(window.__piemTypographySmoke, { configure, scroll, measure });
		await paint();
		return { path, note: `${note}.md`, version: plugin.manifest.version, host: document.title, mobileEmulation: app.isMobile, baseFont,
			sizing: shell === split?.containerEl && typeof split.setSize === "function" ? "native rightSplit.setSize, corrected to measured panel width" : "real workspace-leaf width override; content untouched" };
	} catch (error) { await cleanup(); throw error; }
}

const [port, directory, mode, ...extra] = process.argv.slice(2);
if (!/^\d+$/.test(port ?? "") || Number(port) < 1 || Number(port) > 65535 || !directory || mode && mode !== "--baseline" || extra.length) throw new Error("Usage: node scripts/smoke-typography-obsidian.mjs <CDP-port> <output-dir> [--baseline]");
const root = resolve(directory), baseline = mode === "--baseline", stem = baseline ? "typography-baseline" : "typography";
const report = { passed: false, baseline, checks: [], failures: [], scenarios: [], artifacts: {}, rendererErrors: [] }, pending = new Map();
let socket, sequence = 0, interrupted = false;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const send = (method, params = {}, timeout = 15000) => new Promise((resolve, reject) => {
	if (socket?.readyState !== WebSocket.OPEN) { reject(new Error(`CDP disconnected: ${method}`)); return; }
	const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeout);
	pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression, timeout) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeout);
	if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
	return result.result.value;
};
const stop = () => { interrupted = true; for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Typography smoke interrupted.")); } pending.clear(); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
const check = (name, ok) => { (ok ? report.checks : report.failures).push(name); };
const family = value => value.replace(/["'\s]/g, "").toLowerCase();
const length = (value, font) => value.endsWith("px") ? parseFloat(value) : parseFloat(value) * font;
try {
	await mkdir(root, { recursive: true });
	for (const name of ["main.js", "manifest.json", "styles.css"]) {
		const installed = await readFile(resolve(root, "vault/.obsidian/plugins/piem", name));
		const built = await readFile(new URL(`../${name}`, import.meta.url));
		report.artifacts[name] = { sha256: sha(installed), checkoutSha256: sha(built), bytes: installed.length };
		if (!baseline && sha(installed) !== sha(built)) throw new Error(`Installed ${name} differs from this checkout; install the final artifact first.`);
	}
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
	const target = targets.find(item => item.type === "page" && item.url.startsWith("app://"));
	if (!target) throw new Error("No Obsidian page at this CDP port.");
	socket = new WebSocket(target.webSocketDebuggerUrl);
	socket.addEventListener("message", event => {
		const reply = JSON.parse(event.data), entry = pending.get(reply.id);
		if (reply.method === "Runtime.consoleAPICalled" && reply.params.type === "error") report.rendererErrors.push(reply.params.args.map(arg => arg.value ?? arg.description).join(" "));
		if (reply.method === "Runtime.exceptionThrown") report.rendererErrors.push(reply.params.exceptionDetails.exception?.description ?? reply.params.exceptionDetails.text);
		if (!entry) return;
		pending.delete(reply.id); clearTimeout(entry.timer);
		reply.error ? entry.reject(new Error(JSON.stringify(reply.error))) : entry.resolve(reply.result);
	});
	socket.addEventListener("close", () => { if (pending.size) stop(); });
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("CDP connection timed out.")), 5000);
		socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
		socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP connection failed.")); }, { once: true });
	});
	await send("Runtime.enable");
	report.fixture = await evaluate(`(${prepare.toString()})(${JSON.stringify(root)})`, 40000);
	const scenarios = [300, 390, 560].flatMap(width => ["light", "dark"].map(theme => ({ name: `${width}-${theme}`, width, theme })));
	scenarios.push({ name: "390-light-text-200", width: 390, theme: "light", scale: 2 }, { name: "390-dark-native-tokens", width: 390, theme: "dark", tokens: { "--line-height-normal": "1.9", "--p-spacing": "1.6em", "--list-spacing": "0.45em", "--font-monospace": '"Courier New", monospace' } });
	for (const scenario of scenarios) {
		if (interrupted) throw new Error("Typography smoke interrupted.");
		const metrics = await evaluate(`window.__piemTypographySmoke.configure(${JSON.stringify(scenario)})`);
		const item = { ...scenario, metrics, screenshots: [] }; report.scenarios.push(item);
		check(`${scenario.name}: measured panel width`, Math.abs(metrics.panel.width - scenario.width) <= 1);
		check(`${scenario.name}: no renderer errors`, metrics.errors.length === 0);
		check(`${scenario.name}: pill/prose boundaries actually measured`, [true, false].every(acrossMessage => metrics.rhythm.some(pair => pair.from === "pill" && pair.to === "pill" && pair.acrossMessage === acrossMessage) && metrics.rhythm.some(pair => pair.from === "pill" && pair.to === "prose" && pair.acrossMessage === acrossMessage)));
		if (!baseline) {
			check(`${scenario.name}: native Markdown class`, metrics.prose.every(p => p.nativeClass));
			check(`${scenario.name}: process and prose spacing follows visible roles`, metrics.rhythm.every(pair => Math.abs(pair.gap - (pair.from === "pill" && pair.to === "pill" ? 4 : 8)) < .5));
			check(`${scenario.name}: native prose leading`, metrics.prose.every(p => Math.abs(p.lineHeight - length(p.tokens["--line-height-normal"], p.fontSize)) < .2));
			check(`${scenario.name}: paragraph breathing room`, metrics.paragraphGap > metrics.body.fontSize * .4);
			check(`${scenario.name}: list spacing`, metrics.list.every(li => li.paddingTop + li.paddingBottom > 0));
			check(`${scenario.name}: native inline code family`, family(metrics.inline.font) === family(metrics.body.tokens["--font-monospace"]));
			check(`${scenario.name}: no horizontal prose overflow`, metrics.messages.scrollWidth <= metrics.messages.clientWidth + 1 && metrics.body.scrollWidth <= metrics.body.clientWidth + 1);
			check(`${scenario.name}: code scroll remains reachable`, metrics.pre.reachable > 0 && ["auto", "scroll"].includes(metrics.pre.overflowX));
			check(`${scenario.name}: highlighted source lines stay intact`, metrics.pre.whiteSpace === "pre" && metrics.code.whiteSpace === "pre" && metrics.code.renderedLineTops.length === metrics.code.sourceLines);
			check(`${scenario.name}: wide table scroll remains reachable`, metrics.table.scrollWidth > metrics.table.clientWidth && metrics.table.reachable > 0);
			check(`${scenario.name}: unresolved links stay opaque`, metrics.links.some(link => link.unresolved) && metrics.links.filter(link => link.unresolved).every(link => link.opacity === "1") && metrics.links.some(link => !link.unresolved));
			check(`${scenario.name}: unresolved mark retains contrast`, metrics.links.filter(link => link.unresolved).every(link => link.filter === "none" && link.decorationColor === link.color && link.decorationStyle === "dashed"));
			if (scenario.scale) check(`${scenario.name}: text really doubles`, Math.abs(metrics.body.fontSize - report.fixture.baseFont * 2) < .2);
			if (scenario.tokens) {
				check(`${scenario.name}: paragraph token is inherited`, Math.abs(metrics.paragraphs[0].marginBottom - 1.6 * metrics.body.fontSize) < .2);
				check(`${scenario.name}: list token is inherited`, metrics.list.every(li => Math.abs(li.paddingTop - .45 * li.fontSize) < .2 && Math.abs(li.paddingBottom - .45 * li.fontSize) < .2));
			}
		}
		for (const region of ["prose", "rhythm", "constructs"]) {
			await evaluate(`window.__piemTypographySmoke.scroll(${JSON.stringify(region)})`);
			const shot = await send("Page.captureScreenshot", { format: "png" });
			const name = `${stem}-${scenario.name}-${region}.png`; await writeFile(resolve(root, name), Buffer.from(shot.data, "base64")); item.screenshots.push(name);
		}
	}
} catch (error) { report.failures.push(String(error.stack ?? error)); }
finally {
	try { report.cleanup = await evaluate("window.__piemTypographySmoke?.cleanup()", 15000); if (report.cleanup) check("renderer resources cleaned", report.cleanup.timers === 0 && report.cleanup.frames === 0 && report.cleanup.fixtureRuntimeReleased && report.cleanup.settingsRestored && report.cleanup.sessionRestored && report.cleanup.errors.length === 0); }
	catch (error) { report.failures.push(`Cleanup: ${String(error)}`); }
	for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("CDP closed.")); } pending.clear(); socket?.close();
	process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
	for (const [name, artifact] of Object.entries(report.artifacts)) {
		try { check(`${name}: installed artifact stayed unchanged`, sha(await readFile(resolve(root, "vault/.obsidian/plugins/piem", name))) === artifact.sha256); }
		catch (error) { report.failures.push(String(error)); }
	}
	check("no renderer exceptions or console errors", report.rendererErrors.length === 0);
	report.passed = report.failures.length === 0 && report.scenarios.length === 8;
	await writeFile(resolve(root, `${stem}.json`), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures, report: resolve(root, `${stem}.json`) }));
if (!report.passed) process.exitCode = 1;
