import { beforeEach, describe, expect, it } from "bun:test";
import { installObsidianStub, resetNotices, shownNotices } from "../testUtils/obsidianStub";
import { VIEW_TYPE_PIEM_CHAT } from "../constants";
import type { App } from "obsidian";

installObsidianStub();

// Dynamic imports so the mocked module wins over any cached real one.
const { createNotifyTool, createAskUserTool, createPresentUITool } = await import("./interactionTools");
const { AskUserBroker } = await import("./askUserBroker");
const { UIBlockBroker } = await import("./uiBlockBroker");

beforeEach(() => {
	resetNotices();
});

describe("notify", () => {
	it("shows a toast through Obsidian's Notice", async () => {
		const result = await createNotifyTool(app()).execute("tool-call", { message: "Reorganization finished." });

		expect(shownNotices).toEqual([{ message: "Reorganization finished.", timeout: undefined }]);
		expect(result.details).toMatchObject({ notified: true });
	});

	it("passes an explicit duration through", async () => {
		await createNotifyTool(app()).execute("tool-call", { message: "Done", timeout: 4000 });

		expect(shownNotices).toEqual([{ message: "Done", timeout: 4000 }]);
	});
});

describe("ask_user", () => {
	it("refuses when no chat panel exists instead of asking nobody", async () => {
		const broker = new AskUserBroker();
		const tool = createAskUserTool(appWithoutChat(), broker);

		const error = await tool.execute("tool-call", { questions: [oneQuestion()] }).then(() => null, asError);

		expect(error?.message).toContain("chat panel is not open");
		expect(broker.getPending()).toBeNull();
	});

	it("hands the questions to the broker verbatim and formats the answers back", async () => {
		const broker = new AskUserBroker();
		const tool = createAskUserTool(app(), broker);

		const pending = tool.execute("tool-call", { questions: [oneQuestion()] });

		const asked = broker.getPending();
		expect(asked?.questions).toEqual([oneQuestion()]);

		broker.answer(asked?.id ?? "", [
			{ question: "Where should this note go?", header: "Where to file", selected: ["Inbox"] },
		]);

		const result = (await pending) as Result;
		expect(result.details).toEqual({
			dismissed: false,
			answers: [{ question: "Where should this note go?", header: "Where to file", selected: ["Inbox"] }],
		});
		expect(textOf(result)).toBe("The user answered:\nWhere to file: Inbox");
	});

	it("joins several picks into one line per question", async () => {
		const broker = new AskUserBroker();
		const pending = createAskUserTool(app(), broker).execute("tool-call", { questions: [oneQuestion()] });

		broker.answer(broker.getPending()?.id ?? "", [
			{ question: "Where should this note go?", header: "Where to file", selected: ["Inbox", "Archive"] },
		]);

		expect(textOf((await pending) as Result)).toBe("The user answered:\nWhere to file: Inbox, Archive");
	});

	it("reports a handed-back decision as guidance, not an error", async () => {
		const broker = new AskUserBroker();
		const pending = createAskUserTool(app(), broker).execute("tool-call", { questions: [oneQuestion()] });

		broker.dismiss(broker.getPending()?.id ?? "");

		const result = (await pending) as Result;
		// Not a throw: the user declining to choose is still information, and the
		// result tells the model what to do with it — which is also what the card's
		// "Let Piem decide" button is named after.
		expect(result.details).toMatchObject({ dismissed: true });
		expect(textOf(result)).toContain("make the most reasonable choice yourself");
	});

	it("rejects and drops the question when the run is aborted", async () => {
		const controller = new AbortController();
		const broker = new AskUserBroker();
		const pending = createAskUserTool(app(), broker).execute(
			"tool-call",
			{ questions: [oneQuestion()] },
			controller.signal,
		);

		controller.abort();

		const error = await pending.then(() => null, asError);
		// Without this the question would sit on screen after the agent that asked
		// it was interrupted, and the tool promise would never settle.
		expect(error?.message).toBe("Operation aborted");
		expect(broker.getPending()).toBeNull();
	});
});

