import { describe, expect, it } from "bun:test";
import { build } from "esbuild";
import vm from "node:vm";
import { piExtensionsPlugin, extensionCompatEntry } from "./pi-extensions.mjs";
import { nativeExtensionFixturePlugin } from "./native-extension-fixture.mjs";
import type { ExtensionHost, ExtensionHostCallbacks } from "../src/extensions/extensionHost";
import type { ExtensionShortcutAction, ExtensionUIAdapter, NativeExtensionSurface } from "../src/extensions/extensionUI";
import type { NativeComponentNode } from "../src/extensions/compat/componentTree";
import type { Model } from "@earendil-works/pi-ai";

function findSelect(node: NativeComponentNode): Extract<NativeComponentNode, { kind: "select" }> | undefined {
	if (node.kind === "select") return node;
	if (node.kind === "container") return node.children.map(findSelect).find(Boolean);
	return undefined;
}

describe("Pi public-import native bridge contract", () => {
	it("maps both published namespaces without importing a provider or terminal runtime", () => {
		for (const name of ["pi-ai", "pi-coding-agent", "pi-tui"]) {
			expect(extensionCompatEntry(`@mariozechner/${name}`)).toBe(extensionCompatEntry(`@earendil-works/${name}`));
		}
		expect(extensionCompatEntry("@mariozechner/pi-tui/terminal")).toBeUndefined();
	});

	it("executes public component, shortcut and complete imports in a permanently Node-free realm", async () => {
		const built = await build({
			stdin: { contents: 'export { createExtensionHost } from "./src/extensions/extensionHost"; export { createContractFactory } from "./scripts/fixtures/native-extension-contract.mjs";', resolveDir: process.cwd(), loader: "ts" },
			bundle: true, write: false, metafile: true, minify: true, format: "cjs", target: "es2018",
			plugins: [nativeExtensionFixturePlugin(), piExtensionsPlugin()], logLevel: "silent",
		});
		const output = Object.values(built.metafile!.outputs)[0]!;
		expect(output.imports).toEqual([]);
		expect(Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).some(([file]) => /node_modules\/.+(?:pi-tui|pi-ai)|jiti|highlight\.js/.test(file))).toBe(false);
		const timers = new Set<ReturnType<typeof setTimeout>>();
		const sandbox = { module: { exports: {} }, URL, AbortController, AbortSignal, DOMException, TextEncoder, TextDecoder,
			structuredClone, crypto, queueMicrotask, console, window: {
				setTimeout: (fn: () => void, delay: number) => { const id = setTimeout(() => { timers.delete(id); fn(); }, delay); timers.add(id); return id; },
				clearTimeout: (id: ReturnType<typeof setTimeout>) => { timers.delete(id); clearTimeout(id); },
			} };
		vm.runInNewContext(built.outputFiles[0]!.text, sandbox, { timeout: 1000 });
		const api = sandbox.module.exports as {
			createExtensionHost: (factories: unknown[], callbacks: ExtensionHostCallbacks) => Promise<ExtensionHost>;
			createContractFactory: (record: Record<string, unknown>) => unknown;
		};
		const record: Record<string, unknown> = {};
		const widgets = new Map<string, NativeExtensionSurface>();
		let shortcuts: readonly ExtensionShortcutAction[] = [];
		let active: NativeExtensionSurface | undefined;
		let draft = "";
		let requests = 0;
		const adapter: ExtensionUIAdapter = {
			select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined,
			setStatus: () => {}, setWidget: () => {}, getEditorText: () => draft, setEditorText: text => { draft = text; }, pasteToEditor: () => {},
			addAutocompleteProvider: () => {},
			setComponentWidget: (key, surface) => { if (surface) widgets.set(key, surface); else widgets.delete(key); },
			setShortcuts: actions => { shortcuts = actions; },
			showComponent: async (surface, signal) => { active = surface; await new Promise<void>(resolve => signal.addEventListener("abort", () => { active = undefined; resolve(); }, { once: true })); },
			reset: () => { widgets.clear(); shortcuts = []; active = undefined; },
		};
		const model: Model<string> = {
			id: "fixture", name: "Fixture", provider: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid",
			reasoning: false, input: ["text"], contextWindow: 1024, maxTokens: 128,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, headers: { Authorization: "secret-key" },
		};
		const host = await api.createExtensionHost([{ id: "local-contract", factory: api.createContractFactory(record) }], {
			getEntries: () => [], notify: () => {}, getModel: () => model, getModels: () => [model],
			complete: async (actual, _context, options) => {
				requests++;
				expect(actual.headers?.Authorization).toBe("secret-key");
				expect(options.apiKey).toBeUndefined();
				expect(options.headers).toBeUndefined();
				return { role: "assistant", content: [{ type: "text", text: "Completed" }], api: "openai-completions", provider: "fixture", model: "fixture", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
			},
		});
		const waitFor = async (read: () => unknown): Promise<void> => {
			for (let i = 0; i < 30; i++) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 0)); }
			throw new Error("Fixture condition not met");
		};
		try {
			host.attachUI(adapter);
			await host.start();
			expect(record.widgetMounts).toBe(1);
			expect(JSON.stringify(widgets.get("contract-component")!.getSnapshot())).toContain("<script>literal text</script>");
			const picker = shortcuts[0]!.run();
			await waitFor(() => active);
			findSelect(active!.getSnapshot())!.onSelect(1);
			await picker;
			expect(record.selection).toBe("organize");
			expect(draft).toBe("Selected: organize");
			expect(record.pickerDisposals).toBe(1);
			const loading = shortcuts[1]!.run();
			await waitFor(() => active);
			active!.cancel();
			await loading;
			expect((record.loaderSignal as AbortSignal).aborted).toBe(true);
			await shortcuts[2]!.run();
			expect(requests).toBe(1);
			expect(JSON.stringify(record.auth)).not.toContain("secret-key");
			host.attachUI(undefined);
			expect(record.widgetDisposals).toBe(1);
			host.attachUI(adapter);
			expect(record.widgetMounts).toBe(2);
			expect(vm.runInNewContext("[typeof process, typeof Buffer, typeof require, typeof Bun]", sandbox)).toEqual(Array(4).fill("undefined"));
		} finally {
			host.dispose();
			expect(timers.size).toBe(0);
			for (const timer of timers) clearTimeout(timer);
		}
	});
});
