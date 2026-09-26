import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ObsidianAgentService } from "../agent/ObsidianAgentService";
import type { ActiveSessionInfo } from "../session/ObsidianSessionManager";
import type { SessionRunState } from "../agent/SessionRuntime";
import type { AskUserBroker } from "../tools/askUserBroker";
import { commitsOnClick, type AskUserAnswer } from "../tools/askUserQuestion";
import { IconButton, ObsidianIcon } from "./ObsidianIcon";
import { useT } from "./TranslatorContext";
import { sessionTitle } from "./sessionDialogs";
import {
	advanceNotices,
	noticeList,
	EMPTY_NOTICE_STATE,
	type BackgroundNotice,
	type NoticeState,
} from "./backgroundNotices";

/** How many notices show before the rest collapse into a counter. */
const VISIBLE_LIMIT = 3;

interface BackgroundNotificationsProps {
	service: ObsidianAgentService;
	/** The park for `ask_user` heads; absent in a test with no plugin, so no ask notice appears. */
	askUserBroker?: AskUserBroker;
	/** Every known session's phase, straight from the chat snapshot (issue #235). */
	runStates: ReadonlyArray<{ path: string; state: SessionRunState }>;
	/** The session on screen; it is never noticed. */
	focusedPath: string | undefined;
	/** For titling a notice; the snapshot does not carry a background chat's name. */
	sessions: ActiveSessionInfo[];
	/** Jumps to a session — reveals the panel and re-points the focus. */
	onOpenSession: (path: string) => void;
	/** Opens the full session list, where every chat's run-state dot is shown. */
	onShowAll?: () => void;
}

/**
 * A floating stack at the top of the transcript for background chats that want
 * the reader's eye: one that finished its turn, hit an error, or is waiting on
 * an `ask_user` the reader is not positioned to see.
 *
 * The decision of *which* sessions qualify is a pure fold in
 * {@link advanceNotices}; this component is the two subscriptions that feed it
 * and the markup that renders the result. Two channels, because a completion
 * rides the chat snapshot (the run-states flip) while a pushed `ask_user` moves
 * nothing the snapshot reports and needs the broker's own subscription — the
 * same split the transcript's own pending-question wiring makes.
 *
 * The whole card is the jump: a stretched button behind the content, so a click
 * anywhere but the accessories opens the chat. A lone single-select question
 * under a fine pointer — exactly {@link commitsOnClick} — offers its options
 * inline so a one-tap answer needs no trip; everything else (multi-select, a
 * typed "Other", several questions) is left to the full form the chat renders,
 * reached by the same jump.
 */
