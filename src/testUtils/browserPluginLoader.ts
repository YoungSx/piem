import { readFileSync } from "node:fs";
import vm from "node:vm";
import type { HostModules } from "./pluginLoader";

/**
 * Loads the actual bundle in a separate realm that never has Node globals,
 * including during later async work. Only Web APIs and explicit host modules
 * cross the boundary; the test runner's process/Buffer/require stay outside.
 */
export function loadBrowserPluginBundle(options: {
	bundlePath?: string;
	modules: HostModules;
	onRequire?: (id: string) => void;
	onDynamicImport?: (id: string) => void;
}): { exports: unknown; evaluate(expression: string): unknown } {
	const browser: Record<string, unknown> = {
		console, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, AbortSignal,
		Request, Response, Headers, FormData, Blob, File, ReadableStream, WritableStream,
		TransformStream, DOMException, crypto, structuredClone, atob, btoa,
		setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
	};
	// DOM APIs are supplied by installDom in UI tests. No Node global is copied.
	for (const name of ["document", "navigator", "HTMLElement", "HTMLDivElement", "Element", "Node", "Event", "CustomEvent", "KeyboardEvent", "matchMedia", "requestAnimationFrame", "cancelAnimationFrame"]) {
		const value = (globalThis as Record<string, unknown>)[name];
		if (value !== undefined) browser[name] = value;
	}
	browser.window = browser;
	browser.self = browser;
	const context = vm.createContext(browser);
	const module = { exports: {} as unknown };
	const hostRequire = (id: string): unknown => {
		options.onRequire?.(id);
		if (Object.prototype.hasOwnProperty.call(options.modules, id)) return options.modules[id];
		throw new Error(`Cannot find module '${id}'`);
	};
	const source = readFileSync(options.bundlePath ?? "main.js", "utf8");
	const factory = vm.runInContext(`(function (module, exports, require) {\n${source}\n})`, context, {
		timeout: 1000,
		importModuleDynamically: specifier => {
			options.onDynamicImport?.(specifier);
			return Promise.reject(new TypeError(`Dynamic import unavailable: ${specifier}`));
		},
	}) as (module: { exports: unknown }, exports: unknown, require: (id: string) => unknown) => void;
	factory(module, module.exports, hostRequire);
	return { exports: module.exports, evaluate: expression => vm.runInContext(expression, context, { timeout: 1000 }) };
}
