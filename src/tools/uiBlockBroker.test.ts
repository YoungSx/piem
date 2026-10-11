import { describe, expect, it } from "bun:test";
import { UIBlockBroker } from "./uiBlockBroker";

describe("UIBlockBroker", () => {
	it("enqueues and resolves with committed payload", async () => {
		const broker = new UIBlockBroker();
		const promise = broker.present({ code: "/* test */", title: "Test UI" }, undefined, "session-1");

		const pending = broker.getPending("session-1");
		expect(pending).not.toBeNull();
		expect(pending?.code).toBe("/* test */");
		expect(pending?.title).toBe("Test UI");
		expect(broker.getQueuedCount("session-1")).toBe(0);

		broker.commit(pending!.id, { action: "save", value: 42 });
		const result = await promise;
		expect(result).toEqual({ action: "save", value: 42 });
		expect(broker.getPending("session-1")).toBeNull();
	});

	it("resolves with null on dismiss", async () => {
		const broker = new UIBlockBroker();
		const promise = broker.present({ code: "/* test */" }, undefined, "session-1");

		const pending = broker.getPending("session-1");
		broker.dismiss(pending!.id);

		const result = await promise;
		expect(result).toBeNull();
		expect(broker.getPending("session-1")).toBeNull();
	});

	it("handles abort signal before and during present", async () => {
		const broker = new UIBlockBroker();
		const preAborted = new AbortController();
		preAborted.abort();

		expect(broker.present({ code: "test" }, preAborted.signal, "session-1")).rejects.toThrow("Operation aborted");

		const controller = new AbortController();
		const promise = broker.present({ code: "test" }, controller.signal, "session-1");
		expect(broker.getPending("session-1")).not.toBeNull();

		controller.abort();
		expect(promise).rejects.toThrow("Operation aborted");
		expect(broker.getPending("session-1")).toBeNull();
	});

	it("keeps per-conversation queues isolated and pumps next on settle", async () => {
		const broker = new UIBlockBroker();
		const p1 = broker.present({ code: "first" }, undefined, "session-1");
		const p2 = broker.present({ code: "second" }, undefined, "session-1");
		const pOther = broker.present({ code: "other" }, undefined, "session-2");

		expect(broker.getPending("session-1")?.code).toBe("first");
		expect(broker.getQueuedCount("session-1")).toBe(1);
		expect(broker.getPending("session-2")?.code).toBe("other");

		broker.commit(broker.getPending("session-1")!.id, { ok: 1 });
		await p1;

		expect(broker.getPending("session-1")?.code).toBe("second");
		expect(broker.getQueuedCount("session-1")).toBe(0);

		broker.commit(broker.getPending("session-1")!.id, { ok: 2 });
		await p2;

		expect(broker.getPending("session-1")).toBeNull();

		broker.commit(broker.getPending("session-2")!.id, { ok: "other" });
		await pOther;
		expect(broker.getPending("session-2")).toBeNull();
	});

	it("clears all pending requests on clear()", async () => {
		const broker = new UIBlockBroker();
		const p1 = broker.present({ code: "1" }, undefined, "session-1");
		const p2 = broker.present({ code: "2" }, undefined, "session-2");

		broker.clear();

		expect(await p1).toBeNull();
		expect(await p2).toBeNull();
		expect(broker.getPending("session-1")).toBeNull();
		expect(broker.getPending("session-2")).toBeNull();
	});
});
