import { Window } from "happy-dom";

let installedDocument: Document | undefined;

/**
 * Installs a minimal DOM globals so React components can be rendered under
 * `bun test`, plus the Obsidian-specific `HTMLElement.prototype.empty` helper
 * that production code calls.
 *
 * Idempotent: every caller gets the same window/document. `bun test` executes
 * all files in one process, and reinstalling a second `Window` would swap the
 * globals out from under modules that already captured the first one (React
 * reads `globalThis.document` lazily), so a single shared instance is the only
 * safe shape.
 *
 * Returns the window's document for building hosts and asserting on markup.
 */
export function installDom(): Document {
	if (installedDocument) {
		return installedDocument;
	}
	const window = new Window({ url: "http://localhost/" });
	const globals = globalThis as unknown as Record<string, unknown>;
	globals.window = window;
	globals.document = window.document;
	globals.HTMLElement = window.HTMLElement;
	globals.HTMLDivElement = window.HTMLDivElement;
	globals.Element = window.Element;
	globals.Node = window.Node;
	globals.navigator = window.navigator;
	globals.customElements = window.customElements;
	// happy-dom validates dispatched events against its own realm's Event, so the
	// global has to be that class rather than bun's built-in one.
	globals.Event = window.Event;
	globals.CustomEvent = window.CustomEvent;
	// Escape-dispatching code constructs KeyboardEvents against the document,
	// and happy-dom validates dispatched events against its own realm, so this
	// global must be the window's class too — same reasoning as `Event`.
	globals.KeyboardEvent = window.KeyboardEvent;
	globals.requestAnimationFrame = (callback: FrameRequestCallback): number => window.setTimeout(() => callback(0), 0) as unknown as number;
	// Pointer-query stub for touch-vs-mouse detection. Tests default to fine pointer.
	globals.matchMedia = (query: string) => ({
		matches: false,
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => true,
	});
	// Obsidian patches these helpers onto HTMLElement.prototype; production code
	// calls them, so the test DOM has to provide them too.
	(window.HTMLElement.prototype as unknown as { empty: () => void }).empty = function empty(this: HTMLElement) {
		this.replaceChildren();
	};
	(window.HTMLElement.prototype as unknown as { setCssProps: (props: Record<string, string>) => void }).setCssProps = function setCssProps(
		this: HTMLElement,
		props: Record<string, string>,
	) {
		for (const [name, value] of Object.entries(props)) {
			this.style.setProperty(name, value);
		}
	};
	// Obsidian's element-creation helpers, which production code uses instead of
	// createElement + appendChild. Only the options these call sites pass are
	// honoured; an unsupported one would be a silent no-op, so keep them narrow.
	type CreateOptions = { cls?: string | string[]; text?: string; attr?: Record<string, string> };
	function createChild(this: HTMLElement, tag: string, options: CreateOptions = {}): HTMLElement {
		const child = window.document.createElement(tag) as unknown as HTMLElement;
		if (options.cls) {
			child.classList.add(...(Array.isArray(options.cls) ? options.cls : [options.cls]));
		}
		if (options.text !== undefined) {
			child.textContent = options.text;
		}
		for (const [name, value] of Object.entries(options.attr ?? {})) {
			child.setAttribute(name, value);
		}
		this.appendChild(child);
		return child;
	}
	const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
	proto.createEl = function createEl(this: HTMLElement, tag: string, options?: CreateOptions) {
		return createChild.call(this, tag, options);
	};
	proto.createDiv = function createDiv(this: HTMLElement, options?: CreateOptions) {
		return createChild.call(this, "div", options);
	};
	proto.createSpan = function createSpan(this: HTMLElement, options?: CreateOptions) {
		return createChild.call(this, "span", options);
	};
	installedDocument = window.document as unknown as Document;
	return installedDocument;
}

const FLUSH_TIMEOUT_MS = 5_000;
/** How often the wait loop re-checks its condition while a render settles. */
const POLL_INTERVAL_MS = 10;

/**
 * Mounts the structural skeleton of Obsidian's link-update confirmation into
 * `doc` and returns the modal container. Only the two classes the production
 * selector matches on exist here: the guard must never learn to read titles or
 * button labels, and a richer fixture would make such a read pass a test.
 *
 * Returns the container so tests can remove it (the "user answered" move) or
 * re-mount it (the "answered, then reopened" move).
 */
export function mountLinkUpdateModal(doc: Document): HTMLElement {
	const container = doc.createElement("div");
	container.className = "modal-container";
	const buttons = doc.createElement("div");
	buttons.className = "modal-button-container";
	container.appendChild(buttons);
	doc.body.appendChild(container);
	return container;
}

/**
 * Waits out React's async render cycle before asserting.
 *
 * React commits synchronously here, but effects that kick off promises (e.g.
 * `MarkdownRenderer.render`) resolve on later ticks, and a fixed sleep races
 * them under load. This yields to the macrotask queue until `condition` holds,
 * so tests assert on settled state instead of hoping 20ms was enough.
 *
 * Throws after {@link FLUSH_TIMEOUT_MS} so a genuinely broken render fails
 * loudly rather than hanging the suite forever.
 */
export async function flushRender(condition?: () => boolean): Promise<void> {
	// React 18 schedules passive effects via MessageChannel (a macrotask), and
	// effects that kick off async work (e.g. MarkdownRenderer.render) land on
	// even later ticks. A single `setTimeout(0)` drains only one macrotask;
	// under bun this left effects from the previous test pending when the
	// next test asserted — the flake this suite was built to fix.
	//
	// Drain a bounded number of macrotask rounds instead. Four rounds cover
	// React's commit + passive-effect + async-resolution chain with margin,
	// and the loop is bounded so a genuinely broken render cannot hang.
	for (let i = 0; i < 4; i++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	if (!condition) {
		return;
	}
	const deadline = Date.now() + FLUSH_TIMEOUT_MS;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("flushRender: render did not settle within timeout");
		}
		await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
}
