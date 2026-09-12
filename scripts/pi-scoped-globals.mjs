export const CAPABILITIES = ["fetch", "process", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "Buffer"];
const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self", "global"]);
const WEB_VIEWS = ["document", "performance", "crypto"];
// These host facilities bypass the extension's owned network/event/resource APIs.
const UNAVAILABLE_GLOBALS = ["navigator", "location", "XMLHttpRequest", "WebSocket", "Worker", "SharedWorker", "EventSource", "indexedDB", "localStorage", "sessionStorage", "caches", "Bun", "Deno", "addEventListener", "removeEventListener", "postMessage", "open", "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback", "cancelIdleCallback", "setImmediate", "clearImmediate"];

/** Esbuild inject tracks lexical scope; every global alias receives one factory view. */
export function globalsModule(platform, buffer, helper) {
	const direct = [...CAPABILITIES, ...WEB_VIEWS];
	return `
		import { ${CAPABILITIES.filter(name => name !== "Buffer").join(", ")}, backgroundSignal, backgroundShutdownSignal, reportBackgroundError } from ${JSON.stringify(platform)};
		import { Buffer } from ${JSON.stringify(buffer)};
		import { createExtensionGlobals, createExtensionDocument, createExtensionPerformance, createExtensionCrypto } from ${JSON.stringify(helper)};
		const document = /* @__PURE__ */ createExtensionDocument(backgroundSignal, backgroundShutdownSignal, reportBackgroundError);
		const performance = /* @__PURE__ */ createExtensionPerformance();
		const crypto = /* @__PURE__ */ createExtensionCrypto();
		const scope = /* @__PURE__ */ createExtensionGlobals({ ${direct.join(", ")} });
		const unavailable = undefined;
		export { ${direct.flatMap(name => [name, ...[...GLOBAL_OBJECTS].map(object => `${name} as ${JSON.stringify(`${object}.${name}`)}`)]).join(", ")},
			${[...GLOBAL_OBJECTS].map(name => `scope as ${name}`).join(", ")},
			${UNAVAILABLE_GLOBALS.flatMap(name => [`unavailable as ${name}`, ...[...GLOBAL_OBJECTS].map(object => `unavailable as ${JSON.stringify(`${object}.${name}`)}`)]).join(", ")} };
	`;
}

/** Keep loader checks and virtual URLs; ordinary aliases need no source rewriting. */
export function prepareSource(original, filename, virtualURL, ts) {
	const source = ts.createSourceFile(filename, original, ts.ScriptTarget.Latest, true, filename.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
	if (source.parseDiagnostics.length) throw new Error(`Invalid audited extension source: ${filename}`);
	let changed = false;
	const globalObject = node => ts.isIdentifier(node) && GLOBAL_OBJECTS.has(node.text);
	const direct = [...CAPABILITIES, ...WEB_VIEWS, ...UNAVAILABLE_GLOBALS];
	const transformed = ts.transform(source, [context => {
		const visit = node => {
			if (ts.isIdentifier(node) && node.text === "require" &&
				!(node.parent && ((ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
				(ts.isPropertyAssignment(node.parent) && node.parent.name === node) ||
				(ts.isBindingElement(node.parent) && node.parent.propertyName === node)))) {
				throw new Error("Dynamic extension loading is unavailable.");
			}
			if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
				const key = ts.isPropertyAccessExpression(node) ? node.name.text :
					ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
				if (key === "require" || (key === "module" && globalObject(node.expression))) throw new Error("Dynamic extension loading is unavailable.");
			}
			if (ts.isObjectBindingPattern(node)) {
				for (const element of node.elements) {
					const key = element.propertyName ?? element.name;
					if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === "require") throw new Error("Dynamic extension loading is unavailable.");
				}
			}
			// Preserve tree shaking for explicit destructuring without a rest binding.
			if (ts.isVariableDeclaration(node) && node.initializer && globalObject(node.initializer) && ts.isObjectBindingPattern(node.name) &&
				node.name.elements.every(element => !element.dotDotDotToken && (!element.propertyName || !ts.isComputedPropertyName(element.propertyName)))) {
				const properties = node.name.elements.map(element => {
					const key = element.propertyName ?? element.name;
					return ts.factory.createPropertyAssignment(key, ts.factory.createElementAccessExpression(node.initializer, ts.factory.createStringLiteral(key.text)));
				});
				changed = true;
				return ts.visitEachChild(ts.factory.updateVariableDeclaration(node, node.name, node.exclamationToken, node.type, ts.factory.createObjectLiteralExpression(properties)), visit, context);
			}
			if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
				throw new Error("Dynamic extension loading is unavailable.");
			}
			if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === "url") {
				changed = true;
				return ts.factory.createStringLiteral(virtualURL);
			}
			if (ts.isElementAccessExpression(node) && globalObject(node.expression)) {
				const key = node.argumentExpression;
				if ((ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) && direct.includes(key.text)) {
					changed = true;
					return node.questionDotToken ? ts.factory.createPropertyAccessChain(node.expression, node.questionDotToken, key.text) : ts.factory.createPropertyAccessExpression(node.expression, key.text);
				}
			}
			return ts.visitEachChild(node, visit, context);
		};
		return node => ts.visitNode(node, visit);
	}]);
	try { return changed ? ts.createPrinter().printFile(transformed.transformed[0]) : original; }
	finally { transformed.dispose(); }
}
