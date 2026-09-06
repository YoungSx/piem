import { type Setting, type SettingDefinitionItem, type SettingGroupItem } from "obsidian";
import type { PromptQueueStrategy } from "../../agent/queueStrategy";
import { MIN_COMPACTION_TOKENS, readTokenCount, type CompactionConfig } from "../../agent/compactionSettings";
import { DEFAULT_SESSION_DIR, normalizeSessionDir } from "../../session/sessionDir";
import { readRetentionLimit, UNLIMITED_SESSION_RETENTION } from "../../session/retention";
import {
	compactionGroupHint,
	compactionGroupLabel,
	compactionKeepCopy,
	compactionReserveCopy,
	describeTokenFloor,
	type CompactionRowCopy,
} from "./compactionCopy";
import { createEffectLine } from "./effectLine";
import { sectionNote } from "./sectionNote";
import type { SettingsPanelHost } from "./panelHost";
import {
	describeLegacyChats,
	describeRetention,
	describeRetentionFloor,
	describeSessionDirChange,
	describeSessionDirProblem,
	retentionDescription,
	retentionName,
	RETENTION_PLACEHOLDER,
	sessionDirDescription,
	sessionDirName,
	sessionDirRestartHint,
	SESSION_DIR_PLACEHOLDER,
} from "./sessionsCopy";

/**
 * The Chat tab as declarative definitions.
 *
 * The line between a `control` and a `render` here is not whether a row touches
 * the DOM today — it is whether the framework can own the value faithfully.
 * `showAgentDetails` is a boolean written on change, so it becomes a `control`
 * and the panel stops carrying code for it. The three text-bearing rows cannot:
 * they commit on blur rather than per keystroke, coerce what was typed, and
 * write the coerced value back into the field. That is deliberate — a
 * half-typed "1" of "100" committed as a retention cap would trash chats the
 * user was in the middle of asking to keep — and a declarative `text` control
 * has no way to express it. They stay in `render`, where the name and
 * description still put them in the settings search.
 */

/**
 * The Chat tab's rows, in the order they read: behaviour, then storage.
 */
export function chatDefinitions(host: SettingsPanelHost): SettingDefinitionItem[] {
	const { t } = host;
	return [
		/*
		 * No thinking-level row here: the level belongs to the conversation, picked
		 * beside the model switcher in the chat panel itself, so a global dropdown
		 * would only masquerade as a default while every session overrides it.
		 */
		{
			name: t.t("settings.showAgentDetails"),
			desc: t.t("settings.showAgentDetailsDesc"),
			control: { type: "toggle", key: "showAgentDetails" },
		},
		{
			// A dropdown rather than a toggle set: the three modes are degrees of
			// the same dial — how much machine traffic greets the reader open — and
			// a boolean for "high value" against "everything" would need two rows
			// to explain what one word does.
			name: t.t("settings.traceExpand"),
			desc: t.t("settings.traceExpandDesc"),
			control: {
				type: "dropdown",
				key: "traceExpand",
				options: {
					collapsed: t.t("settings.traceExpandCollapsed"),
					highValue: t.t("settings.traceExpandHighValue"),
					expanded: t.t("settings.traceExpandExpanded"),
				},
			},
		},
		compactionPage(host),
		queueingPage(host),
		{
			// A heading rather than a collapsible: storage is not advanced
			// configuration, it is something every long-term user eventually needs
			// and should not have to unfold to find.
			type: "group",
			heading: t.t("settings.chatHistoryHeading"),
			items: [
				sectionNote(t.t("settings.chatHistoryDesc")),
				{
					name: sessionDirName(t),
					desc: `${sessionDirDescription(t)} ${sessionDirRestartHint(t)}`,
					render: (setting) => configureSessionDir(setting, host),
				},
				{
					name: retentionName(t),
					desc: `${retentionDescription(t)} ${describeRetentionFloor(t)}`,
					render: (setting) => configureRetention(setting, host),
				},
				legacyChatsNotice(host),
			],
		},
	];
}

/**
 * When a message typed mid-reply is let through, behind a navigable entry
 * (issue #289).
 *
 * A page rather than a row on the Chat tab for the same reason the compaction
 * fields are one: the choice needs a paragraph before it is safe to make, and a
 * `desc` on a top-level row is a line, not a paragraph. What that paragraph is
 * mostly for is saying what the page is *not* — neither timing interrupts, so a
 * reader who came looking for "send it right now" leaves knowing the steer
 * button on the chip is the thing they want, rather than changing a default and
 * finding it did not help.
 *
 * `displayValue` carries the pick onto the entry, so the common question ("which
 * one am I on?") is answered without opening it.
 */
