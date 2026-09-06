/**
 * Rebuild `scripts/icons.json` — the glyph set the visual harness resolves
 * `setIcon` with — from a pinned lucide-static copy.
 *
 * Obsidian ships a Lucide subset, and the plugin may only hand `setIcon` names
 * from that set; lucide-static at the pinned version is the copy of those SVGs
 * the harness can paint outside Obsidian. The name list comes from
 * `scan-icons.mjs` (grep + the dynamic icon sources), so a new icon in `src/`
 * lands here on the next rebuild instead of surfacing as a thrown page.
 *
 * Usage: LUCIDE_ICONS=<unpacked lucide-static icons/ dir> bun scripts/build-icons.mjs
 * Get the icons/ dir with `npm pack lucide-static@<version>` and untar — it is
 * deliberately not a repo dependency (bun install would refresh the whole
 * lockfile for one package's worth of SVGs).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drawableIconNames } from "./scan-icons.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The lucide-static version every earlier icons.json copy was stamped with —
 * the single lineage, kept so regenerated entries never mix SVG vintages.
 */
const LUCIDE_VERSION = "1.39.0";
const iconsDir = process.env.LUCIDE_ICONS;
if (!iconsDir || !existsSync(iconsDir)) {
	throw new Error(
		`set LUCIDE_ICONS to the unpacked lucide-static v${LUCIDE_VERSION} icons/ directory (npm pack lucide-static@${LUCIDE_VERSION}, untar, point at package/icons)`,
	);
}

const names = await drawableIconNames();
const icons = {};
const missing = [];
for (const name of names) {
	const path = join(iconsDir, `${name}.svg`);
	try {
		icons[name] = readFileSync(path, "utf8");
	} catch {
		missing.push(name);
	}
}
if (missing.length > 0) {
	throw new Error(
		`lucide-static v${LUCIDE_VERSION} has no ${missing.join(", ")} — check the pinned version against what Obsidian ships`,
	);
}

const out = join(HERE, "icons.json");
writeFileSync(out, JSON.stringify(icons, null, 1) + "\n");
console.log(`wrote ${out} — ${Object.keys(icons).length} icons from lucide-static v${LUCIDE_VERSION}`);
