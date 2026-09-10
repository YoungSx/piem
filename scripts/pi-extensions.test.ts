import { describe, expect, it } from "bun:test";
import { build } from "esbuild";
import { piExtensionsPlugin } from "./pi-extensions.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = process.cwd();
const pkg = path.join(root, "node_modules/@earendil-works/pi-coding-agent");

describe("static official extension bundle", () => {
	it("runs the original command with browser globals and zero Node imports", async () => {
		const built = await build({
			stdin: { contents: 'export { createOfficialBookmark } from "./src/extensions/officialBookmark";', resolveDir: root, loader: "ts" },
			bundle: true, write: false, metafile: true, minify: true, format: "cjs", target: "es2018", plugins: [piExtensionsPlugin(root)], logLevel: "silent",
		});
		const output = Object.values(built.metafile!.outputs)[0]!;
		expect(output.imports).toEqual([]);
		expect(Object.keys(output.inputs).some(file => file.includes("/core/extensions/runner.js"))).toBe(true);
		expect(Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).some(([file]) => /jiti|highlight\.js|pi-tui|providers\//.test(file))).toBe(false);
		const sandbox = { module: { exports: {} }, URL, TextEncoder, TextDecoder, AbortController, console, structuredClone };
		vm.runInNewContext(built.outputFiles[0]!.text, sandbox, { timeout: 1000 });
		const api = sandbox.module.exports as { createOfficialBookmark(callbacks: unknown): Promise<{ run(name: string, args: string): Promise<void>; dispose(): void }> };
		const labels = new Map<string, string | undefined>();
		const commands = await api.createOfficialBookmark({ getEntries: () => [{ id: "answer", type: "message", message: { role: "assistant" } }], getLabel: (id: string) => labels.get(id), setLabel: (id: string, label?: string) => labels.set(id, label), notify: () => {} });
		await commands.run("bookmark", "Browser");
		expect(labels.get("answer")).toBe("Browser");
		await commands.run("unbookmark", "");
		expect(labels.get("answer")).toBeUndefined();
		commands.dispose();
		await expect(commands.run("bookmark", "Stale")).rejects.toThrow();
	});
	it("fails the build if a dynamic loader edge becomes reachable", async () => {
		await expect(build({ stdin: { contents: `export { loadExtensions } from ${JSON.stringify(path.join(pkg, "dist/core/extensions/loader.js"))};`, resolveDir: root, loader: "ts" }, bundle: true, write: false, metafile: true, format: "cjs", target: "es2018", plugins: [piExtensionsPlugin(root)], logLevel: "silent" })).rejects.toThrow();
	});
	it("reads the pinned package as a virtual UTF-8 resource without a host filesystem", async () => {
		const built = await build({
			stdin: { contents: 'export * from "./src/extensions/node/fs"; export { resolve } from "./src/extensions/node/path";', resolveDir: root, loader: "ts" },
			bundle: true, write: false, metafile: true, minify: true, format: "cjs", target: "es2018", plugins: [piExtensionsPlugin(root)], logLevel: "silent",
		});
		const sandbox = { module: { exports: {} }, URL };
		vm.runInNewContext(built.outputFiles[0]!.text, sandbox, { timeout: 1000 });
		const fs = sandbox.module.exports as { readFileSync(path: string | URL, encoding: string): string; resolve(path: string): string; accessSync(path: string, mode: number): void };
		expect(fs.resolve("Notes/a.md")).toBe("/vault/Notes/a.md");
		const original = readFileSync(path.join(pkg, "package.json"), "utf8");
		expect(fs.readFileSync(new URL("file:///pi/package.json"), "utf8")).toBe(original);
		expect(fs.readFileSync("../pi/dist/../package.json", "utf-8")).toBe(original);
		expect(() => fs.readFileSync("__proto__", "utf8")).toThrow("No bundled resource");
		expect(() => fs.readFileSync("/pi/package.json", "hex")).toThrow("does not support");
		expect(() => fs.accessSync("/pi/package.json", 2)).toThrow("does not support");
	});
	it("the integration pin remains explicit and carries the official factory unchanged", () => {
		const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
		expect(packageJson.dependencies["@earendil-works/pi-coding-agent"]).toBe("0.84.3");
		expect(readFileSync("src/extensions/bookmarkFactory.mjs", "utf8")).toContain("examples/extensions/bookmark.ts");
	});
});

describe("audited community graph", () => {
	it("loads all three upstream factories, tools and context hooks without a Node host", async () => {
		const built = await build({
			stdin: { contents: 'export { CommunityHost } from "./src/extensions/communityHost";', resolveDir: root, loader: "ts" },
			bundle: true, write: false, metafile: true, minify: true, format: "cjs", target: "es2018", plugins: [piExtensionsPlugin(root)], logLevel: "silent",
		});
		expect(Object.values(built.metafile!.outputs).flatMap(output => output.imports)).toEqual([]);
		const sandbox = { module: { exports: {} }, URL, TextEncoder, TextDecoder, AbortController, structuredClone, console };
		vm.runInNewContext(built.outputFiles[0]!.text, sandbox, { timeout: 1000 });
		const api = sandbox.module.exports as { CommunityHost: { create(callbacks: unknown): Promise<{ tools: Array<{ execute: (...args: unknown[]) => Promise<unknown> }>; run(name: string): Promise<unknown[]>; transformContext(messages: unknown[]): Promise<unknown[]>; dispose(): void }> } };
		const model = { provider: "test", id: "alpha", name: "Alpha" };
		const host = await api.CommunityHost.create({ getEntries: () => [], getModel: () => model, getModels: () => [model], isIdle: () => true, notify: () => {} });
		const markers = await host.run("continue");
		expect(markers).toHaveLength(1);
		expect(await host.transformContext(markers)).toEqual([]);
		expect(JSON.stringify(await host.tools[0]!.execute("tool", { action: "current" }))).toContain("test/alpha");
		host.dispose();
		await expect(host.run("continue")).rejects.toThrow();
		await expect(host.tools[0]!.execute("tool", { action: "current" })).rejects.toThrow();
	});

	it("refuses unreviewed upstream source before it enters the bundle", async () => {
		await expect(build({
			stdin: { contents: `export * from ${JSON.stringify(path.join(pkg, "dist/core/session-manager.js"))};`, resolveDir: root, loader: "ts" },
			bundle: true, write: false, metafile: true, plugins: [piExtensionsPlugin(root)], logLevel: "silent",
		})).rejects.toThrow("Unaudited extension source");
	});
});