function queueingPage(host: SettingsPanelHost): SettingDefinitionItem {
	const { t } = host;
	const options: Record<PromptQueueStrategy, string> = {
		afterRun: t.t("settings.queueStrategyAfterRun"),
		afterTurn: t.t("settings.queueStrategyAfterTurn"),
	};
	return {
		type: "page",
		name: t.t("settings.queueStrategy"),
		desc: t.t("settings.queueStrategyDesc"),
		displayValue: () => options[host.settings.promptQueueStrategy],
		items: [
			{
				name: t.t("settings.queueStrategyWhen"),
				desc: t.t("settings.queueStrategyWhenDesc"),
				control: { type: "dropdown", key: "promptQueueStrategy", options },
			},
		],
	};
}

/**
 * The two compaction token fields, behind a navigable entry.
 *
 * A sub-page rather than the `<details>` disclosure this was: a declarative
 * group carries a heading and nothing else, so the hint explaining *why* a
 * reader should think twice would have had nowhere to go. A page has a
 * description slot for it, and `displayValue` does better than the old
 * open-when-configured heuristic — a user who set these once reads the value on
 * the entry instead of having to unfold the section to check.
 *
 * These are the only settings in the panel a reader can make worse by touching:
 * the defaults are pi's own, tuned against real conversations, and the reason to
 * change them is narrow. Automatic compaction itself has no row — it is a hard
 * rule, so there is nothing left to turn off.
 */
function compactionPage(host: SettingsPanelHost): SettingDefinitionItem {
	const { settings, t } = host;

	/** Writes one field, dropping it when cleared so the row falls back to pi's default. */
	const update = async (patch: CompactionConfig): Promise<void> => {
		const next: CompactionConfig = { ...settings.compaction, ...patch };
		for (const [key, value] of Object.entries(next)) {
			if (value === undefined) {
				delete next[key as keyof CompactionConfig];
			}
		}
		settings.compaction = Object.keys(next).length > 0 ? next : undefined;
		await host.save();
	};

	const row = (copy: CompactionRowCopy, read: () => number | undefined, write: (value: number | undefined) => Promise<void>): SettingGroupItem => ({
		name: copy.name,
		// The floor is stated in the description instead of enforced on keystroke —
		// rewriting the field while someone is still typing the second digit of
		// `16384` fights the user.
		desc: `${copy.description} ${describeTokenFloor(t)}`,
		render: (setting) => configureTokenRow(setting, copy, read(), write),
	});

	return {
		type: "page",
		name: compactionGroupLabel(t),
		desc: compactionGroupHint(t),
		// Read through a function, not captured: the entry is re-read on `update()`,
		// and a value edited inside the page has to show on the entry the reader
		// returns to.
		displayValue: () => describeCompactionValue(host),
		items: [
			row(compactionReserveCopy(t), () => settings.compaction?.reserveTokens, (reserveTokens) => update({ reserveTokens })),
			row(compactionKeepCopy(t), () => settings.compaction?.keepRecentTokens, (keepRecentTokens) => update({ keepRecentTokens })),
		],
	};
}

/**
 * What the compaction entry shows without being opened.
 *
 * Empty when nothing is stored, which is the honest answer: both fields then
 * follow pi's own defaults, and naming a number the plugin did not choose would
 * freeze it in the reader's mind as configuration they own.
 */
function describeCompactionValue(host: SettingsPanelHost): string {
	const configured = Object.values(host.settings.compaction ?? {}).filter((value) => value !== undefined);
	return configured.length === 0 ? "" : configured.join(" · ");
}

/**
 * One token field.
 *
 * Empty means "follow pi's default", which is why the placeholder is the default
 * itself rather than a hint: the box shows what will be used when it is blank.
 */
function configureTokenRow(
	setting: Setting,
	copy: CompactionRowCopy,
	value: number | undefined,
	onChange: (value: number | undefined) => Promise<void>,
): void {
	setting.addText((text) => {
		text.inputEl.type = "number";
		text.inputEl.min = String(MIN_COMPACTION_TOKENS);
		text.setPlaceholder(copy.placeholder);
		text.setValue(value === undefined ? "" : String(value));
		// Committed on blur, not per keystroke: every intermediate value of a
		// five-digit number is itself a valid setting, and saving each one would
		// rebuild the agent's configuration four times per edit.
		text.inputEl.addEventListener("blur", () => {
			const parsed = readTokenCount(text.inputEl.value);
			// Reflect the coerced value so a raised or rejected entry is visible
			// rather than leaving the box disagreeing with what was stored.
			text.setValue(parsed === undefined ? "" : String(parsed));
			void onChange(parsed);
		});
	});
}

