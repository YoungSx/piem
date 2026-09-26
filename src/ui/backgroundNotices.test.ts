import { describe, expect, it } from "bun:test";
import { advanceNotices, noticeList, EMPTY_NOTICE_STATE, type NoticeInput, type NoticeState } from "./backgroundNotices";
import type { SessionRunState } from "../agent/SessionRuntime";
import type { AskUserRequest } from "../tools/askUserBroker";

function states(entries: Record<string, SessionRunState>): NoticeInput["runStates"] {
	return Object.entries(entries).map(([path, state]) => ({ path, state }));
}

function ask(ownerId: string): AskUserRequest {
	return { id: `ask-${ownerId}`, ownerId, questions: [{ question: "q", header: "h", options: [{ label: "a" }] }], shell: "panel" };
}

function tick(prev: NoticeState, input: Partial<NoticeInput> & { runStates: NoticeInput["runStates"] }): NoticeState {
	return advanceNotices(prev, { focusedPath: undefined, pending: [], ...input });
}

describe("advanceNotices", () => {
	it("raises a completion when a background session leaves running for idle", () => {
		const first = tick(EMPTY_NOTICE_STATE, { runStates: states({ a: "running" }) });
		expect(first.notices.size).toBe(0); // no prior phase: the first sight of running is not a completion

		const next = tick(first, { runStates: states({ a: "idle" }) });
		expect([...next.notices.values()]).toEqual([{ path: "a", kind: "completed" }]);
	});

	it("never notices the focused session", () => {
		const first = tick(EMPTY_NOTICE_STATE, { runStates: states({ a: "running" }) });
		const next = advanceNotices(first, { runStates: states({ a: "idle" }), focusedPath: "a", pending: [] });
		expect(next.notices.size).toBe(0);
	});

	it("clears a session's notice once it becomes focused", () => {
		let s = tick(EMPTY_NOTICE_STATE, { runStates: states({ a: "running" }) });
		s = tick(s, { runStates: states({ a: "idle" }) });
		expect(s.notices.has("a")).toBe(true);
		s = advanceNotices(s, { runStates: states({ a: "idle" }), focusedPath: "a", pending: [] });
		expect(s.notices.has("a")).toBe(false);
	});

	it("prefers an ask over a completion and drops it once answered", () => {
		const request = ask("a");
		let s = tick(EMPTY_NOTICE_STATE, { runStates: states({ a: "running" }), pending: [request] });
		expect([...s.notices.values()]).toEqual([{ path: "a", kind: "ask", request }]);

		// Answered elsewhere: the head is gone even though the session runs on.
		s = tick(s, { runStates: states({ a: "running" }), pending: [] });
		expect(s.notices.has("a")).toBe(false);

		// It then finishes, which is a completion.
		s = tick(s, { runStates: states({ a: "idle" }) });
		expect([...s.notices.values()]).toEqual([{ path: "a", kind: "completed" }]);
	});

	it("supersedes a stale completion when a fresh turn starts", () => {
		let s = tick(EMPTY_NOTICE_STATE, { runStates: states({ a: "running" }) });
		s = tick(s, { runStates: states({ a: "idle" }) });
		expect(s.notices.has("a")).toBe(true);
		s = tick(s, { runStates: states({ a: "running" }) });
		expect(s.notices.has("a")).toBe(false);
	});

	it("raises an error notice on entering error, once", () => {
		let s = tick(EMPTY_NOTICE_STATE, { runStates: states({ a: "running" }) });
		s = tick(s, { runStates: states({ a: "error" }) });
		expect([...s.notices.values()]).toEqual([{ path: "a", kind: "error" }]);
		// Staying in error does not re-raise, and the standing notice persists.
		s = tick(s, { runStates: states({ a: "error" }) });
		expect([...s.notices.values()]).toEqual([{ path: "a", kind: "error" }]);
	});

	it("drops a notice when its session disappears", () => {
		let s = tick(EMPTY_NOTICE_STATE, { runStates: states({ a: "running", b: "running" }) });
		s = tick(s, { runStates: states({ a: "idle", b: "running" }) });
		expect(s.notices.has("a")).toBe(true);
		s = tick(s, { runStates: states({ b: "running" }) });
		expect(s.notices.has("a")).toBe(false);
	});

	it("keeps one notice per session and renders newest first", () => {
		let s = tick(EMPTY_NOTICE_STATE, { runStates: states({ a: "running", b: "running" }) });
		s = tick(s, { runStates: states({ a: "idle", b: "running" }) });
		s = tick(s, { runStates: states({ a: "idle", b: "idle" }) });
		expect(noticeList(s).map((n) => n.path)).toEqual(["b", "a"]);
	});
});
