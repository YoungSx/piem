import { describe, expect, it } from "bun:test";
import { UIBlockBroker } from "./uiBlockBroker";
import type { LoggerLike } from "../logging/Logger";

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

	it("rejects and unblocks queue on fail", async () => {
		const broker = new UIBlockBroker();
		const p1 = broker.present({ code: "/* fail */" }, undefined, "session-1");
		const p2 = broker.present({ code: "/* next */" }, undefined, "session-1");

		const pending = broker.getPending("session-1");
		expect(pending?.code).toBe("/* fail */");

		broker.fail(pending!.id, "Component crashed");
		expect(p1).rejects.toThrow("UI component error: Component crashed");

		// After failure, next item in queue should be presented
		expect(broker.getPending("session-1")?.code).toBe("/* next */");
		broker.dismiss(broker.getPending("session-1")!.id);
		expect(await p2).toBeNull();
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

	it("logs lifecycle events when logger is provided", async () => {
		const logs: Array<{ level: string; msg: string }> = [];
		const mockLogger: LoggerLike = {
			debug: (msg: string) => logs.push({ level: "debug", msg }),
			info: (msg: string) => logs.push({ level: "info", msg }),
			warn: (msg: string) => logs.push({ level: "warn", msg }),
			error: (msg: string) => logs.push({ level: "error", msg }),
			isEnabled: () => true,
			child: () => mockLogger,
		};

		const broker = new UIBlockBroker({ logger: mockLogger });
		const p = broker.present({ code: "console.log(1)" }, undefined, "session-1");
		const pending = broker.getPending("session-1");
		broker.commit(pending!.id, { ok: true });
		await p;

		expect(logs.some((l) => l.msg.includes("UI block queued"))).toBe(true);
		expect(logs.some((l) => l.msg.includes("UI block presented"))).toBe(true);
		expect(logs.some((l) => l.msg.includes("UI block committed"))).toBe(true);
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
