import { describe, expect, it } from "bun:test";
import { build } from "esbuild";
import { createHash, webcrypto } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { buildScopedFactory } from "./pi-scoped-factories.mjs";

interface Audit {
	entry: string;
	version: string;
	files: Record<string, string>;
	virtualRoot?: string;
	exports?: Record<string, string>;
	browser?: Record<string, string>;
	dependencies?: Record<string, Audit>;
}
const root = process.cwd();
const digest = (source: string): string => createHash("sha256").update(source).digest("hex");

function fixture() {
	const directory = mkdtempSync(path.join(tmpdir(), "pi-scoped-contract-"));
	function install(name: string, files: Record<string, string>, entry = "index.mjs", dependencies?: Record<string, Audit>): Audit {
		const packageRoot = path.join(directory, "node_modules", name);
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "unreviewed.cjs", browser: "unreviewed.cjs" }));
		for (const [file, source] of Object.entries(files)) {
			mkdirSync(path.dirname(path.join(packageRoot, file)), { recursive: true });
			writeFileSync(path.join(packageRoot, file), source);
		}
		return { entry, version: "1.0.0", files: Object.fromEntries(Object.entries(files).map(([file, source]) => [file, digest(source)])), dependencies };
	}
	return { directory, install, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

type ProbeContext = { ui: { notify(text: string): void } };
type Handler = (args: string, context: ProbeContext) => unknown;
type Factory = (pi: { registerCommand(name: string, command: { handler: Handler }): void; on(event: string, handler: () => unknown): void }) => void;

async function compileFixture(directory: string, audit: Audit): Promise<(platform: object) => Factory> {
	const { contents } = await buildScopedFactory(directory, "contract", audit);
	const result = await build({
		stdin: { contents, resolveDir: root, loader: "js" },
		bundle: true, write: false, metafile: true, minify: true, format: "cjs", platform: "browser", logLevel: "silent",
		plugins: [{ name: "contract-repository-primitives", setup(build) {
			build.onResolve({ filter: /[/\\]src[/\\]extensions[/\\](node|compat)[/\\]/ }, args => {
				if (!args.path.startsWith(`${directory}${path.sep}`)) return;
				return { path: path.join(root, path.relative(directory, args.path)) };
			});
		} }],
	});
	expect(Object.values(result.metafile!.outputs).flatMap(output => output.imports)).toEqual([]);
	const forbidden = (): never => { throw new Error("Ambient host capability escaped the scoped compiler."); };
	const sandbox = {
		module: { exports: {} }, URL, TextEncoder, TextDecoder, Headers, Request, Response, AbortController,
		fetch: forbidden, setTimeout: forbidden, clearTimeout: forbidden, setInterval: forbidden, clearInterval: forbidden,
		process: new Proxy({}, { get: forbidden }), Buffer: new Proxy({}, { get: forbidden }),
		window: { crypto: webcrypto, fetch: forbidden, setTimeout: forbidden, clearTimeout: forbidden, setInterval: forbidden, clearInterval: forbidden },
	};
	vm.runInNewContext(result.outputFiles[0]!.text, sandbox, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
	return (sandbox.module.exports as { createFactory(platform: object): Factory }).createFactory;
}

function probePlatform(id: number) {
	const env: Record<string, string | undefined> = {};
	const files = new Map<string, string>();
	const timers = new Map<number, () => unknown>();
	const requests: string[] = [];
	const notices: string[] = [];
	const commands = new Map<string, Handler>();
	const events = new Map<string, () => unknown>();
	let timer = 0;
	const schedule = (callback: () => unknown): number => { timers.set(++timer, callback); return timer; };
	const clear = (id?: number): void => { if (id !== undefined) timers.delete(id); };
	return {
		env, files, timers, requests, notices, commands, events,
		platform: {
			fetch: (url: string, init: RequestInit) => { requests.push(`${url}:${String(init.body)}`); return Promise.resolve(new Response(`host-${id}:${String(init.body)}`)); },
			process: { env, pid: id, cwd: () => "/vault" }, getAgentDir: () => "/extensions/config",
			readFileSync: (file: string) => files.get(file), existsSync: (file: string) => files.has(file),
			mkdirSync: () => {}, writeFileSync: (file: string, value: string) => files.set(file, value), unlinkSync: (file: string) => files.delete(file),
			readdirSync: () => [...files.keys()].map(file => path.basename(file)),
			setTimeout: schedule, clearTimeout: clear, setInterval: schedule, clearInterval: clear,
			timersPromises: { setTimeout: (_delay: number, value: unknown) => Promise.resolve(value) },
		},
		register: {
			registerCommand: (name: string, command: { handler: Handler }) => { commands.set(name, command.handler); },
			on: (event: string, handler: () => unknown) => { events.set(event, handler); },
		},
		async run(name: string, args: string) { await commands.get(name)!(args, { ui: { notify: text => notices.push(text) } }); },
	};
}

describe("generic scoped extension compiler", () => {
	it("binds an audited dependency graph to separate hosts without ambient Node, timers or fetch", async () => {
		const setup = fixture();
		try {
			const dependency = setup.install("@piem-bridge/contract-dependency", { "index.mjs": readFileSync("scripts/fixtures/scoped-extension-dependency.mjs", "utf8") });
			const audit = setup.install("contract", { "index.mjs": readFileSync("scripts/fixtures/scoped-extension-contract.mjs", "utf8") }, "index.mjs", { "@piem-bridge/contract-dependency": dependency });
			const createFactory = await compileFixture(setup.directory, audit);
			const first = probePlatform(1);
			const second = probePlatform(2);
			createFactory(first.platform)(first.register);
			createFactory(second.platform)(second.register);
			await first.run("bridge-probe", "第一");
			await second.run("bridge-probe", "第二");
			for (const [host, id, value] of [[first, 1, "第一"], [second, 2, "第二"]] as const) {
				expect(JSON.parse(host.notices[0]!)).toMatchObject({
					value, globalValue: value, pid: id, cwd: "/vault", home: "/vault", direct: `host-${id}:${value}`, dependent: `host-${id}:${value}`,
					config: { value }, files: ["contract.json"], exists: true, buffer: Buffer.from(value).toString("base64"), bufferIdentity: true,
					processIdentity: true, timerIdentity: true, promiseIdentity: true, digest: digest(value), schema: "string", url: "file:///extensions/contract/index.mjs",
				});
				expect(host.requests).toHaveLength(2);
				expect(host.env.BRIDGE_CONTRACT).toBe(value);
				await host.run("bridge-start", value);
				expect(host.timers.size).toBe(2);
			}
			await first.run("bridge-stop", "");
			expect(first.timers.size).toBe(0);
			expect(second.timers.size).toBe(2);
			for (const callback of second.timers.values()) await callback();
			expect(first.requests).toHaveLength(2);
			expect(second.requests).toHaveLength(4);
			second.events.get("session_shutdown")!();
			expect(second.timers.size).toBe(0);
		} finally { setup.dispose(); }
	});

	it("keeps local names and optional globals intact while binding destructured capabilities", async () => {
		const setup = fixture();
		try {
			const audit = setup.install("contract", { "index.mjs": `
				import { pid as platform } from "node:process";
				const __piemPlatform = "kept";
				const { fetch: transport, process: environment } = globalThis;
				function local(globalThis) { return globalThis?.["fetch"]; }
				export default pi => pi.registerCommand("names", { handler: async (_args, ctx) => {
					const response = await transport("https://bridge.example/names", { body: __piemPlatform });
					ctx.ui.notify(JSON.stringify({ value: await response.text(), pid: platform, same: environment === process, optional: local(null) === undefined }));
				} });
			` });
			const createFactory = await compileFixture(setup.directory, audit);
			const host = probePlatform(9);
			createFactory(host.platform)(host.register);
			await host.run("names", "");
			expect(JSON.parse(host.notices[0]!)).toEqual({ value: "host-9:kept", pid: 9, same: true, optional: true });
		} finally { setup.dispose(); }
	});

	it("uses only explicitly audited package subpaths, sharing one dependency version and source audit", async () => {
		const setup = fixture();
		try {
			const dependency = setup.install("@piem-bridge/library", {
				"index.mjs": "export const value = 1;",
				"settings.mjs": "export const setting = 2;",
				"browser-http.mjs": 'import { setting } from "./settings.mjs"; export const browserHttp = setting + 1;',
				"private.mjs": "export const hidden = 4;",
			});
			dependency.exports = { "./settings": "settings.mjs", "./browser-http": "browser-http.mjs" };
			const audit = setup.install("contract", { "index.mjs": `
				import { value } from "@piem-bridge/library";
				import { setting } from "@piem-bridge/library/settings";
				import { browserHttp } from "@piem-bridge/library/browser-http";
				export default pi => pi.registerCommand("subpaths", { handler: (_args, ctx) => ctx.ui.notify(JSON.stringify([value, setting, browserHttp])) });
			` }, "index.mjs", { "@piem-bridge/library": dependency });
			const createFactory = await compileFixture(setup.directory, audit);
			const host = probePlatform(3);
			createFactory(host.platform)(host.register);
			await host.run("subpaths", "");
			expect(JSON.parse(host.notices[0]!)).toEqual([1, 2, 3]);

			const privateAudit = setup.install("contract", { "index.mjs": 'import { hidden } from "@piem-bridge/library/private"; export default () => hidden;' }, "index.mjs", { "@piem-bridge/library": dependency });
			await expect(buildScopedFactory(setup.directory, "contract", privateAudit)).rejects.toThrow("Unaudited scoped extension dependency: @piem-bridge/library/private");
			for (const [exports, error] of [
				[{ "./settings": "unreviewed.mjs" }, "Unaudited extension source"],
				[{ "./settings": "../escape.mjs" }, "Invalid audited source path"],
				[{ "./../settings": "settings.mjs" }, "Invalid audited source path"],
				[{ "./*": "settings.mjs" }, "Invalid audited export"],
			] as const) {
				dependency.exports = exports;
				await expect(buildScopedFactory(setup.directory, "contract", privateAudit)).rejects.toThrow(error);
			}
		} finally { setup.dispose(); }
	});

	it("matches esbuild for dotted basenames, file-before-directory resolution and TypeScript replacements", async () => {
		const setup = fixture();
		try {
			const audit = setup.install("contract", {
				"index.mjs": `
					import merge from "./lodash.merge";
					import ts from "./typescript.js";
					import js from "./existing.js";
					import mts from "./module.mjs";
					import cts from "./classic.cjs";
					import file from "./choice";
					import suffix from "./tricky.js";
					import directory from "./dir.with.dot";
					export default pi => pi.registerCommand("resolution", { handler: (_args, ctx) => ctx.ui.notify(JSON.stringify([merge, ts, js, mts, cts, file, suffix, directory])) });
				`,
				"lodash.merge.js": 'export default "merge";',
				"typescript.ts": 'const value: string = "typescript"; export default value;',
				"existing.js": 'export default "javascript";',
				"existing.ts": 'export default "wrong-existing";',
				"module.mts": 'export default "mts";',
				"classic.cts": 'export default "cts";',
				"choice.js": 'export default "file";',
				"choice/index.tsx": 'export default "wrong-directory";',
				"tricky.js.ts": 'export default "suffix";',
				"tricky.ts": 'export default "wrong-replacement";',
				"dir.with.dot/index.js": 'export default "directory";',
			});
			const reference = await build({
				entryPoints: [path.join(setup.directory, "node_modules/contract/index.mjs")],
				bundle: true, write: false, format: "cjs", platform: "browser", logLevel: "silent",
			});
			const sandbox = { module: { exports: {} } };
			vm.runInNewContext(reference.outputFiles[0]!.text, sandbox, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
			const expected = probePlatform(1);
			(sandbox.module.exports as { default: Factory }).default(expected.register);
			await expected.run("resolution", "");
			expect(JSON.parse(expected.notices[0]!)).toEqual(["merge", "typescript", "javascript", "mts", "cts", "file", "suffix", "directory"]);

			const createFactory = await compileFixture(setup.directory, audit);
			const actual = probePlatform(2);
			createFactory(actual.platform)(actual.register);
			await actual.run("resolution", "");
			expect(actual.notices).toEqual(expected.notices);
		} finally { setup.dispose(); }
	});

	it("uses audited browser file mappings for entries, package subpaths and internal imports", async () => {
		const setup = fixture();
		try {
			const dependency = setup.install("library", {
				"browser.js": 'export { value } from "./platform/index";',
				"platform/index.js": 'import "node:net"; throw new Error("Node source must never load");',
				"platform/browser.js": 'export const value = "browser";',
			}, "node.js");
			dependency.exports = { "./platform": "platform/index.js" };
			dependency.browser = { "./node.js": "./browser.js", "./platform/index.js": "./platform/browser.js" };
			const audit = setup.install("contract", {
				"browser.mjs": `
					import { value } from "library";
					import { value as platform } from "library/platform";
					export default pi => pi.registerCommand("browser", { handler: (_args, ctx) => ctx.ui.notify(JSON.stringify([value, platform])) });
				`,
			}, "node.mjs", { library: dependency });
			audit.browser = { "./node.mjs": "./browser.mjs" };
			const host = probePlatform(1);
			(await compileFixture(setup.directory, audit))(host.platform)(host.register);
			await host.run("browser", "");
			expect(JSON.parse(host.notices[0]!)).toEqual(["browser", "browser"]);

			// Published browser metadata alone must not authorize any redirection.
			writeFileSync(path.join(setup.directory, "node_modules/library/package.json"), JSON.stringify({ version: "1.0.0", browser: dependency.browser }));
			delete dependency.browser;
			await expect(buildScopedFactory(setup.directory, "contract", audit)).rejects.toThrow("Unaudited extension source: library/node.js");
		} finally { setup.dispose(); }
	});

	it("rejects browser redirects outside the reviewed files and still hashes redirected-away sources", async () => {
		const setup = fixture();
		try {
			const audit = setup.install("contract", { "index.mjs": "export default () => {};", "browser.mjs": "export default () => {};" });
			for (const [browser, error] of [
				[{ "./index.mjs": "./unreviewed.mjs" }, "Unaudited extension source"],
				[{ "./index.mjs": "./../escape.mjs" }, "Invalid audited source path"],
				[{ "./../index.mjs": "./browser.mjs" }, "Invalid audited source path"],
				[{ "./index.mjs": "./node_modules/library/index.js" }, "Invalid audited source path"],
				[{ "./index.mjs": "library" }, "Invalid audited browser mapping"],
				[{ "node:fs": "./browser.mjs" }, "Invalid audited browser mapping"],
				[{ "./*": "./browser.mjs" }, "Invalid audited browser mapping"],
				[{ "./index.mjs": false }, "Invalid audited browser mapping"],
				["./browser.mjs", "Invalid audited browser map"],
			] as const) {
				await expect(buildScopedFactory(setup.directory, "contract", { ...audit, browser })).rejects.toThrow(error);
			}
			audit.browser = { "./index.mjs": "./browser.mjs" };
			const entry = path.join(setup.directory, "node_modules/contract/index.mjs");
			writeFileSync(entry, "changed");
			await expect(buildScopedFactory(setup.directory, "contract", audit)).rejects.toThrow("Audited extension file changed: contract/index.mjs");
			writeFileSync(entry, "export default () => {};");
			const target = path.join(setup.directory, "node_modules/contract/browser.mjs");
			writeFileSync(target, "changed");
			await expect(buildScopedFactory(setup.directory, "contract", audit)).rejects.toThrow("Audited extension file changed: contract/browser.mjs");
			rmSync(target);
			const outside = path.join(setup.directory, "outside.mjs");
			writeFileSync(outside, "export default () => {};");
			symlinkSync(outside, target);
			await expect(buildScopedFactory(setup.directory, "contract", audit)).rejects.toThrow("Audited source escaped its package: contract/browser.mjs");
		} finally { setup.dispose(); }
	});

	it("refuses unaudited dependency edges, changed source, changed versions and escaping paths", async () => {
		const setup = fixture();
		try {
			const dependency = setup.install("library", { "index.mjs": "export const value = 7;", "unused.mjs": "export const spare = 1;" });
			const audit = setup.install("contract", { "index.mjs": 'import { value } from "library"; export default () => value;' });
			await expect(buildScopedFactory(setup.directory, "contract", audit)).rejects.toThrow("Unaudited scoped extension dependency");
			audit.dependencies = { library: dependency };
			expect((await buildScopedFactory(setup.directory, "contract", audit)).watchFiles).toContain(path.join(setup.directory, "node_modules/library/unused.mjs"));
			writeFileSync(path.join(setup.directory, "node_modules/library/unused.mjs"), "changed");
			await expect(buildScopedFactory(setup.directory, "contract", audit)).rejects.toThrow("Audited extension file changed: library/unused.mjs");
			writeFileSync(path.join(setup.directory, "node_modules/library/unused.mjs"), "export const spare = 1;");
			dependency.version = "2.0.0";
			await expect(buildScopedFactory(setup.directory, "contract", audit)).rejects.toThrow("Re-audit library before upgrading");
			dependency.version = "1.0.0";
			dependency.entry = "../escape.mjs";
			await expect(buildScopedFactory(setup.directory, "contract", audit)).rejects.toThrow("Invalid audited source path");
			dependency.entry = "index.mjs";
			rmSync(path.join(setup.directory, "node_modules/library/index.mjs"));
			symlinkSync(path.join(setup.directory, "node_modules/contract/index.mjs"), path.join(setup.directory, "node_modules/library/index.mjs"));
			await expect(buildScopedFactory(setup.directory, "contract", audit)).rejects.toThrow("Audited source escaped its package");
		} finally { setup.dispose(); }
	});

	it("rejects unknown builtins, missing static source and runtime loads including computed imports", async () => {
		const setup = fixture();
		try {
			for (const [source, error] of [
				['import { spawn } from "node:child_process"; export default () => spawn;', "Unaudited scoped extension dependency"],
				['import "./unreviewed.mjs"; export default () => {};', "Unaudited extension source"],
				['export default path => import(path);', "Dynamic extension loading is unavailable"],
				['export default path => require(path);', "Dynamic extension loading is unavailable"],
				['const load = require; export default path => load(path);', "Dynamic extension loading is unavailable"],
				['const load = globalThis["require"]; export default path => load(path);', "Dynamic extension loading is unavailable"],
				['const load = module.require; export default path => load(path);', "Dynamic extension loading is unavailable"],
				['const { require: load } = globalThis; export default path => load(path);', "Dynamic extension loading is unavailable"],
			] as const) {
				const audit = setup.install("contract", { "index.mjs": source });
				await expect(buildScopedFactory(setup.directory, "contract", audit)).rejects.toThrow(error);
			}
		} finally { setup.dispose(); }
	});
});
