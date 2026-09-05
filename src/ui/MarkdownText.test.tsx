import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { App, Component } from "obsidian";
import type { createRoot } from "react-dom/client";
import { flushRender, installDom } from "../testUtils/dom";
import { installObsidianStub, markdownRenderMock } from "../testUtils/obsidianStub";

installObsidianStub();
const document = installDom();

// Dynamic imports so the mocked `obsidian` module wins over any cached real one.
const { MarkdownText } = await import("./MarkdownText");
const { createRoot: createRootImpl } = await import("react-dom/client");

let createRootSync: typeof createRoot;

/*
 * happy-dom hangs `MouseEvent` off its own window rather than installing it as a
 * global, and validates dispatched events against that realm.
 */
const { window: domWindow } = globalThis as unknown as { window: { MouseEvent: typeof MouseEvent } };

/** Navigations a click on a rendered link asked the workspace for. */
const openedLinks: [linktext: string, sourcePath: string, newLeaf: unknown][] = [];

const app = {
	workspace: {
		openLinkText: async (linktext: string, source: string, newLeaf: unknown): Promise<void> => {
			openedLinks.push([linktext, source, newLeaf]);
		},
	},
} as unknown as App;
const component = {} as Component;
const sourcePath = "Notes/active.md";

/**
 * Renders one block and waits until its async side effects have settled.
 *
 * The settled marker matters because `MarkdownContainer`'s effect fires
 * `MarkdownRenderer.render` without awaiting it; asserting before that promise
 * lands is exactly the flake this suite used to have.
 */
async function renderBlock(props: {
	text: string;
	kind: "user" | "assistant" | "thinking" | "toolArguments" | "toolResult" | "harness";
	isStreaming?: boolean;
}): Promise<{ host: HTMLElement; markdown: HTMLElement }> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRootSync(host);
	roots.set(host, root);
	root.render(<MarkdownText text={props.text} kind={props.kind} isStreaming={props.isStreaming} app={app} component={component} sourcePath={sourcePath} />);
	if (!props.isStreaming && (props.kind === "user" || props.kind === "assistant" || props.kind === "thinking")) {
		await flushRender(() => host.querySelector(".stub-rendered") !== null || markdownRenderMock.mock.calls.length > 0);
	} else {
		await flushRender(() => host.textContent !== "" || host.querySelector(".piem-chat__markdown, pre.piem-chat__text") !== null);
	}
	// Looked up *after* the wait. `root.render` only schedules, so querying first
	// returned nothing and quietly fell back to the host — which reads the same for
	// any subtree assertion, and not at all the same for anything that appends to
	// the container or depends on which element carries a listener.
	const markdown = (host.querySelector(".piem-chat__markdown") ?? host.firstElementChild ?? host) as HTMLElement;
	return { host, markdown };
}

beforeEach(() => {
	createRootSync = createRootImpl;
	openedLinks.length = 0;
	markdownRenderMock.mockReset();
	markdownRenderMock.mockImplementation(async ({ el }: { el: HTMLElement }) => {
		const rendered = document.createElement("p");
		rendered.className = "stub-rendered";
		el.appendChild(rendered);
	});
});

afterEach(() => {
	document.body.replaceChildren();
});

