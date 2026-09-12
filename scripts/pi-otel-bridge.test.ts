import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { build } from "esbuild";
import { createHash, webcrypto } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { CommunityHost } from "../src/extensions/communityHost";
import type { BackgroundExtensionPlatform } from "../src/extensions/extensionPlatform";
import { stubWindowMembers, stubWindowTimers } from "../src/testUtils/windowStub";
import { buildScopedFactory } from "./pi-scoped-factories.mjs";

const root = process.cwd();
const registryKey = "piem.otel.bridge.contract";
let directory: string;
let compiled: string;

// Small source-shape contract, not a substitute for running the real SDK:
// core's browser redirect/lodash.merge import, api's global alias/Symbol registry,
// and the trace/log processors' visibilitychange + pagehide listeners.
const sdkFiles = {
	"index.js": 'export { processor, release } from "./platform/index.js";',
	"platform/index.js": 'throw new Error("Node implementation selected");',
	"global.js": `
		export const key = Symbol.for("${registryKey}");
		export const _global = typeof globalThis === "object" ? globalThis
			: typeof self === "object" ? self : typeof window === "object" ? window
			: typeof global === "object" ? global : {};
		export const same = () => _global === globalThis && _global === self && _global === window && _global === global;
	`,
	"lodash.merge.js": 'export const transportTag = "browser";',
	"platform/browser.js": `
		import { _global, key, same } from "../global.js";
		import { transportTag } from "../lodash.merge";
		export const release = () => { delete _global[key]; };
		export function processor(signal) {
			_global[key] ??= { session: process.env.CONTRACT_SESSION };
			const snapshot = () => ({ session: _global[key]?.session, signal, transportTag,
				sameGlobals: same(), sameRegistry: globalThis[key] === _global[key],
				sameDocument: document === _global.document, hasDocument: typeof document !== "undefined" });
			const flush = (reason, event) => _global.fetch("https://bridge.invalid/v1/" + signal, {
				method: "POST", body: JSON.stringify({ ...snapshot(), reason,
					documentEscape: !!document.defaultView || !!document.ambientToken,
					eventEscape: !!event?.target?.ambientToken || !!event?.currentTarget?.ambientToken,
				}),
			});
			const visibility = event => { if (document.visibilityState === "hidden") void flush("hidden", event); };
			const pagehide = event => { void flush("pagehide", event); };
			if (typeof document !== "undefined") {
				document.addEventListener("visibilitychange", visibility);
				document.addEventListener("pagehide", pagehide);
			}
			return { snapshot, async shutdown() {
				document.removeEventListener("visibilitychange", visibility);
				document.removeEventListener("pagehide", pagehide);
				await flush("shutdown");
			} };
		}
	`,
};
const entry = `
	import { processor, release } from "otel-contract-sdk";
	import { setTimeout as delay } from "node:timers/promises";
	const browser = globalThis;
	export default pi => {
		const processors = [processor("traces"), processor("logs")];
		if (browser.process.env.FAIL_LOAD === "true") throw new Error("fixture load failed");
		pi.on("session_start", () => {});
		pi.registerCommand("bridge-state", { handler: (_args, ctx) => ctx.ui.notify(JSON.stringify(processors[0].snapshot())) });
		pi.on("session_shutdown", async () => {
			if (browser.process.env.HANG_SHUTDOWN === "true") await delay(60000);
			await Promise.all(processors.map(value => value.shutdown()));
			release();
		});
	};
`;

