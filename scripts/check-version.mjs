/**
 * Static gate against the release version having a second home.
 *
 * `manifest.json` is the one place the plugin's version is allowed to live.
 * Obsidian reads it, the About tab renders it off `this.manifest.version`, and
 * `scripts/release.mjs` stamps it. Anything else that spells the version out is
 * a copy, and a copy drifts silently: nothing reads it back, so no test fails
 * and no reviewer notices.
 *
 * That is not hypothetical. `src/mcp/mcpManager.ts` reported
 * `{ name: "piem", version: "1.0.0" }` to every MCP server it connected to, and
 * kept reporting 1.0.0 while the plugin shipped 1.0.1 and 1.0.2 — the literal
 * was written once, on the day the file was created, and never touched again.
 * Both READMEs likewise told readers Piem was "in early alpha (0.1.0-alpha.x)"
 * a full major release later. The old `stamp-version.mjs` could not have caught
 * either one: it stamps a hardcoded list of three files, so a version number
 * appearing anywhere else is invisible to it by construction. Adding those two
 * files to the list would only move the next miss somewhere else.
 *
 * So the gate is inverted. Rather than enumerate where the version must be
 * written, it enumerates where it may be — `manifest.json`, `package.json`,
 * `versions.json` — and fails on a version-shaped literal anywhere else in the
 * shipped source or the docs.
 *
 * It is a gate, not a proof. A version assembled at runtime (`"1." + minor`) or
 * read from a map passes, because it cannot know what a computed value holds.
 * What it covers is the shape both real defects were written in: someone typing
 * today's version number directly into a file.
 *
 * ## What is deliberately not a violation
 *
 * Most version-shaped strings in this repo are legitimate, and a gate that
 * flagged them would be switched off within a week:
 *
 * - **Other software's versions.** `minAppVersion`, a dependency's pin, or a
 *   protocol revision like MCP's `"2025-06-18"` name something that is not us.
 *   Only a literal matching the plugin's *own* current version is suspicious.
 * - **Test fixtures.** A test that hands a stub `"9.9.9-test"` or asserts on
 *   `describeVersion("0.1.0-alpha.7", …)` is pinning behaviour, not shipping a
 *   version. Test files are exempt wholesale.
 * - **Prose about a past release.** `AGENTS.md` and this file's own header cite
 *   old versions as history. Those are in comments and markdown prose, which is
 *   why the source scan looks at string literals through the parser rather than
 *   grepping lines, and the docs scan looks only for the *current* version.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import process from "node:process";
import ts from "typescript";

/** Where the version legitimately lives. Everything else is a copy. */
const VERSION_HOMES = ["manifest.json", "package.json", "versions.json"];

/** Source tree scanned for version literals. */
const SOURCE_ROOT = process.argv[2] ?? "src";

/**
 * Where reader-facing prose lives: the repo root, and `docs/` recursively.
 *
 * Roots, not a file list. `DOC_FILES` used to name the two READMEs by hand, and
 * the day the README split its reference material into `docs/`, four new prose
 * files became invisible to this gate by construction — the identical failure
 * `stamp-version.mjs` had with its list of three. The root is deliberately
 * non-recursive so `worklogs/` stays out: an entry there describes what a
 * release looked like on the day it was written, and rewriting it on the next
 * release would destroy the record. If a CHANGELOG is ever added, naming the
 * current version is the whole point of its top entry, so it needs an exemption
 * here rather than a rewrite of its heading.
 */
const DOC_ROOTS = [".", "docs"];

/**
 * A SemVer-shaped string, anchored so it is the whole literal.
 *
 * Anchoring is what keeps `"2025-06-18"` (MCP's protocol revision) and a date
 * out of the results, and it means a literal like `"see 1.0.2 for details"` in
 * prose is not treated as a version constant — that shape belongs to the docs
 * scan below, which looks for the current version specifically.
 */
const SEMVER = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

/** Files whose version literals are fixtures rather than shipped values. */
function isExemptSource(file) {
	return (
		file.endsWith(".test.ts") ||
		file.endsWith(".test.tsx") ||
		file.includes(`${sep}testing${sep}`) ||
		file.includes(`${sep}testUtils${sep}`)
	);
}

/** Every TypeScript source under `root`, recursively. */
function collectSources(root) {
	const found = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) {
				walk(path);
			} else if (/\.tsx?$/.test(path)) {
				found.push(path);
			}
		}
	};
	walk(root);
	return found;
}

