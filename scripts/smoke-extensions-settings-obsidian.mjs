/**
 * Real Obsidian smoke for the Extensions settings page subpage hierarchy.
 *
 * Question under test: in real Obsidian 1.13.7, does the Extensions settings
 * tab render preview items, render the Obsidian-native subpage link, navigate
 * into the subpage displaying all items, and navigate back cleanly without
 * errors?
 *
 * Usage: node scripts/smoke-extensions-settings-obsidian.mjs <CDP-port> <output-dir>
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

function createCdpClient(wsUrl) {
	const ws = new WebSocket(wsUrl);
	const waiters = new Map();
	let nextId = 0;

	ws.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		const waiter = waiters.get(message.id);
		if (!waiter) return;
		waiters.delete(message.id);
		message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
	});

	const ready = new Promise((res, rej) => {
		ws.addEventListener("open", res, { once: true });
		ws.addEventListener("error", rej, { once: true });
	});

	const send = async (method, params = {}) => {
		await ready;
		return new Promise((res, rej) => {
			const id = ++nextId;
			waiters.set(id, { resolve: res, reject: rej });
			ws.send(JSON.stringify({ id, method, params }));
		});
	};

	const evaluate = async (expression) => {
		const result = await send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		});
		if (result.exceptionDetails) {
			throw new Error(JSON.stringify(result.exceptionDetails));
		}
		return result.result?.value;
	};

	const close = () => {
		ws.close();
	};

	return { ready, send, evaluate, close };
}

async function main() {
	const [port, root] = process.argv.slice(2);
	const report = { passed: false, checks: [], errors: [], details: {} };
	const check = (name, value, detail) => {
		if (!value) {
			const err = detail ? `${name}: ${detail}` : name;
			report.errors.push(err);
			throw new Error(err);
		}
		report.checks.push(name);
	};

	// 1. Locate main window target
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
	const mainTarget =
		targets.find((item) => item.type === "page" && item.url.startsWith("app://obsidian.md/index.html")) ??
		targets.find((item) => item.type === "page" && item.url.startsWith("app://"));
	if (!mainTarget) throw new Error("No Obsidian main page target found");

	const mainClient = createCdpClient(mainTarget.webSocketDebuggerUrl);
	await mainClient.ready;

	try {
		// Wait for agentService
		await mainClient.evaluate(`(async () => {
			for (let i = 0; i < 300; i++) {
				if (window.app?.plugins?.plugins?.piem?.agentService) return true;
				await new Promise(r => setTimeout(r, 100));
			}
			throw new Error("timeout waiting for agentService");
		})()`);
		check("piem plugin agentService ready", true);

		// Open Settings Tab
		await mainClient.evaluate(`(() => {
			window.app.setting.openTabById("piem");
		})()`);

		// Wait for settings page/target
		let settingsClient = mainClient;
		let settingsTarget = null;
		for (let i = 0; i < 50; i++) {
			const curTargets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
			settingsTarget = curTargets.find((t) => t.title && t.title.includes("Settings"));
			if (settingsTarget) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		if (settingsTarget) {
			settingsClient = createCdpClient(settingsTarget.webSocketDebuggerUrl);
			await settingsClient.ready;
		}

		// Wait for landing items to render in Settings window
		await settingsClient.evaluate(`(async () => {
			for (let i = 0; i < 60; i++) {
				if (document.querySelectorAll(".setting-item").length > 0) return true;
				await new Promise(r => setTimeout(r, 100));
			}
			throw new Error("timeout waiting for settings items to render");
		})()`);

		// 2. In Settings, verify landing page has Extensions
		const landingItems = await settingsClient.evaluate(`(() => {
			return [...document.querySelectorAll(".setting-item")].map(i => ({
				name: i.querySelector(".setting-item-name")?.textContent?.trim() || "",
				desc: i.querySelector(".setting-item-description")?.textContent?.trim() || "",
				control: i.querySelector(".setting-item-control")?.textContent?.trim() || ""
			}));
		})()`);

		const hasExtLanding = landingItems.some((i) => /extensions|扩展/i.test(i.name));
		check("landing page displays Extensions page item", hasExtLanding, JSON.stringify(landingItems.map((i) => i.name)));

		// 3. Click into Extensions page
		await settingsClient.evaluate(`(() => {
			const extItem = [...document.querySelectorAll(".setting-item")].find(i => /extensions|扩展/i.test(i.textContent));
			if (extItem) extItem.click();
		})()`);

		// Wait for Extensions page items to render
		await settingsClient.evaluate(`(async () => {
			for (let i = 0; i < 60; i++) {
				const headings = [...document.querySelectorAll(".setting-item-heading")].map(h => h.textContent.trim());
				if (headings.some(h => /skills|技能/i.test(h))) return true;
				await new Promise(r => setTimeout(r, 100));
			}
			throw new Error("timeout waiting for extensions page headings");
		})()`);

		// 4. Assert on Extensions page
		const extPageInfo = await settingsClient.evaluate(`(() => {
			const items = [...document.querySelectorAll(".setting-item")].map(i => ({
				name: i.querySelector(".setting-item-name")?.textContent?.trim() || "",
				desc: i.querySelector(".setting-item-description")?.textContent?.trim() || "",
				control: i.querySelector(".setting-item-control")?.textContent?.trim() || "",
				isHeading: i.classList.contains("setting-item-heading")
			}));
			return items;
		})()`);

		// Check Skills section preview + subpage
		const allSkillsEntry = extPageInfo.find((i) => /All skills|全部技能/i.test(i.name));
		check("Skills preview has All skills subpage entry", !!allSkillsEntry);
		check("All skills subpage entry displays count badge", /\d+\s*(skills|个技能)/i.test(allSkillsEntry?.control || ""), allSkillsEntry?.control);

		// Check Pi extensions section preview + subpage
		const allExtEntry = extPageInfo.find((i) => /All Pi extensions|全部 Pi 扩展/i.test(i.name));
		check("Pi extensions preview has All Pi extensions subpage entry", !!allExtEntry);
		check("All Pi extensions subpage entry displays count badge", /9\s*(extensions|个扩展)/i.test(allExtEntry?.control || ""), allExtEntry?.control);

		// Check un-relocated items
		const hasWorkflow = extPageInfo.some((i) => /Workflow engine|工作流引擎/i.test(i.name));
		check("Workflow engine setting is not on Extensions page", !hasWorkflow);
		const hasTelemetry = extPageInfo.some((i) => /error reports|错误报告/i.test(i.name));
		check("Error reports setting is not on Extensions page", !hasTelemetry);
		const hasMcp = extPageInfo.some((i) => /MCP/i.test(i.name));
		check("MCP section remains on Extensions page", hasMcp);

		// 5. Navigate into "All Pi extensions" subpage
		await settingsClient.evaluate(`(() => {
			const item = [...document.querySelectorAll(".setting-item")].find(i => /All Pi extensions|全部 Pi 扩展/i.test(i.textContent));
			if (item) item.click();
		})()`);

		// Wait for subpage items
		await settingsClient.evaluate(`(async () => {
			for (let i = 0; i < 60; i++) {
				const names = [...document.querySelectorAll(".setting-item")].map(i => i.querySelector(".setting-item-name")?.textContent?.trim() || "");
				if (names.some(n => /draft rewriting|草稿重写|model handoff/i.test(n))) return true;
				await new Promise(r => setTimeout(r, 100));
			}
			throw new Error("timeout waiting for subpage items");
		})()`);

		const subpageItems = await settingsClient.evaluate(`(() => {
			const cur = (window.app?.setting?.getCurrentPageEl?.() || document.querySelector(".vertical-tab-content:last-of-type") || document);
			const items = [...cur.querySelectorAll(".setting-item")].filter(i => {
				const style = window.getComputedStyle(i);
				return style.display !== "none" && style.visibility !== "hidden";
			});
			return items.map(i => i.querySelector(".setting-item-name")?.textContent?.trim() || "");
		})()`);

		const expectedExtensions = [
			"Web search",
			"Model switching",
			"Context management",
			"Agent team",
			"Draft rewriting",
			"Invisible continue",
			"Todo overlay",
			"Scheduled prompts",
			"Model handoff notes",
		];
		const foundExtensions = expectedExtensions.filter((expected) =>
			subpageItems.some((item) => item.toLowerCase().includes(expected.toLowerCase())),
		);

		check("All Pi extensions subpage renders all 9 extensions", foundExtensions.length === 9, `found ${foundExtensions.length}/9: ${foundExtensions.join(", ")}`);

		// 6. Navigate back using back button
		await settingsClient.evaluate(`(() => {
			const backBtn = document.querySelector(".setting-page-back-button, .modal-setting-back-button");
			if (backBtn) backBtn.click();
		})()`);

		// Wait for return to Extensions page
		await settingsClient.evaluate(`(async () => {
			for (let i = 0; i < 60; i++) {
				const headings = [...document.querySelectorAll(".setting-item-heading")].map(h => h.textContent.trim());
				if (headings.some(h => /skills|技能/i.test(h))) return true;
				await new Promise(r => setTimeout(r, 100));
			}
			throw new Error("timeout waiting for return to extensions page");
		})()`);

		// 7. Navigate into "All skills" subpage
		await settingsClient.evaluate(`(() => {
			const item = [...document.querySelectorAll(".setting-item")].find(i => /All skills|全部技能/i.test(i.textContent));
			if (item) item.click();
		})()`);

		// Wait for skills subpage items
		await settingsClient.evaluate(`(async () => {
			for (let i = 0; i < 60; i++) {
				const names = [...document.querySelectorAll(".setting-item")].map(i => i.querySelector(".setting-item-name")?.textContent?.trim() || "");
				if (names.some(n => /link-graph|mineru-parse|vault-memory/i.test(n))) return true;
				await new Promise(r => setTimeout(r, 100));
			}
			throw new Error("timeout waiting for skills subpage items");
		})()`);

		const subpageSkillsCount = await settingsClient.evaluate(`(() => {
			const cur = (window.app?.setting?.getCurrentPageEl?.() || document.querySelector(".vertical-tab-content:last-of-type") || document);
			return cur.querySelectorAll(".setting-item").length;
		})()`);

		check("All skills subpage renders all skills (>3)", subpageSkillsCount > 3, `found ${subpageSkillsCount}`);

		// 7.1 Test native <details> / <summary> fold behavior and visual states
		const foldDetails = await settingsClient.evaluate(`(() => {
			const item = [...document.querySelectorAll(".setting-item")].find(i => i.querySelector(".piem-settings-desc-details"));
			if (!item) return null;
			item.scrollIntoView({ block: "center" });
			const details = item.querySelector(".piem-settings-desc-details");
			const summary = item.querySelector(".piem-settings-desc-summary");
			const icon = item.querySelector(".piem-settings-desc-icon");
			const label = item.querySelector(".piem-settings-desc-text");
			return {
				name: item.querySelector(".setting-item-name")?.textContent?.trim() || "",
				open: details?.open,
				hasIcon: !!icon,
				labelText: label?.textContent?.trim() || "",
			};
		})()`);

		check("Long description renders native details fold", !!foldDetails, JSON.stringify(foldDetails));
		if (foldDetails) {
			check("Details is initially collapsed", foldDetails.open === false);

			await new Promise((r) => setTimeout(r, 200));
			const shotCollapsed = await settingsClient.send("Page.captureScreenshot", { format: "png" });
			await writeFile(resolve(root, "details-fold-collapsed.png"), Buffer.from(shotCollapsed.data, "base64"));

			const expandedDetails = await settingsClient.evaluate(`(() => {
				const item = [...document.querySelectorAll(".setting-item")].find(i => i.querySelector(".piem-settings-desc-details"));
				const summary = item.querySelector(".piem-settings-desc-summary");
				summary.click();
				const details = item.querySelector(".piem-settings-desc-details");
				const label = item.querySelector(".piem-settings-desc-text");
				return {
					open: details?.open,
					labelText: label?.textContent?.trim() || "",
				};
			})()`);

			check("Clicking summary opens details", expandedDetails?.open === true);

			await new Promise((r) => setTimeout(r, 200));
			const shotExpanded = await settingsClient.send("Page.captureScreenshot", { format: "png" });
			await writeFile(resolve(root, "details-fold-expanded.png"), Buffer.from(shotExpanded.data, "base64"));
		}

		// Navigate back again
		await settingsClient.evaluate(`(() => {
			const backBtn = document.querySelector(".setting-page-back-button, .modal-setting-back-button");
			if (backBtn) backBtn.click();
		})()`);

		await new Promise((r) => setTimeout(r, 400));

		// Screenshot
		const shot = await settingsClient.send("Page.captureScreenshot", { format: "png" });
		await writeFile(resolve(root, "settings-hierarchy-smoke.png"), Buffer.from(shot.data, "base64"));

		// Check that Error reports (diagnostics) is on General page
		await settingsClient.evaluate(`(() => {
			const generalTab = [...document.querySelectorAll(".vertical-tab-nav-item")].find(i => /general|通用/i.test(i.textContent));
			if (generalTab) generalTab.click();
		})()`);
		await new Promise(r => setTimeout(r, 400));
		const generalHasTelemetry = await settingsClient.evaluate(`(() => {
			const items = [...document.querySelectorAll(".setting-item-name")].map(i => i.textContent.trim());
			return items.some(n => /error reports|错误报告/i.test(n));
		})()`);
		check("Error reports setting is present on General page", generalHasTelemetry);

		// Clean up
		await mainClient.evaluate(`(() => {
			window.app.setting.close();
		})()`);

		report.passed = report.errors.length === 0;
		report.details = {
			subpageExtensionsCount: foundExtensions.length,
			subpageSkillsCount,
			extPageEntriesCount: extPageInfo.length,
		};

		const artifact = await readFile(resolve(root, "vault/.obsidian/plugins/piem/main.js"));
		report.artifactSha256 = createHash("sha256").update(artifact).digest("hex");

		await writeFile(resolve(root, "settings-hierarchy.json"), `${JSON.stringify(report, null, 2)}\n`);

		if (settingsClient !== mainClient) {
			settingsClient.close();
		}
	} finally {
		mainClient.close();
	}

	console.log(JSON.stringify(report));
	if (!report.passed) process.exitCode = 1;
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