describe("MarkdownText", () => {
	it("renders a settled assistant block through MarkdownRenderer.render", async () => {
		const { host } = await renderBlock({ text: "**bold**", kind: "assistant" });

		expect(markdownRenderMock).toHaveBeenCalledTimes(1);
		const firstCall = markdownRenderMock.mock.calls[0];
		expect(firstCall).toBeDefined();
		const call = firstCall![0] as { app: unknown; markdown: string; sourcePath: string; component: unknown };
		expect(call.markdown).toBe("**bold**");
		expect(call.sourcePath).toBe(sourcePath);
		expect(call.app).toBe(app);
		expect(call.component).toBe(component);
		expect(host.querySelector(".stub-rendered")).not.toBeNull();
	});

	it("keeps a streaming assistant block plain and skips the renderer", async () => {
		const { host } = await renderBlock({ text: "**partial tok", kind: "assistant", isStreaming: true });

		expect(markdownRenderMock).toHaveBeenCalledTimes(0);
		const pre = host.querySelector("pre.piem-chat__text");
		expect(pre?.textContent).toBe("**partial tok");
	});

	it("keeps tool results plain even when settled", async () => {
		const { host } = await renderBlock({ text: "* matches lines", kind: "toolResult" });

		expect(markdownRenderMock).toHaveBeenCalledTimes(0);
		expect(host.querySelector("pre.piem-chat__text")?.textContent).toBe("* matches lines");
	});

	it("keeps tool arguments plain even when settled", async () => {
		const { host } = await renderBlock({ text: '{"path": "a.md"}', kind: "toolArguments" });

		expect(markdownRenderMock).toHaveBeenCalledTimes(0);
		expect(host.querySelector("pre.piem-chat__text")).not.toBeNull();
	});

	/*
	 * The face class has to reach the DOM, on both branches. A `<pre>` that carries
	 * neither falls back to the UA's monospace default, which silently looks correct
	 * for machine output and wrong for everything else — so the prose cases are the
	 * ones worth pinning.
	 */
	it("sets machine output in the monospace face", async () => {
		const { host } = await renderBlock({ text: "a.md\nb.md", kind: "toolResult" });

		expect(host.querySelector("pre.piem-chat__text--machine")).not.toBeNull();
		expect(host.querySelector("pre.piem-chat__text--prose")).toBeNull();
	});

	it("sets a streaming reply in the prose face, and keeps it there once settled", async () => {
		const streaming = await renderBlock({ text: "half a sen", kind: "assistant", isStreaming: true });
		expect(streaming.host.querySelector("pre.piem-chat__text--prose")).not.toBeNull();

		const settled = await renderBlock({ text: "half a sentence.", kind: "assistant" });
		expect(settled.host.querySelector(".piem-chat__markdown.piem-chat__text--prose")).not.toBeNull();
	});

	it("clears stale content when the text changes instead of stacking renders", async () => {
		const { host, markdown } = await renderBlock({ text: "first", kind: "assistant" });
		expect(host.querySelectorAll(".stub-rendered")).toHaveLength(1);

		rerenderWith(host, "second");
		await flushRender(() => (markdown?.querySelectorAll(".stub-rendered").length ?? 0) === 1);

		expect(markdown?.querySelectorAll(".stub-rendered")).toHaveLength(1);
	});

	it("survives a renderer rejection without throwing during render", async () => {
		const failures: unknown[] = [];
		markdownRenderMock.mockImplementation(async () => {
			failures.push(1);
			throw new Error("renderer exploded");
		});
		// The component logs the failure via console.error; silence it for this test.
		const originalError = console.error;
		console.error = () => undefined;
		try {
			const { host } = await renderBlock({ text: "boom", kind: "user" });
			expect(failures).toHaveLength(1);
			expect(host.querySelector(".piem-chat__markdown")).not.toBeNull();
		} finally {
			console.error = originalError;
		}
	});

	it("does not re-render when only the source path changed", async () => {
		const { host } = await renderBlock({ text: "hello", kind: "assistant" });
		expect(markdownRenderMock).toHaveBeenCalledTimes(1);

		rerenderWith(host, "hello", "Notes/elsewhere.md");
		await flushRender();

		// The context chips subscribe to the workspace, so a note switch now reaches
		// React. If `sourcePath` were a render dependency, every switch would tear
		// down and re-render every block in the transcript through Obsidian's
		// renderer — once per message, per switch.
		expect(markdownRenderMock).toHaveBeenCalledTimes(1);
	});

	it("still re-renders when the text changed", async () => {
		const { host } = await renderBlock({ text: "first", kind: "assistant" });
		expect(markdownRenderMock).toHaveBeenCalledTimes(1);

		rerenderWith(host, "second");
		await flushRender(() => markdownRenderMock.mock.calls.length > 1);

		// Guards the fix above from going too far: content still drives a re-render,
		// so a streamed message that settles is redrawn.
		expect(markdownRenderMock).toHaveBeenCalledTimes(2);
	});

	it("uses the source path that was current when the block rendered", async () => {
		const { host } = await renderBlock({ text: "hello", kind: "assistant" });

		rerenderWith(host, "changed", "Notes/elsewhere.md");
		await flushRender(() => markdownRenderMock.mock.calls.length > 1);

		// The ref is kept current, so the next render that does happen picks up the
		// newer path rather than a stale captured one.
		const latest = markdownRenderMock.mock.calls.at(-1)?.[0] as { sourcePath: string };
		expect(latest.sourcePath).toBe("Notes/elsewhere.md");
	});
});

