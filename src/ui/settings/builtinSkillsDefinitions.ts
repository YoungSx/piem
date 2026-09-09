import type { ButtonComponent, SettingDefinitionItem } from "obsidian";
import type { SkillLoadReport } from "../../agent/skillLoader";
import { emptyBuiltinSkillReport, type BuiltinSkillProblem, type BuiltinSkillReport } from "../../skills/builtinSkillState";
import type { Translator } from "../../i18n";
import type { SettingsPanelHost } from "./panelHost";

export function builtinSkillsStatus(report: BuiltinSkillReport, t: Translator): string {
	switch (report.status) {
		case "idle": return t.t("skills.builtinIdle");
		case "preparing": return t.t("skills.builtinPreparing");
		case "ready": return t.t("skills.builtinReady");
		case "issues": return t.t("skills.builtinIssues");
		case "failed": return t.t("skills.builtinFailed");
		case "newer": return t.t("skills.builtinNewer");
	}
}

function problemDescription(problem: BuiltinSkillProblem, t: Translator): string {
	switch (problem.reason) {
		case "modified": return t.t("skills.builtinProblemModified");
		case "unowned": return t.t("skills.builtinProblemUnowned");
		case "read": return t.t("skills.builtinProblemRead");
		case "write": return t.t("skills.builtinProblemWrite");
		case "retired": return t.t("skills.builtinProblemRetired");
	}
}

/** Native settings rows; preparation is an operation, never a permission switch. */
export function builtinSkillsDefinitions(host: SettingsPanelHost, load?: SkillLoadReport): SettingDefinitionItem[] {
	const { t } = host;
	const report = load?.builtin.install ?? emptyBuiltinSkillReport();
	const description = [t.t("skills.builtinDisclosure"), builtinSkillsStatus(report, t)];
	if (report.removed.length) description.push(t.t("skills.builtinRemoved", { names: report.removed.join(", ") }));
	if (report.modified.length) description.push(t.t("skills.builtinModified", { names: report.modified.join(", ") }));
	return [
		{
			name: t.t("skills.builtinHeading"),
			desc: description.join("\n"),
			render: (setting) => {
				const buttons: ButtonComponent[] = [];
				let pending = false;
				setting.addButton((button) => {
					buttons.push(button);
					button.setButtonText(t.t("skills.builtinRetry"));
					button.setDisabled(report.status === "preparing");
					button.onClick(() => { void prepare(false); });
				});
				setting.addButton((button) => {
					buttons.push(button);
					button.setButtonText(t.t("skills.builtinRestore"));
					button.setDisabled(report.status === "preparing");
					button.onClick(() => { void prepare(true); });
				});
				async function prepare(restore: boolean): Promise<void> {
					if (pending) return;
					pending = true;
					buttons.forEach((button) => {
						button.setDisabled(true);
					});
					try {
						await host.skills.prepareBuiltins(restore);
					} catch (error) {
						host.logger.warn("Built-in skill preparation failed", () => ({ error: String(error) }));
					} finally {
						pending = false;
						buttons.forEach((button) => {
							button.setDisabled(false);
						});
						host.refresh();
					}
				}
			},
		},
		...(report.error ? [{ name: "Piem/builtin-skills", desc: report.error, searchable: false }] : []),
		...report.problems.map((problem) => ({
			name: problem.path,
			desc: problemDescription(problem, t),
			searchable: false,
		})),
	];
}
