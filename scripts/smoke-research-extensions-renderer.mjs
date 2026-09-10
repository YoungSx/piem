/** Serialized into the existing Obsidian renderer. No Node APIs run here. */
export async function runResearchSmoke(root, endpoint, token, expectMobile, observeNodeAccess, scenarios) {
	const report = { passed: false, checks: [], errors: [], scenarios: [], reloads: 0 };
	let cleaned = false, cleanupTask;
	const record = (name, value) => { if (!value) throw new Error(name); report.checks.push(name); };
	const wait = async (test, name = "Condition", timeout = 8000) => {
		const end = performance.now() + timeout;
		while (performance.now() < end) {
			if (cleaned) throw new Error("Smoke renderer was cancelled.");
			if (await test()) return;
			await new Promise(resolve => setTimeout(resolve, 20));
		}
		throw new Error(`${name} timed out`);
	};
	await wait(() => window.app?.plugins?.plugins?.piem?.agentService, "Piem loading");
	if (app.vault.adapter.getBasePath() !== `${root}/vault`) throw new Error("Use a disposable vault at <output-dir>/vault.");
	if (window.__piemResearchSmoke) throw new Error("Another research smoke still owns this renderer.");
	let plugin = app.plugins.plugins.piem, audit;
	const control = async (name, body) => {
		const response = await fetch(`${endpoint}/__smoke/${name}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { "x-smoke-control": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) throw new Error(`Fixture control ${name}: HTTP ${response.status}`);
		return response.json();
	};
	const error = event => report.errors.push(String(event.error ?? event.reason ?? event.message));
	const cleanup = () => cleanupTask ??= (async () => {
		cleaned = true;
		audit?.restore();
		window.removeEventListener("error", error); window.removeEventListener("unhandledrejection", error);
		let stopping = Promise.resolve([]);
		if (!report.passed) {
			const service = app.plugins.plugins.piem?.agentService;
			if (service) stopping = Promise.allSettled([...service.runtimes.keys()].map(path => service.abortSession(path)));
		}
		let heldRequestsReleased = false;
		try { await control("release-all", {}); heldRequestsReleased = true; }
		catch (cause) { report.errors.push(`Fixture cleanup: ${String(cause)}`); report.passed = false; }
		for (const result of await stopping) {
			if (result.status === "rejected") { report.errors.push(`Stop cleanup: ${String(result.reason)}`); report.passed = false; }
		}
		report.cleanup = { observersRestored: true, heldRequestsReleased };
		delete window.__piemResearchSmoke;
	})();
	window.__piemResearchSmoke = { report, cleanup };
	window.addEventListener("error", error); window.addEventListener("unhandledrejection", error);
	const reload = async () => {
		const previous = plugin.agentService;
		await app.plugins.unloadPlugin("piem"); await app.plugins.loadPlugin("piem");
		await wait(() => app.plugins.plugins.piem?.agentService, "Piem reload");
		plugin = app.plugins.plugins.piem; await plugin.agentService.initialize();
		await plugin.activateChatView(); report.reloads += 1;
		record(`reload ${report.reloads}: previous service released runtimes`, previous.runtimes.size === 0);
	};
	const idle = async (path = plugin.agentService.getActiveSessionPath(), service = plugin.agentService) => {
		await wait(() => {
			const rt = service.runtimes.get(path);
			return !!rt && !rt.agent?.state.isStreaming && !rt.isCompacting && !rt.compaction && !rt.retryInFlight
				&& !rt.branchSummaryController && !rt.promptPreparations && !rt.sessionRefreshing && !rt.sessionOperations
				&& !rt.extensionBusy && !rt.extensionCommand && !rt.activeRunContext && !rt.activeRunLedger && !rt.bookmarkWork && !rt.promptQueue.size
				&& !rt.steeredPrompts.length && !rt.compactionPending && !rt.queueInterrupt;
		}, "Conversation fully idle");
	};
	const configure = async (protocol = "openai-responses") => {
		Object.assign(plugin.settings, {
			language: "zh-cn", networkTransport: "requestUrl", mobileComposerCollapsed: false,
			providers: [{ id: "research-fixture", name: "Local research smoke", baseUrl: `${endpoint}/v1`, protocol, apiKey: "local-research-fixture-key", secretRef: "", source: "user", oauthFlow: "" }],
			models: [{ id: "research-model", providerId: "research-fixture", modelApiId: "research-model", displayName: "Research fixture", reasoning: false, supportsImages: false }],
			activeModelId: "research-model", showAgentDetails: true,
		});
		await plugin.saveSettings(); await plugin.agentService.newSession();
		await plugin.activateChatView();
		await wait(() => plugin.agentService.getSnapshot().isConfigured, "Fixture model configuration");
		await idle(); return plugin.agentService.getActiveSessionPath();
	};
	const textarea = () => document.querySelector(".piem-chat__composer textarea");
	const type = async text => {
		if (!textarea()) document.querySelector(".piem-chat__composer-toggle")?.click();
		await wait(textarea, "Composer textarea");
		textarea().focus();
		// Native setter bypasses React's value tracker, just like a real keystroke.
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(textarea(), text);
		textarea().dispatchEvent(new Event("input", { bubbles: true }));
		await wait(() => textarea()?.value === text, "Composer draft update");
		await new Promise(resolve => requestAnimationFrame(resolve));
	};
	const submit = async text => {
		await type(text);
		const button = document.querySelector(".piem-chat__send-button");
		if (!button || button.disabled) throw new Error("Composer send button unavailable");
		button.click();
	};
	const entries = path => plugin.sessionManager.getSessionFor(path).findEntriesOnBranch({ order: "oldestFirst" });
	const textOf = result => result?.content?.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";
	const harness = {
		report, record, wait, idle, control, configure, reload, textarea, type, submit, entries, textOf,
		settle: promise => Promise.resolve(promise).then(value => ({ value }), cause => ({ error: String(cause.stack ?? cause) })),
		get plugin() { return plugin; }, get service() { return plugin.agentService; },
		async plan(id, options) { await control("plan", { id, chat: [], ...options }); },
		async held(label) { await wait(async () => (await control("state")).gates.some(gate => gate.label === label && gate.entered), `Fixture gate ${label}`); },
		async release(label) { await control("release", { label }); },
		async requests(id, kind) { return (await control(`state?requests=1&plan=${encodeURIComponent(id)}${kind ? `&kind=${encodeURIComponent(kind)}` : ""}`)).requests; },
		async tool(prompt, name, args, id) {
			await control("plan", { id, chat: [{ tool: { name, args } }, { text: `已完成 ${name}。` }] });
			const path = plugin.agentService.getActiveSessionPath();
			record(`${id}: real prompt completes`, await plugin.agentService.sendPrompt(prompt)); await idle(path);
			const result = plugin.agentService.getSnapshot().messages.filter(message => message.role === "toolResult" && message.toolName === name).at(-1);
			record(`${id}: tool result persisted`, !!result && (await plugin.sessionManager.buildSessionContextFor(path)).messages.some(message => message.role === "toolResult" && message.toolCallId === result.toolCallId));
			return result;
		},
	};
	try {
		report.environment = { mobile: app.isMobile, phone: document.body.classList.contains("is-phone"), viewport: { width: innerWidth, height: innerHeight }, obsidian: document.title.match(/Obsidian ([0-9.]+)/)?.[1] };
		record("official device mode matches expectation", app.isMobile === expectMobile);
		if (expectMobile) record("official phone emulation at 390px", document.body.classList.contains("emulate-mobile") && report.environment.phone && innerWidth === 390);
		audit = expectMobile ? observeNodeAccess("piem") : undefined;
		await reload();
		for (const scenario of scenarios) {
			const started = performance.now(); await scenario(harness);
			report.scenarios.push({ name: scenario.name, durationMs: Math.round(performance.now() - started) });
		}
		if (audit) {
			report.nodeAccess = audit.report;
			record("six Node and Electron negative controls denied", audit.report.controls.length === 6 && audit.report.controls.every(item => !item.provided));
			record("plugin loader only provides Obsidian", audit.report.requests.length > 0 && audit.report.requests.every(item => item.id === "obsidian" && item.provided));
			record("every plugin reload audited", audit.report.evaluations === report.reloads);
			record("no unexpected console errors", audit.report.consoleErrors.every(item => item.control));
		}
		const fixture = await control("state");
		record("fixture has no protocol or plan errors", fixture.errors.length === 0);
		record("all held requests released", fixture.gates.every(gate => gate.released));
		record("no renderer errors or unhandled rejections", report.errors.length === 0);
		report.passed = true;
	} catch (cause) { report.failure = String(cause.stack ?? cause); }
	finally { await cleanup(); }
	return report;
}
