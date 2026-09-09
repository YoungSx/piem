import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadBrowserPluginBundle } from "./browserPluginLoader";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(source: string): string {
	const root = mkdtempSync(join(tmpdir(), "piem-browser-realm-"));
	roots.push(root);
	const file = join(root, "main.js");
	writeFileSync(file, source);
	return file;
}

describe("browser-only bundle realm", () => {
	it("never exposes Node globals, even after the loader returns and an async callback runs", async () => {
		const realm = loadBrowserPluginBundle({ modules: {}, bundlePath: fixture(`module.exports = { probe: async () => { await Promise.resolve(); return process.versions.node; } };`) });
		const output = realm.exports as { probe(): Promise<string> };
		await expect(output.probe()).rejects.toThrow("process");
		expect(await realm.evaluate('Promise.resolve().then(() => [typeof process, typeof Buffer, typeof globalThis.require, typeof window.process, typeof window.Buffer, typeof Bun])')).toEqual(Array(6).fill("undefined"));
	});
	it("rejects Node and Electron requests instead of falling back to the test runner", () => {
		for (const id of ["node:fs", "fs", "child_process", "electron"]) {
			const requests: string[] = [];
			expect(() => loadBrowserPluginBundle({ bundlePath: fixture(`module.exports = require(${JSON.stringify(id)});`), modules: {}, onRequire: name => requests.push(name) })).toThrow(`Cannot find module '${id}'`);
			expect(requests).toEqual([id]);
		}
	});
	it("rejects an unmodified dynamic import in the separate realm", async () => {
		const attempted: string[] = [];
		const realm = loadBrowserPluginBundle({ modules: {}, bundlePath: fixture(`module.exports = { probe: () => import('node:fs') };`), onDynamicImport: id => attempted.push(id) });
		await expect((realm.exports as { probe(): Promise<unknown> }).probe()).rejects.toThrow();
		// Some Node versions refuse VM dynamic imports before calling the hook.
		expect(attempted.every(id => id === "node:fs")).toBe(true);
	});
});
