import { describe, expect, it } from "bun:test";
import { AskUserBroker, type AskUserRequest } from "./askUserBroker";
import type { AskUserQuestion } from "./askUserQuestion";

/**
 * The broker is where two properties the old modal could not have now live: one
 * question per conversation at a time, and a choice of surface per question.
 * Both are invisible in the UI when they work, so they are asserted here.
 */
describe("AskUserBroker", () => {
	it("routes to the panel when the panel is on screen", () => {
		const escalated: string[] = [];
		const broker = new AskUserBroker({ isPanelVisible: () => true, escalate: () => escalated.push("x") });

		void broker.ask([question()]);

		expect(broker.getPending()?.shell).toBe("panel");
		expect(escalated).toEqual([]);
	});

	it("escalates to the dialog when the panel is not on screen", () => {
		const escalated: AskUserRequest[] = [];
		const broker = new AskUserBroker({ isPanelVisible: () => false, escalate: (request) => escalated.push(request) });

		void broker.ask([question()]);

		// The panel renders nothing in this case: a card in a transcript nobody is
		// looking at is a question dropped on the floor.
		expect(broker.getPending()).toBeNull();
		expect(escalated).toHaveLength(1);
		expect(escalated[0]?.shell).toBe("modal");
	});

	it("keeps the question in the panel when no dialog shell is wired", () => {
		const broker = new AskUserBroker({ isPanelVisible: () => false });

		void broker.ask([question()]);

		// A question the user can reach by opening the panel beats one routed to a
		// surface that does not exist.
		expect(broker.getPending()?.shell).toBe("panel");
	});

	it("shows one question at a time and promotes the next when the first settles", async () => {
		const broker = new AskUserBroker({ isPanelVisible: () => true });
		const first = broker.ask([question("First?")]);
		const second = broker.ask([question("Second?")]);

		// Two agents can ask at once — a subagent and its parent — and the modal this
		// replaces stacked two dialogs nobody could read.
		expect(broker.getPending()?.questions[0]?.question).toBe("First?");
		expect(broker.getQueuedCount()).toBe(1);

		broker.dismiss(broker.getPending()?.id ?? "");
		await first;

		expect(broker.getPending()?.questions[0]?.question).toBe("Second?");
		expect(broker.getQueuedCount()).toBe(0);
		broker.dismiss(broker.getPending()?.id ?? "");
		await second;
		expect(broker.getPending()).toBeNull();
	});

	it("decides the surface when a question reaches the head, not when it is asked", async () => {
		let visible = false;
		const escalated: AskUserRequest[] = [];
		const broker = new AskUserBroker({ isPanelVisible: () => visible, escalate: (request) => escalated.push(request) });

		const first = broker.ask([question("First?")]);
		const second = broker.ask([question("Second?")]);
		expect(escalated).toHaveLength(1);

		// The user opened the panel while the first dialog was up. The queued
		// question must not inherit a routing decision made minutes earlier.
		visible = true;
		broker.dismiss(escalated[0]?.id ?? "");
		await first;

		expect(escalated).toHaveLength(1);
		expect(broker.getPending()?.questions[0]?.question).toBe("Second?");
		broker.dismiss(broker.getPending()?.id ?? "");
		await second;
	});

	it("keeps each conversation's head and queue independent", async () => {
		const escalated: AskUserRequest[] = [];
		const broker = new AskUserBroker({ isPanelVisible: () => true, escalate: (request) => escalated.push(request) });
		const firstA = broker.ask([question("A first?")], undefined, "chat-a");
		const secondA = broker.ask([question("A second?")], undefined, "chat-a");
		const firstB = broker.ask([question("B first?")], undefined, "chat-b");
		try {
			expect(broker.getPending("chat-a")?.questions[0]?.question).toBe("A first?");
			expect(broker.getPending("chat-b")?.questions[0]?.question).toBe("B first?");
			expect(broker.getPending()).toBeNull();
			expect(broker.getQueuedCount("chat-a")).toBe(1);
			expect(broker.getQueuedCount("chat-b")).toBe(0);
			expect(escalated).toEqual([]);

			const answers = [{ question: "B first?", header: "Where to file", selected: ["Inbox"] }];
			broker.answer(broker.getPending("chat-b")?.id ?? "", answers);
			expect(await firstB).toEqual(answers);
			expect(broker.getPending("chat-b")).toBeNull();
			expect(broker.getPending("chat-a")?.questions[0]?.question).toBe("A first?");

			broker.dismiss(broker.getPending("chat-a")?.id ?? "");
			expect(await firstA).toBeNull();
			expect(broker.getPending("chat-a")?.questions[0]?.question).toBe("A second?");
			expect(broker.getQueuedCount("chat-a")).toBe(0);
		} finally {
			broker.clear();
			await Promise.all([firstA, secondA, firstB]);
		}
	});

	it("serializes dialogs globally across conversation heads", async () => {
		const escalated: AskUserRequest[] = [];
		const retracted: string[] = [];
		const broker = new AskUserBroker({
			isPanelVisible: () => false,
			escalate: (request) => escalated.push(request),
			retract: (request) => { retracted.push(request.id); broker.dismiss(request.id); },
		});
		const firstA = broker.ask([question("A first?")], undefined, "chat-a");
		const firstB = broker.ask([question("B first?")], undefined, "chat-b");
		const secondA = broker.ask([question("A second?")], undefined, "chat-a");
		try {
			expect(escalated.map((request) => request.ownerId)).toEqual(["chat-a"]);
			expect(broker.getPending("chat-a")).toBeNull();
			expect(broker.getPending("chat-b")).toBeNull();
			broker.dismiss(escalated[0]?.id ?? "");
			expect(await firstA).toBeNull();
			expect(escalated.map((request) => request.ownerId)).toEqual(["chat-a", "chat-b"]);
			expect(retracted).toEqual([escalated[0]?.id ?? ""]);

			broker.dismiss(escalated[1]?.id ?? "");
			expect(await firstB).toBeNull();
			expect(escalated.map((request) => request.questions[0]?.question)).toEqual(["A first?", "B first?", "A second?"]);
		} finally {
			broker.clear();
			await Promise.all([firstA, firstB, secondA]);
		}
		expect(retracted).toEqual(escalated.map((request) => request.id));
	});

	it("leaves another conversation's dialog alone when a queued owner aborts", async () => {
		const escalated: AskUserRequest[] = [];
		const retracted: string[] = [];
		const broker = new AskUserBroker({
			isPanelVisible: () => false,
			escalate: (request) => escalated.push(request),
			retract: (request) => retracted.push(request.id),
		});
		const controller = new AbortController();
		const first = broker.ask([question("A?")], undefined, "chat-a");
		const aborted = broker.ask([question("B?")], controller.signal, "chat-b").catch((reason: unknown) => reason);
		const next = broker.ask([question("B next?")], undefined, "chat-b");
		try {
			controller.abort();
			expect(await aborted).toEqual(new Error("Operation aborted"));
			expect(escalated).toHaveLength(1);
			expect(retracted).toEqual([]);
			expect(broker.getPending("chat-b")).toBeNull();
			broker.dismiss(escalated[0]?.id ?? "");
			expect(escalated.map((request) => request.questions[0]?.question)).toEqual(["A?", "B next?"]);
		} finally {
			broker.clear();
			await Promise.all([first, aborted, next]);
		}
	});

	it("can settle a dialog synchronously and present the next request", async () => {
		const owners: string[] = [];
		const broker = new AskUserBroker({
			isPanelVisible: () => false,
			escalate: (request) => { owners.push(request.ownerId); broker.dismiss(request.id); },
		});
		const first = broker.ask([question()], undefined, "chat-a");
		const second = broker.ask([question()], undefined, "chat-b");
		try {
			expect(owners).toEqual(["chat-a", "chat-b"]);
			expect(await first).toBeNull();
			expect(await second).toBeNull();
		} finally {
			broker.clear();
			await Promise.all([first, second]);
		}
	});

	it("retracts an escalated dialog that something else settled", async () => {
		const retracted: string[] = [];
		const broker = new AskUserBroker({
			isPanelVisible: () => false,
			escalate: () => undefined,
			retract: (request) => retracted.push(request.id),
		});
		const controller = new AbortController();
		const pending = broker.ask([question()], controller.signal);

		controller.abort();
		await pending.then(() => null, () => null);

		// Nothing else would take the dialog off the screen: its own close path never
		// runs when the answer came from an abort.
		expect(retracted).toHaveLength(1);
	});

	it("ignores a settle for a request that is already gone", async () => {
		const broker = new AskUserBroker({ isPanelVisible: () => true });
		const pending = broker.ask([question()]);
		const id = broker.getPending()?.id ?? "";

		broker.answer(id, [{ question: "Q", header: "H", selected: ["A"] }]);
		// The escalated dialog's `onClose` fires right after a confirmed answer and
		// reports a dismissal. Dropping the request before resolving is what makes
		// that harmless — and is why this class needs no one-shot guard.
		broker.dismiss(id);

		expect(await pending).toEqual([{ question: "Q", header: "H", selected: ["A"] }]);
	});

	it("drops a queued question when its own run is aborted, without disturbing the head", async () => {
		const broker = new AskUserBroker({ isPanelVisible: () => true });
		const controller = new AbortController();
		const first = broker.ask([question("First?")]);
		const second = broker.ask([question("Second?")], controller.signal);

		controller.abort();
		await second.then(() => null, () => null);

		expect(broker.getQueuedCount()).toBe(0);
		expect(broker.getPending()?.questions[0]?.question).toBe("First?");
		broker.dismiss(broker.getPending()?.id ?? "");
		await first;
	});

	it("rejects immediately for a signal that is already aborted", async () => {
		const broker = new AskUserBroker({ isPanelVisible: () => true });
		const controller = new AbortController();
		controller.abort();

		const error = await broker.ask([question()], controller.signal).then(() => null, (reason) => reason as Error);

		expect(error?.message).toBe("Operation aborted");
		expect(broker.getPending()).toBeNull();
	});

	it("dismisses everything on clear, so no tool call is left unsettled", async () => {
		const broker = new AskUserBroker({ isPanelVisible: () => true });
		const first = broker.ask([question("First?")]);
		const second = broker.ask([question("Second?")]);

		broker.clear();

		// Plugin teardown. A dismissal is the one outcome the tool already knows how
		// to report, so it is what an unload reports.
		expect(await first).toBeNull();
		expect(await second).toBeNull();
		expect(broker.getPending()).toBeNull();
	});

	it("notifies subscribers when the head changes", async () => {
		const broker = new AskUserBroker({ isPanelVisible: () => true });
		let notifications = 0;
		const unsubscribe = broker.subscribe(() => {
			notifications++;
		});

		const pending = broker.ask([question()]);
		expect(notifications).toBe(1);
		broker.dismiss(broker.getPending()?.id ?? "");
		await pending;
		expect(notifications).toBe(2);

		unsubscribe();
		void broker.ask([question()]);
		expect(notifications).toBe(2);
		broker.clear();
	});
});

function question(text = "Where should this note go?"): AskUserQuestion {
	return {
		question: text,
		header: "Where to file",
		options: [{ label: "Inbox" }, { label: "Archive" }],
	};
}
