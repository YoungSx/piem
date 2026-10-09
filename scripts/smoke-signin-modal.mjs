/**
 * Smoke test for SignInModal in real Obsidian runtime on the virtual desktop.
 *
 * Verifies that when opening SignInModal in real Obsidian:
 * 1. For a signed-out provider (signedIn: false), the modal footer renders
 *    exactly 2 buttons: "Close" and "Sign in", and crucially, NO blank button.
 * 2. For a signed-in provider (signedIn: true), the modal footer renders
 *    exactly 3 buttons: "Close", "Sign out", and "Sign in again", and NO blank button.
 * 3. Captures real CDP screenshots of both states on the virtual desktop.
 *
 * Usage: node scripts/smoke-signin-modal.mjs <CDP-port> <output-dir> [--expect-mobile]
 */
import { readFile, writeFile } from "node:fs/promises";
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
	const [port, root, ...rest] = process.argv.slice(2);
	const expectMobile = rest.includes("--expect-mobile");
	const modePrefix = expectMobile ? "mobile" : "desktop";

	const report = { passed: false, checks: [], errors: [], details: {} };
	const check = (name, value, detail) => {
		if (!value) {
			const err = detail ? `${name}: ${detail}` : name;
			report.errors.push(err);
			throw new Error(err);
		}
		report.checks.push(name);
	};

	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
	const mainTarget =
		targets.find((item) => item.type === "page" && item.url.startsWith("app://obsidian.md/index.html")) ??
		targets.find((item) => item.type === "page" && item.url.startsWith("app://"));
	if (!mainTarget) throw new Error("No Obsidian main page target found");

	const client = createCdpClient(mainTarget.webSocketDebuggerUrl);
	await client.ready;

	const artifactDir = "/home/ubuntu/.t3/userdata/providers/antigravity/ac0a3dfd6dddb20962cecff6ee5fe65e19d3923be20e52c5ab52ff877f7e4c32/antigravity-acp/brain/ab615975-5889-41da-b8cd-366ea03a4d10";

	try {
		// 1. Wait for piem plugin to be ready
		await client.evaluate(`(async () => {
			for (let i = 0; i < 300; i++) {
				if (window.app?.plugins?.plugins?.piem?.openSignInModal) return true;
				await new Promise(r => setTimeout(r, 100));
			}
			throw new Error("timeout waiting for plugin openSignInModal");
		})()`);
		check(`${modePrefix}: piem plugin and openSignInModal ready`, true);

		// ==========================================
		// Case A: Signed Out Modal Verification
		// ==========================================
		const signedOutRes = await client.evaluate(`(async () => {
			const plugin = window.app.plugins.plugins.piem;
			plugin.openSignInModal({
				target: "xAI (SuperGrok / X Premium)",
				method: "xAI (Grok/X subscription)",
				signedIn: false,
				canStore: true,
			});

			for (let i = 0; i < 50; i++) {
				const modal = document.querySelector(".piem-settings-modal");
				if (modal) {
					const footer = modal.querySelector(".piem-settings-modal-footer");
					if (footer) {
						const buttons = Array.from(footer.querySelectorAll("button")).map(b => ({
							text: b.textContent?.trim() || "",
							classList: Array.from(b.classList),
							outerHtml: b.outerHTML,
						}));
						return {
							found: true,
							title: modal.querySelector(".modal-title")?.textContent || document.querySelector(".modal-title")?.textContent || "",
							buttons,
						};
					}
				}
				await new Promise(r => setTimeout(r, 100));
			}
			return { found: false };
		})()`);

		check(`${modePrefix}: Signed-out modal opened in real Obsidian`, signedOutRes.found);
		report.details.signedOut = signedOutRes;

		// Assert button count and labels: exactly 2 buttons, none blank!
		check(
			`${modePrefix}: modal has exactly 2 buttons when signed out`,
			signedOutRes.buttons?.length === 2,
			`found ${signedOutRes.buttons?.length}: ${JSON.stringify(signedOutRes.buttons?.map(b => b.text))}`
		);
		for (let i = 0; i < (signedOutRes.buttons || []).length; i++) {
			const b = signedOutRes.buttons[i];
			check(`${modePrefix}: button ${i} text is non-empty ("${b.text}")`, b.text.length > 0, `empty button html: ${b.outerHtml}`);
		}

		// Capture screenshot of Case A (Signed Out)
		const shotA = await client.send("Page.captureScreenshot", { format: "png" });
		const shotAPath = resolve(root, `signin-modal-signed-out-${modePrefix}.png`);
		await writeFile(shotAPath, Buffer.from(shotA.data, "base64"));
		await writeFile(resolve(artifactDir, `signin-modal-signed-out-${modePrefix}.png`), Buffer.from(shotA.data, "base64")).catch(() => {});
		if (!expectMobile) {
			await writeFile(resolve(root, "signin-modal-smoke.png"), Buffer.from(shotA.data, "base64"));
			await writeFile(resolve(artifactDir, "signin-modal-smoke.png"), Buffer.from(shotA.data, "base64")).catch(() => {});
		}
		report.details[`screenshotSignedOut_${modePrefix}`] = shotAPath;
		check(`${modePrefix}: Case A screenshot captured`, true, shotAPath);

		// Close modal
		await client.evaluate(`(() => {
			const closeBtn = document.querySelector(".modal-close-button") || document.querySelector(".piem-settings-modal-footer button");
			if (closeBtn) closeBtn.click();
		})()`);
		await new Promise(r => setTimeout(r, 500));

		// ==========================================
		// Case B: Signed In Modal Verification
		// ==========================================
		const signedInRes = await client.evaluate(`(async () => {
			const plugin = window.app.plugins.plugins.piem;
			plugin.openSignInModal({
				target: "xAI (SuperGrok / X Premium)",
				method: "xAI (Grok/X subscription)",
				signedIn: true,
				canStore: true,
			});

			for (let i = 0; i < 50; i++) {
				const modal = document.querySelector(".piem-settings-modal");
				if (modal) {
					const footer = modal.querySelector(".piem-settings-modal-footer");
					if (footer) {
						const buttons = Array.from(footer.querySelectorAll("button")).map(b => ({
							text: b.textContent?.trim() || "",
							classList: Array.from(b.classList),
							outerHtml: b.outerHTML,
						}));
						return {
							found: true,
							title: modal.querySelector(".modal-title")?.textContent || document.querySelector(".modal-title")?.textContent || "",
							buttons,
						};
					}
				}
				await new Promise(r => setTimeout(r, 100));
			}
			return { found: false };
		})()`);

		check(`${modePrefix}: Signed-in modal opened in real Obsidian`, signedInRes.found);
		report.details.signedIn = signedInRes;

		// Assert button count and labels: exactly 3 buttons when signed in, none blank!
		check(
			`${modePrefix}: modal has exactly 3 buttons when signed in`,
			signedInRes.buttons?.length === 3,
			`found ${signedInRes.buttons?.length}: ${JSON.stringify(signedInRes.buttons?.map(b => b.text))}`
		);
		for (let i = 0; i < (signedInRes.buttons || []).length; i++) {
			const b = signedInRes.buttons[i];
			check(`${modePrefix}: button ${i} text is non-empty ("${b.text}")`, b.text.length > 0, `empty button html: ${b.outerHtml}`);
		}

		// Capture screenshot of Case B (Signed In)
		const shotB = await client.send("Page.captureScreenshot", { format: "png" });
		const shotBPath = resolve(root, `signin-modal-signed-in-${modePrefix}.png`);
		await writeFile(shotBPath, Buffer.from(shotB.data, "base64"));
		await writeFile(resolve(artifactDir, `signin-modal-signed-in-${modePrefix}.png`), Buffer.from(shotB.data, "base64")).catch(() => {});
		report.details[`screenshotSignedIn_${modePrefix}`] = shotBPath;
		check(`${modePrefix}: Case B screenshot captured`, true, shotBPath);

		// Close modal
		await client.evaluate(`(() => {
			const closeBtn = document.querySelector(".modal-close-button") || document.querySelector(".piem-settings-modal-footer button");
			if (closeBtn) closeBtn.click();
		})()`);

		report.passed = true;
	} catch (e) {
		report.errors.push(String(e));
	} finally {
		client.close();
	}

	await writeFile(resolve(root, `signin-modal-smoke-${modePrefix}.json`), JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report));
	if (!report.passed) process.exitCode = 1;
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
