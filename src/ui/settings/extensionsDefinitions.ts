import { Notice, TFile, type App, type ButtonComponent, type Setting, type SettingDefinitionItem, type SettingGroupItem } from "obsidian";
import type { SkillDiagnostic } from "@earendil-works/pi-agent-core";
import type { Translator } from "../../i18n";
import type { SkillRow } from "../../skills/skillManager";
import { type SettingsPanelState, type SkillsSnapshot } from "./panelState";
import { createMcpServerConfig, type McpServerConfig } from "../../mcp/mcpConfig";
import type { McpServerState } from "../../mcp/mcpManager";
import { openConfirmDelete } from "./confirmDelete";
import { setFoldableDescription } from "./descFold";
import { createEffectLine } from "./effectLine";
import { McpServerModal } from "./McpServerModal";
import { ImportSkillModal } from "./ImportSkillModal";
import {
	describeSkillRow,
	describeSkillReload,
	skillProblemRow,
	userSkillProblemsCopy,
	vaultSkillProblemsCopy,
	type SkillProblemsCopy,
} from "./skillsCopy";
import {
	describeUserSkillsDirProblem,
	describeUserSkillsDirReading,
	USER_SKILLS_DIR_PLACEHOLDER,
	userSkillsDirDescription,
	userSkillsDirName,
	userSkillsSearchedDescription,
	userSkillsSearchedLabel,
} from "./userSkillsCopy";
import { rowAction, type SettingsPanelHost } from "./panelHost";
import { sectionNote } from "./sectionNote";

/**
 * The Extensions tab as declarative definitions.
 *
 * This is the section the imperative panel worked hardest for, and the reason is
 * one shape repeated twice: create the containers synchronously, fill them from
 * an async read, and hold a mutation callback that empties and refills them. That
 * pattern needed the containers to exist before the data did, which is why the
 * old code created three sibling divs up front and referenced its own
 * `afterMutation` before declaring it.
 *
 * Declaratively the same requirement is met the other way round: the definitions
 * are built from whatever is known synchronously, the read runs alongside, and
 * `update()` rebuilds when the answer differs from what was drawn. Nothing holds
 * a container, so nothing can fill the wrong one.
 *
 * MCP needs none of that — `mcp.states()` is a synchronous read of the running
 * manager — so its section is a plain `list` whose only imperative part is the
 * one row-local reconciliation the enable toggle genuinely needs.
 */

/**
 * Starts a skills read unless one is already running, and rebuilds if it changed
 * anything.
 *
 * Stale-while-revalidate rather than load-once: the vault's skills folder is
 * ordinary vault content, so it can change while the panel is closed, and a
 * cache that trusted itself would show a skill the user deleted from the file
 * explorer. Every build revalidates; only a build whose answer differs triggers
 * `update()`, which is what keeps this from looping — an unchanged read
 * terminates the cycle rather than scheduling the next one.
 *
 * The load goes through the agent, not the panel: the reports below describe
 * *the agent's* load, so the panel has to have caused one. A settings tab opened
 * before any chat would otherwise render the empty report the service starts
 * with.
 */
function revalidateSkills(host: SettingsPanelHost, state: SettingsPanelState): void {
	if (state.skillsLoading) {
		return;
	}
	state.skillsLoading = true;
	void (async () => {
		try {
			await host.skills.refreshAgent();
			const next: SkillsSnapshot = { inventory: await host.skills.list(), load: host.skills.lastSkillLoad() };
			const changed = digest(state.skillsSnapshot) !== digest(next);
			state.skillsSnapshot = next;
			if (changed) {
				host.refresh();
			}
		} catch (cause) {
			// A failed read leaves the previous snapshot in place rather than
			// blanking the lists: the rows on screen were true a moment ago, and an
			// empty section would read as "no skills" instead of "could not look".
			// The startup path swallows this too; the Reload button is where a user
			// asks for a verdict and gets one.
			void cause;
		} finally {
			state.skillsLoading = false;
		}
	})();
}

/**
 * What a rebuild would change, as one string.
 *
 * Compared rather than deep-equalled because the only question is whether the
 * rendered rows would differ: names, paths, provenance, and the diagnostics and
 * searched folders the reports below print. Anything else on these objects
 * cannot reach the screen, so a change in it must not trigger a rebuild.
 */
