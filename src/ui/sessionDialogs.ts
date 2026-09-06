import { Modal, Setting, SuggestModal, type App } from "obsidian";
import type { ActiveSessionInfo } from "../session/ObsidianSessionManager";
import type { SessionRunState } from "../agent/SessionRuntime";
import type { SessionSearchResult } from "../session/sessionSearch";
import type { Translator } from "../i18n";
import { mergeSearchRows, titleMatches, type SessionRow } from "./sessionSearchRows";

export interface SessionPickerActions {
	onOpen: (path: string) => void;
	onDelete: (session: ActiveSessionInfo) => void;
	/**
	 * Scans the stored logs for `text`. Omitted leaves the picker matching on
	 * titles alone, which is what a caller without a live service can offer.
	 */
	searchSessions?: (text: string, options: { signal: AbortSignal }) => Promise<SessionSearchResult[]>;
}

export function sessionTitle(session: ActiveSessionInfo | undefined, t: Translator): string {
	if (!session) {
		return t.t("session.newChat");
	}
	return session.name?.trim() || session.firstMessage.trim().split("\n")[0] || t.t("session.untitled");
}

/**
 * Prefers an explicit name, then the opening question, then the timestamp. Lives
 * beside the dialogs because the header, the picker rows and the delete
 * confirmation all have to name a session the same way.
 */
export function describeSession(session: ActiveSessionInfo, t: Translator): string {
	const label = sessionTitle(session, t);
	const summary = label.length > 60 ? `${label.slice(0, 60)}…` : label;
	return `${summary} · ${new Date(session.updatedAt).toLocaleString()}`;
}

export function openSessionPicker(
	app: App,
	sessions: ActiveSessionInfo[],
	actions: SessionPickerActions,
	t: Translator,
	runStates?: ReadonlyArray<{ path: string; state: SessionRunState }>,
): void {
	new SessionPickerModal(app, sessions, actions, t, runStates).open();
}

/**
 * Copy key for a session's run state, absent for `idle`: a quiet session is the
 * norm, so its row stays clean rather than wearing a badge that says so.
 */
function runStateKey(state: SessionRunState): "session.runStateRunning" | "session.runStateWaitingInput" | "session.runStateError" | undefined {
	switch (state) {
		case "running":
			return "session.runStateRunning";
		case "waiting-input":
			return "session.runStateWaitingInput";
		case "error":
			return "session.runStateError";
		default:
			return undefined;
	}
}

export function openSessionRename(app: App, session: ActiveSessionInfo, onSubmit: (name: string) => void, t: Translator): void {
	new SessionNameModal(app, session, onSubmit, t).open();
}

export function openSessionDeleteConfirm(app: App, session: ActiveSessionInfo, onConfirm: () => void, t: Translator): void {
	new SessionDeleteModal(app, session, onConfirm, t).open();
}

/**
 * Keyboard navigation comes from Obsidian rather than a hand-rolled dropdown,
 * which also makes deleting a chat other than the active one reachable — the
 * header only ever knows about the active session.
 *
 * A `SuggestModal` rather than a `FuzzySuggestModal`: finding a chat by what was
 * *said* in it means reading logs off disk, and `getItems()` is synchronous. So
 * each keystroke paints the title matches at once and starts a scan; when the
 * scan lands, the rows are re-requested by replaying an `input` event, with the
 * hits cached per query so the replay cannot loop. A superseded query is aborted
 * at the next session boundary — pi checks the signal there, and `repo.open`
 * cannot be interrupted mid-read.
 */
class SessionPickerModal extends SuggestModal<SessionRow> {
	private readonly sessions: ActiveSessionInfo[];
	private readonly actions: SessionPickerActions;
	private readonly t: Translator;
	/** Run state per session path (issue #235); rows without one render clean. */
	private readonly runStates: ReadonlyMap<string, SessionRunState>;
	/** Content hits per query, so a settled query never rescans the vault. */
	private readonly cache = new Map<string, SessionSearchResult[]>();
	private pending: AbortController | undefined;
	/** The query the open scan belongs to; a later keystroke discards its result. */
	private scanning: string | undefined;

	constructor(
		app: App,
		sessions: ActiveSessionInfo[],
		actions: SessionPickerActions,
		t: Translator,
		runStates?: ReadonlyArray<{ path: string; state: SessionRunState }>,
	) {
		super(app);
		this.sessions = sessions;
		this.actions = actions;
		this.t = t;
		this.runStates = new Map((runStates ?? []).map((entry) => [entry.path, entry.state]));
		this.setPlaceholder(t.t(actions.searchSessions ? "session.searchContentPlaceholder" : "session.searchPlaceholder"));
		this.emptyStateText = t.t("session.searchNoResults");
		this.setInstructions([
			{ command: "\u21b5", purpose: t.t("session.pickerOpenHint") },
			{ command: "shift \u21b5", purpose: t.t("session.pickerDeleteHint") },
		]);
	}

	getSuggestions(query: string): SessionRow[] {
		const trimmed = query.trim();
		const rows = titleMatches(this.sessions, query, (session) => describeSession(session, this.t));
		if (!trimmed || !this.actions.searchSessions) {
			return rows;
		}
		const cached = this.cache.get(trimmed);
		if (cached) {
			return mergeSearchRows(rows, cached, this.sessions);
		}
		this.startScan(trimmed);
		return rows;
	}