/** Every markdown doc under `DOC_ROOTS`; the root itself is not recursed. */
function collectDocs() {
	const found = new Set();
	const walk = (dir, recurse) => {
		let entries;
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = dir === "." ? entry : join(dir, entry);
			if (statSync(path).isDirectory()) {
				if (recurse) {
					walk(path, true);
				}
			} else if (path.endsWith(".md")) {
				found.add(path);
			}
		}
	};
	for (const root of DOC_ROOTS) {
		walk(root, root !== ".");
	}
	return [...found].sort();
}

/**
 * The plugin's current version, from the file that owns it.
 *
 * Read rather than passed in: the gate's whole claim is that this file is the
 * single source of truth, and taking the value from anywhere else would weaken
 * it to a consistency check between two copies.
 */
function currentVersion() {
	return JSON.parse(readFileSync("manifest.json", "utf8")).version;
}

/**
 * String literals in `file` whose text is a bare SemVer.
 *
 * Parsed, not grepped: this file's own header cites "1.0.0" in prose, and the
 * comment explaining the drift would otherwise fail the gate that explains it.
 * The parser sees a comment for what it is.
 */
function versionLiteralsIn(file) {
	const text = readFileSync(file, "utf8");
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	const found = [];

	const visit = (node) => {
		const isPlainString = ts.isStringLiteral(node);
		const isPlainTemplate = ts.isNoSubstitutionTemplateLiteral(node);
		if (isPlainString || isPlainTemplate) {
			const value = node.text;
			if (SEMVER.test(value)) {
				const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
				found.push({ file, line: line + 1, value, context: contextOf(node, source) });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

/**
 * A short description of where the literal sits, so the failure names the line
 * a person has to change rather than just quoting a number back at them.
 */
function contextOf(node, source) {
	const parent = node.parent;
	if (parent && ts.isPropertyAssignment(parent)) {
		return `${parent.name.getText(source)}: "${node.text}"`;
	}
	if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
		return `${parent.name.text} = "${node.text}"`;
	}
	return `"${node.text}"`;
}

const version = currentVersion();
const failures = [];

const sources = collectSources(SOURCE_ROOT).filter((file) => !isExemptSource(file));
const docs = collectDocs();

for (const file of sources) {
	for (const literal of versionLiteralsIn(file)) {
		// Only the plugin's own version is a drift risk. A dependency pin or
		// another product's minimum is a fact about someone else's software and
		// has no reason to move when we release.
		if (literal.value !== version) {
			continue;
		}
		failures.push({
			at: `${relative(process.cwd(), literal.file)}:${literal.line}`,
			what: literal.context,
			why:
				`This is the plugin's current version written out by hand. It will not move on the next release, ` +
				`and nothing reads it back, so the drift is silent — this is exactly how mcpManager.ts came to report ` +
				`1.0.0 to every MCP server two releases after 1.0.0. Take the value from the manifest instead: a Plugin ` +
				`subclass has this.manifest.version, and a module that is not one should receive it as a constructor ` +
				`argument (see McpManager's pluginVersion).`,
		});
	}
}

// Docs are prose, so the rule is narrower: citing an old version as history is
// fine (AGENTS.md does it deliberately), but writing the *current* one means a
// sentence that silently becomes false on the next release. Both READMEs said
// "early alpha (0.1.0-alpha.x)" through the whole 1.0.x line.
for (const doc of docs) {
	let text;
	try {
		text = readFileSync(doc, "utf8");
	} catch {
		continue;
	}
	const lines = text.split("\n");
	for (const [index, line] of lines.entries()) {
		if (!line.includes(version)) {
			continue;
		}
		failures.push({
			at: `${doc}:${index + 1}`,
			what: line.trim(),
			why:
				`Prose that names the current version goes stale on the next release with nothing to catch it. ` +
				`Point readers at manifest.json (or the About tab, which reads it) instead of restating the number.`,
		});
	}
}

if (failures.length > 0) {
	console.error(`check-version: ${failures.length} place(s) other than ${VERSION_HOMES.join(", ")} spell out ${version}\n`);
	for (const failure of failures) {
		console.error(`  ✗ ${failure.at}  ${failure.what}`);
		console.error(`    ${failure.why}\n`);
	}
	process.exit(1);
}

console.log(
	`check-version: ${version} lives only in ${VERSION_HOMES.join(", ")} (${sources.length} sources and ${docs.length} docs clean)`,
);