function digest(snapshot: SkillsSnapshot | undefined): string {
	if (!snapshot) {
		return "";
	}
	const rows = snapshot.inventory.rows.map((row) => `${row.name}|${row.path}|${row.dirName}|${row.provenance?.url ?? ""}`);
	const user = snapshot.load.user;
	return JSON.stringify([
		rows,
		snapshot.load.vault.map(problemKey),
		user.skills.map((skill) => `${skill.name}|${skill.description}`),
		user.searched.map((entry) => `${entry.dir}|${entry.found}|${entry.loaded}`),
		user.diagnostics.map(problemKey),
	]);
}

function problemKey(diagnostic: SkillDiagnostic): string {
	const { path, message } = skillProblemRow(diagnostic);
	return `${path}|${message}`;
}

/** The Extensions tab's sections: vault skills, user skills, then MCP servers. */
export function extensionsDefinitions(host: SettingsPanelHost, state: SettingsPanelState): SettingDefinitionItem[] {
	revalidateSkills(host, state);
	const snapshot = state.skillsSnapshot;
	return [
		vaultSkillsList(host, state, snapshot),
		...problemRows(snapshot?.load.vault ?? [], vaultSkillProblemsCopy(host.t)),
		...userSkillsSection(host, state, snapshot),
		mcpList(host),
	];
}

/**
 * The vault's own skills: what the agent can load on request.
 *
 * A `list` because these are exactly what one is for — entries the user adds and
 * removes. Import is the add affordance; Reload is a header button because it is
 * not an add, it is the recovery for every problem the reports below can name:
 * fix the file, fix the folder's permissions, then press this. It is also the
 * only way to re-trigger a load with the log panel open, which is how the
 * underlying failure gets diagnosed at all.
 */
function vaultSkillsList(host: SettingsPanelHost, state: SettingsPanelState, snapshot: SkillsSnapshot | undefined): SettingDefinitionItem {
	const { t } = host;
	return {
		type: "list",
		heading: t.t("skills.heading"),
		addItem: {
			name: t.t("skills.import"),
			action: () =>
				new ImportSkillModal({
					app: host.app,
					t,
					fetchSource: (url) => host.skills.fetchSource(url),
					install: (source, skill) => host.skills.install(source, skill),
					onImported: () => reloadSkills(host, state),
				}).open(),
		},
		extraButtons: [
			(button) => {
				rowAction(button, "refresh-cw", t.t("skills.reload"));
				button.onClick(() => void announceReload(host, state, button));
			},
		],
		// No `emptyState`: a list holding the section note is never empty, so the
		// framework would never draw it. The empty sentence joins the note instead —
		// and only once a read has landed, since before that the folder has not been
		// looked in and claiming it is empty would be a guess.
		items: [
			sectionNote(t.t("skills.desc"), snapshot && snapshot.inventory.rows.length === 0 ? t.t("skills.empty") : undefined),
			...(snapshot?.inventory.rows ?? []).map((row) => vaultSkillRow(host, state, row)),
		],
	};
}

/**
 * Re-reads skills and reports the outcome.
 *
 * The verdict is a `Notice` because a clean reload changes nothing on screen —
 * the problem lists simply stay empty — and a button that appears to do nothing
 * reads as broken. It cannot be inline either: the reload rebuilds both lists, so
 * any element inside them is destroyed before it could be read.
 *
 * The problems themselves are not restated in the toast. They are listed under
 * the section each belongs to, where the path sits beside the message, and a
 * count in a toast that vanishes would be the less useful copy of both.
 */
async function announceReload(host: SettingsPanelHost, state: SettingsPanelState, button: { setDisabled(disabled: boolean): unknown }): Promise<void> {
	const { t } = host;
	button.setDisabled(true);
	try {
		await host.skills.refreshAgent();
		state.skillsSnapshot = { inventory: await host.skills.list(), load: host.skills.lastSkillLoad() };
		new Notice(describeSkillReload(host.skills.lastSkillLoad(), t));
		host.refresh();
	} catch (cause) {
		// Unlike the revalidation above, a failure here is not swallowed: someone
		// pressed a control and is waiting for its verdict.
		new Notice(t.t("skills.couldNotReload", { message: cause instanceof Error ? cause.message : String(cause) }));
	} finally {
		button.setDisabled(false);
	}
}

/** Re-reads after a mutation wrote skill files, then rebuilds from the new state. */
function reloadSkills(host: SettingsPanelHost, state: SettingsPanelState): void {
	// Dropped rather than compared: a mutation is known to have changed the folder,
	// so the next read must be treated as different even if the digest happens to
	// match — a delete followed by an identical import would otherwise leave the
	// rebuild unscheduled.
	state.skillsSnapshot = undefined;
	revalidateSkills(host, state);
}

