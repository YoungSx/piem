import type { SessionRunState } from "../agent/SessionRuntime";
import type { AskUserRequest } from "../tools/askUserBroker";

/**
 * Cross-session attention, derived: which background chats want the reader's eye.
 *
 * The gap this fills is narrow and specific. A collapsed panel or a background
 * tab already escalates an `ask_user` to a modal (issue #237); a panel that is
 * on screen but showing a *different* conversation does not — the question waits
 * in its own transcript, and a background chat that simply finishes its turn
 * surfaces nowhere at all. So when the reader is present but looking elsewhere,
 * a finished or waiting background session is invisible. This module decides,
 * from the two channels that already report background state, which sessions
 * earn a floating notice.
 *
 * It owns the *decision*, not the DOM and not the copy: given the last phase it
 * saw per session and the current run-states plus live `ask_user` heads, it
 * returns the standing notices. Keeping it a pure fold over carried state is
 * what makes "a completion is an edge, not a level" testable — `idle` does not
 * persist in the run-states, so the notice for a turn that ended has to be
 * remembered between ticks or it would blink out on the next snapshot.
 */

export type BackgroundNoticeKind = "completed" | "error" | "ask";

/** A background session asking to be looked at, keyed by its file path. */
export interface BackgroundNotice {
	/** Session file path: both the dedupe key and the jump target for a click. */
	path: string;
	kind: BackgroundNoticeKind;
	/** The live question, present only for `kind === "ask"`. */
	request?: AskUserRequest;
}

/** What the fold reads each tick. */
export interface NoticeInput {
	/** Every known session's derived phase (issue #235), background ones included. */
	runStates: ReadonlyArray<{ path: string; state: SessionRunState }>;
	/**
	 * The session on screen. It never earns a notice: the reader is already
	 * there, its `ask_user` renders in the transcript, and its completion is
	 * visible.
	 */
	focusedPath: string | undefined;
	/**
	 * Live `ask_user` heads by owner. A background owner's question reads as
	 * `running` in the run-states — {@link SessionRunState} has no branch for a
	 * pending broker question — so this is the only channel that distinguishes
	 * "needs an answer" from "still working".
	 */
	pending: ReadonlyArray<AskUserRequest>;
}

/** Carried between ticks: the last phase seen per path, and the standing notices. */
export interface NoticeState {
	readonly notices: ReadonlyMap<string, BackgroundNotice>;
	readonly prevStates: ReadonlyMap<string, SessionRunState>;
}

export const EMPTY_NOTICE_STATE: NoticeState = {
	notices: new Map(),
	prevStates: new Map(),
};

/**
 * Folds one tick of run-states and pending questions into the next notice set.
 *
 * The rules, in the order a single session is examined:
 * - A fresh turn (`→ running`) clears any standing done/error notice for it: the
 *   reader's last acknowledgement is stale the moment new work starts.
 * - The focused session is dropped outright.
 * - A live `ask_user` for it wins — it supersedes a completion, since a question
 *   is the more urgent state and the two cannot both be true of the same tick.
 * - Otherwise a settled turn earns one: `running → idle` is a completion, and
 *   entering `error` from anything else is a failure.
 *
 * A trailing sweep drops notices whose session vanished or whose `ask_user` was
 * answered elsewhere, so a resolved or deleted chat cannot leave a ghost.
 */
export function advanceNotices(prev: NoticeState, input: NoticeInput): NoticeState {
	const notices = new Map(prev.notices);
	const nextStates = new Map<string, SessionRunState>();
	const pendingByPath = new Map(input.pending.map((request) => [request.ownerId, request] as const));
	const live = new Set<string>();

	for (const { path, state } of input.runStates) {
		live.add(path);
		nextStates.set(path, state);
		const before = prev.prevStates.get(path);

		if (state === "running" && before !== "running") {
			notices.delete(path);
		}

		if (path === input.focusedPath) {
			notices.delete(path);
			continue;
		}

		const question = pendingByPath.get(path);
		if (question) {
			notices.set(path, { path, kind: "ask", request: question });
			continue;
		}

		if (before === "running" && state === "idle") {
			notices.set(path, { path, kind: "completed" });
		} else if (state === "error" && before !== "error") {
			notices.set(path, { path, kind: "error" });
		}
	}

	for (const [path, notice] of [...notices]) {
		if (!live.has(path)) {
			notices.delete(path);
			continue;
		}
		if (notice.kind === "ask" && !pendingByPath.has(path)) {
			notices.delete(path);
		}
	}

	return { notices, prevStates: nextStates };
}

/** The notices as a list, newest first, for rendering. */
export function noticeList(state: NoticeState): BackgroundNotice[] {
	// Map preserves insertion order and `set` on an existing key keeps its slot,
	// so reversing puts the most recently *first-seen* notices on top — good
	// enough ordering for a stack the reader clears by hand; no timestamps needed.
	return [...state.notices.values()].reverse();
}