	renderSuggestion(row: SessionRow, el: HTMLElement): void {
		const state = this.runStates.get(row.session.path);
		const key = state ? runStateKey(state) : undefined;
		const label = key ? this.t.t(key) : undefined;
		// The dot is a child of the value line so the shared `.piem-suggestion-value`
		// layout stays untouched — other pickers render through the same class.
		const value = el.createDiv({ cls: "piem-suggestion-value" });
		if (state && label) {
			value.createSpan({
				cls: `piem-session-run-dot piem-session-run-dot--${state}`,
				attr: { role: "img", "aria-label": label, title: label },
			});
		}
		value.createSpan({ text: sessionTitle(row.session, this.t) });
		let meta = new Date(row.session.updatedAt).toLocaleString();
		// Lineage shows only when the parent is in the loaded list: a deleted or
		// evicted parent has nothing to name, and a bare "forked" tag would just
		// be noise. The parent is matched by id — forks copy it into the header.
		const parent = row.session.parentSessionId
			? this.sessions.find((session) => session.id === row.session.parentSessionId)
			: undefined;
		if (parent) {
			meta += ` · ${this.t.t("session.forkedFrom", { title: sessionTitle(parent, this.t) })}`;
		}
		el.createDiv({
			cls: "piem-suggestion-description",
			text: row.matchCount === undefined ? meta : `${meta} · ${this.t.t("session.searchMatchCount", { count: row.matchCount })}`,
		});
		if (row.snippet) {
			el.createDiv({ cls: "piem-session-search__snippet", text: row.snippet });
		}
	}

	onChooseSuggestion(row: SessionRow, evt: MouseEvent | KeyboardEvent): void {
		if (evt.shiftKey) {
			this.actions.onDelete(row.session);
			return;
		}
		this.actions.onOpen(row.session.path);
	}

	onClose(): void {
		this.pending?.abort();
		this.pending = undefined;
	}

	/** Scans in the background, then replays the input so the rows refresh. */
	private startScan(query: string): void {
		if (this.scanning === query) {
			return;
		}
		this.pending?.abort();
		const controller = new AbortController();
		this.pending = controller;
		this.scanning = query;
		void this.actions
			.searchSessions?.(query, { signal: controller.signal })
			.then((hits) => {
				if (controller.signal.aborted) {
					return;
				}
				this.cache.set(query, hits);
				// Only the query still in the box may repaint; an earlier one landing
				// late would otherwise overwrite what the user is now reading.
				if (this.inputEl.value.trim() === query) {
					this.inputEl.dispatchEvent(new Event("input"));
				}
			})
			.catch(() => {
				// A cancelled or failed scan leaves the title matches on screen.
			})
			.finally(() => {
				if (this.scanning === query) {
					this.scanning = undefined;
				}
			});
	}
}

class SessionNameModal extends Modal {
	private readonly session: ActiveSessionInfo;
	private readonly onSubmit: (name: string) => void;
	private readonly t: Translator;
	private name: string;

	constructor(app: App, session: ActiveSessionInfo, onSubmit: (name: string) => void, t: Translator) {
		super(app);
		this.session = session;
		this.onSubmit = onSubmit;
		this.t = t;
		this.name = session.name ?? "";
	}

	onOpen(): void {
		this.setTitle(this.t.t("session.renameChat"));
		new Setting(this.contentEl)
			.setName(this.t.t("session.nameLabel"))
			.setDesc(this.t.t("session.nameDesc"))
			.addText((text) => {
				text
					.setPlaceholder(sessionTitle(this.session, this.t) || this.t.t("session.untitled"))
					.setValue(this.name)
					.onChange((value) => {
						this.name = value;
					});
				text.inputEl.addEventListener("keydown", (event) => {
					if (event.key !== "Enter" || event.isComposing) {
						return;
					}
					event.preventDefault();
					this.submit();
				});
				text.inputEl.focus();
				text.inputEl.select();
			});

		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText(this.t.t("session.cancel")).onClick(() => this.close()))
			.addButton((button) => button.setButtonText(this.t.t("session.save")).setCta().onClick(() => this.submit()));
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private submit(): void {
		this.close();
		this.onSubmit(this.name);
	}
}

class SessionDeleteModal extends Modal {
	private readonly session: ActiveSessionInfo;
	private readonly onConfirm: () => void;
	private readonly t: Translator;

	constructor(app: App, session: ActiveSessionInfo, onConfirm: () => void, t: Translator) {
		super(app);
		this.session = session;
		this.onConfirm = onConfirm;
		this.t = t;
	}

	onOpen(): void {
		this.setTitle(this.t.t("session.deleteChat"));
		this.contentEl.createEl("p", { text: describeSession(this.session, this.t) });
		this.contentEl.createEl("p", { text: this.t.t("session.deleteRestorable") });

		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText(this.t.t("session.cancel")).onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(this.t.t("session.delete"))
					.setDestructive()
					.onClick(() => {
						this.close();
						this.onConfirm();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
