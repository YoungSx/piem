import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

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

const CAPABILITIES = ["fetch", "process", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "Buffer"];
const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self", "global"]);
const LOADERS = new Map([[".ts", "ts"], [".mts", "ts"], [".cts", "ts"], [".tsx", "tsx"], [".js", "js"], [".mjs", "js"], [".cjs", "js"], [".jsx", "jsx"], [".json", "json"]]);
const inside = (directory, file) => file.startsWith(`${directory}${path.sep}`);
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

function auditedPath(directory, relative) {
	if (typeof relative !== "string" || relative.includes("\\") || relative.includes("\0") || relative.split("/").includes("node_modules") || path.posix.isAbsolute(relative) || path.posix.normalize(relative) !== relative || relative === "." || relative.startsWith("../")) {
		throw new Error(`Invalid audited source path: ${relative}`);
	}
	return path.join(directory, relative);
}

/** Only exact audited entries are used; package main/exports/browser never select new source. */
async function auditedGraph(root, name, audit) {
	const physicalRoot = await realpath(root);
	const packages = new Map();
	const watchFiles = [];
	async function visit(packageName, specification, directory) {
		if (!PACKAGE_NAME.test(packageName)) throw new Error(`Invalid audited package name: ${packageName}`);
		if (!specification?.entry || !specification.version || !specification.files) throw new Error(`Missing scoped extension audit: ${packageName}`);
		const previous = packages.get(directory);
		if (previous) {
			if (JSON.stringify(previous.audit) !== JSON.stringify(specification)) throw new Error(`Conflicting extension audits: ${packageName}`);
			return previous;
		}
		const physicalDirectory = await realpath(directory);
		if (!inside(physicalRoot, physicalDirectory)) throw new Error(`Audited package escaped its checkout: ${packageName}`);
		const metadataPath = path.join(directory, "package.json");
		if (!inside(physicalDirectory, await realpath(metadataPath))) throw new Error(`Audited metadata escaped its package: ${packageName}`);
		if (JSON.parse(await readFile(metadataPath, "utf8")).version !== specification.version) throw new Error(`Re-audit ${packageName} before upgrading.`);
		watchFiles.push(metadataPath);
		const files = new Map();
		for (const [relative, hash] of Object.entries(specification.files)) {
			const file = auditedPath(directory, relative);
			if (!inside(physicalDirectory, await realpath(file))) throw new Error(`Audited source escaped its package: ${packageName}/${relative}`);
			const bytes = await readFile(file);
			if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error(`Audited extension file changed: ${packageName}/${relative}`);
			files.set(file, bytes.toString("utf8"));
			watchFiles.push(file);
		}
		const entry = auditedPath(directory, specification.entry);
		if (!files.has(entry)) throw new Error(`Unaudited extension source: ${packageName}/${specification.entry}`);
		const exports = new Map([[".", entry]]);
		for (const [subpath, relative] of Object.entries(specification.exports ?? {})) {
			if (!subpath.startsWith("./") || subpath.includes("*")) throw new Error(`Invalid audited export: ${packageName}/${subpath}`);
			auditedPath(directory, subpath.slice(2));
			const file = auditedPath(directory, relative);
			if (!files.has(file)) throw new Error(`Unaudited extension source: ${packageName}/${relative}`);
			exports.set(subpath, file);
		}
		const owner = { name: packageName, audit: specification, directory, entry, exports, files, dependencies: new Map() };
		packages.set(directory, owner);
		for (const [dependency, dependencyAudit] of Object.entries(specification.dependencies ?? {})) {
			if (!PACKAGE_NAME.test(dependency)) throw new Error(`Invalid audited package name: ${dependency}`);
			// Match the install's nearest node_modules, but never search outside this checkout.
			let dependencyDirectory;
			for (let parent = directory; parent === root || inside(root, parent); parent = path.dirname(parent)) {
				const candidate = path.join(parent, "node_modules", dependency);
				try { await readFile(path.join(candidate, "package.json")); dependencyDirectory = candidate; break; }
				catch (error) { if (error.code !== "ENOENT") throw error; }
			}
			if (!dependencyDirectory) throw new Error(`Missing audited extension dependency: ${dependency}`);
			owner.dependencies.set(dependency, await visit(dependency, dependencyAudit, dependencyDirectory));
		}
		return owner;
	}
	return { entry: await visit(name, audit, path.join(root, "node_modules", name)), packages, watchFiles };
}

function relativeSource(owner, importer, specifier) {
	const file = path.resolve(path.dirname(importer), specifier);
	if (!inside(owner.directory, file)) throw new Error(`Unaudited scoped extension dependency: ${specifier}`);
	const extension = path.extname(file);
	const candidates = [file];
	// TypeScript packages commonly spell ./utility.js while publishing utility.ts.
	if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
		for (const replacement of extension === ".mjs" ? [".mts"] : extension === ".cjs" ? [".cts"] : [".ts", ".tsx"]) candidates.push(file.slice(0, -extension.length) + replacement);
	} else if (!extension) {
		for (const suffix of [".tsx", ".ts", ".jsx", ".js", ".json"]) candidates.push(file + suffix, path.join(file, `index${suffix}`));
	}
	const found = candidates.find(candidate => owner.files.has(candidate));
	if (!found) throw new Error(`Unaudited extension source: ${owner.name}/${path.relative(owner.directory, file)}`);
	return found;
}

