import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import esbuild from "esbuild";

/** Audited, unmodified upstream modules. A changed pin requires a fresh dependency review. */
const AUDIT = JSON.parse(await readFile(new URL("./pi-extension-packages.json", import.meta.url), "utf8"));
const PURE_DEPENDENCIES = new Set(["typebox", "typebox/compile", "typebox/value", "chalk"]);
const BUILTINS = new Set(builtinModules.map(name => name.replace(/^node:/, "")));

/**
 * Restricts the audited static extension graphs. Core's desktop skill environment keeps real Node.
 * Unused dynamic-loader edges may be shaken out; onEnd refuses any of them that survived.
 * No source functions are copied or rewritten. import.meta receives each original module's identity.
 */
export function piExtensionsPlugin(root = process.cwd()) {
	const pkg = path.join(root, "node_modules/@earendil-works/pi-coding-agent");
	const bridge = path.join(root, "src/extensions/node");
	const packages = Object.entries(AUDIT).map(([name, audit]) => ({ name, audit, directory: path.join(root, "node_modules", name) }));
	const ownerOf = file => packages.find(item => file.startsWith(`${item.directory}${path.sep}`));
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
				resources = {};
				for (const { name, audit, directory } of packages) {
					const metadata = await readFile(path.join(directory, "package.json"), "utf8");
					if (JSON.parse(metadata).version !== audit.version) throw new Error(`Re-audit ${name} before upgrading.`);
					for (const [relative, hash] of Object.entries(audit.files)) {
						const actual = createHash("sha256").update(await readFile(path.join(directory, relative))).digest("hex");
						if (actual !== hash) throw new Error(`Audited extension file changed: ${name}/${relative}`);
					}
					resources[`${audit.virtualRoot}/package.json`] = metadata;
				}
			});
			build.onResolve({ filter: /.*/ }, args => {
				const owner = ownerOf(args.importer);
				if (!owner) return;
				const community = owner.name !== "@earendil-works/pi-coding-agent" ? owner : undefined;
				if (community && args.kind === "dynamic-import") throw new Error(`Dynamic extension loading is unavailable: ${args.path}`);
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
				if (args.path === path.join(bridge, "process.ts")) return { path: args.path };
				const name = args.path.replace(/^node:/, "");
				if (name === "events") return { path: path.join(root, "node_modules/events/events.js") };
				const mapped = platformModules.get(name);
				if (mapped) return { path: path.join(bridge, `${mapped}.ts`) };
				if (BUILTINS.has(name) || args.path.startsWith("node:")) throw new Error(`Unsupported extension builtin: ${args.path}`);
				if (PURE_DEPENDENCIES.has(args.path)) return;
				if (args.path.startsWith(".")) {
					const resolved = path.resolve(path.dirname(args.importer), args.path);
					if (resolved.startsWith(`${owner.directory}${path.sep}`)) return;
				}
				throw new Error(`Unaudited extension dependency: ${args.path}`);
			});
			build.onLoad({ filter: /[/\\]extensions[/\\]node[/\\]resources\.ts$/ }, () => ({
				contents: `export const extensionResources = ${JSON.stringify(resources)};`, loader: "js",
				watchFiles: [path.join(pkg, "package.json")],
			}));
			build.onLoad({ filter: /\.[cm]?[jt]s$/ }, async args => {
				const owner = ownerOf(args.path);
				if (!owner) return;
				const relative = path.relative(owner.directory, args.path).split(path.sep).join("/");
				if (!Object.hasOwn(owner.audit.files, relative)) throw new Error(`Unaudited extension source: ${owner.name}/${relative}`);
				const original = await readFile(args.path, "utf8");
				const virtualPath = `${owner.audit.virtualRoot}/${relative}`;
				const result = await esbuild.transform(original, {
					format: "esm", target: "es2022", sourcemap: false, loader: args.path.endsWith(".ts") ? "ts" : "js",
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
				if (result.errors.length) return;
				if (!result.metafile) return { errors: [{ text: "Pi bridge builds require a metafile to validate pruned imports." }] };
				const remaining = Object.values(result.metafile.outputs).flatMap(output => output.imports)
					.filter(item => item.external && pruned.has(item.path));
				if (remaining.length) return { errors: remaining.map(item => ({ text: `Unsupported Pi dependency became reachable: ${item.path}` })) };
			});
		},
	};
}