describe("present_ui", () => {
	it("refuses when no chat panel exists", async () => {
		const broker = new UIBlockBroker();
		const tool = createPresentUITool(appWithoutChat(), broker);

		const error = await tool.execute("tool-call", { code: "/* test */" }).then(() => null, asError);

		expect(error?.message).toContain("chat panel is not open");
		expect(broker.getPending()).toBeNull();
	});

	it("hands the request to the broker and returns committed data", async () => {
		const broker = new UIBlockBroker();
		const tool = createPresentUITool(app(), broker);

		const pending = tool.execute("tool-call", { code: "/* render */", title: "Config Block" });

		const asked = broker.getPending();
		expect(asked?.code).toBe("/* render */");
		expect(asked?.title).toBe("Config Block");

		broker.commit(asked?.id ?? "", { action: "submit", port: 8080 });

		const result = (await pending) as Result;
		expect(result.details).toMatchObject({
			dismissed: false,
			action: "submit",
			title: "Config Block",
			data: { action: "submit", port: 8080 },
		});
		expect(textOf(result)).toContain('User submitted action "submit"');
		expect(textOf(result)).toContain('"port": 8080');
	});

	it("handles dismiss/cancel", async () => {
		const broker = new UIBlockBroker();
		const tool = createPresentUITool(app(), broker);

		const pending = tool.execute("tool-call", { code: "/* test */" });
		broker.dismiss(broker.getPending()?.id ?? "");

		const result = (await pending) as Result;
		expect(result.details).toMatchObject({ dismissed: true });
		expect(textOf(result)).toContain("dismissed or cancelled");
	});

	it("rejects and cleans up when signal is aborted", async () => {
		const controller = new AbortController();
		const broker = new UIBlockBroker();
		const pending = createPresentUITool(app(), broker).execute(
			"tool-call",
			{ code: "/* test */" },
			controller.signal,
		);

		controller.abort();

		const error = await pending.then(() => null, asError);
		expect(error?.message).toBe("Operation aborted");
		expect(broker.getPending()).toBeNull();
	});
	it("sanitizes circular structures and DOM nodes in committed payload", async () => {
		const broker = new UIBlockBroker();
		const tool = createPresentUITool(app(), broker);

		const pending = tool.execute("tool-call", { code: "/* test */" });
		const circular: Record<string, unknown> = { key: "value" };
		circular.self = circular;
		circular.element = { nodeType: 1, tagName: "BUTTON" };

		broker.commit(broker.getPending()?.id ?? "", circular);

		const result = (await pending) as Result;
		expect(result.details).toMatchObject({
			dismissed: false,
			data: {
				key: "value",
				self: "[Circular]",
				element: "[Element <button>]",
			},
		});
		expect(textOf(result)).toContain("[Circular]");
		expect(textOf(result)).toContain("[Element <button>]");
	});

	it("preserves shared references in directed acyclic graphs (DAGs)", async () => {
		const broker = new UIBlockBroker();
		const tool = createPresentUITool(app(), broker);

		const pending = tool.execute("tool-call", { code: "/* test */" });
		const shared = { enabled: true, count: 42 };
		const payload = {
			defaults: shared,
			current: shared,
			items: [shared, shared],
		};

		broker.commit(broker.getPending()?.id ?? "", payload);

		const result = (await pending) as Result;
		expect(result.details).toMatchObject({
			dismissed: false,
			data: {
				defaults: { enabled: true, count: 42 },
				current: { enabled: true, count: 42 },
				items: [
					{ enabled: true, count: 42 },
					{ enabled: true, count: 42 },
				],
			},
		});
		expect(textOf(result)).not.toContain("[Circular]");
	});
});


type Result = { content: Array<{ type: "text"; text: string }>; details?: unknown };

function textOf(result: Result): string {
	return result.content.find((item) => item.type === "text")?.text ?? "";
}

function oneQuestion(): {
	question: string;
	header: string;
	options: Array<{ label: string; description?: string }>;
} {
	return {
		question: "Where should this note go?",
		header: "Where to file",
		options: [
			{ label: "Inbox", description: "Sort it later from the desktop." },
			{ label: "Archive", description: "Keep it for search, off the workbench." },
		],
	};
}

function app(): App {
	return {
		workspace: {
			getLeavesOfType: (type: string) => (type === VIEW_TYPE_PIEM_CHAT ? [{}] : []),
		},
	} as unknown as App;
}

function appWithoutChat(): App {
	return {
		workspace: {
			getLeavesOfType: () => [],
		},
	} as unknown as App;
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
