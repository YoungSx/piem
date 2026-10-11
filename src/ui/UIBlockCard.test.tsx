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

function request(overrides: Partial<UIBlockRequest> & { code: string }): UIBlockRequest {
	return { id: "req-1", ownerId: "session-1", ...overrides };
}

/** Every callback stubbed, so a test names only the one it is about. */
function handlers(overrides: Partial<CardHandlers> = {}): CardHandlers {
	return {
		onReady: () => undefined,
		onSendMessage: () => undefined,
		onUpdate: () => undefined,
		onClose: () => undefined,
		...overrides,
	};
}

interface CardHandlers {
	onReady: () => void;
	onSendMessage: (data: Record<string, unknown>) => void;
	onUpdate: (state: Record<string, unknown>) => void;
	onClose: () => void;
	onFail?: (error: string) => void;
}

describe("UIBlockCard", () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(() => {
		document.body.replaceChildren();
	});

	it("renders the card and runs the script inside its container", async () => {
		await mount(
			<UIBlockCard
				request={request({
					code: `container.createEl("div", { text: "Hello from dynamic UI", cls: "custom-div" });`,
					title: "Custom Card",
				})}
				app={mockApp()}
				{...handlers()}
			/>,
		);

		expect(document.querySelector(".piem-ui-block-card--live")).not.toBeNull();
		expect(document.querySelector(".piem-ui-block-card__title")?.textContent).toContain("Custom Card");
		expect(document.querySelector(".custom-div")?.textContent).toBe("Hello from dynamic UI");
	});

	it("announces readiness once a synchronous script finishes setting up", async () => {
		let ready = 0;

		await mount(
			<UIBlockCard
				request={request({ code: `container.createEl("div");` })}
				app={mockApp()}
				{...handlers({ onReady: () => void ready++ })}
			/>,
		);

		expect(ready).toBe(1);
	});

	it("waits for an async script's promise before announcing readiness", async () => {
		const order: string[] = [];

		await mount(
			<UIBlockCard
				request={request({
					code: `
						await new Promise(resolve => setTimeout(resolve, 0));
						window.__asyncSetupDone = true;
					`,
				})}
				app={mockApp()}
				{...handlers({
					onReady: () => order.push((window as any).__asyncSetupDone ? "after-setup" : "before-setup"),
				})}
			/>,
		);

		// Readiness settles the tool call, so announcing it before the script's own
		// setup resolved would report a blank view as delivered.
		expect(order).toEqual(["after-setup"]);
	});

	it("never announces readiness for a script that threw", async () => {
		let ready = 0;

		await mount(
			<UIBlockCard
				request={request({ code: `throw new Error("UI code exploded");` })}
				app={mockApp()}
				{...handlers({ onReady: () => void ready++ })}
			/>,
		);

		expect(ready).toBe(0);
		expect(document.querySelector(".piem-ui-block-card__error")?.textContent).toContain(
			"UI code exploded",
		);
	});

	it("lets a script send repeatedly, with no one-shot latch", async () => {
		const sent: Record<string, unknown>[] = [];

		await mount(
			<UIBlockCard
				request={request({
					code: `
						ui.sendMessage({ count: 1 });
						ui.sendMessage({ count: 2 });
					`,
				})}
				app={mockApp()}
				{...handlers({ onSendMessage: (data) => sent.push(data) })}
			/>,
		);

		/*
		 * The old card swallowed everything after the first call, because a commit
		 * was the end of its view. A panel's button is pressed many times, so the
		 * latch is gone and the broker owns what each call means.
		 */
		expect(sent).toEqual([{ count: 1 }, { count: 2 }]);
	});

	it("reads a bare send as an affirmative", async () => {
		const sent: Record<string, unknown>[] = [];

		await mount(
			<UIBlockCard
				request={request({ code: `ui.sendMessage();` })}
				app={mockApp()}
				{...handlers({ onSendMessage: (data) => sent.push(data) })}
			/>,
		);

		expect(sent).toEqual([{ value: true }]);
	});

	it("routes update separately from sendMessage", async () => {
		const sent: Record<string, unknown>[] = [];
		const updated: Record<string, unknown>[] = [];

		await mount(
			<UIBlockCard
				request={request({
					code: `
						ui.update({ filter: "open" });
						ui.sendMessage({ action: "approve" });
					`,
				})}
				app={mockApp()}
				{...handlers({
					onSendMessage: (data) => sent.push(data),
					onUpdate: (state) => updated.push(state),
				})}
			/>,
		);

		// The two channels are the whole contract: one wakes the agent, one does not.
		expect(updated).toEqual([{ filter: "open" }]);
		expect(sent).toEqual([{ action: "approve" }]);
	});

	it("hands the script its last published state back on mount", async () => {
		await mount(
			<UIBlockCard
				request={request({
					code: `container.createEl("div", { cls: "restored", text: String(ui.state?.filter) });`,
				})}
				app={mockApp()}
				state={{ filter: "closed" }}
				{...handlers()}
			/>,
		);

		// What makes a remount survivable: the panel reopening must not silently
		// reset a dashboard's filters.
		expect(document.querySelector(".restored")?.textContent).toBe("closed");
	});

	it("exposes its own id to the script", async () => {
		await mount(
			<UIBlockCard
				request={request({ id: "req-id", code: `container.createEl("div", { cls: "id", text: ui.id });` })}
				app={mockApp()}
				{...handlers()}
			/>,
		);

		expect(document.querySelector(".id")?.textContent).toBe("req-id");
	});

	it("closes when the script asks to", async () => {
		let closed = 0;

		await mount(
			<UIBlockCard
				request={request({ code: `ui.close();` })}
				app={mockApp()}
				{...handlers({ onClose: () => void closed++ })}
			/>,
		);

		expect(closed).toBe(1);
	});

	it("closes when the user presses the card's own button", async () => {
		let closed = 0;

		await mount(
			<UIBlockCard
				request={request({ code: `container.createEl("div");` })}
				app={mockApp()}
				{...handlers({ onClose: () => void closed++ })}
			/>,
		);

		(document.querySelector(".piem-ui-block-card__dismiss") as HTMLButtonElement | null)?.click();

		expect(closed).toBe(1);
	});

	/*
	 * The regression this guards is the whole point of the lifecycle split,
	 * reached by a different door: while the error waited for a "Report error to
	 * agent" button, a script that threw left the tool call pending on a human —
	 * and inside `codemode` no human is coming, so the script sat on it until the
	 * sandbox deadline. The card must report itself.
	 */
	it("reports a throwing script without waiting for the user", async () => {
		let failed: string | null = null;
		let ready = 0;

		await mount(
			<UIBlockCard
				request={request({ code: `throw new Error("Broken component");` })}
				app={mockApp()}
				{...handlers({
					onReady: () => void ready++,
					onFail: (error) => (failed = error),
				})}
			/>,
		);

		expect(String(failed)).toContain("Broken component");
		expect(ready).toBe(0);
		expect(document.querySelector(".piem-ui-block-card__error-message")?.textContent).toContain(
			"Broken component",
		);
		expect(document.querySelector(".piem-ui-block-card__error-report")).toBeNull();
	});

	it("reports an async script's rejection the same way", async () => {
		let failed: string | null = null;

		await mount(
			<UIBlockCard
				request={request({ code: `await Promise.reject(new Error("Late failure"));` })}
				app={mockApp()}
				{...handlers({ onFail: (error) => (failed = error) })}
			/>,
		);
		await flushRender();

		expect(String(failed)).toContain("Late failure");
	});

	it("closes a broken card when the user dismisses it, having already reported it", async () => {
		let failed: string | null = null;
		let closed = 0;

		await mount(
			<UIBlockCard
				request={request({ code: `throw new Error("Broken component");` })}
				app={mockApp()}
				{...handlers({
					onClose: () => void closed++,
					onFail: (error) => (failed = error),
				})}
			/>,
		);

		expect(String(failed)).toContain("Broken component");
		(document.querySelector(".piem-ui-block-card__dismiss") as HTMLButtonElement | null)?.click();
		expect(closed).toBe(1);
	});

	/*
	 * `ui.update` does not re-render the panel — that would remount the card and
	 * destroy the interaction that called it — so nothing refreshes the `state`
	 * prop afterwards. A script reading `ui.state` back in a later handler has to
	 * see what it last published, which is what the tool's own description
	 * promises it.
	 */
	it("reads back the state the script itself published", async () => {
		(window as any).__readBack = null;

		await mount(
			<UIBlockCard
				request={request({
					code: `
						ui.update({ filter: "mine" });
						const button = container.createEl("button", { cls: "read-back", text: "read" });
						button.onclick = () => { window.__readBack = ui.state; };
					`,
				})}
				app={mockApp()}
				{...handlers({ onUpdate: () => undefined })}
			/>,
		);

		(document.querySelector(".read-back") as HTMLButtonElement | null)?.click();

		expect((window as any).__readBack).toEqual({ filter: "mine" });
	});

	it("does not re-run the script when a callback's identity changes", async () => {
		(window as any).__execCount = 0;
		const req = request({ id: "req-stable", code: `window.__execCount = (window.__execCount || 0) + 1;` });
		const app = mockApp();
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);

		root.render(<UIBlockCard request={req} app={app} {...handlers({ onSendMessage: () => 1 })} />);
		await flushRender();

		// The panel builds these inline, so every render is a new identity. If that
		// re-ran the effect, a parent re-render would wipe a half-filled form.
		root.render(<UIBlockCard request={req} app={app} {...handlers({ onSendMessage: () => 2 })} />);
		await flushRender();

		expect((window as any).__execCount).toBe(1);
		root.unmount();
	});

	it("does not re-run the script when its state changes", async () => {
		(window as any).__stateExecCount = 0;
		const req = request({ id: "req-state", code: `window.__stateExecCount = (window.__stateExecCount || 0) + 1;` });
		const app = mockApp();
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);

		root.render(<UIBlockCard request={req} app={app} state={{ n: 1 }} {...handlers()} />);
		await flushRender();

		/*
		 * `update` is the script's own write. Remounting on it would mean a view
		 * destroyed itself every time it recorded a filter change — the interaction
		 * eating its own view.
		 */
		root.render(<UIBlockCard request={req} app={app} state={{ n: 2 }} {...handlers()} />);
		await flushRender();

		expect((window as any).__stateExecCount).toBe(1);
		root.unmount();
	});

	it("ignores channels reached by a stale closure after unmount", async () => {
		const sent: Record<string, unknown>[] = [];
		const req = request({
			id: "req-late",
			code: `
				window.__lateSend = () => ui.sendMessage({ late: true });
				return () => undefined;
			`,
		});
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);

		root.render(
			<UIBlockCard
				request={req}
				app={mockApp()}
				{...handlers({ onSendMessage: (data) => sent.push(data) })}
			/>,
		);
		await flushRender();

		root.unmount();
		await flushRender();
		(window as any).__lateSend();

		// A timer or async handler the script left behind must not report for a view
		// the user is no longer looking at.
		expect(sent).toEqual([]);
	});

	it("runs the script's cleanup on unmount", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		(window as any).__cleaned_up = false;

		root.render(
			<UIBlockCard
				request={request({ code: `return () => { window.__cleaned_up = true; };` })}
				app={mockApp()}
				{...handlers()}
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

	it("marks a view that was used and then closed", async () => {
		await mount(<UIBlockReceipt title="Action Card" />);

		expect(document.querySelector(".piem-ui-block-card--completed")).not.toBeNull();
		expect(document.querySelector(".piem-ui-block-card__title")?.textContent).toContain("Action Card");
		expect(document.querySelector(".piem-ui-block-card__status-text")?.textContent).toContain("Closed");
	});

	it("distinguishes a view that never opened", async () => {
		await mount(<UIBlockReceipt undelivered={true} />);

		// Two different facts: the agent's attempt to show something failed, versus
		// the ordinary end of a view the user did use.
		expect(document.querySelector(".piem-ui-block-card--dismissed")).not.toBeNull();
		expect(document.querySelector(".piem-ui-block-card__status-text")?.textContent).toContain(
			"Never opened",
		);
	});
});

async function mount(element: React.JSX.Element): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	createRoot(container).render(element);
	await flushRender();
}