function vaultSkillRow(host: SettingsPanelHost, state: SettingsPanelState, row: SkillRow): SettingGroupItem {
	const { t } = host;
	return {
		name: row.name,
		desc: describeSkillRow(row, t),
		render: (setting) => {
			// The path always names a real file: pi only reports skills it actually
			// loaded, so opening it needs no existence check beyond TFile's own.
			setting.addButton((button) => {
				button.setButtonText(t.t("skills.open"));
				button.onClick(() => void openVaultPath(host.app, row.path));
			});
			if (row.provenance) {
				setting.addButton((button) => {
					button.setButtonText(t.t("skills.update"));
					button.onClick(() => void runSkillUpdate(host, row, button, async () => reloadSkills(host, state)));
				});
			}
			// Deletion is directory-only: a root-level skill file is an ordinary note
			// the user owns, and the panel does not trash notes from a settings row.
			if (row.dirName !== "") {
				setting.addButton((button) => {
					button.setButtonText(t.t("skills.delete"));
					button.onClick(() => {
						openConfirmDelete(host.app, {
							subject: t.t("confirmDelete.skillSubject", { name: row.name }),
							consequences: [t.t("deletion.skillFiles")],
							t,
							onConfirm: () => runSkillRemove(host, row, async () => reloadSkills(host, state)),
						});
					});
				});
			}
		},
	};
}

/**
 * The problems from one skill layer, or nothing at all when it loaded cleanly.
 *
 * Framed rather than dumped. The messages here are the filesystem's own words —
 * `EACCES: permission denied, realpath '…'` — and a raw errno under no heading
 * reads as a crash in the plugin. One row per diagnostic, path as the name and
 * message as the description, rather than the messages joined into one
 * paragraph: `SkillDiagnostic` carries the two separately and they genuinely
 * differ, since the path names a symlink and the message names the resolved
 * target it could not read. Joining them throws away exactly the comparison the
 * reader needs.
 *
 * `code` stays off the screen. It is a jargon token with no consequence attached
 * (`file_info_failed`); it goes to the log, where a bug report gets assembled.
 *
 * Unsearchable, all of it: a filesystem error is not a setting anyone looks for
 * by name, and indexing the paths would put vault noise in the global results.
 */
function problemRows(diagnostics: readonly SkillDiagnostic[], copy: SkillProblemsCopy): SettingDefinitionItem[] {
	if (diagnostics.length === 0) {
		return [];
	}
	return [
		{ name: copy.heading, desc: copy.description, searchable: false },
		...diagnostics.map((diagnostic): SettingDefinitionItem => {
			const { path, message } = skillProblemRow(diagnostic);
			return {
				name: path,
				searchable: false,
				render: (setting) => {
					setting.descEl.createDiv({ cls: "piem-settings-problem", text: message });
				},
			};
		}),
	];
}

/**
 * The user-level skills section: the extra-folder row, then what was loaded.
 *
 * Skill files themselves are read-only — they live outside the vault by
 * definition, so their management belongs to pi and the user's editor. The one
 * thing this panel *does* own is the folder list's extra member, which is a
 * plugin setting like any other, and the report of what was actually read, which
 * is the section's whole reason to exist: pi's loader treats a missing directory
 * as "no skills here" and says nothing, so an unread folder is indistinguishable
 * from an empty one anywhere else.
 *
 * Absent entirely on mobile, where the node filesystem these live in does not
 * exist and a section promising skills that can never load is noise.
 */
