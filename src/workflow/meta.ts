/**
 * meta.ts — extract and validate a workflow script's `meta` block.
 *
 * Ported from tintinweb/pi-subagents' workflow engine (`meta.ts`), which ports
 * Claude Code's contract. Workflow scripts open with `export const meta = { … }`,
 * and the block has to be readable *before* execution because the declared
 * phases seed the progress tree. Claude Code parses with acorn and requires a
 * pure literal; this takes the same contract without the dependency: scan to the
 * matching brace, then evaluate only that fragment. A pure literal has nothing
 * to call, so evaluating it cannot reach anything.
 *
 * The scanner is string-, comment-, and regex-aware: a workflow's `detail`
 * routinely contains braces, and `phases: [{ title: "a}b" }]` must not
 * terminate the scan early.
 *
 * Deltas from upstream, both because this host has no `node:vm`:
 *   - the fragment evaluates through `new Function("return ( … )")` in this
 *     realm — same purity argument, and an IIFE in the fragment is still
 *     computable, so the impure-literal rules below carry the load;
 *   - upstream bound synchronous execution with vm's `timeout` because the
 *     evaluation runs on the host thread before the worker exists. A WebView
 *     cannot bound synchronous JS, so a pathological literal that hangs would
 *     wedge the UI. The prelude and the worker-side compile keep real scripts
 *     off the host thread; `meta` itself is the only host-thread evaluation and
 *     the interpolation ban below already rules out its cheapest hang shape.
 */

/** A phase declared up front, so the progress tree can show it before any agent runs. */
export interface WorkflowPhaseMeta {
	title: string;
	detail?: string;
	/** Set when a phase pins a model; display-only, the runtime does not read it. */
	model?: string;
}

export interface WorkflowMeta {
	name: string;
	description: string;
	/** Shown in listings. Not used by the runtime. */
	whenToUse?: string;
	phases?: WorkflowPhaseMeta[];
}

export interface MetaExtraction {
	meta: WorkflowMeta;
	/**
	 * The script with the leading `export ` blanked out, so `const meta = {...}`
	 * compiles inside the worker. Replacing the keyword with spaces rather than
	 * deleting it keeps every subsequent offset — and therefore every reported
	 * line and column — identical to the source the author wrote.
	 */
	body: string;
}

export class WorkflowMetaError extends Error {}

const PURE_LITERAL_HINT =
	"The `meta` object must be a PURE LITERAL — no variables, function calls, spreads, or template interpolation.";

/** Matches `export const meta =` allowing arbitrary inner whitespace. */
const META_DECLARATION = /(^|[\r\n])[ \t]*export[ \t\r\n]+const[ \t\r\n]+meta[ \t\r\n]*=/;

interface ScanResult {
	/** Index of the literal's closing brace, or -1 when braces never balance. */
	end: number;
	/**
	 * True when a `${` substitution opened inside a template literal. Reported
	 * separately because such a fragment can still *evaluate* — `` `a${1+1}b` ``
	 * needs no globals — so an evaluation pass cannot catch it.
	 */
	sawInterpolation: boolean;
}

/**
 * Find the index just past the object literal that starts at `open`.
 *
 * Tracks string, template, comment, and regex context so braces inside them do
 * not move the depth counter.
 */
function scanObjectLiteral(source: string, open: number): ScanResult {
	let depth = 0;
	let i = open;
	let sawInterpolation = false;
	// What we are currently inside of. "code" means brace counting is live.
	let mode: "code" | "line-comment" | "block-comment" | "single" | "double" | "template" | "regex" = "code";
	// Template literals nest: `${ {a:1} }` re-enters code, and the closing brace
	// of that substitution must not be read as the object's. One depth per level.
	const templateStack: number[] = [];

	while (i < source.length) {
		const c = source[i];
		const next = source[i + 1];

		if (mode === "line-comment") {
			if (c === "\n") mode = "code";
			i++;
			continue;
		}
		if (mode === "block-comment") {
			if (c === "*" && next === "/") { mode = "code"; i += 2; continue; }
			i++;
			continue;
		}
		if (mode === "single" || mode === "double" || mode === "regex") {
			if (c === "\\") { i += 2; continue; }
			if (mode === "single" && c === "'") mode = "code";
			else if (mode === "double" && c === '"') mode = "code";
			else if (mode === "regex" && c === "/") mode = "code";
			// An unterminated regex/string can't run past a newline; bail to code so a
			// misdetected regex (see below) cannot swallow the rest of the literal.
			else if (c === "\n" && mode !== "double") mode = "code";
			i++;
			continue;
		}
		if (mode === "template") {
			if (c === "\\") { i += 2; continue; }
			if (c === "`") { mode = "code"; i++; continue; }
			if (c === "$" && next === "{") {
				sawInterpolation = true;
				templateStack.push(depth);
				depth++;
				mode = "code";
				i += 2;
				continue;
			}
			i++;
			continue;
		}

		// mode === "code"
		if (c === "/" && next === "/") { mode = "line-comment"; i += 2; continue; }
		if (c === "/" && next === "*") { mode = "block-comment"; i += 2; continue; }
		if (c === "'") { mode = "single"; i++; continue; }
		if (c === '"') { mode = "double"; i++; continue; }
		if (c === "`") { mode = "template"; i++; continue; }
		if (c === "/" && isRegexPosition(source, i)) { mode = "regex"; i++; continue; }
		if (c === "{") { depth++; i++; continue; }
		if (c === "}") {
			depth--;
			i++;
			if (templateStack.length > 0 && depth === templateStack[templateStack.length - 1]) {
				templateStack.pop();
				mode = "template";
				continue;
			}
			if (depth === 0) return { end: i, sawInterpolation };
			continue;
		}
		i++;
	}
	return { end: -1, sawInterpolation };
}

