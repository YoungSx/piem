import { describe, expect, it } from "bun:test";
import { UIBlockBroker, type UIBlockPayload } from "./uiBlockBroker";
import type { LoggerLike } from "../logging/Logger";

function recordingSink(): {
	sink: (message: { ownerId: string; id: string; title?: string; payload: UIBlockPayload }) => void;
	sent: { ownerId: string; id: string; title?: string; payload: UIBlockPayload }[];
} {
	const sent: { ownerId: string; id: string; title?: string; payload: UIBlockPayload }[] = [];
	return { sink: (message) => sent.push(message), sent };
}

describe("UIBlockBroker", () => {
	it("resolves on mount and keeps the view live", async () => {
		const broker = new UIBlockBroker();
		const promise = broker.present({ code: "/* test */", title: "Test UI" }, undefined, "session-1");

		const [live] = broker.getLive("session-1");
		expect(live).toBeDefined();
		expect(live?.code).toBe("/* test */");
		expect(live?.title).toBe("Test UI");

		broker.ready(live!.id);
		expect(await promise).toEqual({ id: live!.id, delivered: true });

		// The call has returned and the view is still there. This is the whole point.
		expect(broker.getLive("session-1")).toHaveLength(1);
	});

	it("sends a message to the owning conversation without closing the view", async () => {
		const { sink, sent } = recordingSink();
		const broker = new UIBlockBroker({ sendMessage: sink });
		const promise = broker.present({ code: "x", title: "Panel" }, undefined, "session-1");
		const id = broker.getLive("session-1")[0]!.id;
		broker.ready(id);
		await promise;

		broker.sendMessage(id, { action: "approve" });
		broker.sendMessage(id, { action: "approve-again" });

		// Twice, because a panel's button is not a one-shot commit.
		expect(sent).toHaveLength(2);
		expect(sent[0]).toEqual({ ownerId: "session-1", id, title: "Panel", payload: { action: "approve" } });
		expect(sent[1]?.payload).toEqual({ action: "approve-again" });
		expect(broker.getLive("session-1")).toHaveLength(1);
	});

	it("drops a message when no sink is registered rather than throwing", async () => {
		const broker = new UIBlockBroker();
		const promise = broker.present({ code: "x" }, undefined, "session-1");
		const id = broker.getLive("session-1")[0]!.id;
		broker.ready(id);
		await promise;

		expect(() => broker.sendMessage(id, { action: "lost" })).not.toThrow();
		expect(broker.getLive("session-1")).toHaveLength(1);
	});

	it("stores published state for the context block and for a remount", async () => {
		const broker = new UIBlockBroker();
		const promise = broker.present({ code: "x", title: "Dashboard" }, undefined, "session-1");
		const id = broker.getLive("session-1")[0]!.id;
		broker.ready(id);
		await promise;

		expect(broker.getState(id)).toBeNull();
		expect(broker.getContext("session-1")).toEqual([]);

		broker.update(id, { filter: "open" });
		expect(broker.getState(id)).toEqual({ filter: "open" });
		expect(broker.getContext("session-1")).toEqual([{ title: "Dashboard", state: { filter: "open" } }]);

		// Wholesale replacement, not a merge: the script owns the shape.
		broker.update(id, { filter: "closed" });
		expect(broker.getState(id)).toEqual({ filter: "closed" });
	});

	it("names a view by id in the context block when it has no title", async () => {
		const broker = new UIBlockBroker();
		const promise = broker.present({ code: "x" }, undefined, "session-1");
		const id = broker.getLive("session-1")[0]!.id;
		broker.ready(id);
		await promise;
		broker.update(id, { n: 1 });

		expect(broker.getContext("session-1")).toEqual([{ title: id, state: { n: 1 } }]);
	});

	it("reports a view closed before it mounted as undelivered", async () => {
		const broker = new UIBlockBroker();
		const promise = broker.present({ code: "x" }, undefined, "session-1");
		const id = broker.getLive("session-1")[0]!.id;

		broker.close(id);

		expect(await promise).toEqual({ id, delivered: false });
		expect(broker.getLive("session-1")).toHaveLength(0);
	});

	it("closes a live view without disturbing its already-settled delivery", async () => {
		const broker = new UIBlockBroker();
		const promise = broker.present({ code: "x" }, undefined, "session-1");
		const id = broker.getLive("session-1")[0]!.id;
		broker.ready(id);
		expect(await promise).toEqual({ id, delivered: true });

		broker.close(id);
		expect(broker.getLive("session-1")).toHaveLength(0);
		expect(broker.getState(id)).toBeNull();
	});

	it("rejects the delivery when the script throws while mounting", async () => {
		const broker = new UIBlockBroker();
		const promise = broker.present({ code: "/* fail */" }, undefined, "session-1");
		const id = broker.getLive("session-1")[0]!.id;

		broker.fail(id, "Component crashed");

		await expect(promise).rejects.toThrow("UI component error: Component crashed");
		expect(broker.getLive("session-1")).toHaveLength(0);
	});

	/*
	 * A view's code runs again on every remount, so one that mounted cleanly can
	 * throw later — a reopened panel, a switched session. There is no waiter left
	 * by then; dropping the broken view must still work rather than throw on an
	 * absent waiter or leave a view nothing can render.
	 */
	it("drops a live view whose remount throws, with no delivery left to reject", async () => {
		const broker = new UIBlockBroker();
		const promise = broker.present({ code: "x" }, undefined, "session-1");
		const id = broker.getLive("session-1")[0]!.id;
		broker.ready(id);
		await expect(promise).resolves.toEqual({ id, delivered: true });

		broker.update(id, { rows: 2 });
		broker.fail(id, "Threw on remount");

		expect(broker.getLive("session-1")).toHaveLength(0);
		expect(broker.getState(id)).toBeNull();
		expect(broker.getContext("session-1")).toHaveLength(0);
	});

	/*
	 * `getState` feeds the script's own `ui.state`. Handing out the stored object
	 * would let a script that sorts a list in place move what the next turn reads
	 * with no publish behind it — `update` is the only writer.
	 */
	it("hands out a copy of the state, not the record itself", async () => {
		const broker = new UIBlockBroker();
		const promise = broker.present({ code: "x" }, undefined, "session-1");
		const id = broker.getLive("session-1")[0]!.id;
		broker.ready(id);
		await promise;
		broker.update(id, { rows: ["a", "b"] });

		const handed = broker.getState(id)!;
		handed.rows = [];
		handed.injected = true;

		expect(broker.getState(id)).toEqual({ rows: ["a", "b"] });
		expect(broker.getContext("session-1")[0]!.state).toEqual({ rows: ["a", "b"] });
	});

	it("ignores every channel for an unknown or closed id", async () => {
		const { sink, sent } = recordingSink();
		const broker = new UIBlockBroker({ sendMessage: sink });
		const promise = broker.present({ code: "x" }, undefined, "session-1");
		const id = broker.getLive("session-1")[0]!.id;
		broker.ready(id);
		await promise;
		broker.close(id);

		// A stale closure in a torn-down script reaching every channel at once.
		broker.ready(id);
		broker.sendMessage(id, { late: true });
		broker.update(id, { late: true });
		broker.close(id);
		broker.fail(id, "late");

		expect(sent).toHaveLength(0);
		expect(broker.getState(id)).toBeNull();
		expect(broker.getLive("session-1")).toHaveLength(0);
	});

	it("keeps several views live in one conversation", async () => {
		const broker = new UIBlockBroker();
		const first = broker.present({ code: "first" }, undefined, "session-1");
		const second = broker.present({ code: "second" }, undefined, "session-1");

		// Both are presented at once. Under the old pending-queue model only the
		// head was, so an unanswered view blocked every later one behind it.
		const live = broker.getLive("session-1");
		expect(live.map((request) => request.code)).toEqual(["first", "second"]);

		broker.ready(live[1]!.id);
		expect(await second).toEqual({ id: live[1]!.id, delivered: true });

		// The second mounted first and did not have to wait for the first.
		broker.ready(live[0]!.id);
		expect(await first).toEqual({ id: live[0]!.id, delivered: true });
		expect(broker.getLive("session-1")).toHaveLength(2);
	});

	it("keeps conversations isolated", async () => {
		const broker = new UIBlockBroker();
		const mine = broker.present({ code: "mine" }, undefined, "session-1");
		const theirs = broker.present({ code: "theirs" }, undefined, "session-2");

		expect(broker.getLive("session-1").map((r) => r.code)).toEqual(["mine"]);
		expect(broker.getLive("session-2").map((r) => r.code)).toEqual(["theirs"]);

		broker.ready(broker.getLive("session-1")[0]!.id);
		broker.ready(broker.getLive("session-2")[0]!.id);
		await Promise.all([mine, theirs]);

		broker.update(broker.getLive("session-1")[0]!.id, { a: 1 });
		expect(broker.getContext("session-2")).toEqual([]);
	});

	it("rejects a pre-aborted present and an abort during mount", async () => {
		const broker = new UIBlockBroker();
		const preAborted = new AbortController();
		preAborted.abort();

		await expect(broker.present({ code: "x" }, preAborted.signal, "session-1")).rejects.toThrow(
			"Operation aborted",
		);

		const controller = new AbortController();
		const promise = broker.present({ code: "x" }, controller.signal, "session-1");
		expect(broker.getLive("session-1")).toHaveLength(1);

		controller.abort();
		await expect(promise).rejects.toThrow("Operation aborted");
		expect(broker.getLive("session-1")).toHaveLength(0);
	});

	it("survives the run's abort once the view is live", async () => {
		const { sink, sent } = recordingSink();
		const broker = new UIBlockBroker({ sendMessage: sink });
		const controller = new AbortController();
		const promise = broker.present({ code: "x" }, controller.signal, "session-1");
		const id = broker.getLive("session-1")[0]!.id;
		broker.ready(id);
		await promise;

		/*
		 * The regression this guards is the one the old coupling made inevitable:
		 * the tool call returns, its run ends, and the signal fires — which used to
		 * reach through and tear the card off the screen while the user was using
		 * it. Inside `codemode` that fired on the sandbox deadline, two minutes at
		 * the time (five now, with no ceiling — #580).
		 */
		controller.abort();

		expect(broker.getLive("session-1")).toHaveLength(1);
		broker.sendMessage(id, { still: "working" });
		expect(sent).toHaveLength(1);
	});

	it("drops everything on clear, reporting undelivered deliveries", async () => {
		const broker = new UIBlockBroker();
		const mounting = broker.present({ code: "1" }, undefined, "session-1");
		const liveOne = broker.present({ code: "2" }, undefined, "session-2");
		broker.ready(broker.getLive("session-2")[0]!.id);
		await liveOne;

		broker.clear();

		expect(await mounting).toMatchObject({ delivered: false });
		expect(broker.getLive("session-1")).toHaveLength(0);
		expect(broker.getLive("session-2")).toHaveLength(0);
	});

	it("drops only the named conversation's views on clearOwner", async () => {
		const broker = new UIBlockBroker();
		const mine = broker.present({ code: "mine" }, undefined, "session-1");
		const theirs = broker.present({ code: "theirs" }, undefined, "session-2");
		broker.ready(broker.getLive("session-1")[0]!.id);
		broker.ready(broker.getLive("session-2")[0]!.id);
		await Promise.all([mine, theirs]);

		broker.clearOwner("session-1");

		expect(broker.getLive("session-1")).toHaveLength(0);
		expect(broker.getLive("session-2")).toHaveLength(1);
	});

	it("routes a message to the sink registered after construction", async () => {
		const broker = new UIBlockBroker();
		const { sink, sent } = recordingSink();
		broker.setMessageSink(sink);

		const promise = broker.present({ code: "x" }, undefined, "session-1");
		const id = broker.getLive("session-1")[0]!.id;
		broker.ready(id);
		await promise;
		broker.sendMessage(id, { ok: true });

		expect(sent).toHaveLength(1);
	});

	it("logs the lifecycle when a logger is provided", async () => {
		const logs: Array<{ level: string; msg: string }> = [];
		const mockLogger: LoggerLike = {
			debug: (msg: string) => logs.push({ level: "debug", msg }),
			info: (msg: string) => logs.push({ level: "info", msg }),
			warn: (msg: string) => logs.push({ level: "warn", msg }),
			error: (msg: string) => logs.push({ level: "error", msg }),
			isEnabled: () => true,
			child: () => mockLogger,
		};

		const { sink } = recordingSink();
		const broker = new UIBlockBroker({ logger: mockLogger, sendMessage: sink });
		const promise = broker.present({ code: "console.log(1)" }, undefined, "session-1");
		const id = broker.getLive("session-1")[0]!.id;
		broker.ready(id);
		await promise;
		broker.update(id, { ok: true });
		broker.sendMessage(id, { ok: true });
		broker.close(id);

		const said = (fragment: string): boolean => logs.some((entry) => entry.msg.includes(fragment));
		expect(said("UI block mounting")).toBe(true);
		expect(said("UI block live")).toBe(true);
		expect(said("UI block state updated")).toBe(true);
		expect(said("UI block message")).toBe(true);
		expect(said("UI block closed")).toBe(true);
	});
});