function userSkillsSection(host: SettingsPanelHost, state: SettingsPanelState, snapshot: SkillsSnapshot | undefined): SettingDefinitionItem[] {
	if (!host.skills.userSkillsAvailable) {
		return [];
	}
	const { t } = host;
	const user = snapshot?.load.user;
	const searched = user?.searched ?? [];
	return [
		{
			type: "group",
			heading: t.t("skills.userHeading"),
			items: [
				sectionNote(t.t("skills.userDesc")),
				{
					name: userSkillsDirName(t),
					desc: userSkillsDirDescription(t),
					render: (setting) => configureUserSkillsDir(setting, host, state),
				},
				// Skills first — the list the heading promises — then the searched
				// report, then the problems, because a reader's first question is what
				// the agent can do, the second is why something is missing from that
				// answer, and the third is what the machine said about it.
				...(user && user.skills.length === 0
					? [{ name: t.t("skills.userEmpty"), searchable: false } satisfies SettingGroupItem]
					: (user?.skills ?? []).map(
							(skill): SettingGroupItem => ({
								name: skill.name,
								render: (setting) => {
									// Frontmatter descriptions are written by outside hands with no
									// length limit; past the budget the row folds instead of
									// stretching the list.
									setFoldableDescription(setting, skill.description, t);
								},
							}),
						)),
			],
		},
		// Nothing to frame means no frame: without this guard a zero-folder report
		// would render the label and its prose over an empty list.
		...(searched.length === 0
			? []
			: [
					{ name: userSkillsSearchedLabel(t), desc: userSkillsSearchedDescription(t), searchable: false } satisfies SettingDefinitionItem,
					// The path is the row's name, not interpolated into the sentence: it
					// stays selectable, and a long path cannot swallow the reading beside it.
					...searched.map(
						(entry): SettingDefinitionItem => ({
							name: entry.dir,
							desc: describeUserSkillsDirReading({ found: entry.found, loaded: entry.loaded }, t),
							searchable: false,
						}),
					),
				]),
		// Last, and after the user's own skills rather than at the top of the tab.
		// This is where someone already is when they ask why a folder was skipped,
		// and it is the long-form answer to a row reading "Could not be checked."
		...problemRows(user?.diagnostics ?? [], userSkillProblemsCopy(t)),
	];
}

/**
 * The extra-folder field, validated in place on blur.
 *
 * Follows the session-folder row's rules with two deliberate differences. An
 * emptied field is a valid answer here, not a fallback to restore: the built-in
 * pair simply stays the whole set, so the value clears to `""`. And a rejected
 * path reports why without touching the field, because the typed text is what the
 * message is about — re-normalizing it would tell the user the panel knows better
 * what they meant than they do.
 *
 * An accepted change reloads rather than patching rows: the searched report below
 * describes the *last* load, so it is only true again once the agent has read the
 * new folder. The old row rebuilt its own parent container from inside its blur
 * handler to achieve this; `refresh()` is the framework's version of the same
 * thing, and it does not require the row to know what contains it.
 */
function configureUserSkillsDir(setting: Setting, host: SettingsPanelHost, state: SettingsPanelState): void {
	const { settings, t } = host;
	const effect = createEffectLine(setting.descEl);
	const describe = (problem?: string): void => {
		effect.setText(problem ?? "");
		effect.toggleClass("piem-settings-effect--error", problem !== undefined);
	};

	setting.addText((text) => {
		text.setPlaceholder(USER_SKILLS_DIR_PLACEHOLDER);
		text.setValue(settings.userSkillsDir);
		text.inputEl.addEventListener("blur", () => {
			const typed = text.inputEl.value.trim();
			const problem = describeUserSkillsDirProblem(typed, t);
			if (problem) {
				describe(problem);
				return;
			}
			text.setValue(typed);
			describe();
			if (typed === settings.userSkillsDir) {
				return;
			}
			settings.userSkillsDir = typed;
			void (async () => {
				await host.save();
				reloadSkills(host, state);
			})();
		});
	});
}

/**
 * The MCP servers section: what remote tools the agent is offered.
 *
 * Saving — not a private reconnect call — is what reconnects: `host.save()`
 * reaches the running agent's configuration and the connect happens on that
 * path, so there is one road from "config changed" to "agent sees the new tools".
 *
 * Synchronous throughout, unlike the skills sections above: `mcp.states()` reads
 * the running manager, so the rows can be built where they are declared.
 */
function mcpList(host: SettingsPanelHost): SettingDefinitionItem {
	const { t } = host;
	const states = host.mcp.states();
	return {
		type: "list",
		heading: t.t("mcp.heading"),
		addItem: {
			name: t.t("mcp.add"),
			action: () => openMcpModal(host),
		},
		items: [
			sectionNote(
				t.t("mcp.desc"),
				// Unconditional now: mounting is pinned to the buffered transport
				// regardless of what this reader selected, so the limitation it
				// describes belongs to every reader (see mcpManager's mount).
				t.t("mcp.bufferedNoPush"),
				states.length === 0 ? t.t("mcp.empty") : undefined,
			),
			...states.map((state) => mcpRow(host, state)),
		],
	};
}

