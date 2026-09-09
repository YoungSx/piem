import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import esbuild from "esbuild";

/** Audited, unmodified upstream modules. A changed pin requires a fresh dependency review. */
const PI_VERSION = "0.84.3";
const HASHES = {
	"dist/core/extensions/loader.js": "2da25d0ad695f3c209dac9245d6044292edf89f10059e108f9d90183256d5189",
	"dist/core/extensions/runner.js": "b39d59b8f86693b9aca15f13e14f367fce9a0ad8ed7ce9ad17950906f226951d",
	"examples/extensions/bookmark.ts": "a71d9449d415ad75c9f3d0d13afde129b9bea2d695b889566db17ecfca256d79",
};

/**
 * Restricts only the official extension graph. Core's desktop skill environment keeps real Node.
 * Unused dynamic-loader edges may be shaken out; onEnd refuses any of them that survived.
 * No source functions are copied or rewritten. import.meta receives each original module's identity.
 */
export function piExtensionsPlugin(root = process.cwd()) {
	const pkg = path.join(root, "node_modules/@earendil-works/pi-coding-agent");
	const bridge = path.join(root, "src/extensions/node");
	const loader = path.join(pkg, "dist/core/extensions/loader.js");
	const theme = path.join(pkg, "dist/modes/interactive/theme/theme.js");
	const children = path.join(pkg, "dist/utils/child-process.js");
	const pruned = new Set();
	let resources;
	const platformModules = new Map([
		["fs", "fs"], ["path", "path"], ["os", "os"], ["url", "url"],
		["module", "module"], ["child_process", "childProcess"], ["process", "process"],
	]);
	return {
		name: "pi-static-extensions",
		setup(build) {
			build.onStart(async () => {
				pruned.clear();
				const text = await readFile(path.join(pkg, "package.json"), "utf8");
				if (JSON.parse(text).version !== PI_VERSION) throw new Error("Re-audit the Pi extension bridge before upgrading Pi.");
				for (const [relative, hash] of Object.entries(HASHES)) {
					const actual = createHash("sha256").update(await readFile(path.join(pkg, relative))).digest("hex");
					if (actual !== hash) throw new Error(`Official Pi file changed: ${relative}`);
				}
				resources = { "/pi/package.json": text };
			});
			build.onResolve({ filter: /.*/ }, args => {
				if (!args.importer.startsWith(`${pkg}${path.sep}`)) return;
				const dynamicOnly = args.importer === loader && (
					args.path === "../../index.js" || args.path.startsWith("@earendil-works/") || args.path === "jiti/static"
				);
				const terminalOnly = args.importer === theme && (args.path === "@earendil-works/pi-tui" || args.path === "../../../utils/syntax-highlight.js");
				const windowsOnly = args.importer === children && args.path === "cross-spawn";
				if (dynamicOnly || terminalOnly || windowsOnly) {
					// These values occur only in uncalled dynamic/terminal functions. If a future
					// consumer makes them live, the output check below fails instead of shipping a require.
					pruned.add(args.path);
					return { path: args.path, external: true, sideEffects: false };
				}
				const name = args.path.replace(/^node:/, "");
				if (name === "events") return { path: path.join(root, "node_modules/events/events.js") };
				const mapped = platformModules.get(name);
				if (mapped) return { path: path.join(bridge, `${mapped}.ts`) };
			});
			build.onLoad({ filter: /[/\\]extensions[/\\]node[/\\]resources\.ts$/ }, () => ({
				contents: `export const extensionResources = ${JSON.stringify(resources)};`, loader: "js",
				watchFiles: [path.join(pkg, "package.json")],
			}));
			build.onLoad({ filter: /[/\\]pi-coding-agent[/\\].*\.js$/ }, async args => {
				const original = await readFile(args.path, "utf8");
				const virtualPath = `/pi/${path.relative(pkg, args.path).split(path.sep).join("/")}`;
				const result = await esbuild.transform(original, {
					format: "esm", target: "es2022", sourcemap: false,
					// Theme schema construction only feeds theme loaders, which this host does not use.
					pure: args.path === theme ? ["Compile", "Type.Object", "Type.Optional", "Type.Union", "Type.String", "Type.Number", "Type.Intersect", "Type.Record"] : [],
					define: { "import.meta.url": JSON.stringify(`file://${virtualPath}`) },
				});
				return {
					contents: `import process from ${JSON.stringify(path.join(bridge, "process.ts"))};\n${result.code}`,
					loader: "js", resolveDir: path.dirname(args.path), watchFiles: [args.path],
				};
			});
			build.onEnd(result => {
				if (!result.metafile) return { errors: [{ text: "Pi bridge builds require a metafile to validate pruned imports." }] };
				const remaining = Object.values(result.metafile.outputs).flatMap(output => output.imports)
					.filter(item => item.external && pruned.has(item.path));
				if (remaining.length) return { errors: remaining.map(item => ({ text: `Unsupported Pi dependency became reachable: ${item.path}` })) };
			});
		},
	};
}
