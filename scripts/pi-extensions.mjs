import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import esbuild from "esbuild";
import { buildScopedFactory, SCOPED_FACTORY_PREFIX } from "./pi-scoped-factories.mjs";

/** Audited, unmodified upstream modules. A changed pin requires a fresh dependency review. */
const AUDIT = JSON.parse(await readFile(new URL("./pi-extension-packages.json", import.meta.url), "utf8"));
const PURE_DEPENDENCIES = new Set(["typebox", "typebox/compile", "typebox/value", "chalk", "ignore", "yaml"]);
const BUILTINS = new Set(builtinModules.map(name => name.replace(/^node:/, "")));
const COMPAT_ENTRIES = new Map([
	["pi-ai", "piAI.ts"], ["pi-tui", "piTui.ts"], ["pi-coding-agent", "piCodingAgent.ts"],
].flatMap(([name, file]) => ["@earendil-works", "@mariozechner"].map(scope => [`${scope}/${name}`, file])));

/** Resolution is shared by audited production graphs and opt-in local fixtures. */
export function extensionCompatEntry(specifier, root = process.cwd()) {
	const file = COMPAT_ENTRIES.get(specifier);
	return file ? path.join(root, "src/extensions/compat", file) : undefined;
}

/**
 * Restricts the audited static extension graphs. Core's desktop skill environment keeps real Node.
 * Unused dynamic-loader edges may be shaken out; onEnd refuses any of them that survived.
 * Upstream function bodies remain unchanged. New network/timer factories get a
 * per-host static closure; import.meta receives each original module's identity.
 */
