import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { App } from "obsidian";
import type { UIBlockRequest } from "../tools/uiBlockBroker";
import { flushRender, installDom } from "../testUtils/dom";
import { installObsidianStub } from "../testUtils/obsidianStub";

installObsidianStub();
const document = installDom();

const { UIBlockCard, UIBlockReceipt } = await import("./UIBlockCard");
const { createRoot } = await import("react-dom/client");

function mockApp(): App {
	return {
		workspace: {
			getLeavesOfType: () => [],
		},
	} as unknown as App;
}

describe("UIBlockCard", () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(() => {
		document.body.replaceChildren();
	});

	it("renders pending card and executes code inside container", async () => {
		const req: UIBlockRequest = {
			id: "req-1",
			ownerId: "session-1",
			code: `
				container.createEl("div", { text: "Hello from dynamic UI", cls: "custom-div" });
			`,
			title: "Custom Card",
		};

		await mount(
			<UIBlockCard
				request={req}
				app={mockApp()}
				onCommit={() => undefined}
				onDismiss={() => undefined}
			/>,
		);

		expect(document.querySelector(".piem-ui-block-card--pending")).not.toBeNull();
		expect(document.querySelector(".piem-ui-block-card__title")?.textContent).toContain("Custom Card");
		expect(document.querySelector(".custom-div")?.textContent).toBe("Hello from dynamic UI");
	});

	it("guards against multiple commits", async () => {
		let commitCount = 0;
		const req: UIBlockRequest = {
			id: "req-2",
			ownerId: "session-1",
			code: `
				commit({ count: 1 });
				commit({ count: 2 });
			`,
		};

		await mount(
			<UIBlockCard
				request={req}
				app={mockApp()}
				onCommit={() => {
					commitCount++;
				}}
				onDismiss={() => undefined}
			/>,
		);

		expect(commitCount).toBe(1);
	});

	it("normalizes empty commit argument to object with value", async () => {
		let committedData: any = null;
		const req: UIBlockRequest = {
			id: "req-empty-commit",
			ownerId: "session-1",
			code: `
				commit();
			`,
		};

		await mount(
			<UIBlockCard
				request={req}
				app={mockApp()}
				onCommit={(data) => {
					committedData = data;
				}}
				onDismiss={() => undefined}
			/>,
		);

		expect(committedData).toEqual({ value: true });
	});

	it("does not re-execute code when onCommit prop reference changes", async () => {
		(window as any).__execCount = 0;

		const req: UIBlockRequest = {
			id: "req-stable",
			ownerId: "session-1",
			code: `
				window.__execCount = (window.__execCount || 0) + 1;
			`,
		};

		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		const app = mockApp();

		root.render(
			<UIBlockCard
				request={req}
				app={app}
				onCommit={() => 1}
				onDismiss={() => undefined}
			/>,
		);
		await flushRender();

		// Re-render with new inline onCommit callback identity
		root.render(
			<UIBlockCard
				request={req}
				app={app}
				onCommit={() => 2}
				onDismiss={() => undefined}
			/>,
		);
		await flushRender();

		expect((window as any).__execCount).toBe(1);
		root.unmount();
	});

	it("displays runtime error without crashing", async () => {
		const req: UIBlockRequest = {
			id: "req-3",
			ownerId: "session-1",
			code: `
				throw new Error("UI code exploded");
			`,
		};

		await mount(
			<UIBlockCard
				request={req}
				app={mockApp()}
				onCommit={() => undefined}
				onDismiss={() => undefined}
			/>,
		);

		const error = document.querySelector(".piem-ui-block-card__error");
		expect(error).not.toBeNull();
		expect(error?.textContent).toContain("UI code exploded");
	});

	it("runs cleanup on unmount", async () => {
		const req: UIBlockRequest = {
			id: "req-4",
			ownerId: "session-1",
			code: `
				return () => {
					window.__cleaned_up = true;
				};
			`,
		};

		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		(window as any).__cleaned_up = false;

		root.render(
			<UIBlockCard
				request={req}
				app={mockApp()}
				onCommit={() => undefined}
				onDismiss={() => undefined}
			/>,
		);
		await flushRender();

		root.unmount();
		await flushRender();

		expect((window as any).__cleaned_up).toBe(true);
	});
});

describe("UIBlockReceipt", () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(() => {
		document.body.replaceChildren();
	});

	it("renders completed state with title, action and data record", async () => {
		await mount(
			<UIBlockReceipt
				title="Action Card"
				action="applied"
				data={{ settingName: "Theme", value: "Dark" }}
				dismissed={false}
			/>,
		);

		expect(document.querySelector(".piem-ui-block-card--settled")).not.toBeNull();
		expect(document.querySelector(".piem-ui-block-card__title")?.textContent).toContain("Action Card");
		expect(document.querySelector(".piem-ui-block-card__action-badge")?.textContent).toBe("applied");

		const keys = Array.from(document.querySelectorAll(".piem-ui-block-card__key")).map(
			(el) => el.textContent,
		);
		const values = Array.from(document.querySelectorAll(".piem-ui-block-card__value")).map(
			(el) => el.textContent,
		);

		expect(keys).toEqual(["settingName", "value"]);
		expect(values).toEqual(["Theme", "Dark"]);
	});

	it("renders dismissed receipt cleanly", async () => {
		await mount(<UIBlockReceipt dismissed={true} />);

		expect(document.querySelector(".piem-ui-block-card--dismissed")).not.toBeNull();
		expect(document.querySelector(".piem-ui-block-card__status-text")?.textContent).toContain("cancelled");
	});
});

async function mount(element: React.JSX.Element): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	createRoot(container).render(element);
	await flushRender();
}
