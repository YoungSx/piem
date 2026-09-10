import { beforeAll, describe, expect, it } from "bun:test";
import { build } from "esbuild";
import { piExtensionsPlugin } from "./pi-extensions.mjs";
import { buildScopedFactory } from "./pi-scoped-factories.mjs";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
	it("loads the community factories and preserves the original commands without a Node host", async () => {
		const built = await build({
			stdin: { contents: 'export { CommunityHost } from "./src/extensions/communityHost";', resolveDir: root, loader: "ts" },
			bundle: true, write: false, metafile: true, minify: true, format: "cjs", target: "es2018", plugins: [piExtensionsPlugin(root)], logLevel: "silent",
		});
		expect(Object.values(built.metafile!.outputs).flatMap(output => output.imports)).toEqual([]);
		const sandbox = { module: { exports: {} }, URL, TextEncoder, TextDecoder, AbortController, structuredClone, console };
		vm.runInNewContext(built.outputFiles[0]!.text, sandbox, { timeout: 1000 });
		const api = sandbox.module.exports as { CommunityHost: { create(callbacks: unknown): Promise<{ tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>; run(name: string): Promise<unknown[]>; transformContext(messages: unknown[]): Promise<unknown[]>; dispose(): void }> } };
		const model = { provider: "test", id: "alpha", name: "Alpha" };
		const unavailable = () => { throw new Error("This command must stay offline."); };
		const host = await api.CommunityHost.create({
			getEntries: () => [], getModel: () => model, getModels: () => [model], isIdle: () => true, notify: () => {},
			prepare: async () => {}, deliver: unavailable,
			platform: { fetch: unavailable, complete: unavailable, readConfig: () => undefined, onError: unavailable },
		});
		expect(host.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(["switch_model", "web_search", "context_checkpoint", "context_timeline", "context_compact"]));
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

type ProbeResult = { content: Array<{ type: string; text: string }>; details?: Record<string, unknown> };
interface ProbeTool { name: string; execute(id: string, params: object, signal: AbortSignal, update: undefined, context: object): Promise<ProbeResult> }
interface ProbeCommand { handler(args: string, context: object): Promise<void> }
type ProbeHandler = (event: object, context: object) => unknown;
type ProbeFactory = (api: object) => void;
type ProbeBuilder = (platform: object) => ProbeFactory;

function collectRegistrations(factory: ProbeFactory) {
	const tools = new Map<string, ProbeTool>();
	const commands = new Map<string, ProbeCommand>();
	const handlers = new Map<string, ProbeHandler>();
	factory({ registerTool: (tool: ProbeTool) => tools.set(tool.name, tool), registerCommand: (name: string, command: ProbeCommand) => commands.set(name, command), on: (event: string, handler: ProbeHandler) => handlers.set(event, handler) });
	return { tools, commands, handlers };
}

describe("scoped original extension factories", () => {
	let builders: Record<"createWebSearch" | "createClarify" | "createContext", ProbeBuilder>;
	beforeAll(async () => {
		const built = await build({
			stdin: { contents: 'export { createWebSearch, createClarify, createContext } from "./src/extensions/communityFactories.mjs";', resolveDir: root, loader: "js" },
			bundle: true, write: false, metafile: true, minify: true, format: "cjs", target: "es2018", plugins: [piExtensionsPlugin(root)], logLevel: "silent",
		});
		expect(Object.values(built.metafile!.outputs).flatMap(output => output.imports)).toEqual([]);
		const inputs = Object.keys(built.metafile!.inputs);
		for (const name of ["pi-web-search", "pi-clarify", "pi-context"]) expect(inputs).toContain(`pi-scoped-extension:${name}`);
		expect(inputs.some(file => /pi-tui|compat\.js|\/providers\/|\/session-manager\.js/.test(file))).toBe(false);
		const forbidden = () => { throw new Error("Ambient host capability must not be used"); };
		const sandbox = { module: { exports: {} }, URL, TextEncoder, TextDecoder, Headers, Request, Response, ReadableStream, AbortController, console, fetch: forbidden, setTimeout: forbidden, clearTimeout: forbidden };
		vm.runInNewContext(built.outputFiles[0]!.text, sandbox, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
		builders = sandbox.module.exports as typeof builders;
	});

	it("keeps overlapping searches on their own transport, credentials and original citation parser", async () => {
		const makeHost = (name: string) => {
			const requests: Array<{ url: string; headers: Headers; body: string }> = [];
			let respond!: () => void;
			const gate = new Promise<void>(resolve => { respond = resolve; });
			const platform = {
				process: { env: {} }, getAgentDir: () => "/vault/.pi/agent", getEnvApiKey: () => undefined,
				readFileSync: () => { throw Object.assign(new Error("No config"), { code: "ENOENT" }); },
				Text: class { constructor() { throw new Error("Terminal renderer unavailable"); } },
				fetch: async (url: string, init: RequestInit) => {
					requests.push({ url, headers: new Headers(init.headers), body: String(init.body) });
					await gate;
					const events = [
						{ type: "response.output_text.delta", delta: `结果 ${name}` },
						{ type: "response.output_text.annotation.added", annotation: { type: "url_citation", title: `资料 ${name}`, url: `https://${name}.example/source`, end_index: `结果 ${name}`.length } },
						{ type: "response.completed", response: { output: [{ type: "web_search_call", id: `search-${name}`, action: { query: `query ${name}`, sources: [{ title: `资料 ${name}`, url: `https://${name}.example/source` }] } }] } },
					];
					return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
				},
			};
			const registered = collectRegistrations(builders.createWebSearch(platform));
			const model = { provider: name, api: "openai-responses", id: name, baseUrl: `https://${name}.example/api` };
			const ctx = { model, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: `${name}-key` }) } };
			const pending = registered.tools.get("web_search")!.execute(name, { query: `query ${name}` }, new AbortController().signal, undefined, ctx);
			return { requests, respond, pending, registered };
		};
		const first = makeHost("first");
		const second = makeHost("second");
		second.respond();
		const secondResult = await second.pending;
		first.respond();
		const firstResult = await first.pending;
		for (const [name, host, result] of [["first", first, firstResult], ["second", second, secondResult]] as const) {
			expect(host.requests).toHaveLength(1);
			expect(host.requests[0]!.url).toBe(`https://${name}.example/api/responses`);
			expect(host.requests[0]!.headers.get("authorization")).toBe(`Bearer ${name}-key`);
			expect(host.requests[0]!.body).toContain(`query ${name}`);
			expect(result.details?.nativeSearchUsed).toBe(true);
			expect(result.details?.sources).toEqual([{ title: `资料 ${name}`, url: `https://${name}.example/source` }]);
			expect(result.content[0]!.text).toContain(`结果 ${name}`);
		}
	});

	it("routes clarify through its own completion and leaves filesystem writes denied", async () => {
		const errors: string[] = [];
		const outputs: string[] = [];
		const found = { provider: "configured", id: "writer" };
		const platform = {
			getAgentDir: () => "/vault/.pi/agent", existsSync: () => false,
			mkdirSync: () => { throw new Error("Writable resources unavailable"); },
			readFileSync: () => { throw new Error("No config"); }, writeFileSync: () => { throw new Error("Writable resources unavailable"); }, unlinkSync: () => { throw new Error("Writable resources unavailable"); },
			BorderedLoader: class { constructor() { throw new Error("Terminal loader unavailable"); } },
			complete: async (model: unknown, context: { messages: Array<{ content: Array<{ text: string }> }> }, options: { apiKey: string }) => {
				expect(model).toBe(found);
				expect(options.apiKey).toBe("configured-key");
				expect(context.messages[0]!.content[0]!.text).toBe("整理花园记录");
				return { stopReason: "stop", content: [{ type: "text", text: "按季节整理花园记录。" }] };
			},
		};
		const registered = collectRegistrations(builders.createClarify(platform));
		const ctx = { hasUI: true, mode: "print", model: found, modelRegistry: { find: () => found, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "configured-key" }) }, ui: { getEditorText: () => "", setEditorText: (text: string) => outputs.push(text), notify: (message: string) => errors.push(message) } };
		await registered.commands.get("clarify")!.handler("整理花园记录", ctx);
		expect(outputs).toEqual(["按季节整理花园记录。"]);
		await expect(registered.commands.get("clarify")!.handler("model configured writer", ctx)).rejects.toThrow("Writable resources unavailable");
		expect(errors.some(message => message.includes("pinned"))).toBe(false);
		const marker = await registered.handlers.get("input")!({ text: "整理花园记录 -clarify", source: "interactive" }, ctx);
		expect(marker).toEqual({ action: "handled" });
		expect(outputs).toHaveLength(2);
	});

	it("clears context's private acquisition timer when its host shuts down", async () => {
		const timers = new Map<number, () => unknown>();
		let nextTimer = 0;
		const platform = { setTimeout: (callback: () => unknown) => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: (id: number) => timers.delete(id) };
		const tools = new Map<string, ProbeTool>();
		const handlers = new Map<string, ProbeHandler>();
		const sent: string[] = [];
		builders.createContext(platform)({ registerTool: (tool: ProbeTool) => tools.set(tool.name, tool), registerCommand: () => {}, on: (event: string, handler: ProbeHandler) => handlers.set(event, handler), sendUserMessage: (text: string) => sent.push(text) });
		const ctx = { sessionManager: { getBranch: () => [{ type: "message", id: "1234abcd", message: { role: "assistant", content: [{ type: "toolCall", id: "compact", name: "context_compact" }] } }] } };
		const pending = tools.get("context_compact")!.execute("compact", { target: "root", summary: "交接记录" }, new AbortController().signal, undefined, ctx);
		const settled = pending.then(() => "unexpected success", (error: unknown) => String(error));
		expect(sent).toEqual(["/acm"]);
		expect(timers.size).toBe(1);
		handlers.get("session_shutdown")!({}, {});
		expect(await settled).toContain("session closed");
		expect(timers.size).toBe(0);
	});

	it("refuses unknown imports, reachable dynamic loads and unaudited source bytes", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "pi-scoped-audit-"));
		const pkgRoot = path.join(directory, "node_modules/pi-context/src");
		mkdirSync(pkgRoot, { recursive: true });
		try {
			for (const [source, error] of [
				['import fs from "node:child_process"; export default () => fs;', "Unaudited scoped extension dependency"],
				['export default () => import("node:fs");', "Dynamic extension loading is unavailable"],
				['export default () => require("node:fs");', "Dynamic extension loading is unavailable"],
			] as const) {
				writeFileSync(path.join(pkgRoot, "index.ts"), source);
				const audit = { files: { "src/index.ts": createHash("sha256").update(source).digest("hex") } };
				await expect(buildScopedFactory(directory, "pi-context", audit)).rejects.toThrow(error);
			}
			await expect(buildScopedFactory(directory, "pi-context", { files: { "src/index.ts": "changed" } })).rejects.toThrow("Audited extension file changed");
			await expect(buildScopedFactory(directory, "pi-context", { files: {} })).rejects.toThrow("Unaudited extension source");
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});
});
