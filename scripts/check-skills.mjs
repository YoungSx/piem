import { readFile } from "node:fs/promises";
import { buildBuiltinSkills } from "./builtin-skills.mjs";

/** The released JSON must be the one the built JS expects, not a stale copy. */
const expected = await buildBuiltinSkills();
const actual = await readFile("dist/builtin-skills.json", "utf8");
if (actual !== expected.content) throw new Error("dist/builtin-skills.json does not match the standard skill sources. Rebuild first.");
const bundle = await readFile(process.argv[2] ?? "main.js", "utf8");
if (!bundle.includes(expected.asset.sha256)) throw new Error("main.js does not pin the packaged skill resource.");
if (bundle.includes("/__piem_builtin_skills__")) throw new Error("The virtual built-in skill root is still in main.js.");
const { files } = JSON.parse(actual);
for (const file of files) {
	// esbuild may escape Unicode; paragraphs that are ASCII still detect a
	// copied text payload, and the metafile gate catches Markdown imports too.
	const body = file.content.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "");
	const line = body.split("\n").find((line) => line.length > 55 && /^[\x20-\x7e]+$/.test(line));
	if (line && bundle.includes(line)) throw new Error(`Skill body was bundled into JavaScript: ${file.path}`);
}
console.log(`check-skills: ${expected.asset.names.length} standard skills, ${expected.asset.bytes} bytes; source, resource and bundle digest agree`);