beforeAll(async () => {
	directory = mkdtempSync(path.join(tmpdir(), "piem-otel-contract-"));
	const install = (name: string, files: Record<string, string>) => {
		const packageRoot = path.join(directory, "node_modules", name);
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
		for (const [file, source] of Object.entries(files)) {
			mkdirSync(path.dirname(path.join(packageRoot, file)), { recursive: true });
			writeFileSync(path.join(packageRoot, file), source);
		}
		return { entry: "index.js", version: "1.0.0", files: Object.fromEntries(Object.entries(files).map(([file, source]) => [file, createHash("sha256").update(source).digest("hex")])) };
	};
	const sdk = { ...install("otel-contract-sdk", sdkFiles), browser: { "./platform/index.js": "./platform/browser.js" } };
	const audit = { ...install("otel-contract", { "index.js": entry }), dependencies: { "otel-contract-sdk": sdk } };
	const { contents } = await buildScopedFactory(directory, "otel-contract", audit);
	const result = await build({
		stdin: { contents, resolveDir: root, loader: "js" }, bundle: true, write: false, metafile: true,
		minify: true, platform: "browser", format: "cjs", logLevel: "silent",
		plugins: [{ name: "contract-repository-bridge", setup(builder) {
			builder.onResolve({ filter: /[/\\]src[/\\]extensions[/\\]/ }, args => {
				if (args.path.startsWith(`${directory}${path.sep}`)) return { path: path.join(root, path.relative(directory, args.path)) };
				return undefined;
			});
		} }],
	});
	expect(Object.values(result.metafile!.outputs).flatMap(output => output.imports)).toEqual([]);
	compiled = result.outputFiles[0]!.text;
});
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

type HostPageEvent = { type: string; timeStamp: number; target: HostDocument; currentTarget: HostDocument };
class HostDocument {
	visibilityState = "visible";
	readonly ambientToken = "real document";
	readonly defaultView = { ambientToken: "real window" };
	private readonly listeners = new Map<string, Set<(event: HostPageEvent) => void>>();
	addEventListener(type: string, callback: (event: HostPageEvent) => void): void {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set());
		this.listeners.get(type)!.add(callback);
	}
	removeEventListener(type: string, callback: (event: HostPageEvent) => void): void { this.listeners.get(type)?.delete(callback); }
	dispatch(type: string): void {
		for (const callback of this.listeners.get(type) ?? []) callback({ type, timeStamp: 1, target: this, currentTarget: this });
	}
	get listenerCount(): number { return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0); }
}

type Receipt = { session: string; signal: string; reason: string; sameGlobals: boolean; sameRegistry: boolean; sameDocument: boolean; hasDocument: boolean; documentEscape: boolean; eventEscape: boolean; transportTag: string };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function harness() {
	const document = new HostDocument();
	const restoreTimers = stubWindowTimers();
	const restoreDocument = stubWindowMembers({ document });
	const forbidden = () => { throw new Error("An extension used an ambient host capability."); };
	const sandbox = {
		module: { exports: {} }, URL, URLSearchParams, TextEncoder, TextDecoder, Headers, Request, Response, AbortController, AbortSignal, DOMException,
		window: { document, crypto: webcrypto },
		fetch: forbidden, setTimeout: forbidden, clearTimeout: forbidden, setInterval: forbidden, clearInterval: forbidden,
		[Symbol.for(registryKey)]: { session: "ambient registration" },
	};
	vm.runInNewContext(compiled, sandbox, { timeout: 1500, contextCodeGeneration: { strings: false, wasm: false } });
	const createFactory = (sandbox.module.exports as { createFactory(platform: BackgroundExtensionPlatform): ExtensionFactory }).createFactory;
	const hosts: CommunityHost[] = [];
	return {
		document, sandbox,
		async host(name: string, mode?: "failure" | "hang") {
			const receipts: Receipt[] = [], notices: string[] = [];
			const errors: unknown[] = [];
			let listenersAtNextFactory: number | undefined;
			const host = await CommunityHost.create({
				getEntries: () => [], getBranch: () => [], getSessionId: () => name,
				notify: text => notices.push(text), prepare: async () => {}, deliver: () => {},
				platform: {
					fetch: async () => { throw new Error("Unexpected foreground fetch"); },
					backgroundFetch: async (_input, init) => { receipts.push(JSON.parse(String(init?.body)) as Receipt); return new Response("{}"); },
					onError: error => { errors.push(error); },
				},
			}, [
				{ id: "otel-contract", createFactory(platform) {
					platform.process.env.CONTRACT_SESSION = name;
					platform.process.env.FAIL_LOAD = String(mode === "failure");
					platform.process.env.HANG_SHUTDOWN = String(mode === "hang");
					return createFactory(platform);
				} },
				{ id: "healthy", factory: () => { listenersAtNextFactory = document.listenerCount; } },
			]);
			hosts.push(host);
			await host.start();
			return { host, receipts, notices, errors, listenersAtNextFactory };
		},
		async dispose() {
			try { for (const host of hosts) { host.dispose(); await host.closed().catch(() => {}); } }
			finally { restoreDocument(); restoreTimers(); }
		},
	};
}

