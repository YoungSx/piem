import esbuild from "esbuild";
import path from "node:path";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

/** The browser assets shared by the release build and real-VM tests. */
export async function buildCodemodeAssets() {
	const fromPackage = createRequire(path.resolve("node_modules/@earendil-works/pi-codemode/package.json"));
	const built = await esbuild.build({
		entryPoints: [fromPackage.resolve("quickjs-wasi")],
		bundle: true,
		minify: true,
		format: "iife",
		globalName: "__QUICKJS_WASI__",
		platform: "browser",
		write: false,
		logLevel: "silent",
	});
	return {
		quickjs: built.outputFiles[0].text,
		wasm: readFileSync(fromPackage.resolve("quickjs-wasi/quickjs.wasm")),
	};
}

/** Obsidian releases contain main.js, not a separate worker or wasm file. */
export function codemodeRuntimePlugin() {
	const assetFile = path.resolve("src/codemode/runtimeAsset.ts");
	return {
		name: "piem-codemode-runtime",
		setup(build) {
			build.onLoad({ filter: /[/\\]codemode[/\\]runtimeAsset\.ts$/ }, async args => {
				if (args.path !== assetFile) return;
				const { quickjs, wasm } = await buildCodemodeAssets();
				const url = `data:application/wasm;base64,${wasm.toString("base64")}`;
				return {
					contents: `export const QUICKJS_IIFE_SOURCE = ${JSON.stringify(quickjs)};`
						+ `export function quickJsWasmUrl() { return ${JSON.stringify(url)}; }`,
					loader: "js",
				};
			});
		},
	};
}
