import path from "node:path";
import { closeOverPlatform } from "./pi-scoped-factories.mjs";

/** Close the original synchronous resource loaders over one read-only Vault snapshot. */
export async function buildResourceFactory(root) {
	const [{ default: esbuild }, { default: ts }, { piExtensionsPlugin }] = await Promise.all([
		import("esbuild"), import("typescript"), import("./pi-extensions.mjs"),
	]);
	const pkg = path.join(root, "node_modules/@earendil-works/pi-coding-agent");
	const platform = "piem:extension-platform";
	const names = "existsSync, readdirSync, readFileSync, statSync, realpathSync, accessSync, constants";
	const built = await esbuild.build({
		stdin: {
			contents: `import { loadSkillsFromDir, formatSkillsForPrompt } from ${JSON.stringify(path.join(pkg, "dist/core/skills.js"))};
import { loadPromptTemplates, parseCommandArgs, substituteArgs } from ${JSON.stringify(path.join(pkg, "dist/core/prompt-templates.js"))};
import { parseFrontmatter } from ${JSON.stringify(path.join(pkg, "dist/utils/frontmatter.js"))};
export default { parseFrontmatter, loadSkillsFromDir, formatSkillsForPrompt, loadPromptTemplates, parseCommandArgs, substituteArgs };`,
			resolveDir: root,
		},
		bundle: true, write: false, metafile: true, format: "esm", platform: "browser", target: "es2018", logLevel: "silent",
		plugins: [{
			name: "pi-resource-filesystem",
			setup(build) {
				build.onResolve({ filter: /^(yaml|ignore)$/ }, args => ({ path: args.path, external: true }));
				build.onResolve({ filter: /^(node:)?fs$/ }, args => args.importer.startsWith(pkg) ? { path: "fs", namespace: "pi-resource-fs" } : undefined);
				build.onResolve({ filter: /^piem:extension-platform$/ }, () => ({ path: platform, external: true }));
				build.onLoad({ filter: /.*/, namespace: "pi-resource-fs" }, () => ({ contents: `export { ${names} } from ${JSON.stringify(platform)};`, loader: "js" }));
			},
		}, piExtensionsPlugin(root, true)],
	});
	return { contents: closeOverPlatform(built.outputFiles[0].text, new Set(["yaml", "ignore"]), ts), loader: "js" };
}
