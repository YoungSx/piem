/**
 * Bun preload that pins `.md` imports to raw text.
 *
 * Bun's built-in markdown loader transpiles a `.md` import into rendered HTML
 * (`# Title` arrives as `<h1>Title</h1>`), while esbuild's `text` loader — the
 * one the production bundle uses — hands back the file verbatim. Left alone,
 * every test that reaches a builtin skill would run against a document the
 * shipped plugin never produces. Bun's plugin `loader` whitelist has no
 * `text` entry, so the raw text is wrapped in a one-line JS module instead.
 *
 * Loaded through `preload` in bunfig.toml; inert outside bun.
 */
Bun.plugin({
	name: "md-as-text",
	setup(build) {
		build.onLoad({ filter: /\.md$/ }, async (args) => ({
			contents: `export default ${JSON.stringify(await Bun.file(args.path).text())};`,
			loader: "js",
		}));
	},
});
