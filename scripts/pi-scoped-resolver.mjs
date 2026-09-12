import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

const inside = (directory, file) => file.startsWith(`${directory}${path.sep}`);
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
// Esbuild's implicit code extensions, excluding CSS (not a scoped source loader).
const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".json"];

function auditedPath(directory, relative) {
	if (typeof relative !== "string" || relative.includes("\\") || relative.includes("\0") || relative.split("/").includes("node_modules") || path.posix.isAbsolute(relative) || path.posix.normalize(relative) !== relative || relative === "." || relative === ".." || relative.startsWith("../")) {
		throw new Error(`Invalid audited source path: ${relative}`);
	}
	return path.join(directory, relative);
}

/** Only the audit selects entries and browser files; package metadata cannot expand it. */
export async function auditedGraph(root, name, audit) {
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
		const browser = new Map();
		if (specification.browser !== undefined && (!specification.browser || typeof specification.browser !== "object" || Array.isArray(specification.browser))) {
			throw new Error(`Invalid audited browser map: ${packageName}`);
		}
		for (const [source, target] of Object.entries(specification.browser ?? {})) {
			if (![source, target].every(relative => typeof relative === "string" && relative.startsWith("./") && !relative.includes("*"))) {
				throw new Error(`Invalid audited browser mapping: ${packageName}/${source}`);
			}
			const from = auditedPath(directory, source.slice(2));
			const to = auditedPath(directory, target.slice(2));
			if (!files.has(to)) throw new Error(`Unaudited extension source: ${packageName}/${target}`);
			// The source is a selector, not an input: a browser audit need not include Node code.
			browser.set(from, to);
		}
		const resolveEntry = relative => {
			const requested = auditedPath(directory, relative);
			const file = browser.get(requested) ?? requested;
			if (!files.has(file)) throw new Error(`Unaudited extension source: ${packageName}/${relative}`);
			return file;
		};
		const entry = resolveEntry(specification.entry);
		const exports = new Map([[".", entry]]);
		for (const [subpath, relative] of Object.entries(specification.exports ?? {})) {
			if (!subpath.startsWith("./") || subpath.includes("*")) throw new Error(`Invalid audited export: ${packageName}/${subpath}`);
			auditedPath(directory, subpath.slice(2));
			exports.set(subpath, resolveEntry(relative));
		}
		const owner = { name: packageName, audit: specification, directory, entry, exports, files, browser, dependencies: new Map() };
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

export function relativeSource(owner, importer, specifier) {
	const file = path.resolve(path.dirname(importer), specifier);
	if (!inside(owner.directory, file)) throw new Error(`Unaudited scoped extension dependency: ${specifier}`);
	// Like esbuild, try implicit extensions even when the basename contains a dot.
	// Complete file candidates precede directory indexes.
	const candidates = [file, ...EXTENSIONS.map(suffix => file + suffix)];
	const extension = path.extname(file);
	// TypeScript packages commonly spell ./utility.js while publishing utility.ts.
	if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
		for (const replacement of extension === ".mjs" ? [".mts"] : extension === ".cjs" ? [".cts"] : [".ts", ".tsx"]) candidates.push(file.slice(0, -extension.length) + replacement);
	}
	candidates.push(...EXTENSIONS.map(suffix => path.join(file, `index${suffix}`)));
	const found = candidates.find(candidate => owner.files.has(candidate) || owner.browser.has(candidate));
	if (!found) throw new Error(`Unaudited extension source: ${owner.name}/${path.relative(owner.directory, file)}`);
	return owner.browser.get(found) ?? found;
}
