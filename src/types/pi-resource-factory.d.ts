declare module "pi-resource-factory" {
	export function createFactory(platform: {
		constants: { F_OK: number; R_OK: number };
		existsSync(path: string): boolean;
		readFileSync(path: string): string;
		statSync(path: string): unknown;
		readdirSync(path: string, options?: { withFileTypes?: boolean }): unknown[];
		realpathSync(path: string): string;
		accessSync(path: string): void;
	}): {
		loadSkillsFromDir: typeof import("../../node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js").loadSkillsFromDir;
		formatSkillsForPrompt: typeof import("../../node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js").formatSkillsForPrompt;
		loadPromptTemplates: typeof import("../../node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js").loadPromptTemplates;
		parseCommandArgs: typeof import("../../node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js").parseCommandArgs;
		substituteArgs: typeof import("../../node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js").substituteArgs;
		parseFrontmatter(content: string): { body: string; frontmatter: Record<string, unknown> };
	};
}
