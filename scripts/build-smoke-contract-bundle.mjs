import esbuild from "esbuild";
import { writeFileSync } from "node:fs";
import path from "node:path";
import process from "process";
import { builtinModules } from "node:module";
import { piExtensionsPlugin } from "./pi-extensions.mjs";
import { nativeExtensionFixturePlugin } from "./native-extension-fixture.mjs";
import { builtinSkillsPlugin } from "./builtin-skills.mjs";

/**
 * Test-only smoke bundle for scripts/smoke-generic-bridge-obsidian.mjs.
 *
 * One graph, exactly like `npm run build`: production entry plus the local
 * contract fixture resolved through nativeExtensionFixturePlugin, so the
 * fixture's compat imports are the production modules themselves. The tree
 * recognition registry (componentTree.ts) is a WeakMap keyed by module
 * identity — appending a separately bundled fixture IIFE onto main.js would
 * ship a second registry that the native surface cannot read, and every
 * interactive extension component would be rejected as unrenderable.
 *
 * Usage: node scripts/build-smoke-contract-bundle.mjs <output-main.js>
 */
const outfile = process.argv[2];
if (!outfile) throw new Error("Usage: build-smoke-contract-bundle.mjs <output-main.js>");

const result = await esbuild.build({
	stdin: {
		contents: `import Plugin from "./src/main"; import { createContractFactory } from "./scripts/fixtures/native-extension-contract.mjs"; window.__piemBridgeContract = { createContractFactory }; export default Plugin;`,
		resolveDir: path.resolve(import.meta.dirname, ".."),
		loader: "js",
	},
	alias: {
		openai: path.resolve("src/net/shims/openaiSdk.ts"),
		"@anthropic-ai/sdk": path.resolve("src/net/shims/anthropicSdk.ts"),
	},
	plugins: [piExtensionsPlugin(), nativeExtensionFixturePlugin(), builtinSkillsPlugin(process.cwd(), false)],
	loader: { ".png": "dataurl" },
	bundle: true,
	external: ["node:*", "obsidian", "electron",
		"@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands", "@codemirror/language",
		"@codemirror/lint", "@codemirror/search", "@codemirror/state", "@codemirror/view",
		"@lezer/common", "@lezer/highlight", "@lezer/lr", ...builtinModules],
	format: "cjs",
	charset: "utf8",
	target: "es2018",
	logLevel: "info",
	sourcemap: false,
	treeShaking: true,
	minify: true,
	metafile: true,
	outfile,
});

const { readFile } = await import("node:fs/promises");
if (!(await readFile(outfile, "utf8")).includes("Choose a bridge item")) {
	throw new Error("Contract fixture did not reach the bundle; the smoke would export nothing.");
}
writeFileSync(`${outfile}.smoke.meta.json`, JSON.stringify(result.metafile));
