import { afterAll, describe, expect, it } from "bun:test";
import { build } from "esbuild";
import { createHash, webcrypto } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { CommunityHost } from "../src/extensions/communityHost";
import { createExtensionConfigStore, type ExtensionConfigData } from "../src/extensions/extensionConfigStore";
import type { BackgroundExtensionPlatform } from "../src/extensions/extensionPlatform";
import { stubWindowMembers, stubWindowTimers } from "../src/testUtils/windowStub";
import { buildScopedFactory } from "./pi-scoped-factories.mjs";

const restore = stubWindowTimers();
const restoreCrypto = stubWindowMembers({ crypto: webcrypto });
afterAll(() => { restoreCrypto(); restore(); });

describe("compiled background extension with the real host", () => {
	it("owns dependency requests and timers across two conversations and unloading", async () => {
		const root = process.cwd();
		const directory = mkdtempSync(path.join(tmpdir(), "piem-background-compiled-"));
		const hosts: CommunityHost[] = [];
		const install = (name: string, fixture: string) => {
			const packageRoot = path.join(directory, "node_modules", name);
			mkdirSync(packageRoot, { recursive: true });
			const source = readFileSync(fixture, "utf8");
			writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
			writeFileSync(path.join(packageRoot, "index.mjs"), source);
			return { entry: "index.mjs", version: "1.0.0", files: { "index.mjs": createHash("sha256").update(source).digest("hex") } };
		};
		try {
			const dependency = install("@piem-bridge/contract-dependency", "scripts/fixtures/scoped-extension-dependency.mjs");
			const audit = { ...install("contract", "scripts/fixtures/scoped-extension-contract.mjs"), dependencies: { "@piem-bridge/contract-dependency": dependency } };
			const { contents } = await buildScopedFactory(directory, "contract", audit);
			const built = await build({
				stdin: { contents, resolveDir: root, loader: "js" }, bundle: true, write: false, metafile: true, minify: true, platform: "browser", format: "cjs", logLevel: "silent",
				plugins: [{ name: "repository-bridge", setup(build) {
					build.onResolve({ filter: /[/\\]src[/\\]extensions[/\\](node|compat)[/\\]/ }, args => {
						if (args.path.startsWith(`${directory}${path.sep}`)) return { path: path.join(root, path.relative(directory, args.path)) };
						return undefined;
					});
				} }],
			});
			expect(Object.values(built.metafile!.outputs).flatMap(output => output.imports)).toEqual([]);
			const forbidden = () => { throw new Error("Ambient capability used"); };
			const sandbox = { module: { exports: {} }, URL, TextEncoder, TextDecoder, window: { crypto: webcrypto }, fetch: forbidden, setTimeout: forbidden, clearTimeout: forbidden, setInterval: forbidden, clearInterval: forbidden };
			vm.runInNewContext(built.outputFiles[0]!.text, sandbox, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
			const createFactory = (sandbox.module.exports as { createFactory(platform: BackgroundExtensionPlatform): ExtensionFactory }).createFactory;
			const makeHost = async (name: string) => {
				let data: ExtensionConfigData | undefined;
				const requests: string[] = [], notices: string[] = [];
				const host = await CommunityHost.create({
					getEntries: () => [], getBranch: () => [], getSessionId: () => name,
					notify: text => notices.push(text), prepare: async () => {}, deliver: () => {},
					platform: {
						fetch: async () => { throw new Error("Unexpected foreground fetch"); },
						backgroundFetch: async (_input, init) => { const body = String(init?.body); requests.push(body); return new Response(`${name}:${body}`); },
						config: createExtensionConfigStore({ getData: () => data, setData: value => { data = value; }, persist: async () => {}, queue: task => task() }),
						onError: error => { notices.push(String(error)); },
					},
				}, [{ id: "contract", createFactory }]);
				hosts.push(host);
				return { host, requests, notices };
			};
			const one = await makeHost("one"), two = await makeHost("two");
			await one.host.run("bridge-probe", "first");
			await two.host.run("bridge-probe", "second");
			expect(JSON.parse(one.notices[0]!)).toMatchObject({ value: "first", direct: "one:first", dependent: "one:first", config: { value: "first" } });
			expect(JSON.parse(two.notices[0]!)).toMatchObject({ value: "second", direct: "two:second", dependent: "two:second", config: { value: "second" } });
			await one.host.run("bridge-start", "first");
			await two.host.run("bridge-start", "second");
			expect(one.host.busy).toBe(false); expect(two.host.busy).toBe(false);
			await new Promise(resolve => setTimeout(resolve, 25));
			expect(one.requests).toContain("interval:first"); expect(two.requests).toContain("interval:second");
			one.host.dispose(); await one.host.closed();
			const before = one.requests.length, otherBefore = two.requests.length;
			await new Promise(resolve => setTimeout(resolve, 25));
			expect(one.requests).toHaveLength(before);
			expect(two.requests.length).toBeGreaterThan(otherBefore);
			await two.host.run("bridge-stop", "");
			const stopped = two.requests.length;
			await new Promise(resolve => setTimeout(resolve, 20));
			expect(two.requests).toHaveLength(stopped);
			expect(vm.runInNewContext("[typeof require, typeof process, typeof Buffer, typeof Bun]", sandbox)).toEqual(["undefined", "undefined", "undefined", "undefined"]);
		} finally {
			for (const host of hosts) { host.dispose(); await host.closed().catch(() => {}); }
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
