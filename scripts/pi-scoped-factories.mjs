import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const SCOPED_FACTORIES = Object.freeze({
	"pi-web-search": "src/index.ts",
	"pi-clarify": "extensions/clarify.ts",
	"pi-context": "src/index.ts",
});
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
	return `${imports.join("\n")}\nexport function createFactory(platform) {\nconst { ${bindings.join(", ")} } = platform;\n${body.join("\n")}\nreturn ${factory};\n}\n`;
}

export async function buildScopedFactory(root, name, audit) {
	const entry = SCOPED_FACTORIES[name];
	if (!entry) throw new Error(`Unknown scoped extension: ${name}`);
	// Source-test preload reads the registry without compiling anything. Keep
	// both compilers lazy so unrelated standalone tests do not pay for them.
	const [{ default: esbuild }, { default: ts }] = await Promise.all([import("esbuild"), import("typescript")]);
	const directory = path.join(root, "node_modules", name);
	const bridge = path.join(root, "src/extensions/node");
	const truncate = path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/core/tools/truncate.js");
	const pureImports = new Set(["typebox", path.join(bridge, "path.ts"), path.join(bridge, "util.ts"), truncate]);
	const isSearch = name === "pi-web-search";
	const isClarify = name === "pi-clarify";
	const modules = new Map([
		[GLOBALS, `export { ${isSearch ? "fetch, process" : isClarify ? "" : "setTimeout, clearTimeout"} } from ${JSON.stringify(PLATFORM)};`],
		["@earendil-works/pi-ai", 'export { Type } from "typebox";'],
		["@earendil-works/pi-ai/compat", `export { ${isSearch ? "getEnvApiKey" : "complete"} } from ${JSON.stringify(PLATFORM)};`],
		["@earendil-works/pi-coding-agent", `export { getAgentDir${isClarify ? ", BorderedLoader" : ""} } from ${JSON.stringify(PLATFORM)}; ${isSearch ? `export { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from ${JSON.stringify(truncate)};` : ""}`],
		["@earendil-works/pi-tui", `export { Text } from ${JSON.stringify(PLATFORM)};`],
		["node:fs", `export { readFileSync${isClarify ? ", existsSync, mkdirSync, writeFileSync, unlinkSync" : ""} } from ${JSON.stringify(PLATFORM)};`],
	]);
	const entryPath = path.join(directory, entry);
	const built = await esbuild.build({
		stdin: { contents: `export { default } from ${JSON.stringify(entryPath)};`, resolveDir: root, loader: "js" },
		bundle: true, write: false, metafile: true, format: "esm", platform: "browser", target: "es2018", treeShaking: true,
		inject: isClarify ? [] : [GLOBALS], logLevel: "silent",
		plugins: [{
			name: "pi-scoped-platform",
			setup(build) {
				build.onResolve({ filter: /.*/ }, args => {
					if (args.kind === "dynamic-import" || args.kind === "require-call" || args.kind === "require-resolve") {
						throw new Error(`Dynamic extension loading is unavailable: ${args.path}`);
					}
					if (args.path === PLATFORM || pureImports.has(args.path)) return { path: args.path, external: true };
					if (modules.has(args.path)) return { path: args.path, namespace: BINDINGS };
					if (args.path === "path" || args.path === "node:path") return { path: path.join(bridge, "path.ts"), external: true };
					if (args.path === "util" || args.path === "node:util") return { path: path.join(bridge, "util.ts"), external: true };
					if (args.path === entryPath && args.importer === "<stdin>") return { path: entryPath };
					if (args.path.startsWith(".")) {
						const resolved = path.resolve(path.dirname(args.importer), args.path);
						if (resolved.startsWith(`${directory}${path.sep}`)) return;
					}
					throw new Error(`Unaudited scoped extension dependency: ${args.path}`);
				});
				build.onLoad({ filter: /.*/, namespace: BINDINGS }, args => ({ contents: modules.get(args.path), loader: "js" }));
				build.onLoad({ filter: /\.[cm]?[jt]s$/ }, async args => {
					const relative = path.relative(directory, args.path).split(path.sep).join("/");
					const source = await readFile(args.path, "utf8");
					if (!Object.hasOwn(audit.files, relative)) throw new Error(`Unaudited extension source: ${name}/${relative}`);
					if (createHash("sha256").update(source).digest("hex") !== audit.files[relative]) throw new Error(`Audited extension file changed: ${name}/${relative}`);
					return { contents: source, loader: args.path.endsWith(".ts") ? "ts" : "js", resolveDir: path.dirname(args.path) };
				});
			},
		}],
	});
	if (built.outputFiles.length !== 1) throw new Error("Scoped extensions must compile to one static module.");
	return {
		contents: closeOverPlatform(built.outputFiles[0].text, pureImports, ts),
		watchFiles: [path.join(directory, "package.json"), ...Object.keys(audit.files).map(file => path.join(directory, file))],
	};
}
