/**
 * Smoke verifying thinking level inheritance and model clamping in a real Obsidian instance.
 * Usage: node scripts/smoke-thinking-level-obsidian.mjs <CDP-port> <output-directory> [--expect-mobile]
 */
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";

async function runSmoke(root, expectMobile) {
	const wait = async test => {
		for (let i = 0; i < 200; i++) {
			if (await test()) return;
			await new Promise(r => setTimeout(r, 25));
		}
		throw new Error("Condition timed out");
	};

	await wait(() => window.app?.plugins?.plugins?.piem?.agentService);
	const report = { passed: false, checks: [], errors: [], environment: {} };
	const record = (name, value) => {
		if (!value) throw new Error(name);
		report.checks.push(name);
	};

	report.environment = {
		officialMobileEmulation: app.isMobile,
		phone: document.body.classList.contains("is-phone"),
		viewport: { width: innerWidth, height: innerHeight },
	};
	record("expected Obsidian device mode", app.isMobile === expectMobile);
	if (expectMobile) {
		record("official phone layout active", document.body.classList.contains("emulate-mobile") && report.environment.phone && innerWidth === 390);
	}

	const error = e => report.errors.push(String(e.error ?? e.reason ?? e.message));
	window.addEventListener("error", error);
	window.addEventListener("unhandledrejection", error);

	let plugin = app.plugins.plugins.piem;
	try {
		record("plugin and service ready", !!plugin?.agentService);

		// Seed settings with two models: reasoning model and non-reasoning model
		Object.assign(plugin.settings, {
			language: "en",
			networkTransport: "fetch",
			providers: [
				{
					id: "test-provider",
					name: "Test Provider",
					baseUrl: "http://127.0.0.1:9999/v1",
					protocol: "openai-completions",
					apiKey: "fixture-key",
					secretRef: "",
					source: "user",
					oauthFlow: "",
				},
			],
			models: [
				{
					id: "reasoning-model",
					providerId: "test-provider",
					modelApiId: "reasoning-model",
					displayName: "Reasoning Model",
					reasoning: true,
					supportsImages: false,
				},
				{
					id: "simple-model",
					providerId: "test-provider",
					modelApiId: "simple-model",
					displayName: "Simple Model",
					reasoning: false,
					supportsImages: false,
				},
			],
			activeModelId: "reasoning-model",
		});
		await plugin.saveSettings({ reconfigure: true });

		const service = plugin.agentService;
		const manager = plugin.sessionManager;

		// 1. Initial new session under reasoning model starts with default "off"
		await service.newSession({ force: true });
		const session1 = service.getActiveSessionPath();
		record("session1 created", !!session1);
		if (expectMobile) {
			record("mobile cold start inherited high from desktop pass", service.getSnapshot().thinkingLevel === "high");
		} else {
			record("desktop cold start defaulted to off for empty vault", service.getSnapshot().thinkingLevel === "off");
		}

		// 2. Set thinking level to "high"
		await service.setThinkingLevel("high");
		record("session1 level set to high", service.getSnapshot().thinkingLevel === "high");

		// Materialize session1 so it exists durably on disk
		await manager.materializeIfBlank(session1, {
			provider: "test-provider",
			modelId: "reasoning-model",
			thinkingLevel: "high",
		});
		await manager.appendMessageFor(session1, {
			role: "user",
			content: [{ type: "text", text: "Hello session 1" }],
			timestamp: Date.now(),
		});

		// 3. New session should inherit "high" from session1
		await service.newSession({ force: true });
		const session2 = service.getActiveSessionPath();
		record("session2 created", !!session2 && session2 !== session1);
		record("session2 inherited high thinking level", service.getSnapshot().thinkingLevel === "high");

		// 4. Set session2 to "medium" and materialize
		await service.setThinkingLevel("medium");
		await manager.materializeIfBlank(session2, {
			provider: "test-provider",
			modelId: "reasoning-model",
			thinkingLevel: "medium",
		});
		await manager.appendMessageFor(session2, {
			role: "user",
			content: [{ type: "text", text: "Hello session 2" }],
			timestamp: Date.now(),
		});

		// 5. Verify readThinkingLevelFor reads recorded levels correctly
		const s1Level = await manager.readThinkingLevelFor(session1);
		record("readThinkingLevelFor session1 is high", s1Level === "high");
		const s2Level = await manager.readThinkingLevelFor(session2);
		record("readThinkingLevelFor session2 is medium", s2Level === "medium");

		// 6. Switching active model to simple-model clamps active session2 to "off"
		plugin.settings.activeModelId = "simple-model";
		await plugin.saveSettings({ reconfigure: true });
		record("session2 clamped to off after model switch", service.getSnapshot().thinkingLevel === "off");

		// 7. New session under simple-model remains clamped to "off"
		await service.newSession({ force: true });
		const session3 = service.getActiveSessionPath();
		record("session3 created", !!session3 && session3 !== session2);
		record("session3 clamped thinking level to off for simple model", service.getSnapshot().thinkingLevel === "off");

		// 8. Switching back to reasoning-model and reopening session1 restores "high"
		plugin.settings.activeModelId = "reasoning-model";
		await plugin.saveSettings({ reconfigure: true });
		await service.openSession(session1);
		record("reopening session1 restores high thinking level", service.getSnapshot().thinkingLevel === "high");

		// 9. Creating a new session from session1 inherits "high" again
		await service.newSession({ force: true });
		const session4 = service.getActiveSessionPath();
		record("session4 inherited high from session1", service.getSnapshot().thinkingLevel === "high");

		record("no unhandled errors", report.errors.length === 0);
		report.passed = true;
	} catch (err) {
		report.failure = String(err.stack ?? err);
	} finally {
		window.removeEventListener("error", error);
		window.removeEventListener("unhandledrejection", error);
	}
	return report;
}

