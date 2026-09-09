import { ExtensionRunner } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { createEventBus } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";
import bookmark from "./bookmarkFactory.mjs";
import type { ExtensionActions, ExtensionContextActions, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { unavailable } from "./node/unavailable";

export interface BookmarkEntry {
	id: string;
	type: string;
	message?: { role: string };
}
export interface BookmarkCallbacks {
	getEntries(): BookmarkEntry[];
	getLabel(id: string): string | undefined;
	setLabel(id: string, label: string | undefined): void;
	notify(message: string): void;
}

/** A missing capability is an explicit failure, including reads of unavailable host members. */
function limited<T extends object>(members: T, name: string): T {
	return new Proxy(members, {
		get(target, key, receiver): unknown {
			if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
			return unavailable(`${name}.${String(key)}`);
		},
	});
}

/**
 * Runs only the pinned, unchanged official bookmark factory. This is not a general extension host.
 * The upstream constructor names concrete CLI classes even though it only passes these objects
 * through. Reflect.construct isolates that upstream typing defect: the supported structural
 * contract is checked here, unsupported members throw, and the returned class is verified.
 */
export async function createOfficialBookmark(callbacks: BookmarkCallbacks): Promise<{
	run(name: "bookmark" | "unbookmark", args: string): Promise<void>;
	dispose(): void;
}> {
	const runtime = createExtensionRuntime();
	const events = createEventBus();
	const extension = await loadExtensionFromFactory(bookmark, "/vault", events, runtime, "<builtin:bookmark>");
	const session = limited({ getEntries: () => callbacks.getEntries(), getLabel: (id: string) => callbacks.getLabel(id) }, "session");
	const candidate: unknown = Reflect.construct(ExtensionRunner, [[extension], runtime, "/vault", session, limited({}, "models")]);
	if (!(candidate instanceof ExtensionRunner)) throw new Error("Pi did not construct an extension runner.");
	const runner = candidate;
	const deny = (): never => unavailable("this extension action");
	const actions: ExtensionActions = {
		sendMessage: deny, sendUserMessage: deny, appendEntry: deny, setSessionName: deny,
		getSessionName: deny, setLabel: (id, label) => callbacks.setLabel(id, label), getActiveTools: deny,
		getAllTools: deny, setActiveTools: deny, refreshTools: deny, getCommands: deny,
		setModel: deny, getThinkingLevel: deny, setThinkingLevel: deny,
	};
	const context: ExtensionContextActions = {
		getModel: deny, getScopedModels: deny, isIdle: deny,
		isProjectTrusted: deny, getSignal: deny, abort: deny,
		hasPendingMessages: deny, shutdown: deny, getContextUsage: deny,
		compact: deny, getSystemPrompt: deny,
	};
	runner.bindCore(actions, context, { registerProvider: deny, registerNativeProvider: deny, unregisterProvider: deny });
	runner.bindCommandContext({ waitForIdle: deny, newSession: deny, fork: deny, navigateTree: deny, switchSession: deny, reload: deny });
	const ui: ExtensionUIContext = {
		notify: message => callbacks.notify(message), select: deny, confirm: deny, input: deny,
		onTerminalInput: deny, setStatus: deny, setWorkingMessage: deny, setWorkingVisible: deny,
		setWorkingIndicator: deny, setHiddenThinkingLabel: deny, setWidget: deny, setFooter: deny,
		setHeader: deny, setTitle: deny, custom: deny, pasteToEditor: deny, setEditorText: deny,
		getEditorText: deny, editor: deny, addAutocompleteProvider: deny, setEditorComponent: deny,
		getEditorComponent: deny, get theme(): never { return unavailable("terminal theme"); },
		getAllThemes: deny, getTheme: deny, setTheme: deny, getToolsExpanded: deny, setToolsExpanded: deny,
	};
	runner.setUIContext(ui, "print");
	return {
		run: async (name, args) => {
			const command = runner.getCommand(name);
			if (!command) throw new Error(`Missing official command: ${name}`);
			await command.handler(args, runner.createCommandContext());
		},
		dispose: () => {
			runner.invalidate();
			events.clear();
		},
	};
}
