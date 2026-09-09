import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { loadSkills } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PACKAGE_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 64;

/** Build-only: source files are never imported into the plugin's module graph. */
export async function buildBuiltinSkills(root = process.cwd()) {
	const skillsRoot = path.join(root, "skills");
	const files = [];
	const watchFiles = [path.join(root, "manifest.json")];
	const watchDirs = [];
	async function walk(dir) {
		watchDirs.push(dir);
		for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
			const absolute = path.join(dir, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`Skill symlink is not allowed: ${absolute}`);
			if (entry.isDirectory()) {
				await walk(absolute);
				continue;
			}
			const relative = path.relative(skillsRoot, absolute).split(path.sep).join("/");
			if (!entry.isFile() || !/^[a-z0-9-]+\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.md$/.test(relative)) {
				throw new Error(`Skill resources must be Markdown with safe relative paths: ${relative}`);
			}
			const content = await readFile(absolute, "utf8");
			if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error(`Skill file too large: ${relative}`);
			files.push({ path: relative, content });
			watchFiles.push(absolute);
		}
	}
	await walk(skillsRoot);
	if (files.length === 0 || files.length > MAX_FILES) throw new Error(`Expected 1-${MAX_FILES} skill files`);
	const names = [];
	for (const file of files.filter((file) => file.path.endsWith("/SKILL.md"))) {
		const [dir, filename, extra] = file.path.split("/");
		if (filename !== "SKILL.md" || extra) throw new Error(`Nested skill entry: ${file.path}`);
		const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(file.content);
		const metadata = frontmatter ? parse(frontmatter[1]) : undefined;
		if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
			|| metadata.name !== dir || !NAME.test(dir) || dir.length > 64
			|| typeof metadata.description !== "string" || !metadata.description.trim() || metadata.description.length > 1024) {
			throw new Error(`Invalid required skill frontmatter: ${file.path}`);
		}
		if (names.includes(dir)) throw new Error(`Duplicate skill: ${dir}`);
		names.push(dir);
	}
	for (const file of files) {
		if (!names.includes(file.path.split("/")[0])) throw new Error(`Resource has no SKILL.md: ${file.path}`);
		// Only actual Markdown links outside code fences; paths in examples are not resources.
		const prose = file.content.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");
		for (const match of prose.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
			const href = match[1];
			if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(href)) continue;
			const target = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), decodeURIComponent(href.split("#")[0])));
			if (!target.startsWith(`${file.path.split("/")[0]}/`) || !files.some((candidate) => candidate.path === target)) {
				throw new Error(`Broken skill reference in ${file.path}: ${href}`);
			}
		}
	}
	const env = new NodeExecutionEnv({ cwd: root });
	try {
		const loaded = await loadSkills(env, skillsRoot);
		if (loaded.diagnostics.length || loaded.skills.length !== names.length) {
			throw new Error(`Pi rejected the skill collection: ${JSON.stringify(loaded.diagnostics)}`);
		}
	} finally {
		await env.cleanup();
	}
	const { version } = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
	const content = `${JSON.stringify({ schema: 1, version, files })}\n`;
	const bytes = Buffer.byteLength(content);
	if (bytes > MAX_PACKAGE_BYTES) throw new Error("Skill package is too large");
	return { content, asset: { sha256: createHash("sha256").update(content).digest("hex"), bytes, names }, watchFiles, watchDirs };
}

/** esbuild onStart runs on both builds and watched source changes. */
export function builtinSkillsPlugin(root = process.cwd(), development = false) {
	let current;
	return {
		name: "builtin-skills-resource",
		setup(build) {
			build.onStart(async () => {
				current = await buildBuiltinSkills(root);
				const outDir = path.join(root, "dist");
				await mkdir(outDir, { recursive: true });
				await writeFile(path.join(outDir, "builtin-skills.json"), current.content);
				if (development) await writeFile(path.join(root, "builtin-skills.json"), current.content);
			});
			build.onLoad({ filter: /[/\\]builtinSkillAsset\.ts$/ }, () => ({
				contents: `export const BUILTIN_SKILL_ASSET = ${JSON.stringify(current.asset)}; export const BUILTIN_SKILLS_DEVELOPMENT = ${development};`,
				loader: "js",
				watchFiles: current.watchFiles,
				watchDirs: current.watchDirs,
			}));
		},
	};
}
