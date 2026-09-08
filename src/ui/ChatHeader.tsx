import React from "react";
import { Menu, type App } from "obsidian";
import type { ChatSnapshot } from "../agent/ObsidianAgentService";
import type { ActiveSessionInfo } from "../session/ObsidianSessionManager";
import type { SessionSearchResult } from "../session/sessionSearch";
import { IconButton } from "./ObsidianIcon";
import { useT } from "./TranslatorContext";
import { suppressOwnTooltip } from "./tooltipSuppression";
import {
	openSessionDeleteConfirm,
	openSessionPicker,
	openSessionRename,
	sessionTitle,
} from "./sessionDialogs";

interface ChatHeaderProps {
	app: App;
	snapshot: ChatSnapshot;
	sessions: ActiveSessionInfo[];
	onOpenSession: (path: string) => void;
	onNewSession: () => void;
	onRenameSession: (name: string) => void;
	onDeleteSession: (path: string) => void;
	/**
	 * Reads the stored logs so the picker can match on what was said, not just on
	 * the title. Absent leaves the picker matching titles alone.
	 */
	onSearchSessions?: (text: string, options: { signal: AbortSignal }) => Promise<SessionSearchResult[]>;
	/**
	 * Writes the transcript into the vault as a Markdown note and opens it.
	 * Offered only while a settled session with at least one message exists —
	 * the same door as rename, since an empty or in-flight chat has nothing to
	 * export yet.
	 */
	onExportSession?: () => void;
	/**
	 * Opens the plugin's settings tab. Absent when the host cannot reach it, in
	 * which case the overflow menu simply does not offer the item — the same
	 * treatment {@link ChatBanner} gives its settings button.
	 */
	onOpenSettings?: () => void;
}

/**
 * Which chat you are in, and the controls that steer it.
 *
 * The chat's name and its session actions — nothing else. Three other things
 * have been evicted from this row, each for the same reason: the header sits
 * between the reader and the first message of their own conversation, so
 * anything parked here is read before the thing they opened the panel for.
 *
 * The context meter, the spend counter and the compaction notice went to
 * `ChatStatusBar` below the transcript, where an ambient readout belongs. The
 * model went to `ModelSwitcher` in the composer's send row, which is a stronger
 * version of the same argument: that line was not merely ambient but inert — it
 * named the model and offered no way to change it, while the control that could
 * was two tabs deep in settings.
 */
