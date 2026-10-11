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
		expect(result.details).toMatchObject({
			dismissed: false,
			answers: [{ question: "Where should this note go?", header: "Where to file", selected: ["Inbox"] }],
			interactive: true,
		});
		expect(typeof (result.details as Record<string, unknown>).userWaitMs).toBe("number");
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
		expect(broker.getLive()).toHaveLength(0);
	});

	it("returns once the view is on screen, leaving it live", async () => {
		const broker = new UIBlockBroker();
		const tool = createPresentUITool(app(), broker);

		const call = tool.execute("tool-call", { code: "/* render */", title: "Config Block" });

		const [presented] = broker.getLive();
		expect(presented?.code).toBe("/* render */");
		expect(presented?.title).toBe("Config Block");

		broker.ready(presented!.id);

		const result = (await call) as Result;
		expect(result.details).toMatchObject({
			uiId: presented!.id,
			live: true,
			title: "Config Block",
			interactive: true,
		});
		expect(typeof (result.details as Record<string, unknown>).mountMs).toBe("number");
		// The text has one job: stop the model from sitting there waiting.
		expect(textOf(result)).toContain("stays open");
		expect(textOf(result)).toContain("Your turn ends here");
		expect(textOf(result)).toContain('from "Config Block"');
		// And the view it just reported as open is in fact still open.
		expect(broker.getLive()).toHaveLength(1);
	});

	it("reports a view closed before it mounted as never seen", async () => {
		const broker = new UIBlockBroker();
		const tool = createPresentUITool(app(), broker);

		const call = tool.execute("tool-call", { code: "/* test */" });
		broker.close(broker.getLive()[0]?.id ?? "");

		const result = (await call) as Result;
		expect(result.details).toMatchObject({ live: false, interactive: true });
		expect(textOf(result)).toContain("never saw it");
		expect(broker.getLive()).toHaveLength(0);
	});

	it("fails the call when the script throws while mounting", async () => {
		const broker = new UIBlockBroker();
		const tool = createPresentUITool(app(), broker);

		const call = tool.execute("tool-call", { code: "/* crash */" });
		broker.fail(broker.getLive()[0]?.id ?? "", "render crashed");

		const error = await call.then(() => null, asError);
		expect(error?.message).toContain("UI component error: render crashed");
	});

	it("rejects and cleans up when the signal aborts before the view mounts", async () => {
		const controller = new AbortController();
		const broker = new UIBlockBroker();
		const call = createPresentUITool(app(), broker).execute(
			"tool-call",
			{ code: "/* test */" },
			controller.signal,
		);

		controller.abort();

		const error = await call.then(() => null, asError);
		expect(error?.message).toBe("Operation aborted");
		expect(broker.getLive()).toHaveLength(0);
	});

	it("leaves a delivered view alone when the run's signal fires afterwards", async () => {
		const controller = new AbortController();
		const broker = new UIBlockBroker();
		const call = createPresentUITool(app(), broker).execute(
			"tool-call",
			{ code: "/* test */" },
			controller.signal,
		);
		broker.ready(broker.getLive()[0]!.id);
		await call;

		// The run this call belonged to ends. The view is not its to destroy.
		controller.abort();

		expect(broker.getLive()).toHaveLength(1);
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
