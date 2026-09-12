import { afterEach, describe, expect, it } from "bun:test";
import { build } from "esbuild";
import { createHash, webcrypto } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createExtensionPlatform, type BackgroundExtensionPlatform } from "../src/extensions/extensionPlatform";
import { stubWindowTimers } from "../src/testUtils/windowStub";
import { buildScopedFactory } from "./pi-scoped-factories.mjs";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const registryKey = "piem.test.scoped.registry";

async function compile(source: string) {
	const directory = mkdtempSync(path.join(tmpdir(), "pi-scoped-globals-"));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	const packageRoot = path.join(directory, "node_modules/contract");
	mkdirSync(packageRoot, { recursive: true });
	writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "1.0.0" }));
	writeFileSync(path.join(packageRoot, "index.mjs"), source);
	const audit = { entry: "index.mjs", version: "1.0.0", files: { "index.mjs": createHash("sha256").update(source).digest("hex") } };
	const compiled = await buildScopedFactory(directory, "contract", audit);
	const output = await build({
		stdin: { contents: compiled.contents, resolveDir: process.cwd(), loader: "js" },
		bundle: true, write: false, metafile: true, minify: true, format: "cjs", platform: "browser", logLevel: "silent",
		plugins: [{ name: "repository-globals", setup(build) {
			build.onResolve({ filter: /[/\\]src[/\\]extensions[/\\]/ }, args => {
				if (args.path.startsWith(`${directory}${path.sep}`)) return { path: path.join(process.cwd(), path.relative(directory, args.path)) };
				return undefined;
			});
		} }],
	});
	expect(Object.values(output.metafile!.outputs).flatMap(item => item.imports)).toEqual([]);
	const forbidden = (): never => { throw new Error("Ambient host capability escaped"); };
	const sandbox = {
		module: { exports: {} }, URL, URLSearchParams, Headers, Request, Response, AbortController, AbortSignal, DOMException, TextEncoder, TextDecoder,
		[Symbol.for(registryKey)]: "ambient", Bun: { sentinel: true },
		window: { crypto: webcrypto, performance, fetch: forbidden },
		fetch: forbidden, setTimeout: forbidden, clearTimeout: forbidden, setInterval: forbidden, clearInterval: forbidden,
		process: new Proxy({}, { get: forbidden }), Buffer: new Proxy({}, { get: forbidden }),
	};
	vm.runInNewContext(output.outputFiles[0]!.text, sandbox, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
	return { compiled, sandbox, create: (sandbox.module.exports as { createFactory(platform: BackgroundExtensionPlatform): () => Record<string, any> }).createFactory };
}
function background() {
	cleanups.push(stubWindowTimers());
	const requests: string[] = [];
	const host = createExtensionPlatform({
		fetch: async () => { throw new Error("Unexpected foreground transport"); },
		backgroundFetch: async input => { requests.push(String(input)); return new Response("ok"); },
		complete: async () => { throw new Error("Unexpected model request"); },
		onError: error => { throw error; },
	});
	cleanups.push(() => host.dispose());
	return { host, requests };
}

describe("scoped global aliases", () => {
	it("keeps alias and computed registries private without changing lexical names or the host", async () => {
		const fixture = await compile(`
			const scope = globalThis;
			const key = Symbol.for(${JSON.stringify(registryKey)});
			const { fetch: request, process: privateProcess, ...rest } = scope;
			function local(globalThis) { const alias = globalThis; return alias.fetch; }
			export default () => ({
				write: value => { scope[key] = value; privateProcess.env.TEST = value; },
				read: () => scope[key], remove: () => delete scope[key], request,
				check: () => ({ identities: scope === globalThis && scope === global && scope === self && scope === window && scope.self === scope,
					fetch: scope.fetch === fetch && rest.setTimeout === setTimeout, local: local({ fetch: "local" }),
					prototype: Object.getPrototypeOf(scope) === null, escaped: [Bun, navigator, XMLHttpRequest, ...["require", "module", "Bun", "navigator", "XMLHttpRequest"].map(key => scope[key])].some(value => value !== undefined),
					document: scope.document === document, url: new scope.URL("https://example.test/path").host }),
				mutate: () => Reflect.setPrototypeOf(scope, { fetch: "ambient" }),
				retained: () => ({ request, timeout: scope.setTimeout, env: privateProcess.env }),
			});
		`);
		const { host, requests } = background();
		const one = host.forBackgroundExtension("one"), two = host.forBackgroundExtension("two");
		const first = fixture.create(one.platform)(), second = fixture.create(two.platform)();
		first.write("one"); second.write("two");
		expect(first.read()).toBe("one"); expect(second.read()).toBe("two");
		expect(first.check()).toEqual({ identities: true, fetch: true, local: "local", prototype: true, escaped: false, document: true, url: "example.test" });
		expect(first.mutate()).toBe(false);
		expect(() => fixture.create(host.forExtension("foreground") as BackgroundExtensionPlatform)).toThrow("owned background lifetime");
		expect(fixture.sandbox[Symbol.for(registryKey)]).toBe("ambient");
		const retained = first.retained();
		await retained.request("https://first.example/test");
		expect(requests).toEqual(["https://first.example/test"]);
		one.dispose();
		await expect(retained.request("https://first.example/late")).rejects.toMatchObject({ name: "AbortError" });
		expect(() => retained.timeout(() => {}, 0)).toThrow("disposed");
		expect(() => retained.env.TEST).toThrow("disposed");
		expect(() => { retained.env.TEST = "late"; }).toThrow("disposed");
		first.remove();
		expect(second.read()).toBe("two");
		await second.request("https://second.example/test");
		expect(requests).toEqual(["https://first.example/test", "https://second.example/test"]);
	});

	it("does not include unused global or document views for direct scoped APIs", async () => {
		const fixture = await compile('export default () => ({ run: () => fetch("https://example.test"), timer: () => globalThis.setTimeout(() => {}, 1) });');
		expect(fixture.compiled.contents).not.toContain("extensionGlobals");
		expect(fixture.compiled.contents).not.toContain("createExtensionDocument");
	});

	it("still refuses indirect runtime loaders and unaudited Node imports", async () => {
		for (const source of [
			'const browser = globalThis; const load = browser.require; export default name => load(name);',
			'const browser = globalThis; const { require: load } = browser; export default name => load(name);',
			'export default name => import(name);',
			'import { connect } from "node:net"; export default () => connect;',
		]) await expect(compile(source)).rejects.toThrow();
	});
});
