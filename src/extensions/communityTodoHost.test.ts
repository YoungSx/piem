import { afterEach, describe, expect, it } from "bun:test";
import { webcrypto } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import { Logger } from "../logging/Logger";
import { stubWindowMembers } from "../testUtils/windowStub";
import { createExtensionConfigStore } from "./extensionConfigStore";
import { CommunityHost } from "./communityHost";
import type { ExtensionUIAdapter, NativeExtensionSurface } from "./extensionUI";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const model: Model<string> = {
	provider: "fixture", id: "fixture-model", name: "Fixture", api: "openai-completions", baseUrl: "https://model.invalid",
	reasoning: false, input: ["text"], contextWindow: 8000, maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** A standing UI adapter that records component widgets the panel would mount. */
function adapter() {
	const widgets = new Map<string, { surface: NativeExtensionSurface; options?: unknown }>();
	const ui: ExtensionUIAdapter = {
		select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined,
		getEditorText: () => "", setEditorText: () => {}, pasteToEditor: () => {}, setStatus: () => {}, addAutocompleteProvider: () => {},
		setWidget: (key, content) => { if (content) throw new Error("The overlay must render through component widgets"); },
		setComponentWidget: (key, surface, options) => { if (surface) widgets.set(key, { surface, options }); else widgets.delete(key); },
		setShortcuts: () => {},
		reset: () => widgets.clear(),
	};
	return { ui, widgets };
}

/** One production-registered CommunityHost with a live session branch view. */
async function host(ui: ExtensionUIAdapter) {
	// Real timers, but the upstream pre-warm's handle is dropped: the overlay
	// graph loads on the first refresh either way, and a live 2s timer would
	// outlive the test.
	const restore = stubWindowMembers({
		crypto: webcrypto,
		setTimeout: (callback: () => void, delay?: number) => globalThis.setTimeout(callback, delay),
		clearTimeout: (id?: number) => { if (id !== undefined) globalThis.clearTimeout(id); },
	});
	cleanups.push(async () => restore());
	const branch: Array<{ id: string; type: "message"; message: { role: string; toolName?: string; details?: unknown } }> = [];
	const conversation = await CommunityHost.create({
		getEntries: () => [], getBranch: () => branch, getSessionId: () => "session-1", getSessionFile: () => "Piem/session-1.jsonl",
		getModel: () => model, getModels: () => [model], getThinkingLevel: () => "off", isIdle: () => true,
		notify: () => {}, prepare: async () => {}, deliver: () => {},
		logger: new Logger({ level: () => "debug", sinks: [] }),
		otelEnvironment: () => ({}),
		platform: {
			fetch: async () => { throw new Error("Unexpected foreground request"); },
			backgroundFetch: async () => new Response("{}"),
			config: createExtensionConfigStore({ getData: () => undefined, setData: () => {}, persist: async () => {}, queue: work => work() }),
			onError: () => {},
		},
	});
	cleanups.push(async () => { conversation.dispose(); await conversation.closed().catch(() => {}); });
	conversation.attachUI(ui);
	await conversation.start();
	return { host: conversation, branch };
}

/** The snapshot text, ANSI-stripped, as one joined string. */
function text(surface: NativeExtensionSurface): string {
	const join = (node: ReturnType<NativeExtensionSurface["getSnapshot"]>): string =>
		node.kind === "container" ? node.children.map(join).join("\n")
			: node.kind === "text" ? node.text
			: "";
	return join(surface.getSnapshot());
}

/** Wait for the surface to publish the rendered lines (render itself is microtask-deferred). */
async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for the todo overlay to render");
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

describe("rpiv-todo overlay through the community host", () => {
	it("mounts the todo widget above the editor and refreshes it after the todo tool runs", async () => {
		const ui = adapter();
		const { host: conversation, branch } = await host(ui.ui);

		const todo = conversation.tools.find(tool => tool.name === "todo");
		expect(todo).toBeDefined();
		// An empty list registers no widget: the overlay auto-hides upstream.
		expect(ui.widgets.size).toBe(0);
		const created = await todo!.execute("todo-1", { action: "create", subject: "Ship the Piem integration", status: "in_progress" } as never, new AbortController().signal);
		expect(created.content).toEqual([{ type: "text", text: expect.stringContaining("Ship the Piem integration") }]);
		// The tool result carries the replayable snapshot a later replay reads.
		branch.push({ id: "e1", type: "message", message: { role: "toolResult", toolName: "todo", details: created.details } });

		await conversation.emitAgentEvent({ type: "tool_execution_end", toolName: "todo", toolCallId: "todo-1", isError: false, result: created });
		await until(() => ui.widgets.has("rpiv-todos"));
		const { surface, options } = ui.widgets.get("rpiv-todos")!;
		expect(options).toEqual({ placement: "aboveEditor" });
		await until(() => text(surface).includes("Ship the Piem integration"));
	});

	it("hides the widget again once the last task is cleared", async () => {
		const ui = adapter();
		const { host: conversation, branch } = await host(ui.ui);
		const todo = conversation.tools.find(tool => tool.name === "todo")!;
		const created = await todo.execute("todo-1", { action: "create", subject: "One task" } as never, new AbortController().signal);
		branch.push({ id: "e1", type: "message", message: { role: "toolResult", toolName: "todo", details: created.details } });
		await conversation.emitAgentEvent({ type: "tool_execution_end", toolName: "todo", toolCallId: "todo-1", isError: false, result: created });
		await until(() => ui.widgets.has("rpiv-todos"));

		const cleared = await todo.execute("todo-2", { action: "clear" } as never, new AbortController().signal);
		branch.push({ id: "e2", type: "message", message: { role: "toolResult", toolName: "todo", details: cleared.details } });
		await conversation.emitAgentEvent({ type: "tool_execution_end", toolName: "todo", toolCallId: "todo-2", isError: false, result: cleared });
		await until(() => !ui.widgets.has("rpiv-todos"));
	});
});
