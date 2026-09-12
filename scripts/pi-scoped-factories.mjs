import { readFile } from "node:fs/promises";
import path from "node:path";
import { auditedGraph, relativeSource } from "./pi-scoped-resolver.mjs";
import { globalsModule, prepareSource } from "./pi-scoped-globals.mjs";

const AUDIT = JSON.parse(await readFile(new URL("./pi-extension-packages.json", import.meta.url), "utf8"));
export const SCOPED_FACTORIES = Object.freeze(Object.fromEntries(
	Object.entries(AUDIT).filter(([, audit]) => audit.entry).map(([name, audit]) => [name, audit.entry]),
));
export const SCOPED_FACTORY_PREFIX = "pi-scoped-factory:";

const PLATFORM = "piem:extension-platform";
const GLOBALS = "piem:extension-globals";
const BINDINGS = "pi-extension-bindings";

/**
 * The build-time compiler emits ordinary JavaScript. Move only its platform
 * imports inside a factory closure; shared pure imports stay static and dedupe
 * in the outer bundle. No runtime source evaluation or global swapping occurs.
 */
function closeOverPlatform(code, allowedImports, ts) {
	const source = ts.createSourceFile("scoped-extension.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	if (source.parseDiagnostics.length) throw new Error("Invalid compiled extension module.");
	const imports = [];
	const bindings = [];
	const body = [];
	let factory;
	for (const statement of source.statements) {
		if (ts.isImportDeclaration(statement)) {
			const clause = statement.importClause;
			if (!ts.isStringLiteral(statement.moduleSpecifier) || !clause) throw new Error("Scoped extensions require explicit static imports.");
			const specifier = statement.moduleSpecifier.text;
			if (specifier === PLATFORM) {
				if (clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) throw new Error("Scoped platforms require named imports.");
				for (const element of clause.namedBindings.elements) {
					const imported = element.propertyName ?? element.name;
					if (!ts.isIdentifier(imported)) throw new Error("Invalid extension platform binding.");
					bindings.push(imported.text === element.name.text ? element.name.text : `${imported.text}: ${element.name.text}`);
				}
			} else {
				if (!allowedImports.has(specifier)) throw new Error(`Unaudited scoped extension import: ${specifier}`);
				imports.push(statement.getText(source));
			}
			continue;
		}
		if (ts.isExportDeclaration(statement)) {
			const elements = statement.exportClause && ts.isNamedExports(statement.exportClause) ? statement.exportClause.elements : [];
			if (factory || statement.moduleSpecifier || elements.length !== 1 || elements[0].name.text !== "default" || !elements[0].propertyName || !ts.isIdentifier(elements[0].propertyName)) {
				throw new Error("Scoped extension bundle must export only its original default factory.");
			}
			factory = elements[0].propertyName.text;
			continue;
		}
		if (ts.isExportAssignment(statement) || statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
			throw new Error("Unexpected export in compiled extension module.");
		}
		body.push(statement.getText(source));
	}
	if (!factory) throw new Error("Missing scoped extension factory.");
	const identifiers = new Set();
	const collect = node => { if (ts.isIdentifier(node)) identifiers.add(node.text); ts.forEachChild(node, collect); };
	collect(source);
	let parameter = "__piemPlatform";
	while (identifiers.has(parameter)) parameter += "_";
	return `${imports.join("\n")}\nexport function createFactory(${parameter}) {\nconst { ${bindings.join(", ")} } = ${parameter};\n${body.join("\n")}\nreturn ${factory};\n}\n`;
}

const LOADERS = new Map([[".ts", "ts"], [".mts", "ts"], [".cts", "ts"], [".tsx", "tsx"], [".js", "js"], [".mjs", "js"], [".cjs", "js"], [".jsx", "jsx"], [".json", "json"]]);

export async function buildScopedFactory(root, name, audit) {
	root = path.resolve(root);
	const graph = await auditedGraph(root, name, audit);
	// Unrelated standalone tests only read the registry, without starting compilers.
	const [{ default: esbuild }, { default: ts }] = await Promise.all([import("esbuild"), import("typescript")]);
	const bridge = path.join(root, "src/extensions/node");
	const compatibility = path.join(root, "src/extensions/compat");
	const truncate = path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/core/tools/truncate.js");
	const pureModules = new Map(["path", "util", "os", "url", "crypto", "buffer"].map(module => [module, path.join(bridge, `${module}.ts`)]));
	const tui = path.join(compatibility, "piTui.ts");
	const codingAgent = path.join(compatibility, "piCodingAgent.ts");
	const globals = path.join(root, "src/extensions/extensionGlobals.ts");
	const pureImports = new Set(["typebox", ...pureModules.values(), tui, codingAgent, truncate, globals]);
	const platformExport = names => `export { ${names.join(", ")} } from ${JSON.stringify(PLATFORM)};`;
	const namespaceModule = names => `import { ${names.join(", ")} } from ${JSON.stringify(PLATFORM)}; export { ${names.join(", ")} }; export default { ${names.join(", ")} };`;
	const timers = ["setTimeout", "clearTimeout", "setInterval", "clearInterval"];
	const modules = new Map([
		[GLOBALS, globalsModule(PLATFORM, pureModules.get("buffer"), globals)],
		["fs", namespaceModule(["readFileSync", "existsSync", "mkdirSync", "writeFileSync", "unlinkSync", "readdirSync"])],
		["timers", namespaceModule(timers)],
		["timers/promises", `import { timersPromises } from ${JSON.stringify(PLATFORM)}; export const setTimeout = timersPromises.setTimeout; export default timersPromises;`],
		["process", `import { process } from ${JSON.stringify(PLATFORM)}; export default process; export const { env, pid, cwd, platform, arch, versions, argv, exit } = process;`],
	]);
	for (const scope of ["@earendil-works", "@mariozechner"]) {
		for (const suffix of ["", "/compat"]) modules.set(`${scope}/pi-ai${suffix}`, `export { Type } from "typebox"; ${platformExport(["complete", "getEnvApiKey"])}`);
		modules.set(`${scope}/pi-coding-agent`, `export { DynamicBorder, theme, getSelectListTheme } from ${JSON.stringify(codingAgent)}; ${platformExport(["getAgentDir", "BorderedLoader"])} export { truncateHead, truncateTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from ${JSON.stringify(truncate)};`);
		modules.set(`${scope}/pi-tui`, `export { Container, SelectList, Key, matchesKey, parseKey, getKeybindings, visibleWidth, truncateToWidth } from ${JSON.stringify(tui)}; ${platformExport(["Text"])}`);
	}
	const built = await esbuild.build({
		stdin: { contents: `export { default } from ${JSON.stringify(graph.entry.entry)};`, resolveDir: root, loader: "js" },
		bundle: true, write: false, metafile: true, format: "esm", platform: "browser", target: "es2018", treeShaking: true,
		inject: [GLOBALS], logLevel: "silent",
		plugins: [{
			name: "pi-scoped-platform",
			setup(build) {
				build.onResolve({ filter: /.*/ }, args => {
					if (args.kind === "dynamic-import" || args.kind === "require-call" || args.kind === "require-resolve") throw new Error(`Dynamic extension loading is unavailable: ${args.path}`);
					if (args.path === PLATFORM || pureImports.has(args.path)) return { path: args.path, external: true, sideEffects: false };
					const builtin = args.path.replace(/^node:/, "");
					if (modules.has(builtin)) return { path: builtin, namespace: BINDINGS };
					if (pureModules.has(builtin)) return { path: pureModules.get(builtin), external: true, sideEffects: false };
					if (args.path === graph.entry.entry && args.importer === "<stdin>") return { path: graph.entry.entry };
					const owner = [...graph.packages.values()].find(item => item.files.has(args.importer));
					if (owner && !args.path.startsWith(".")) {
						const packageName = args.path.split("/").slice(0, args.path.startsWith("@") ? 2 : 1).join("/");
						const dependency = owner.dependencies.get(packageName);
						const subpath = args.path === packageName ? "." : `.${args.path.slice(packageName.length)}`;
						if (dependency?.exports.has(subpath)) return { path: dependency.exports.get(subpath) };
					}
					if (owner && args.path.startsWith(".")) return { path: relativeSource(owner, args.importer, args.path) };
					throw new Error(`Unaudited scoped extension dependency: ${args.path}`);
				});
				build.onLoad({ filter: /.*/, namespace: BINDINGS }, args => ({ contents: modules.get(args.path), loader: "js" }));
				build.onLoad({ filter: /.*/, namespace: "file" }, args => {
					const owner = [...graph.packages.values()].find(item => item.files.has(args.path));
					if (!owner) throw new Error(`Unaudited extension source: ${args.path}`);
					const loader = LOADERS.get(path.extname(args.path));
					if (!loader) throw new Error(`Unsupported audited source type: ${args.path}`);
					const original = owner.files.get(args.path);
					const relative = path.relative(owner.directory, args.path).split(path.sep).join("/");
					const virtualRoot = owner.audit.virtualRoot ?? `/extensions/${owner.name}`;
					return {
						contents: loader === "json" ? original : prepareSource(original, args.path, `file://${virtualRoot}/${relative}`, ts),
						loader, resolveDir: path.dirname(args.path),
					};
				});
			},
		}],
	});
	if (built.outputFiles.length !== 1) throw new Error("Scoped extensions must compile to one static module.");
	return { contents: closeOverPlatform(built.outputFiles[0].text, pureImports, ts), watchFiles: graph.watchFiles };
}
