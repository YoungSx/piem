/**
 * Smoke for `present_ui`'s lifecycle in a real Obsidian instance (desktop + official mobile).
 *
 * What this exists to catch, which no happy-dom test can: the view is rendered
 * by the real panel, its script runs in the real Electron realm against the real
 * `obsidian` module, and the two channels have to reach a real agent service.
 *
 * Covered:
 * 1. A view mounts and the tool call returns while it stays on screen.
 * 2. A second view opens without waiting behind the first.
 * 3. `ui.sendMessage` reaches the owning conversation as a new turn.
 * 4. `ui.update` records state for the next turn and wakes nobody.
 * 5. `ui.state` is handed back across a remount.
 * 6. A script that throws is reported, with its error visible and reportable.
 * 7. `ui.close` and the card's own button both end the view.
 * 8. A delivered view survives the presenting run's abort.
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

	await wait(() => window.app?.plugins?.plugins?.piem?.agentService, 90_000);
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

		await plugin.activateChatView();
		await wait(() => document.querySelector(".piem-chat") !== null);
		record("chat view activated", true);

		const broker = plugin.uiBlockBroker;
		broker.clear();

		// 1. A view mounts, the call returns, the view stays.
		const firstCall = broker.present(
			{
				code: `
					container.createEl("button", { text: "Send", cls: "smoke-send-btn" })
						.onclick = () => ui.sendMessage({ action: "smoke-send", answer: 123 });
					container.createEl("button", { text: "Update", cls: "smoke-update-btn" })
						.onclick = () => ui.update({ filter: "smoke-open" });
					container.createEl("button", { text: "Close", cls: "smoke-close-btn" })
						.onclick = () => ui.close();
					container.createEl("div", { cls: "smoke-state", text: String(ui.state && ui.state.filter) });
				`,
				title: "Smoke Panel",
			},
			undefined,
			ownerId,
		);

		await wait(() => document.querySelector(".smoke-send-btn") !== null);
		record("view rendered in chat panel", true);

		const firstDelivery = await firstCall;
		record("call returned on mount", firstDelivery?.delivered === true && !!firstDelivery.id);
		record("view still on screen after the call returned", document.querySelector(".smoke-send-btn") !== null);
		record("broker still holds the view", broker.getLive(ownerId).length === 1);

		if (expectMobile) {
			const card = document.querySelector(".piem-ui-block-card");
			record("card width fits mobile viewport", card.getBoundingClientRect().width <= 390);
		}

		// 2. A second view does not queue behind the first.
		const secondCall = broker.present(
			{ code: `container.createEl("div", { cls: "smoke-second", text: "Second" });`, title: "Second Panel" },
			undefined,
			ownerId,
		);
		await wait(() => document.querySelector(".smoke-second") !== null);
		const secondDelivery = await secondCall;
		record("second view opened without waiting", secondDelivery?.delivered === true);
		record("both views live at once", broker.getLive(ownerId).length === 2);
		broker.close(secondDelivery.id);
		await wait(() => document.querySelector(".smoke-second") === null);

		// 3. `ui.update` records state and wakes nobody.
		const messagesBeforeUpdate = service.getSnapshot().messages.length;
		document.querySelector(".smoke-update-btn").click();
		await wait(() => broker.getState(firstDelivery.id)?.filter === "smoke-open");
		record("update stored state for the next turn", true);
		record(
			"update started no turn",
			service.getSnapshot().messages.length === messagesBeforeUpdate && !service.getSnapshot().isStreaming,
		);
		const context = broker.getContext(ownerId);
		record(
			"state reaches the context block",
			context.some(entry => entry.title === "Smoke Panel" && entry.state.filter === "smoke-open"),
		);

		// 4. State survives a remount, which is what reopening the panel costs.
		const leaves = app.workspace.getLeavesOfType("piem-chat-view");
		leaves.forEach(leaf => leaf.detach());
		await wait(() => document.querySelector(".piem-chat") === null);
		await plugin.activateChatView();
		await wait(() => document.querySelector(".smoke-state") !== null);
		record(
			"script received its state back on remount",
			document.querySelector(".smoke-state")?.textContent === "smoke-open",
		);
		record("view survived the panel closing", broker.getLive(ownerId).length === 1);

		// 5. `ui.sendMessage` reaches the owning conversation as a new turn.
		document.querySelector(".smoke-send-btn").click();
		await wait(() => {
			const messages = service.getSnapshot().messages;
			return messages.some(
				message =>
					message.role === "user" &&
					JSON.stringify(message.content ?? "").includes("smoke-send"),
			);
		}, 15_000);
		record("sendMessage arrived as a new turn in the owning conversation", true);
		record("view survived its own message", broker.getLive(ownerId).length === 1);

		// 6. `ui.close` ends it.
		document.querySelector(".smoke-close-btn").click();
		await wait(() => broker.getLive(ownerId).length === 0);
		record("script-initiated close removed the view", document.querySelector(".smoke-send-btn") === null);

		// 7. A script that throws is reported and reportable.
		const failing = broker.present(
			{ code: `throw new Error("Deliberate smoke render explosion");`, title: "Smoke Error" },
			undefined,
			ownerId,
		);
		const failure = failing.then(() => null, error => error);
		await wait(() => document.querySelector(".piem-ui-block-card__error") !== null);
		record(
			"error visible in the card",
			document
				.querySelector(".piem-ui-block-card__error-message")
				?.textContent?.includes("Deliberate smoke render explosion"),
		);
		const reportBtn = document.querySelector(".piem-ui-block-card__error-report");
		record("report button present", reportBtn !== null);
		reportBtn.click();
		const reported = await failure;
		record(
			"failure reached the agent without deadlock",
			String(reported).includes("Deliberate smoke render explosion"),
		);
		record("broker clean after failure", broker.getLive(ownerId).length === 0);

		// 8. A delivered view survives the presenting run's abort. This is the
		//    regression the old coupling guaranteed: the call returns, its run
		//    ends, and the signal used to tear the card off the screen — which
		//    inside `codemode` fired on a two-minute deadline.
		const controller = new AbortController();
		const abortable = broker.present(
			{ code: `container.createEl("div", { cls: "smoke-survivor", text: "Still here" });`, title: "Survivor" },
			controller.signal,
			ownerId,
		);
		await wait(() => document.querySelector(".smoke-survivor") !== null);
		const survivorDelivery = await abortable;
		controller.abort();
		await new Promise(r => setTimeout(r, 200));
		record("delivered view survived the run's abort", broker.getLive(ownerId).length === 1);
		record("survivor still on screen", document.querySelector(".smoke-survivor") !== null);
		broker.close(survivorDelivery.id);

		// 9. The user's own close button.
		const dismissible = broker.present(
			{ code: `container.createEl("div", { cls: "smoke-dismiss", text: "Close me" });`, title: "Dismiss" },
			undefined,
			ownerId,
		);
		await wait(() => document.querySelector(".smoke-dismiss") !== null);
		await dismissible;
		document.querySelector(".piem-ui-block-card__dismiss").click();
		await wait(() => broker.getLive(ownerId).length === 0);
		record("user's close button ended the view", document.querySelector(".smoke-dismiss") === null);

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