/**
 * Decide whether the `/` at `i` opens a regex literal rather than a division.
 *
 * Walks back past whitespace and comments to the previous significant char: a
 * regex can only follow an operator or opener, never a value. The only thing
 * riding on this is not miscounting braces inside a `meta` literal — and a
 * `meta` literal containing division is already not a pure literal.
 */
function isRegexPosition(source: string, i: number): boolean {
	let j = i - 1;
	while (j >= 0 && /\s/.test(source[j] as string)) j--;
	if (j < 0) return true;
	const prev = source[j] as string;
	// Identifier/number/closer before `/` means division.
	return !/[\w$)\]]/.test(prev);
}

function fail(message: string): never {
	throw new WorkflowMetaError(message);
}

function assertPhases(value: unknown): WorkflowPhaseMeta[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) fail("`meta.phases` must be an array of { title, detail?, model? } objects.");
	return value.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			fail(`\`meta.phases[${index}]\` must be an object with a \`title\`.`);
		}
		const { title, detail, model } = entry as Record<string, unknown>;
		if (typeof title !== "string" || title.trim() === "") {
			fail(`\`meta.phases[${index}].title\` must be a non-empty string.`);
		}
		if (detail !== undefined && typeof detail !== "string") {
			fail(`\`meta.phases[${index}].detail\` must be a string.`);
		}
		if (model !== undefined && typeof model !== "string") {
			fail(`\`meta.phases[${index}].model\` must be a string.`);
		}
		return { title, ...(detail !== undefined ? { detail } : {}), ...(model !== undefined ? { model } : {}) };
	});
}

/**
 * Pull `meta` off the front of a workflow script and hand back the runnable body.
 *
 * Throws {@link WorkflowMetaError} with author-facing guidance for every
 * rejection — these messages are shown verbatim to whoever wrote the script.
 */
export function extractMeta(source: string): MetaExtraction {
	const declaration = META_DECLARATION.exec(source);
	if (!declaration) {
		fail(
			"A workflow script must begin with `export const meta = { name, description }`.\n" +
				PURE_LITERAL_HINT,
		);
	}

	const open = source.indexOf("{", declaration.index + declaration[0].length);
	if (open === -1) fail("`export const meta` must be assigned an object literal.\n" + PURE_LITERAL_HINT);

	const { end: close, sawInterpolation } = scanObjectLiteral(source, open);
	if (close === -1) fail("`meta` object literal is never closed — check for an unbalanced `{`.");

	// Caught here rather than by evaluation: a self-contained substitution such
	// as `` `a${1 + 1}b` `` resolves without touching a single global, so it
	// would silently produce "a2b".
	if (sawInterpolation) {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: quoting the syntax being rejected
		fail("`meta` must not use template interpolation (`${...}`).\n" + PURE_LITERAL_HINT);
	}

	const fragment = source.slice(open, close);
	let value: unknown;
	try {
		// A pure literal needs no globals, so anything reaching for one (a
		// variable, a helper call) throws here and is reported as impure.
		value = new Function(`return (${fragment})`)();
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		fail(`\`meta\` could not be evaluated: ${detail}\n${PURE_LITERAL_HINT}`);
	}

	if (!value || typeof value !== "object" || Array.isArray(value)) {
		fail("`meta` must be an object literal.\n" + PURE_LITERAL_HINT);
	}
	const raw = value as Record<string, unknown>;

	if (typeof raw.name !== "string" || raw.name.trim() === "") {
		fail("`meta.name` is required and must be a non-empty string.");
	}
	if (typeof raw.description !== "string" || raw.description.trim() === "") {
		fail("`meta.description` is required and must be a non-empty string.");
	}
	if (raw.whenToUse !== undefined && typeof raw.whenToUse !== "string") {
		fail("`meta.whenToUse` must be a string.");
	}
	const phases = assertPhases(raw.phases);

	const meta: WorkflowMeta = {
		name: raw.name,
		description: raw.description,
		...(raw.whenToUse !== undefined ? { whenToUse: raw.whenToUse as string } : {}),
		...(phases !== undefined ? { phases } : {}),
	};

	const exportAt = source.indexOf("export", declaration.index);
	const body = `${source.slice(0, exportAt)}${" ".repeat(6)}${source.slice(exportAt + 6)}`;

	return { meta, body };
}