/** Opens the add/edit form and hands the finished row to the save-and-rebuild path. */
function openMcpModal(host: SettingsPanelHost, server?: McpServerConfig): void {
	new McpServerModal({
		app: host.app,
		secretStorage: host.secretStorage,
		readSecret: (id) => host.readSecret(id),
		t: host.t,
		server,
		test: (draft) => host.mcp.test(draft),
		onSubmit: async (draft) => {
			// Re-created through the config factory so the row lands normalized; the
			// modal's draft already carries a stable id, which makes this an upsert
			// and lets add and edit share one path.
			const normalized = createMcpServerConfig(draft);
			if (normalized === null) {
				return;
			}
			const existing = host.settings.mcpServers.findIndex((row) => row.id === normalized.id);
			if (existing >= 0) {
				host.settings.mcpServers[existing] = normalized;
			} else {
				host.settings.mcpServers.push(normalized);
			}
			await host.save();
			host.refresh();
		},
	}).open();
}

function mcpRow(host: SettingsPanelHost, state: McpServerState): SettingGroupItem {
	const { t } = host;
	return {
		// The URL is the address requests leave to, so it reads as the row's main
		// description; the connection verdict hangs beneath it as an effect line,
		// the same slot every other async status in this panel uses. Both are set in
		// `render` rather than as `desc`: the URL folds, and the verdict is rewritten
		// in place.
		name: state.name,
		aliases: [state.url],
		render: (setting) => {
			// URLs are handed in verbatim and can be very long; the fold keeps the row
			// scannable, and the verdict line below still appends after the folded body.
			setFoldableDescription(setting, state.url, t);
			const verdictEl = createEffectLine(setting.descEl);
			setMcpVerdict(verdictEl, state, t);
			configureMcpToggle(setting, host, state, verdictEl);
			setting.addExtraButton((button) => {
				rowAction(button, "pencil", t.t("mcp.edit"));
				button.onClick(() => {
					const server = host.settings.mcpServers.find((row) => row.id === state.id);
					if (server) {
						openMcpModal(host, server);
					}
				});
			});
			setting.addExtraButton((button) => {
				rowAction(button, "trash-2", t.t("mcp.delete"));
				button.onClick(() => {
					openConfirmDelete(host.app, {
						subject: t.t("confirmDelete.mcpServerSubject", { name: state.name }),
						consequences: [t.t("deletion.mcpServer")],
						t,
						onConfirm: async () => {
							// No keychain cleanup on purpose: a bound token's entry belongs to
							// the user and may be shared, so the plugin — read-only there —
							// leaves it alone.
							host.settings.mcpServers = host.settings.mcpServers.filter((row) => row.id !== state.id);
							await host.save();
							host.refresh();
						},
					});
				});
			});
		},
	};
}

/**
 * The enable toggle: optimistic, then reconciled against the manager.
 *
 * The toggle writes the enabled flag and saves; whether the server connects or
 * disconnects is decided on the save path, not here. While that save runs the
 * verdict line promises the attempt, then reports the fresh verdict in place — a
 * rebuild here would replace the row out from under the very toggle the user just
 * flipped, which is why this is the one part of the section that stays
 * imperative.
 *
 * Every programmatic move of the switch goes through `show`, and that fence is
 * load-bearing: Obsidian's `ToggleComponent.setValue` calls the change callback
 * whenever the value actually changes, so a `setValue` from inside `onChange`
 * re-enters `onChange`. Without the fence one click on an enabled server ran the
 * *enable* path again — the switch sprang back on while its own disable dialog
 * was still open, and answering that dialog opened another one.
 */