export function piExtensionsPlugin(root = process.cwd(), resourceSnapshot = false) {
	const pkg = path.join(root, "node_modules/@earendil-works/pi-coding-agent");
	const bridge = path.join(root, "src/extensions/node");
	const packages = Object.entries(AUDIT).map(([name, audit]) => ({ name, audit, directory: path.join(root, "node_modules", name) }));
	const ownerOf = file => packages.find(item => file.startsWith(`${item.directory}${path.sep}`));
	const loader = path.join(pkg, "dist/core/extensions/loader.js");
	const theme = path.join(pkg, "dist/modes/interactive/theme/theme.js");
	const runner = path.join(pkg, "dist/core/extensions/runner.js");
	const systemPrompt = path.join(pkg, "dist/core/system-prompt.js");
	const skills = path.join(pkg, "dist/core/skills.js");
	const sessionManager = path.join(pkg, "dist/core/session-manager.js");
	const compaction = path.join(pkg, "dist/core/compaction/compaction.js");
	const branchSummary = path.join(pkg, "dist/core/compaction/branch-summarization.js");
	const compactionUtils = path.join(pkg, "dist/core/compaction/utils.js");
	const children = path.join(pkg, "dist/utils/child-process.js");
	const truncate = path.join(pkg, "dist/core/tools/truncate.js");
	const pruned = new Set();
	let resources;
	const platformModules = new Map([
		["fs", "fs"], ["path", "path"], ["os", "os"], ["url", "url"],
		["module", "module"], ["child_process", "childProcess"], ["process", "process"],
	]);
	return {
		name: "pi-static-extensions",
		setup(build) {
			// Every Models instance belongs to Obsidian; never fall back to Node
			// environment probing through an opaque import in an eval-loaded bundle.
			build.onResolve({ filter: /^\.\/auth\/context\.js$/ }, args => args.importer === path.join(root, "node_modules/@earendil-works/pi-ai/dist/models.js")
				? { path: path.join(root, "src/auth/authContext.ts") } : undefined);
			build.onResolve({ filter: /^pi-resource-factory$/ }, () => ({ path: "resources", namespace: "pi-resources" }));
			build.onLoad({ filter: /.*/, namespace: "pi-resources" }, async () => {
				const { buildResourceFactory } = await import("./pi-resource-factory.mjs");
				return { ...await buildResourceFactory(root), resolveDir: root };
			});
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
			build.onResolve({ filter: /^pi-scoped-factory:/ }, args => {
				const name = args.path.slice(SCOPED_FACTORY_PREFIX.length);
				if (!Object.hasOwn(AUDIT, name) || !AUDIT[name].entry) throw new Error(`Unknown scoped extension: ${name}`);
				return { path: name, namespace: "pi-scoped-extension" };
			});
			build.onLoad({ filter: /.*/, namespace: "pi-scoped-extension" }, async args => ({
				...await buildScopedFactory(root, args.path, AUDIT[args.path]), loader: "js", resolveDir: root,
			}));
			build.onResolve({ filter: /.*/ }, args => {
				const owner = ownerOf(args.importer);
				if (!owner) return;
				const community = owner.name !== "@earendil-works/pi-coding-agent" ? owner : undefined;
				if (args.importer === sessionManager && ["crypto", "fs", "fs/promises", "path", "readline", "string_decoder", "../config.js", "../utils/paths.js"].includes(args.path.replace(/^node:/, ""))) {
					pruned.add(args.path);
					return { path: args.path, external: true, sideEffects: false };
				}
				if (args.importer === compaction && args.path === "@earendil-works/pi-ai/compat") return { path: path.join(root, "src/agent/compactionTransport.ts") };
				if (community && args.kind === "dynamic-import") throw new Error(`Dynamic extension loading is unavailable: ${args.path}`);
				const compatibility = community && extensionCompatEntry(args.path, root);
				if (compatibility) return { path: compatibility };
				const dynamicOnly = args.importer === loader && (
					args.path === "../../index.js" || args.path.startsWith("@earendil-works/") || args.path === "jiti/static" ||
					["./jiti-loader.js", "./jiti-static-loader.js", "./virtual-modules.js"].includes(args.path)
				);
				const terminalOnly = args.importer === theme && (args.path === "@earendil-works/pi-tui" || args.path === "../../../utils/syntax-highlight.js" || args.path === "./system-theme.js");
				// Discovery needs an invocation-owned snapshot, never the static fs stub.
				const discoveryOnly = !resourceSnapshot && args.importer === skills && (args.path === "ignore" || args.path === "../utils/frontmatter.js");
				const windowsOnly = args.importer === children && args.path === "cross-spawn";
				if (dynamicOnly || terminalOnly || discoveryOnly || windowsOnly) {
					// These values occur only in uncalled dynamic/terminal functions. If a future
					// consumer makes them live, the output check below fails instead of shipping a require.
					pruned.add(args.path);
					return { path: args.path, external: true, sideEffects: false };
				}
				if (args.path === path.join(bridge, "process.ts")) return { path: args.path };
				if (args.importer === truncate && args.path === path.join(bridge, "utf8.ts")) return { path: args.path };
				const name = args.path.replace(/^node:/, "");
				if (name === "events") return { path: path.join(root, "node_modules/events/events.js") };
				const mapped = platformModules.get(name);
				if (mapped) return { path: path.join(bridge, `${mapped}.ts`) };
				if (BUILTINS.has(name) || args.path.startsWith("node:")) throw new Error(`Unsupported extension builtin: ${args.path}`);
				// These hashed files import only transcript projection helpers. Do not
				// open the pi-ai root to community graphs (which use our compatibility API).
				if ([runner, systemPrompt, sessionManager, compaction, branchSummary, compactionUtils].includes(args.importer) && args.path === "@earendil-works/pi-ai") return;
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
				// The four literal fallback-color constructors are pure (pi-tui/colors.js:
				// parseColor -> rgbColor). Annotating them lets the unused terminal graph
				// disappear; esbuild's `pure` option cannot annotate an imported binding.
				const source = args.path === theme ? original.replaceAll('parseColor("#', '/* @__PURE__ */ parseColor("#') : original;
				const result = await esbuild.transform(source, {
					format: "esm", target: "es2022", sourcemap: false, loader: args.path.endsWith(".ts") ? "ts" : "js",
					define: { "import.meta.url": JSON.stringify(`file://${virtualPath}`) },
				});
				return {
					contents: `import process from ${JSON.stringify(path.join(bridge, "process.ts"))};\n${args.path === truncate ? `import { Buffer } from ${JSON.stringify(path.join(bridge, "utf8.ts"))};\n` : ""}${result.code}`,
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
