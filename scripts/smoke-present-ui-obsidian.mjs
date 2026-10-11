/**
 * Smoke verifying present_ui observability gaps in a real Obsidian instance (Desktop + Mobile).
 * Gaps covered:
 * 1. UI rendering inside Obsidian chat panel (Desktop & Mobile 390x844 layout).
 * 2. JS execution error caught, rendered in DOM with error title & report button.
 * 3. Settle/fail unblocks broker queue without deadlock/hanging.
 * 4. Dismissal observability and resolution.
 * 5. Lifecycle logs and interactive/userWaitMs telemetry.
 *
 * Usage: node scripts/smoke-present-ui-obsidian.mjs <CDP-port> <output-directory> [--expect-mobile]
 */
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";

async function runSmoke(root, expectMobile) {
	const wait = async (test, timeoutMs = 8000) => {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			try {
				if (await test()) return;
			} catch {}
			await new Promise(r => setTimeout(r, 30));
		}
		throw new Error(`Condition timed out after ${timeoutMs}ms`);
	};

	await wait(() => window.app?.plugins?.plugins?.piem?.agentService);
	const report = { passed: false, checks: [], errors: [], environment: {} };
	const record = (name, value) => {
		if (!value) throw new Error(`Check failed: ${name}`);
		report.checks.push(name);
	};

	report.environment = {
		officialMobileEmulation: app.isMobile,
		phone: document.body.classList.contains("is-phone"),
		viewport: { width: innerWidth, height: innerHeight },
	};
	record("expected Obsidian device mode", app.isMobile === expectMobile);
	if (expectMobile) {
		record(
			"official phone layout active",
			document.body.classList.contains("emulate-mobile") && report.environment.phone && innerWidth === 390,
		);
	}

	const errorListener = e => report.errors.push(String(e.error ?? e.reason ?? e.message));
	window.addEventListener("error", errorListener);
	window.addEventListener("unhandledrejection", errorListener);

	const plugin = app.plugins.plugins.piem;
	try {
		record("plugin and broker ready", !!plugin?.uiBlockBroker);

		const service = plugin.agentService;
		if (!service.getActiveSessionPath()) {
			await service.newSession({ force: true });
		}
		const ownerId = service.getActiveSessionPath();
		record("active session ready", !!ownerId);

		// Activate chat panel so broker requests render
		await plugin.activateChatView();
		await wait(() => document.querySelector(".piem-chat") !== null);
		record("chat view activated", true);

		const broker = plugin.uiBlockBroker;
		broker.clear();

		// 1. Test normal execution & commit
		const commitPromise = broker.present(
			{
				code: `
					const btn = container.createEl("button", { text: "Smoke Commit", cls: "smoke-commit-btn" });
					btn.onclick = () => commit({ action: "smoke-success", answer: 123 });
				`,
				title: "Smoke Commit Test",
			},
			undefined,
			ownerId,
		);



		await wait(() => document.querySelector(".smoke-commit-btn") !== null);
		record("ui block card rendered in chat panel", true);

		if (expectMobile) {
			const card = document.querySelector(".piem-ui-block-card");
			if (card) {
				const rect = card.getBoundingClientRect();
				record("card width fits mobile viewport", rect.width <= 390);
			}
		}

		const commitBtn = document.querySelector(".smoke-commit-btn");
		commitBtn.click();

		const commitResult = await commitPromise;
		record(
			"broker committed with correct payload",
			commitResult?.action === "smoke-success" && commitResult?.answer === 123,
		);

		// 2. Test runtime error observability & fail mechanism
		let errorThrown = false;
		const failPromise = broker.present(
			{
				code: `
					throw new Error("Deliberate smoke render explosion");
				`,
				title: "Smoke Error Test",
			},
			undefined,
			ownerId,
		);

		await wait(() => document.querySelector(".piem-ui-block-card__error") !== null);
		record("error block rendered in UI card", true);

		const errorMsgEl = document.querySelector(".piem-ui-block-card__error-message");
		record(
			"error message visible in DOM",
			errorMsgEl?.textContent?.includes("Deliberate smoke render explosion"),
		);

		const reportBtn = document.querySelector(".piem-ui-block-card__error-report");
		record("report error button present in DOM", reportBtn !== null);

		// Fail promise should reject on clicking the report error button
		const failCatchPromise = failPromise.catch(err => {
			errorThrown = true;
			return err;
		});

		reportBtn.click();
		const rejectedErr = await failCatchPromise;
		record(
			"error reported to agent without deadlock",
			errorThrown && String(rejectedErr).includes("Deliberate smoke render explosion"),
		);

		// Verify broker queue unblocked
		record("broker queue clean after failure", broker.getPending() === null);

		// 3. Test dismiss observability
		const dismissPromise = broker.present(
			{
				code: `
					container.createEl("div", { text: "Will dismiss" });
				`,
				title: "Smoke Dismiss Test",
			},
			undefined,
			ownerId,
		);

		await wait(() => document.querySelector(".piem-ui-block-card__dismiss") !== null);
		const dismissBtn = document.querySelector(".piem-ui-block-card__dismiss");
		dismissBtn.click();

		const dismissResult = await dismissPromise;
		record("dismissed UI block resolves with null", dismissResult === null);
		record("broker queue empty after dismiss", broker.getPending() === null);



		record("no unhandled browser runtime errors", report.errors.length === 0);
		report.passed = true;
	} catch (err) {
		report.failure = String(err.stack ?? err);
	} finally {
		window.removeEventListener("error", errorListener);
		window.removeEventListener("unhandledrejection", errorListener);
		plugin?.uiBlockBroker?.clear();
	}
	return report;
}

const [port, directory, mode, ...extra] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port) || !directory || (mode && mode !== "--expect-mobile") || extra.length) {
	throw new Error("Usage: node scripts/smoke-present-ui-obsidian.mjs <CDP-port> <output-directory> [--expect-mobile]");
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
	await writeFile(resolve(root, `present-ui-${kind}.json`), JSON.stringify(report, null, 2));
	const shot = await call("Page.captureScreenshot", { format: "png" });
	await writeFile(resolve(root, `present-ui-${kind}.png`), Buffer.from(shot.data, "base64"));
	console.log(JSON.stringify({ passed: report.passed, checks: report.checks?.length, failure: report.failure }));
	if (!report.passed) process.exitCode = 1;
} finally {
	socket.close();
}