function configureMcpToggle(
	setting: Setting,
	host: SettingsPanelHost,
	state: McpServerState,
	verdictEl: HTMLElement,
): void {
	const { t } = host;
	setting.addToggle((toggle) => {
		toggle.setValue(state.enabled);
		let correcting = false;
		/** Moves the switch without the move being mistaken for a user's flip. */
		const show = (value: boolean): void => {
			correcting = true;
			try {
				toggle.setValue(value);
			} finally {
				correcting = false;
			}
		};
		toggle.onChange(async (enabled) => {
			if (correcting) {
				return;
			}
			const apply = async (): Promise<void> => {
				const server = host.settings.mcpServers.find((row) => row.id === state.id);
				if (server) {
					server.enabled = enabled;
				}
				toggle.setDisabled(true);
				verdictEl.setText(enabled ? t.t("mcp.statusConnecting") : t.t("mcp.statusDisabled"));
				try {
					await host.save();
				} finally {
					toggle.setDisabled(false);
					const fresh = host.mcp.states().find((row) => row.id === state.id);
					if (fresh) {
						setMcpVerdict(verdictEl, fresh, t);
					}
				}
			};
			// Disabling cuts the server's tools out of chat the moment the save lands,
			// while its token stays behind — a one-sided consequence the delete path
			// spells out in a dialog, so the flip gets the same treatment instead of a
			// post-hoc verdict line. Enabling restores rather than destroys, so it
			// goes straight through.
			if (enabled) {
				await apply();
				return;
			}
			// The switch stays off while the question is open — it is the flip the user
			// just made — and the question owns it until answered: a live switch would
			// let a second flip race the dialog's own answer. `apply` re-enables it,
			// and a dismissal restores the configured position instead.
			toggle.setDisabled(true);
			openConfirmDelete(host.app, {
				subject: t.t("confirmDelete.mcpServerSubject", { name: state.name }),
				kind: "disable",
				consequences: [t.t("mcp.disableConsequenceTools"), t.t("mcp.disableConsequenceToken")],
				t,
				onConfirm: apply,
				onDismiss: () => {
					show(true);
					toggle.setDisabled(false);
				},
			});
		});
	});
}

/** The connection verdict, as one sentence. */
function describeMcpRow(state: McpServerState, t: Translator): string {
	return state.enabled
		? state.status === "ok"
			? t.t("mcp.statusOk", { tools: state.toolCount })
			: state.status === "error"
				? t.t("mcp.statusError", { error: state.error ?? "" })
				: t.t("mcp.statusUntested")
		: t.t("mcp.statusDisabled");
}

/**
 * Rewrites a row's verdict line in place — the sentence and the error tint
 * together, so a failed connection reads as one through {@link describeMcpRow}'s
 * words and the same effect-line styling every other failure in this panel uses.
 */
function setMcpVerdict(el: HTMLElement, state: McpServerState, t: Translator): void {
	el.setText(describeMcpRow(state, t));
	el.toggleClass("piem-settings-effect--error", state.enabled && state.status === "error");
}

/**
 * Opens a skill file in a workspace tab.
 *
 * A tab leaf rather than the active one: the settings dialog stays where the
 * user left it, and a skill is reference material to glance at, not work to
 * switch into.
 */
async function openVaultPath(app: App, path: string): Promise<void> {
	const file = app.vault.getAbstractFileByPath(path);
	if (file instanceof TFile) {
		await app.workspace.getLeaf("tab").openFile(file);
	}
}

/**
 * Checks upstream and reports the outcome, applying clean changes.
 *
 * All three verdicts are Notices rather than inline state: the row is
 * re-rendered by `afterMutation` before the message could be shown on it, and
 * a verdict the user has just waited a network round trip for survives a
 * re-render better as a toast than as a line that the next click erases.
 */
async function runSkillUpdate(host: SettingsPanelHost, row: SkillRow, button: ButtonComponent, afterMutation: () => Promise<void>): Promise<void> {
	const { t } = host;
	button.setDisabled(true);
	try {
		const plan = await host.skills.update(row.dirName);
		if (plan.status === "up-to-date") {
			new Notice(t.t("skills.upToDate", { name: row.name }));
		} else if (!plan.hasConflicts) {
			new Notice(
				plan.entries.length === 1
					? t.t("skills.updatedOne", { name: row.name })
					: t.t("skills.updatedMany", { name: row.name, count: plan.entries.length }),
			);
		} else {
			// Naming the files is what makes the refusal actionable: the user can
			// open exactly those, keep or revert their edits, and try again.
			const files = plan.entries.filter((entry) => entry.action === "conflict").map((entry) => entry.path).join(", ");
			new Notice(t.t("skills.conflict", { name: row.name, files }));
		}
		await afterMutation();
	} catch (cause) {
		new Notice(t.t("skills.couldNotUpdate", { name: row.name, message: cause instanceof Error ? cause.message : String(cause) }));
	} finally {
		// Harmless when the row has been re-rendered away; the fresh row's
		// buttons start enabled regardless.
		button.setDisabled(false);
	}
}

async function runSkillRemove(host: SettingsPanelHost, row: SkillRow, afterMutation: () => Promise<void>): Promise<void> {
	const { t } = host;
	try {
		await host.skills.remove(row.dirName);
		await afterMutation();
	} catch (cause) {
		new Notice(t.t("skills.couldNotDelete", { name: row.name, message: cause instanceof Error ? cause.message : String(cause) }));
	}
}