describe("OTel browser source patterns through the real community host", () => {
	it("keeps global registrations and four visibility listeners per conversation isolated", async () => {
		const setup = harness();
		try {
			const one = await setup.host("one"), two = await setup.host("two");
			expect(one.listenersAtNextFactory).toBe(4);
			expect(two.listenersAtNextFactory).toBe(8);
			await one.host.run("bridge-state"); await two.host.run("bridge-state");
			expect(JSON.parse(one.notices[0]!)).toMatchObject({ session: "one", transportTag: "browser", sameGlobals: true, sameRegistry: true, sameDocument: true, hasDocument: true });
			expect(JSON.parse(two.notices[0]!)).toMatchObject({ session: "two", sameGlobals: true, sameRegistry: true });
			setup.document.dispatch("visibilitychange");
			await settle();
			expect(one.receipts).toEqual([]); expect(two.receipts).toEqual([]);
			setup.document.visibilityState = "hidden";
			setup.document.dispatch("visibilitychange");
			await settle();
			expect(one.receipts.map(value => value.signal).sort()).toEqual(["logs", "traces"]);
			expect(two.receipts.map(value => value.signal).sort()).toEqual(["logs", "traces"]);
			expect(one.host.busy).toBe(false); expect(two.host.busy).toBe(false);
			one.host.dispose();
			expect(setup.document.listenerCount).toBe(4);
			await one.host.closed();
			const firstCount = one.receipts.length;
			setup.document.dispatch("pagehide");
			await settle();
			expect(one.receipts).toHaveLength(firstCount);
			expect(two.receipts.filter(value => value.reason === "pagehide")).toHaveLength(2);
			for (const [host, session] of [[one, "one"], [two, "two"]] as const) {
				for (const receipt of host.receipts) expect(receipt).toMatchObject({ session, sameGlobals: true, sameRegistry: true, documentEscape: false, eventEscape: false });
			}
			expect(setup.sandbox[Symbol.for(registryKey)]).toEqual({ session: "ambient registration" });
			two.host.dispose(); await two.host.closed();
			expect(setup.document.listenerCount).toBe(0);
			expect(one.errors).toEqual([]); expect(two.errors).toEqual([]);
		} finally { await setup.dispose(); }
	});

	it("revokes document subscriptions on failed loading and timed out shutdown", async () => {
		const setup = harness();
		try {
			const failed = await setup.host("failed", "failure");
			expect(failed.listenersAtNextFactory).toBe(0);
			expect(failed.host.commands).toEqual([]);
			const hanging = await setup.host("hanging", "hang");
			expect(setup.document.listenerCount).toBe(4);
			hanging.host.dispose();
			expect(setup.document.listenerCount).toBe(0);
			await expect(hanging.host.closed()).rejects.toMatchObject({ name: "AbortError" });
			setup.document.visibilityState = "hidden";
			setup.document.dispatch("visibilitychange");
			setup.document.dispatch("pagehide");
			await settle();
			expect(failed.receipts).toEqual([]); expect(hanging.receipts).toEqual([]);
			expect(setup.document.listenerCount).toBe(0);
		} finally { await setup.dispose(); }
	});
});