const [port, directory, mode, ...extra] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port) || !directory || (mode && mode !== "--expect-mobile") || extra.length) {
	throw new Error("Usage: node scripts/smoke-thinking-level-obsidian.mjs <CDP-port> <output-directory> [--expect-mobile]");
}
const expectMobile = mode === "--expect-mobile";
const root = resolve(directory);

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(t => t.type === "page" && t.url.startsWith("app://") && t.url.includes("index.html"));
if (!target) throw new Error("No Obsidian index.html target");

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let sequence = 0;
socket.addEventListener("message", event => {
	const reply = JSON.parse(event.data);
	const waiter = pending.get(reply.id);
	if (!waiter) return;
	pending.delete(reply.id);
	reply.error ? waiter.reject(new Error(JSON.stringify(reply.error))) : waiter.resolve(reply.result);
});
await new Promise((res, rej) => {
	socket.addEventListener("open", res, { once: true });
	socket.addEventListener("error", rej, { once: true });
});

const call = (method, params) =>
	new Promise((res, rej) => {
		const id = ++sequence;
		pending.set(id, { resolve: res, reject: rej });
		socket.send(JSON.stringify({ id, method, params }));
	});

try {
	const reply = await call("Runtime.evaluate", {
		expression: `(${runSmoke})(${JSON.stringify(root)}, ${expectMobile})`,
		awaitPromise: true,
		returnByValue: true,
	});
	const report = reply.exceptionDetails ? { passed: false, failure: reply.exceptionDetails.exception?.description } : reply.result.value;
	const kind = expectMobile ? "mobile" : "desktop";
	await writeFile(resolve(root, `thinking-level-${kind}.json`), JSON.stringify(report, null, 2));
	const shot = await call("Page.captureScreenshot", { format: "png" });
	await writeFile(resolve(root, `thinking-level-${kind}.png`), Buffer.from(shot.data, "base64"));
	console.log(JSON.stringify({ passed: report.passed, checks: report.checks?.length, failure: report.failure }));
	if (!report.passed) process.exitCode = 1;
} finally {
	socket.close();
}