/**
 * The folder chat logs go to.
 *
 * Validated on blur and reported in place rather than through a `Notice`: the
 * mistake is in the field the user is looking at, and a rejected path has to
 * leave the previous folder in force instead of falling back to the default,
 * which would repoint the plugin on a typo.
 */
function configureSessionDir(setting: Setting, host: SettingsPanelHost): void {
	const { settings, t } = host;
	// Appended after the declaration's `desc`, in its own element, so the line can
	// be rewritten after an edit without re-rendering the row — which would throw
	// focus out of the field.
	const effect = createEffectLine(setting.descEl);

	const currentDir = host.activeSessionDir();
	const describe = (next: string, problem?: string): void => {
		effect.setText(problem ?? describeSessionDirChange(currentDir, next, t));
		// The state is carried in text, not colour alone: this line is the only
		// report a rejected path gets.
		effect.toggleClass("piem-settings-effect--error", problem !== undefined);
	};
	describe(settings.sessionDir);

	setting.addText((text) => {
		text.setPlaceholder(SESSION_DIR_PLACEHOLDER);
		text.setValue(settings.sessionDir);
		text.inputEl.addEventListener("blur", () => {
			const typed = text.inputEl.value.trim();
			// An emptied field means "use the default", the same as a fresh vault.
			if (!typed) {
				text.setValue(DEFAULT_SESSION_DIR);
				settings.sessionDir = DEFAULT_SESSION_DIR;
				describe(DEFAULT_SESSION_DIR);
				void host.save();
				return;
			}
			const problem = describeSessionDirProblem(typed, t);
			if (problem) {
				describe(typed, problem);
				return;
			}
			const normalized = normalizeSessionDir(typed);
			if (!normalized || normalized === settings.sessionDir) {
				describe(typed, problem);
				return;
			}
			text.setValue(normalized);
			settings.sessionDir = normalized;
			describe(normalized);
			void host.save();
		});
	});
}

/** How many chats are kept, and what that means for the ones already stored. */
function configureRetention(setting: Setting, host: SettingsPanelHost): void {
	const { settings, t } = host;
	const effect = createEffectLine(setting.descEl);

	// Undefined until the directory has been read; `describeRetention` is only
	// called once a real count exists, so the line never states a wrong one.
	let storedCount: number | undefined;
	const describe = (limit: number): void => {
		effect.setText(storedCount === undefined ? "" : describeRetention(limit, storedCount, t));
	};
	void host.countStoredSessions().then((count) => {
		storedCount = count;
		describe(settings.sessionRetention);
	});

	setting.addText((text) => {
		text.inputEl.type = "number";
		text.inputEl.min = String(UNLIMITED_SESSION_RETENTION);
		text.setPlaceholder(RETENTION_PLACEHOLDER);
		text.setValue(String(settings.sessionRetention));
		// Committed on blur so a half-typed "1" of "100" never becomes the cap —
		// which, being lower than the real intent, would trash chats the user was
		// still in the middle of asking to keep.
		text.inputEl.addEventListener("blur", () => {
			const limit = readRetentionLimit(text.inputEl.value);
			text.setValue(String(limit));
			describe(limit);
			if (limit === settings.sessionRetention) {
				return;
			}
			settings.sessionRetention = limit;
			void host.save();
		});
	});
}

/**
 * Names the folder earlier releases wrote to, when chats are still in it.
 *
 * The release that moved the default folder makes those chats disappear from the
 * chat list without anything having been deleted, and the folder is inside the
 * config directory, which Obsidian's file explorer does not show. Without this
 * line a user has no way to find them.
 *
 * Unnamed and unsearchable until the count arrives, and hidden until then: the
 * copy needs both the count and the folder, so there is nothing to say before
 * the read finishes, and every vault installed after the move has nothing to say
 * at all. `searchable: false` keeps it out of the index rather than putting an
 * empty entry there — the sentence is a notice about vault state, not a setting
 * anyone would go looking for by name.
 */
function legacyChatsNotice(host: SettingsPanelHost): SettingGroupItem {
	return {
		name: "",
		searchable: false,
		render: (setting) => {
			setting.settingEl.addClass("piem-settings-legacy");
			setting.settingEl.hide();
			void host.countLegacySessions().then(({ count, dir }) => {
				if (count === 0) {
					return;
				}
				setting.setName(describeLegacyChats(count, dir, host.t));
				setting.settingEl.show();
			});
		},
	};
}
