import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
				// Electron's safeStorage (API-key encryption) hands back Buffers,
				// so the desktop path references the Node global inside this
				// browser-globals config.
				Buffer: "readonly",
				// A TS lib type, not a runtime global: the session search returns
				// one from its lazy source. The browser-globals preset predates
				// these landing in the list, so `no-undef` flags the annotation —
				// the same gap `src/net/shims` works around for AsyncGenerator.
				AsyncIterable: "readonly",
			},
			parserOptions: {
				projectService: {
					// Files that no tsconfig lists, so type-aware rules would fail on
					// them outright. `eslint.config.mts` is matched by the recommended
					// config's `**/*.mts` glob but is not a source file, and the
					// `scripts/*.mjs` gates are build tooling — `tsconfig.json`
					// includes `scripts/**/*.ts`, not `.mjs`.
					allowDefaultProject: [
						'eslint.config.mts',
						'manifest.json',
						'scripts/*.mjs',
						'src/extensions/bookmarkFactory.mjs'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// The official Obsidian scanner runs typescript-eslint's
		// `no-unnecessary-type-assertion`; keeping it on here means a stale cast
		// fails locally instead of resurfacing in the marketplace Scorecard
		// (issue #203). Scoped to TS files: the tseslint plugin this rule needs
		// is only registered for those.
		files: ["**/*.ts", "**/*.tsx"],
		rules: {
			"@typescript-eslint/no-unnecessary-type-assertion": "error",
		},
	},
	{
		// The SDK shims (issue #92) reproduce the two provider SDKs' HTTP surface
		// so the real packages stay out of the bundle. They never touch a global
		// fetch themselves — the caller injects one — but the file references
		// node:http types to describe the wire shape it decodes.
		files: ["src/net/shims/*.ts"],
		languageOptions: {
			globals: {
				// First async-generator usage in the plugin; the browser-globals
				// preset predates the TS lib type landing in the globals list.
				AsyncGenerator: "readonly",
			},
		},
		rules: {
			"import/no-nodejs-modules": "off",
			"no-restricted-globals": "off",
		},
	},
	globalIgnores([
		// Mirrors the community-plugin scanner's own ignore set, which the official
		// `docs/configuration.md` publishes. Keeping the two aligned is the point:
		// this gate used to report 0/0 while the scanner failed the submission,
		// because our per-path rule exemptions are invisible to it and it lints
		// files we were not looking at. What the scanner skips, we skip; what it
		// checks, this reports — so a clean run here means a clean run there.
		"node_modules",
		// Nested agent worktrees are separate checkouts; linting them here would
		// report the same files twice and fail on their own build artifacts.
		".claude",
		"dist",
		// Build and utility scripts, not plugin code. The scanner skips
		// `**/scripts/**` and every `.mjs`/`.cjs`/`.mts`/`.cts` for the same
		// reason: none of it is bundled into `main.js`.
		"scripts/**",
		// Test files and test utilities. `src/testUtils/**` is named to match the
		// scanner's `**/testUtils**` pattern — the directory reproduces Obsidian's
		// own API surface (its `hide()` really does assign `style.display`), so the
		// rules that rightly steer plugin code elsewhere do not apply to it, and
		// none of it reaches the bundle.
		"**/*.test.ts",
		"**/*.test.tsx",
		"src/testUtils/**",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