export function BackgroundNotifications({
	service,
	askUserBroker,
	runStates,
	focusedPath,
	sessions,
	onOpenSession,
	onShowAll,
}: BackgroundNotificationsProps): React.JSX.Element | null {
	const t = useT();
	const stateRef = useRef<NoticeState>(EMPTY_NOTICE_STATE);
	const [notices, setNotices] = useState<BackgroundNotice[]>([]);
	// Read inside subscription callbacks that outlive the render they were set in.
	const inputRef = useRef({ runStates, focusedPath });
	inputRef.current = { runStates, focusedPath };

	const recompute = useCallback(() => {
		const { runStates: rs, focusedPath: focus } = inputRef.current;
		const pending = askUserBroker
			? rs.map((entry) => askUserBroker.getPending(entry.path)).filter((request) => request !== null)
			: [];
		const next = advanceNotices(stateRef.current, { runStates: rs, focusedPath: focus, pending });
		stateRef.current = next;
		setNotices(noticeList(next));
	}, [askUserBroker]);

	// Snapshot channel: a new run-state array arrives on every notify.
	useEffect(recompute, [recompute, runStates, focusedPath]);

	// Broker channel: a question is pushed from inside a tool call, which moves
	// nothing the snapshot reports.
	useEffect(() => {
		if (!askUserBroker) {
			return;
		}
		return askUserBroker.subscribe(recompute);
	}, [askUserBroker, recompute]);

	/** Drops a notice by hand, without waiting for its state to change. */
	const drop = useCallback((path: string) => {
		const notices = new Map(stateRef.current.notices);
		if (!notices.delete(path)) {
			return;
		}
		stateRef.current = { ...stateRef.current, notices };
		setNotices(noticeList(stateRef.current));
	}, []);

	const open = useCallback(
		(path: string) => {
			drop(path);
			onOpenSession(path);
		},
		[drop, onOpenSession],
	);

	const answer = useCallback(
		(notice: BackgroundNotice, selected: string): void => {
			const request = notice.request;
			const question = request?.questions[0];
			if (!askUserBroker || !request || !question) {
				return;
			}
			const reply: AskUserAnswer = { question: question.question, header: question.header, selected: [selected] };
			askUserBroker.answer(request.id, [reply]);
			drop(notice.path);
		},
		[askUserBroker, drop],
	);

	if (notices.length === 0) {
		return null;
	}

	const shown = notices.slice(0, VISIBLE_LIMIT);
	const overflow = notices.length - shown.length;

	return (
		// Zero-height flow anchor: it pins the floating stack to the top of the
		// transcript (below header and banner) without pushing any content down.
		<div className="piem-chat__toasts-anchor">
			<div className="piem-chat__toasts" role="status" aria-live="polite">
				{shown.map((notice) => (
					<Toast key={notice.path} notice={notice} title={sessionTitle(sessions.find((s) => s.path === notice.path), t)} preview={notice.kind === "completed" ? service.peekLastReply(notice.path) : undefined} onOpen={() => open(notice.path)} onDismiss={() => drop(notice.path)} onAnswer={(label) => answer(notice, label)} />
				))}
				{overflow > 0 && onShowAll ? (
					<button type="button" className="piem-chat__toasts-more" onClick={onShowAll}>
						{t.t("notifications.more", { count: overflow })}
					</button>
				) : null}
			</div>
		</div>
	);
}

const ICON: Record<BackgroundNotice["kind"], "check" | "alert-triangle" | "message-circle"> = {
	completed: "check",
	error: "alert-triangle",
	ask: "message-circle",
};

function Toast({
	notice,
	title,
	preview,
	onOpen,
	onDismiss,
	onAnswer,
}: {
	notice: BackgroundNotice;
	title: string;
	preview?: string;
	onOpen: () => void;
	onDismiss: () => void;
	onAnswer: (label: string) => void;
}): React.JSX.Element {
	const t = useT();
	const question = notice.kind === "ask" ? notice.request?.questions[0] : undefined;
	// The same predicate the transcript uses: a lone single-select under a fine
	// pointer commits on the first click, which is exactly what a chip on a toast
	// can honour. Touch, multi-select and typed answers stay behind the jump.
	const inlineOptions =
		question && notice.request && commitsOnClick(typeof window === "undefined" ? null : window, notice.request.questions)
			? question.options
			: null;
	const body = notice.kind === "ask" ? question?.question : notice.kind === "error" ? t.t("notifications.error") : preview?.split("\n")[0] || t.t("notifications.completed");

	return (
		<div className={`piem-chat__toast piem-chat__toast--${notice.kind}`}>
			<button type="button" className="piem-chat__toast-open" onClick={onOpen} aria-label={t.t("notifications.jump", { title })}>
				<ObsidianIcon name={ICON[notice.kind]} className="piem-chat__toast-icon" />
				<span className="piem-chat__toast-lines">
					<span className="piem-chat__toast-title">{title}</span>
					{body ? <span className="piem-chat__toast-text">{body}</span> : null}
				</span>
			</button>
			{inlineOptions ? (
				<div className="piem-chat__toast-options">
					{inlineOptions.map((option) => (
						<button key={option.label} type="button" className="piem-chat__toast-option" onClick={() => onAnswer(option.label)}>
							{option.label}
						</button>
					))}
				</div>
			) : null}
			<IconButton icon="x" label={t.t("notifications.dismiss")} onClick={onDismiss} className="piem-chat__toast-dismiss" />
		</div>
	);
}