/*
 * The link wiring, from the container's side. `routeMarkdownLinkClick` is tested
 * on its own in `markdownLinks.test.ts`; what these three cases pin is that the
 * handler is actually attached to the block that Obsidian renders into, and which
 * source path it hands over — neither of which the unit tests can see.
 *
 * The anchors are appended by hand because the renderer is a stub here. That is
 * the honest fixture anyway: in production the anchors are appended by Obsidian,
 * not by React, and a handler that only saw React-managed children would pass a
 * test that built them any other way.
 */
describe("MarkdownText link navigation", () => {
	it("opens a vault link that was rendered into the block", async () => {
		const { markdown } = await renderBlock({ text: "see [[Projects/beta]]", kind: "assistant" });

		clickLink(markdown, { cls: "internal-link", dataHref: "Projects/beta" });

		expect(openedLinks).toEqual([["Projects/beta", sourcePath, false]]);
	});

	it("leaves an external link in the block to the platform", async () => {
		const { markdown } = await renderBlock({ text: "see [page](https://example.com/page)", kind: "assistant" });

		const event = clickLink(markdown, { cls: "external-link", href: "https://example.com/page" });

		expect(openedLinks).toEqual([]);
		// Electron already routes these to the system browser off the anchor's own
		// target="_blank"; preventing the default would take that away.
		expect(event.defaultPrevented).toBe(false);

		// Proves the empty list above is the handler declining and not the handler
		// missing: the same container claims an internal link right after.
		clickLink(markdown, { cls: "internal-link", dataHref: "Projects/beta" });
		expect(openedLinks).toEqual([["Projects/beta", sourcePath, false]]);
	});

	it("resolves a link against the path the block was rendered with", async () => {
		const { host, markdown } = await renderBlock({ text: "see [[dup]]", kind: "assistant" });

		// Same text, different note. The block does not re-render, so its links still
		// belong to the note that was open when they were drawn — which is the base
		// that makes `[[dup]]` mean what the model meant by it.
		rerenderWith(host, "see [[dup]]", "Archive/elsewhere.md");
		await flushRender();
		expect(markdownRenderMock).toHaveBeenCalledTimes(1);

		clickLink(markdown, { cls: "internal-link", dataHref: "dup" });

		expect(openedLinks).toEqual([["dup", sourcePath, false]]);
	});

	it("replaces the listener on a re-render instead of stacking one", async () => {
		const { host, markdown } = await renderBlock({ text: "first", kind: "assistant" });

		rerenderWith(host, "second");
		await flushRender(() => markdownRenderMock.mock.calls.length > 1);

		clickLink(markdown, { cls: "internal-link", dataHref: "Projects/beta" });

		// A missed removeEventListener is visible here and nowhere else: the click
		// would open the note once per render the block had been through.
		expect(openedLinks).toHaveLength(1);
	});
});

/** Appends one anchor the way Obsidian's renderer would, then clicks it. */
function clickLink(container: HTMLElement, attrs: { cls: string; dataHref?: string; href?: string }): MouseEvent {
	const anchor = document.createElement("a");
	anchor.className = attrs.cls;
	if (attrs.dataHref !== undefined) {
		anchor.setAttribute("data-href", attrs.dataHref);
	}
	anchor.setAttribute("href", attrs.href ?? attrs.dataHref ?? "");
	anchor.setAttribute("target", "_blank");
	anchor.textContent = "link";
	container.appendChild(anchor);
	const event = new domWindow.MouseEvent("click", { bubbles: true, cancelable: true });
	anchor.dispatchEvent(event);
	return event;
}

function rerenderWith(host: HTMLElement, text: string, path: string = sourcePath): void {
	rootOf(host)?.render(
		<MarkdownText text={text} kind="assistant" app={app} component={component} sourcePath={path} />,
	);
}

const roots = new WeakMap<HTMLElement, import("react-dom/client").Root>();

function rootOf(host: HTMLElement): import("react-dom/client").Root | undefined {
	return roots.get(host);
}
