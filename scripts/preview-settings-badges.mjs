// Render the shipped definitions and badge helpers using deterministic sample data.
// OBSIDIAN_CSS can point to an installed Obsidian app.css for native layout checks.
import { readFileSync } from "node:fs";

export async function settingsBadgesPreview({ document, styles, tokens, lightTokens, coreShim }) {
	const { Setting, SettingGroup } = await import("obsidian");
	const { getT } = await import("../src/i18n/index.ts");
	const { DEFAULT_SETTINGS } = await import("../src/settings.ts");
	const { SettingsPanelState } = await import("../src/ui/settings/panelState.ts");
	const { extensionsDefinitions } = await import("../src/ui/settings/extensionsDefinitions.ts");
	const { NOOP_LOGGER } = await import("../src/logging/Logger.ts");
	const rows = [
		{ name: "link-graph", description: "Inspect note links", path: "Piem/skills/link-graph/SKILL.md", dirName: "link-graph", provenance: { url: "https://example.com/skills/link-graph/SKILL.md", kind: "raw", importedAt: "", files: {} } },
		{ name: "daily-review", description: "Review daily notes", path: "Piem/skills/daily-review/SKILL.md", dirName: "daily-review" },
		{ name: "reading-list", description: "Keep a reading list", path: "Piem/skills/reading-list.md", dirName: "" },
	];
	const report = {
		vault: [0, 1].map((n) => ({ path: `Piem/skills/broken-${n}.md`, type: "warning", code: "file_info_failed", message: "Missing description" })),
		templates: [],
		user: {
			skills: [{ name: "project-notes", description: "Capture project decisions and follow-up work.", filePath: "/skills/project-notes/SKILL.md", content: "", sourceDir: "/skills" }],
			searched: [
				{ dir: "~/.pi/agent/skills", found: true, loaded: 4 },
				{ dir: "~/.agents/skills", found: false, loaded: 0 },
				{ dir: "~/skills", found: true, loaded: 0 },
				{ dir: `~/work/${"long-folder-name-".repeat(8)}`, found: undefined, loaded: 0 },
			],
			diagnostics: [{ path: "~/work/skills", type: "warning", code: "list_failed", message: "EACCES: permission denied" }],
		},
	};
	const panels = [];
	for (const language of ["zh-cn", "en"]) {
		const t = getT(language);
		const servers = [
			{ name: "GitHub", status: "ok", enabled: true, toolCount: 12 },
			{ name: "Notion", status: "error", enabled: true, toolCount: 0, error: "401 Unauthorized" },
			{ name: "Figma", status: "untested", enabled: true, toolCount: 0 },
			{ name: "Slack", status: "disabled", enabled: false, toolCount: 0 },
			{ name: "Connecting", status: "error", enabled: true, toolCount: 0 },
			{ name: `server-${"long-name-".repeat(10)}`, status: "ok", enabled: true, toolCount: 123456 },
		].map((s, i) => ({ ...s, id: `server-${i}`, url: `https://example.com/${i}/mcp`, token: "", secretRef: "" }));
		let finishRetry;
		const pending = new Promise((resolve) => { finishRetry = resolve; });
		const state = new SettingsPanelState();
		state.skillsSnapshot = { inventory: { rows }, load: report };
		const host = {
			app: {}, t, settings: { ...DEFAULT_SETTINGS, mcpServers: servers }, logger: NOOP_LOGGER,
			refresh() {}, save: async () => {},
			skills: { list: async () => ({ rows }), lastSkillLoad: () => report, refreshAgent: async () => {}, catalog: () => [], userSkillsAvailable: true },
			mcp: { states: () => servers, reconnect: () => pending },
		};
		const root = document.createElement("div");
		const outer = new SettingGroup(root);
		const draw = (item, group) => {
			const setting = new Setting(group.listEl).setName(item.name ?? "");
			if (item.desc) setting.setDesc(item.desc);
			item.render?.(setting, group);
			if (item.name === "Connecting") setting.extraButtons[0].click();
		};
		for (const item of extensionsDefinitions(host, state)) {
			if (item.type === "list" || item.type === "group") {
				// Empty built-ins are outside this fixture's subject.
				if (item.heading === t.t("skills.builtinHeading")) continue;
				const group = new SettingGroup(root).setHeading(item.heading);
				if (item.type === "list") group.addClass("mod-list");
				for (const build of item.extraButtons ?? []) group.addExtraButton(build);
				if (item.addItem) group.addExtraButton((button) => {
					button.setIcon("plus").setTooltip(item.addItem.name);
					button.extraSettingsEl.setAttribute("aria-label", item.addItem.name);
				});
				for (const row of item.items) draw(row, group);
			} else {
				draw(item, outer);
				// Preserve the definitions' interleaved diagnostic/report order.
				root.append(outer.listEl.lastElementChild);
			}
		}
		root.firstElementChild.remove();
		for (const input of root.querySelectorAll("input[type=checkbox]")) {
			if (input.checked) input.setAttribute("checked", "");
		}
		for (const theme of ["dark", "light"]) {
			panels.push(`<section class="badge-preview theme-${theme}" data-language="${language}"><h2>${language} / ${theme}</h2>${root.innerHTML}</section>`);
		}
		finishRetry();
		await pending;
	}
	// Body-level variables must resolve against each panel's own theme, rather
	// than inherit values already resolved against the outer page's dark theme.
	const hostStyles = process.env.OBSIDIAN_CSS ? readFileSync(process.env.OBSIDIAN_CSS, "utf8").replace(
		/^body\s*\{(?=\s*(?:\/\*[\s\S]*?\*\/\s*)?--)/gm,
		"body, .badge-preview {",
	) : `
:root { ${tokens} --text-warning: #e0ac00; }
.theme-light { ${lightTokens} --text-success: #08b94e; --text-warning: #e0ac00; }
${coreShim}
.setting-group > .setting-item-heading { font-weight: var(--font-semibold); margin: 24px 0 12px; }
.extra-setting-button { display: flex; padding: 4px; color: var(--text-muted); }
.checkbox-container { height: 18px; width: 32px; border-radius: 9px; background: var(--background-modifier-border); position: relative; flex-shrink: 0; }
.checkbox-container.is-enabled { background: var(--interactive-accent); }
.checkbox-container::after { content: ""; position: absolute; width: 14px; height: 14px; top: 2px; left: 2px; background: white; border-radius: 50%; }
.checkbox-container.is-enabled::after { transform: translateX(14px); }
.checkbox-container input { opacity: 0; margin: 0; width: 100%; height: 100%; }
`;
	return {
		element: null,
		width: 1220,
		height: 6100,
		cleanup: async () => document.body.replaceChildren(),
		html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Extension badges</title><style>
${hostStyles}
body { margin: 0; background: var(--background-secondary); display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; padding: 16px; height: auto; overflow: auto; contain: none; }
.badge-preview { background: var(--background-primary); color: var(--text-normal); padding: 16px; min-width: 0; container-type: inline-size; }
.badge-preview > h2 { font-size: 15px; margin: 0 0 24px; }
${styles}
@media (max-width: 640px) { body { grid-template-columns: minmax(0, 1fr); padding: 8px; } .badge-preview { padding: 8px; } }
</style></head><body class="theme-dark">${panels.join("\n")}</body></html>`,
	};
}
