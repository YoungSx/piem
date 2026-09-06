/**
 * Every icon name the plugin may ask `setIcon` to draw.
 *
 * The visual harness resolves glyphs through `scripts/icons.json`, so a name
 * missing from that file means a blank glyph or a thrown page — and the miss is
 * invisible to `tsc` because `IconName` is an open string. Literal names are
 * grepped; the dynamic ones (catalog tables, state-to-glyph functions) are
 * imported and evaluated here so a new catalog row cannot outpace the file.
 *
 * `drawableIconNames()` filters out `TOOL_CATALOG`'s category words ("read",
 * "write", "web", "search", "other", "subagent"), which feed `categorizeTool`
 * and never `setIcon`.
 *
 * Known blind spots, kept small and listed rather than pretended away:
 * `traceIcon` / `harnessIcon` / the send-squircle toggle in MessageList.tsx
 * return literal names inline — they are enumerated in `UNEXPORTED_ICONS`
 * below, next to the functions they shadow.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "src");

/**
 * Icon names returned inside functions that grep cannot see through and that
 * are not exported. When MessageList.tsx grows another state-to-glyph helper,
 * add its names here — the comment it shadows should say so too.
 */
const UNEXPORTED_ICONS = ["terminal", "info", "send", "square"];

/** Every literal icon-ish string from plugin and harness sources. */
function grepLiteralIconNames() {
	const files = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			const stats = statSync(path);
			if (stats.isDirectory()) {
				walk(path);
			} else if (/\.(tsx?|mjs)$/.test(entry) && !/\.test\./.test(entry)) {
				files.push(path);
			}
		}
	};
	walk(SRC);
	files.push(join(HERE, "preview-visual.mjs"));

	const names = new Set();
	// `name="…"` is ObsidianIcon's prop, `icon(=|:) "…"` covers object entries
	// and call-site kwargs, `setIcon(_, "…")` covers direct calls. A name or
	// icon prop can also be a brace expression (`name={x ? "a" : "b"}`), whose
	// literals only show up if the whole span is swept — so those spans are
	// captured and every quoted token inside is taken.
	const patterns = [
		/\bname\s*=\s*"([a-z0-9][a-z0-9-]*)"/g,
		/\bicon\s*(?:=|:)\s*"([a-z0-9][a-z0-9-]*)"/gi,
		/setIcon\([^,]+,\s*"([a-z0-9][a-z0-9-]*)"/g,
	];
	const braceProps = /\b(?:name|icon)\s*=\s*\{([^}]*)\}/g;
	const quoted = /"([a-z0-9][a-z0-9-]*)"/g;
	for (const path of files) {
		const text = readFileSync(path, "utf8");
		for (const pattern of patterns) {
			for (const match of text.matchAll(pattern)) {
				names.add(match[1]);
			}
		}
		for (const span of text.matchAll(braceProps)) {
			for (const match of span[1].matchAll(quoted)) {
				names.add(match[1]);
			}
		}
	}
	return names;
}

/** Names reachable from the dynamic sources a grep cannot see through. */
async function dynamicIconNames() {
	const { TOOL_CATALOG, GENERIC_TOOL_ICON } = await import("../src/ui/toolCatalog.ts");
	const { compactionRowIcon } = await import("../src/ui/compactionRow.ts");
	const { describeReplyCutoff } = await import("../src/ui/replyCutoff.ts");

	const names = new Set([GENERIC_TOOL_ICON, ...UNEXPORTED_ICONS]);
	for (const entry of Object.values(TOOL_CATALOG)) {
		names.add(entry.icon);
	}
	for (const state of ["running", "failed", "done"]) {
		names.add(compactionRowIcon(state));
	}
	// The five stopReasons `describeReplyCutoff` answers (aborted with and
	// without `steeredAway`, length starved and truncated, error); every other
	// reason returns null and draws nothing. The starved sample pairs a full
	// context window with heavy output so `isContextStarved` flips true.
	const samples = [
		{ stopReason: "aborted" },
		{ stopReason: "aborted", steeredAway: true },
		{ stopReason: "length", usage: { input: 0, cacheRead: 0, output: 0 } },
		{
			stopReason: "length",
			usage: { input: 0, cacheRead: 0, output: 1000 },
		},
		{ stopReason: "error", errorMessage: "some provider text" },
	];
	const t = { t: (key) => key };
	for (const sample of samples) {
		const cutoff = describeReplyCutoff(sample, t, 2000);
		if (cutoff?.icon) {
			names.add(cutoff.icon);
		}
	}
	return names;
}

/**
 * Every name the UI may hand to `setIcon`: grep + dynamic sources,
 * deduplicated, category words dropped.
 */
export async function drawableIconNames() {
	const { TOOL_CATALOG } = await import("../src/ui/toolCatalog.ts");
	const categories = new Set(Object.values(TOOL_CATALOG).map((entry) => entry.category));
	const all = new Set([...grepLiteralIconNames(), ...(await dynamicIconNames())]);
	return [...all].filter((name) => !categories.has(name)).sort();
}