/** Esbuild inject handles names and dotted members, but not string-indexed globals. */
function prepareSource(original, filename, virtualURL, ts) {
	const kind = filename.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const source = ts.createSourceFile(filename, original, ts.ScriptTarget.Latest, true, kind);
	if (source.parseDiagnostics.length) throw new Error(`Invalid audited extension source: ${filename}`);
	let changed = false;
	const globalObject = node => ts.isIdentifier(node) && GLOBAL_OBJECTS.has(node.text);
	const transformed = ts.transform(source, [context => {
		const visit = node => {
			// Checking only calls misses `const load = require; load(name)`.
			// Refuse the loader value as well; ordinary object property names stay valid.
			if (ts.isIdentifier(node) && node.text === "require" &&
				!(node.parent && ((ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
				(ts.isPropertyAssignment(node.parent) && node.parent.name === node) ||
				(ts.isBindingElement(node.parent) && node.parent.propertyName === node)))) {
				throw new Error("Dynamic extension loading is unavailable.");
			}
			if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && ts.isIdentifier(node.expression)) {
				const key = ts.isPropertyAccessExpression(node) ? node.name.text :
					ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
				if ((globalObject(node.expression) && ["require", "module"].includes(key)) ||
					(node.expression.text === "module" && key === "require")) throw new Error("Dynamic extension loading is unavailable.");
			}
			if (ts.isVariableDeclaration(node) && node.initializer && globalObject(node.initializer)) {
				if (ts.isObjectBindingPattern(node.name)) {
					if (node.name.elements.some(element => element.dotDotDotToken || (element.propertyName && ts.isComputedPropertyName(element.propertyName)))) {
						throw new Error("Dynamic extension platform access is unavailable.");
					}
					// An explicit object preserves defaults/nested bindings while each value
					// becomes a dotted access that esbuild can bind without changing scope.
					const properties = node.name.elements.map(element => {
						const key = element.propertyName ?? element.name;
						if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) throw new Error("Dynamic extension platform access is unavailable.");
						return ts.factory.createPropertyAssignment(key, ts.factory.createElementAccessExpression(node.initializer, ts.factory.createStringLiteral(key.text)));
					});
					changed = true;
					return ts.visitEachChild(ts.factory.updateVariableDeclaration(node, node.name, node.exclamationToken, node.type, ts.factory.createObjectLiteralExpression(properties)), visit, context);
				}
				throw new Error("Indirect extension platform access is unavailable.");
			}
			if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && globalObject(node.right)) {
				throw new Error("Indirect extension platform access is unavailable.");
			}
			if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === "require") ||
				(ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "require"))) {
				throw new Error("Dynamic extension loading is unavailable.");
			}
			if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === "url") {
				changed = true;
				return ts.factory.createStringLiteral(virtualURL);
			}
			if ((ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) && ts.isIdentifier(node.expression) && GLOBAL_OBJECTS.has(node.expression.text)) {
				if (ts.isElementAccessExpression(node)) {
					const key = node.argumentExpression;
					const symbolKey = ts.isCallExpression(key) && ts.isPropertyAccessExpression(key.expression) && ts.isIdentifier(key.expression.expression) && key.expression.expression.text === "Symbol" && key.expression.name.text === "for";
					if (!ts.isStringLiteral(key) && !ts.isNoSubstitutionTemplateLiteral(key) && !symbolKey) throw new Error("Dynamic extension platform access is unavailable.");
					if (!symbolKey && CAPABILITIES.includes(key.text)) {
						changed = true;
						return node.questionDotToken ? ts.factory.createPropertyAccessChain(node.expression, node.questionDotToken, key.text) : ts.factory.createPropertyAccessExpression(node.expression, key.text);
					}
				}
			}
			return ts.visitEachChild(node, visit, context);
		};
		return node => ts.visitNode(node, visit);
	}]);
	try { return changed ? ts.createPrinter().printFile(transformed.transformed[0]) : original; }
	finally { transformed.dispose(); }
}

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
	const pureImports = new Set(["typebox", ...pureModules.values(), tui, codingAgent, truncate]);
	const platformExport = names => `export { ${names.join(", ")} } from ${JSON.stringify(PLATFORM)};`;
	const namespaceModule = names => `import { ${names.join(", ")} } from ${JSON.stringify(PLATFORM)}; export { ${names.join(", ")} }; export default { ${names.join(", ")} };`;
	const timers = ["setTimeout", "clearTimeout", "setInterval", "clearInterval"];
	const modules = new Map([
		[GLOBALS, `import { ${CAPABILITIES.filter(name => name !== "Buffer").join(", ")} } from ${JSON.stringify(PLATFORM)}; import { Buffer } from ${JSON.stringify(pureModules.get("buffer"))}; export { ${CAPABILITIES.flatMap(name => [name, ...[...GLOBAL_OBJECTS].map(object => `${name} as ${JSON.stringify(`${object}.${name}`)}`)]).join(", ")} };`],
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