export function ChatHeader({
	app,
	snapshot,
	sessions,
	onOpenSession,
	onNewSession,
	onRenameSession,
	onDeleteSession,
	onSearchSessions,
	onExportSession,
	onOpenSettings,
}: ChatHeaderProps): React.JSX.Element {
	const t = useT();
	const activeSession = snapshot.session;
	// The history button's availability, shared with nothing — it is the only
	// door to the picker. Available mid-run too (issue #252): opening the picker
	// never touches the run in flight, and the rows already mark which sessions
	// are mid-run.
	const canPickSession = sessions.length >= 2 || (sessions.length === 1 && onSearchSessions !== undefined);
	const openPicker = (): void => {
		openSessionPicker(
			app,
			sessions,
			{
				onOpen: onOpenSession,
				onDelete: (session) => openSessionDeleteConfirm(app, session, () => onDeleteSession(session.path), t),
				searchSessions: onSearchSessions,
			},
			t,
			snapshot.sessionRunStates,
		);
	};
	/**
	 * The overflow menu.
	 *
	 * Session actions are conditional on a session existing — there is nothing to
	 * rename or delete before the first message — but not on the panel being
	 * idle. Mid-run (issue #252) every one of them is safe: rename and export
	 * write outside the agent's transcript, and delete is the service's own
	 * choreography, which aborts the run and lands the panel on its replacement.
	 * Settings is likewise unconditional, so it keeps the button alive in states
	 * where the session actions alone would have greyed it out — which is
	 * precisely when a user goes looking for settings, since a wrong model or a
	 * missing key is what they are trying to fix.
	 *
	 * Every item in this menu is a single act on this chat or the plugin —
	 * rename, export, settings, delete — and each is conditional on the state
	 * that gives it something to act on.
	 *
	 * A mirror of the slash-command list lived here too, as a second door to
	 * templates and skills, one menu row per invocation. It is gone. Every other
	 * item in this menu is a single act on this chat or the plugin — rename,
	 * export, settings, delete — while that block was a catalogue whose length is
	 * the vault's business, and past a handful of skills it pushed Delete off the
	 * bottom of a phone screen. The composer's `/` menu is the door: it filters as
	 * you type, which is what a list that long needs, and it is where the
	 * invocation is going to be typed anyway.
	 *
	 * Separators are emitted by the block that follows them rather than the one
	 * that precedes them, so no combination of absent blocks can produce a pair
	 * of adjacent rules or a rule against the menu's own edge.
	 */
	const openMenu = (event: React.MouseEvent<HTMLButtonElement>): void => {
		const menu = new Menu();
		if (activeSession) {
			menu.addItem((item) =>
				item
					.setTitle(t.t("chat.renameChat"))
					.setIcon("pencil")
					.onClick(() => openSessionRename(app, activeSession, onRenameSession, t)),
			);
			// An export needs a transcript worth writing; an empty chat's note
			// would be a heading and nothing under it.
			if (onExportSession && snapshot.messages.length > 0) {
				menu.addItem((item) => item.setTitle(t.t("chat.exportNote")).setIcon("file-down").onClick(() => onExportSession()));
			}
		}
		if (onOpenSettings) {
			if (activeSession) {
				menu.addSeparator();
			}
			menu.addItem((item) => item.setTitle(t.t("chat.openSettings")).setIcon("settings").onClick(onOpenSettings));
		}
		if (activeSession) {
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle(t.t("chat.deleteChat"))
					.setIcon("trash-2")
					.setWarning(true)
					.onClick(() => openSessionDeleteConfirm(app, activeSession, () => onDeleteSession(activeSession.path), t)),
			);
		}
		menu.showAtMouseEvent(event.nativeEvent);
	};

	return (
		// The header's name is for the screen reader's landmarks, not the pointer:
		// the title it names is printed right beside it, so Obsidian's native
		// tooltip would restate the visible heading on every stray hover. The
		// toolbar below suppresses for the same reason its buttons do not.
		<header className="piem-chat__header" aria-label={t.t("chat.headerAria")} onMouseOver={suppressOwnTooltip}>
			{/* No wrapper: the title is the whole of the header's identity now that the
			    model line has moved, and an element holding one child is one more left
			    edge for a reader's eye to resolve. No `title` either — the details it
			    carried are one menu item away, and a tooltip restating chrome is not
			    worth a second hover channel. */}
			<h2 className="piem-chat__title">{sessionTitle(activeSession, t)}</h2>
			<div
				className="piem-chat__header-actions"
				role="toolbar"
				aria-label={t.t("chat.actionsAria")}
				onMouseOver={suppressOwnTooltip}
			>
				{/*
				 * Always mounted, on every platform, so the button positions never
				 * shift as the vault accumulates chats; disabled until there is a
				 * second one to pick. It once left the row on a phone — one line of
				 * chrome for a squeezed transcript — but the menu detour buried the
				 * picker behind a second tap, so it is back where the desktop has it.
				 */}
				<IconButton
					icon="history"
					label={t.t("chat.openChatHistory")}
					onClick={openPicker}
					disabled={!canPickSession}
				/>
				<IconButton icon="square-plus" label={t.t("chat.newChat")} onClick={onNewSession} />
				{/* Disabled only when the menu would open empty — see `openMenu`. Three
				    doors keep it alive; the slash-command list used to be a fourth, and
				    its removal is why a vault with skills but no session and no settings
				    door now greys this out, correctly: there is nothing behind it. */}
				<IconButton
					icon="ellipsis"
					label={t.t("chat.moreActions")}
					onClick={openMenu}
					hasPopup="menu"
					disabled={!activeSession && !onOpenSettings}
				/>
			</div>
		</header>
	);
}
