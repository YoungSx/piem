import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Fixture from the actual standard sources, installed as files in a fake Vault. */
export function officialSkillFiles(): Record<string, string> {
	const root = join(import.meta.dir, "../../skills");
	return Object.fromEntries(readdirSync(root).sort().map((name) => [
		`Piem/builtin-skills/${name}/SKILL.md`, readFileSync(join(root, name, "SKILL.md"), "utf8"),
	]));
}
