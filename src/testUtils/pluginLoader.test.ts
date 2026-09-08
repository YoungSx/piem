import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginBundle } from "./pluginLoader";

/**
 * Self-test for the load harness.
 *
 * `bundleLoad.test.ts` asserts that the real bundle loads. That only means
 * something if the harness would actually reject a bundle that cannot load —
 * and an unshimmed harness does not: under bun, `import("electron")` resolves
 * against this package's own node_modules, so the broken 0.1.0-alpha.3 artifact
 * loads without complaint. Verified against the published alpha.3 bundle while
 * building this gate.
 *
 * These fixtures pin the distinction the harness has to draw, so nobody
 * "simplifies" the shim away and silently turns the smoke test into a no-op.
 */

const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function bundleFixture(source: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-loader-fixture-"));
	directories.push(dir);
	const file = join(dir, "main.js");
	writeFileSync(file, source, "utf8");
	return file;
}

describe("loadPluginBundle", () => {
	it("can refuse real Node builtins even though the test runner provides them", () => {
		const bundlePath = bundleFixture(`module.exports = require("node:fs");`);
		const requests: string[] = [];
		expect(() => loadPluginBundle({
			bundlePath, modules: {}, allowNodeBuiltins: false, onRequire: (id) => requests.push(id),
		})).toThrow("Cannot find module 'node:fs'");
		expect(requests).toEqual(["node:fs"]);
	});

	it("rejects a literal dynamic import of a bare package, as Obsidian's renderer does", async () => {
		// The exact construct 0.1.0-alpha.3 shipped.
		const bundlePath = bundleFixture(`module.exports = { probe: () => import("electron") };`);

		const exports = loadPluginBundle({ bundlePath, modules: {} }) as { probe(): Promise<unknown> };

		expect(exports.probe()).rejects.toThrow(/Failed to resolve module specifier 'electron'/);
	});

	it("rejects even when the package is installed in this repo", async () => {
		// electron is a devDependency here, which is precisely why an unshimmed
		// harness resolves this and lets a broken bundle pass.
		const bundlePath = bundleFixture(`module.exports = { probe: async () => (await import("electron")).safeStorage };`);

		const exports = loadPluginBundle({ bundlePath, modules: {} }) as { probe(): Promise<unknown> };

		expect(exports.probe()).rejects.toThrow(TypeError);
	});

	it("rejects dynamic imports of node builtins; desktop code must use require", async () => {
		const bundlePath = bundleFixture(`module.exports = { probe: async () => typeof (await import("node:path")).join };`);

		const exports = loadPluginBundle({ bundlePath, modules: {} }) as { probe(): Promise<string> };

		expect(exports.probe()).rejects.toThrow(/Failed to resolve module specifier 'node:path'/);
	});

	it("reports every dynamic import the bundle attempts, including the tolerated ones", () => {
		// pi-ai's env-api-keys.js fires exactly this shape at module scope, with no
		// handler. The attempt has to stay observable, or the only evidence the
		// bundle reached for an unavailable module is an unhandled rejection.
		const bundlePath = bundleFixture(
			`const spec = "node:" + "fs"; import(spec).then(m => { globalThis.__leaked = m; }); module.exports = {};`,
		);
		const attempted: string[] = [];

		loadPluginBundle({ bundlePath, modules: {}, onDynamicImport: (id) => attempted.push(id) });

		expect(attempted).toEqual(["node:fs"]);
		expect((globalThis as { __leaked?: unknown }).__leaked).toBeUndefined();
	});

	it("still delivers the failure to a caller that handles it", async () => {
		// The tolerated set is silent only for a fire-and-forget `.then(fn)`;
		// awaiting one must not quietly succeed, or a real defect would pass.
		const bundlePath = bundleFixture(
			`module.exports = { probe: async () => { try { await import("node:" + "os"); return "resolved"; } catch (error) { return error.message; } } };`,
		);

		const exports = loadPluginBundle({ bundlePath, modules: {} }) as { probe(): Promise<string> };

		expect(await exports.probe()).toMatch(/Failed to resolve module specifier 'node:os'/);
	});

	it("leaves import-like text inside strings alone", async () => {
		// Dependencies embed this shape in error messages; rewriting it must not
		// change what the bundle reports.
		const message = "set globalThis.File to `import('node:buffer').File`";
		const bundlePath = bundleFixture(`module.exports = { text: ${JSON.stringify(message)} };`);

		const exports = loadPluginBundle({ bundlePath, modules: {} }) as { text: string };

		expect(exports.text).toContain("node:buffer");
	});

	it("serves host modules through require and throws for unknown ids", () => {
		const bundlePath = bundleFixture(
			`module.exports = { ok: require("obsidian").marker, missing: (() => { try { require("nope"); return false; } catch { return true; } })() };`,
		);

		const exports = loadPluginBundle({ bundlePath, modules: { obsidian: { marker: "served" } } }) as {
			ok: string;
			missing: boolean;
		};

		expect(exports.ok).toBe("served");
		expect(exports.missing).toBe(true);
	});

	it("exposes a global require only when the shell is said to inject one", () => {
		const bundlePath = bundleFixture(`module.exports = { hasGlobalRequire: typeof globalThis.require === "function" };`);

		const desktop = loadPluginBundle({ bundlePath, modules: {}, exposeGlobalRequire: true }) as { hasGlobalRequire: boolean };
		const mobile = loadPluginBundle({ bundlePath, modules: {}, exposeGlobalRequire: false }) as { hasGlobalRequire: boolean };

		expect(desktop.hasGlobalRequire).toBe(true);
		expect(mobile.hasGlobalRequire).toBe(false);
	});

	it("restores the ambient global require after loading", () => {
		const bundlePath = bundleFixture(`module.exports = {};`);
		const before = (globalThis as { require?: unknown }).require;

		loadPluginBundle({ bundlePath, modules: {}, exposeGlobalRequire: true });

		expect((globalThis as { require?: unknown }).require).toBe(before);
	});

	it("reports a missing bundle as a build problem rather than a plugin defect", () => {
		expect(() => loadPluginBundle({ bundlePath: join(tmpdir(), "pi-does-not-exist.js"), modules: {} })).toThrow(
			/npm run build/,
		);
	});
});
